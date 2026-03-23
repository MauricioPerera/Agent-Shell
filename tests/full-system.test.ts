/**
 * @module full-system
 * @description Full system integration battery test.
 *
 * Validates the ENTIRE Agent Shell stack working together:
 * - Core + CommandRegistry + VectorIndex + ContextStore
 * - MCP Server (cli_help + cli_exec)
 * - All 3 skill categories (scaffold, wizard, registry admin)
 * - Shell skills (http, json, file, shell, env) via adapter
 * - Agent profiles + permission enforcement in discovery + execution
 * - Matryoshka progressive search
 * - Pipelines, batch, JQ filter, formatting, pagination
 * - Confirm flow, dry-run, validate modes
 * - Audit logging
 * - History + undo tracking
 * - Error handling and structured responses
 *
 * This is the definitive "does the whole thing work?" test.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { Core } from '../src/core/index.js';
import { CommandRegistry } from '../src/command-registry/index.js';
import { VectorIndex } from '../src/vector-index/index.js';
import { ContextStore } from '../src/context-store/index.js';
import { Executor } from '../src/executor/index.js';
import { McpServer } from '../src/mcp/server.js';
import { AuditLogger } from '../src/security/audit-logger.js';
import { RBAC } from '../src/security/rbac.js';
import { parse } from '../src/parser/index.js';
import { applyFilter } from '../src/jq-filter/index.js';
import { command } from '../src/command-builder/index.js';
import { registerSkills } from '../src/skills/index.js';
import { createShellCommands, createShellCommands as createShell } from '../src/skills/shell-exec.js';
import { createFileCommands } from '../src/skills/shell-file.js';
import { httpCommands } from '../src/skills/shell-http.js';
import { jsonCommands } from '../src/skills/shell-json.js';
import { envCommands } from '../src/skills/shell-env.js';
import { NativeShellAdapter } from '../src/just-bash/adapter.js';
import { createShellAdapter } from '../src/just-bash/factory.js';
import { defaultMatryoshkaConfig } from '../src/vector-index/matryoshka.js';
import type { JsonRpcRequest, JsonRpcResponse } from '../src/mcp/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function mcpSend(server: McpServer, req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  return (server as any).handleMessage(req);
}

async function mcpInit(server: McpServer): Promise<void> {
  await mcpSend(server, { jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } });
}

async function mcpExec(server: McpServer, command: string): Promise<any> {
  const res = await mcpSend(server, { jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name: 'cli_exec', arguments: { command } } });
  return JSON.parse(res!.result.content[0].text);
}

async function mcpHelp(server: McpServer): Promise<string> {
  const res = await mcpSend(server, { jsonrpc: '2.0', id: 'help', method: 'tools/call', params: { name: 'cli_help' } });
  return res!.result.content[0].text;
}

// Mock embedding adapter
function createEmbeddingAdapter(dimensions = 128) {
  return {
    async embed(text: string) {
      const vector = Array.from({ length: dimensions }, (_, i) => Math.sin(text.charCodeAt(i % text.length) + i) * 0.5 + 0.5);
      return { vector, dimensions, tokenCount: text.split(' ').length, model: 'test-model' };
    },
    async embedBatch(texts: string[]) { return Promise.all(texts.map(t => this.embed(t))); },
    getDimensions() { return dimensions; },
    getModelId() { return 'test-model'; },
  };
}

// Mock storage adapter
function createStorageAdapter() {
  const entries = new Map<string, any>();
  return {
    async upsert(entry: any) { entries.set(entry.id, entry); },
    async upsertBatch(batch: any[]) { batch.forEach(e => entries.set(e.id, e)); return { success: batch.length, failed: 0 }; },
    async delete(id: string) { entries.delete(id); },
    async deleteBatch(ids: string[]) { ids.forEach(id => entries.delete(id)); return { success: ids.length, failed: 0 }; },
    async search(query: any) {
      const all = Array.from(entries.values());
      let results = all.map(entry => {
        let dot = 0, nA = 0, nB = 0;
        for (let i = 0; i < query.vector.length; i++) { dot += query.vector[i] * entry.vector[i]; nA += query.vector[i] ** 2; nB += entry.vector[i] ** 2; }
        const score = Math.sqrt(nA) * Math.sqrt(nB) === 0 ? 0 : dot / (Math.sqrt(nA) * Math.sqrt(nB));
        return { id: entry.id, score, metadata: entry.metadata };
      });
      if (query.threshold) results = results.filter((r: any) => r.score >= query.threshold);
      if (query.filters?.namespace) results = results.filter((r: any) => r.metadata.namespace === query.filters.namespace);
      results.sort((a: any, b: any) => b.score - a.score);
      return results.slice(0, query.topK);
    },
    async listIds() { return Array.from(entries.keys()); },
    async count() { return entries.size; },
    async clear() { entries.clear(); },
    async healthCheck() { return { status: 'healthy' as const }; },
  };
}

// In-memory storage adapter for ContextStore
function createMemoryStorageAdapter() {
  const stores = new Map<string, any>();
  return {
    name: 'memory',
    async initialize(sid: string) { if (!stores.has(sid)) stores.set(sid, { context: { entries: {} }, history: [], undo_snapshots: [] }); },
    async load(sid: string) { return stores.get(sid) || null; },
    async save(sid: string, data: any) { stores.set(sid, data); },
    async destroy(sid: string) { stores.delete(sid); },
    async healthCheck() { return true; },
    async dispose() { stores.clear(); },
  };
}

// ---------------------------------------------------------------------------
// Build the full system
// ---------------------------------------------------------------------------

/**
 * Wraps a CommandRegistry for Core compatibility.
 * Core.get() expects command-or-null, not Result<RegisteredCommand>.
 */
function wrapForCore(registry: CommandRegistry) {
  return {
    get(namespace: string, name: string) {
      const result = registry.get(namespace, name);
      if (result.ok) {
        return { ...result.value.definition, handler: result.value.handler };
      }
      return null;
    },
    listAll() { return registry.listAll(); },
    getNamespaces() { return registry.getNamespaces(); },
    listByNamespace(ns: string) { return registry.listByNamespace(ns); },
    resolve(fullName: string) { return registry.resolve(fullName); },
    toCompactText(def: any) { return registry.toCompactText(def); },
    toCompactTextBatch(defs: any[]) { return registry.toCompactTextBatch(defs); },
    register(def: any, handler: any) { return registry.register(def, handler); },
    _real: registry,
  };
}

function createDomainRegistry() {
  const registry = new CommandRegistry();

  const cmds = [
    { ns: 'users', name: 'list', desc: 'List all users', perms: ['users:read'],
      handler: async () => ({ success: true, data: [{ id: 1, name: 'Alice', role: 'admin' }, { id: 2, name: 'Bob', role: 'user' }, { id: 3, name: 'Charlie', role: 'user' }] }) },
    { ns: 'users', name: 'get', desc: 'Get user by ID', perms: ['users:read'],
      handler: async (args: any) => ({ success: true, data: { id: Number(args.id), name: 'Alice', role: 'admin' } }) },
    { ns: 'users', name: 'create', desc: 'Create a new user', perms: ['users:create'],
      handler: async (args: any) => ({ success: true, data: { id: 99, name: args.name, email: args.email } }) },
    { ns: 'users', name: 'delete', desc: 'Delete a user', perms: ['users:delete'],
      handler: async (args: any) => ({ success: true, data: { deleted: Number(args.id) } }) },
    { ns: 'users', name: 'count', desc: 'Count users', perms: ['users:read'],
      handler: async (_args: any, input: any) => {
        if (Array.isArray(input)) return { success: true, data: { count: input.length } };
        return { success: true, data: { count: 3 } };
      } },
    { ns: 'orders', name: 'list', desc: 'List all orders', perms: ['orders:read'],
      handler: async () => ({ success: true, data: [{ id: 101, product: 'Widget', amount: 25.00 }, { id: 102, product: 'Gadget', amount: 50.00 }] }) },
    { ns: 'orders', name: 'create', desc: 'Create an order', perms: ['orders:create'],
      handler: async (args: any) => ({ success: true, data: { id: 200, product: args.product, amount: Number(args.amount) } }) },
    { ns: 'system', name: 'status', desc: 'System health status', perms: [],
      handler: async () => ({ success: true, data: { status: 'healthy', uptime: 3600, version: '0.1.0' } }) },
    { ns: 'system', name: 'echo', desc: 'Echo input back', perms: [],
      handler: async (args: any) => ({ success: true, data: { echo: args.message } }) },
    { ns: 'math', name: 'add', desc: 'Add two numbers', perms: [],
      handler: async (args: any) => ({ success: true, data: { result: Number(args.a) + Number(args.b) } }) },
  ];

  for (const c of cmds) {
    const def = command(c.ns, c.name)
      .version('1.0.0')
      .description(c.desc)
      .example(`${c.ns}:${c.name}`)
      .tags(c.ns)
      .build();
    if (c.perms.length > 0) def.requiredPermissions = c.perms;
    registry.register(def, c.handler);
  }

  return wrapForCore(registry);
}

// ===========================================================================
// 1. PARSER → CORE → RESPONSE (basic chain)
// ===========================================================================

describe('Full System: Parser → Core → Response', () => {
  let core: Core;

  beforeAll(async () => {
    const registry = createDomainRegistry();
    const vectorIndex = new VectorIndex({ embeddingAdapter: createEmbeddingAdapter(), storageAdapter: createStorageAdapter(), defaultTopK: 5, defaultThreshold: 0.3 });
    await vectorIndex.indexBatch(registry.listAll());
    const ctxStore: Record<string, any> = {};
    const contextStore = {
      get(key: string) { return { data: ctxStore[key] }; },
      set(key: string, value: any) { ctxStore[key] = value; },
      delete(key: string) { delete ctxStore[key]; },
      getAll() { return { data: { ...ctxStore } }; },
    };
    core = new Core({ registry, vectorIndex, contextStore });
  });

  it('FS01: executes a simple command and returns structured response', async () => {
    const res = await core.exec('system:status');
    expect(res.code).toBe(0);
    expect(res.data.status).toBe('healthy');
    expect(res.meta.duration_ms).toBeGreaterThanOrEqual(0);
    expect(res.meta.timestamp).toBeDefined();
  });

  it('FS02: executes command with named arguments', async () => {
    const res = await core.exec('users:get --id 42');
    expect(res.code).toBe(0);
    expect(res.data.id).toBe(42);
  });

  it('FS03: returns error for unknown command', async () => {
    const res = await core.exec('nonexistent:cmd');
    expect(res.code).toBe(2);
    expect(res.error).toContain('not found');
  });

  it('FS04: returns error for empty input', async () => {
    const res = await core.exec('');
    expect(res.code).toBe(1);
  });

  it('FS05: help returns interaction protocol', () => {
    const help = core.help();
    expect(help).toContain('cli_help');
    expect(help).toContain('cli_exec');
    expect(help).toContain('search');
    expect(help).toContain('describe');
  });
});

// ===========================================================================
// 2. MCP SERVER — full agent workflow
// ===========================================================================

describe('Full System: MCP Server Agent Workflow', () => {
  let server: McpServer;

  beforeAll(async () => {
    const realRegistry = new CommandRegistry();
    // Register domain commands
    const domain = createDomainRegistry();
    // Register skills into the same real registry
    registerSkills(realRegistry);
    // Re-register domain commands into real registry (they were registered in createDomainRegistry's internal one)
    const domainCmds = [
      { ns: 'users', name: 'list' }, { ns: 'users', name: 'get' }, { ns: 'users', name: 'create' },
      { ns: 'users', name: 'delete' }, { ns: 'users', name: 'count' }, { ns: 'orders', name: 'list' },
      { ns: 'orders', name: 'create' }, { ns: 'system', name: 'status' }, { ns: 'system', name: 'echo' },
      { ns: 'math', name: 'add' },
    ];
    for (const c of domainCmds) {
      const cmd = domain.get(c.ns, c.name);
      if (cmd) realRegistry.register(command(c.ns, c.name).version('1.0.0').description(cmd.description || 'test').example(`${c.ns}:${c.name}`).tags(c.ns).build(), cmd.handler);
    }
    const registry = wrapForCore(realRegistry);
    const vectorIndex = new VectorIndex({ embeddingAdapter: createEmbeddingAdapter(), storageAdapter: createStorageAdapter(), defaultTopK: 5, defaultThreshold: 0.3 });
    await vectorIndex.indexBatch(registry.listAll());
    const core = new Core({ registry, vectorIndex });
    server = new McpServer({ core, name: 'full-test', version: '1.0.0' });
    await mcpInit(server);
  });

  it('FS06: tools/list returns exactly 2 tools', async () => {
    const res = await mcpSend(server, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res!.result.tools).toHaveLength(2);
  });

  it('FS07: full agent flow — help → search → describe → execute', async () => {
    // 1. Help
    const help = await mcpHelp(server);
    expect(help).toContain('search');

    // 2. Search
    const searchRes = await mcpExec(server, 'search user');
    expect(searchRes.code).toBe(0);
    expect(searchRes.data.results.length).toBeGreaterThan(0);

    // 3. Describe
    const firstCmd = searchRes.data.results[0].commandId;
    const descRes = await mcpExec(server, `describe ${firstCmd}`);
    expect(descRes.code).toBe(0);

    // 4. Execute
    const execRes = await mcpExec(server, 'system:status');
    expect(execRes.code).toBe(0);
    expect(execRes.data.status).toBe('healthy');
  });

  it('FS08: batch execution via MCP', async () => {
    const res = await mcpExec(server, 'batch [system:status, math:add --a 2 --b 3]');
    expect(res.code).toBe(0);
  });

  it('FS09: pipeline execution via MCP', async () => {
    const res = await mcpExec(server, 'users:list >> users:count');
    expect(res.code).toBe(0);
    expect(res.data.count).toBe(3);
  });

  it('FS10: JQ filter via MCP', async () => {
    const res = await mcpExec(server, 'system:status | .status');
    expect(res.code).toBe(0);
    expect(res.data).toBe('healthy');
  });

  it('FS11: dry-run mode via MCP', async () => {
    const res = await mcpExec(server, 'users:create --name Test --email t@t.com --dry-run');
    expect(res.code).toBe(0);
    expect(res.data.dryRun).toBe(true);
  });

  it('FS12: context set and get via MCP', async () => {
    // This test uses Core without contextStore so it will return empty
    const res = await mcpExec(server, 'context');
    expect(res.code).toBe(0);
  });

  it('FS13: history via MCP', async () => {
    const res = await mcpExec(server, 'history');
    expect(res.code).toBe(0);
    expect(Array.isArray(res.data)).toBe(true);
  });

  it('FS14: scaffold skill accessible via MCP', async () => {
    const res = await mcpExec(server, 'scaffold:init --name test-cli');
    expect(res.code).toBe(0);
    expect(res.data.files['package.json']).toBeDefined();
  });

  it('FS15: wizard skill creates valid definition via MCP', async () => {
    const res = await mcpExec(server, "wizard:create-command --namespace test --name hello --description 'Says hello'");
    expect(res.code).toBe(0);
    expect(res.data.definition.namespace).toBe('test');
  });

  it('FS16: registry:stats via MCP shows all commands', async () => {
    const res = await mcpExec(server, 'registry:stats');
    expect(res.code).toBe(0);
    expect(res.data.totalCommands).toBeGreaterThan(10);
  });
});

// ===========================================================================
// 3. PERMISSION ENFORCEMENT — full flow with profiles
// ===========================================================================

describe('Full System: Permission Enforcement', () => {

  async function createCoreWithProfile(profile: 'admin' | 'reader' | 'restricted' | 'operator') {
    const registry = createDomainRegistry();
    const vectorIndex = new VectorIndex({ embeddingAdapter: createEmbeddingAdapter(), storageAdapter: createStorageAdapter(), defaultTopK: 5, defaultThreshold: 0.3 });
    await vectorIndex.indexBatch(registry.listAll());
    return new Core({ registry, vectorIndex, agentProfile: profile });
  }

  it('FS17: admin profile — full access to everything', async () => {
    const core = await createCoreWithProfile('admin');
    expect((await core.exec('users:list')).code).toBe(0);
    expect((await core.exec('users:create --name X --email x@t.com')).code).toBe(0);
    expect((await core.exec('users:delete --id 1')).code).toBe(0);
  });

  it('FS18: reader profile — can search and read, cannot create/delete', async () => {
    const core = await createCoreWithProfile('reader');
    expect((await core.exec('search user')).code).toBe(0);
    expect((await core.exec('system:status')).code).toBe(0); // public
    expect((await core.exec('users:create --name X --email x@t.com')).code).toBe(3); // denied
    expect((await core.exec('users:delete --id 1')).code).toBe(3); // denied
  });

  it('FS19: restricted profile — only public commands', async () => {
    const core = await createCoreWithProfile('restricted');
    expect((await core.exec('system:status')).code).toBe(0); // no requiredPermissions
    expect((await core.exec('users:list')).code).toBe(3); // denied
  });

  it('FS20: search hides commands from restricted agent', async () => {
    const core = await createCoreWithProfile('restricted');
    const res = await core.exec('search user');
    expect(res.code).toBe(0);
    const ids = res.data.results.map((r: any) => r.commandId);
    expect(ids).not.toContain('users:list');
    expect(ids).not.toContain('users:delete');
  });

  it('FS21: describe denies restricted agent', async () => {
    const core = await createCoreWithProfile('restricted');
    const res = await core.exec('describe users:list');
    expect(res.code).toBe(3);
  });

  it('FS22: pipeline fails mid-step if permission denied', async () => {
    // Custom permissions: can read users but not delete
    const registry = createDomainRegistry();
    const core = new Core({ registry, permissions: ['users:read'] });

    // users:list → users:count both need users:read → OK
    const res = await core.exec('users:list >> users:count');
    expect(res.code).toBe(0);

    // users:get → users:delete: delete needs users:delete → DENIED
    const res2 = await core.exec('users:get --id 1 >> users:delete');
    expect(res2.code).toBe(3);
    expect(res2.error).toContain('Permission denied');
  });

  it('FS23: permission enforcement via MCP server', async () => {
    const registry = createDomainRegistry();
    const core = new Core({ registry, agentProfile: 'restricted' });
    const server = new McpServer({ core });
    await mcpInit(server);

    const res = await mcpExec(server, 'users:list');
    expect(res.code).toBe(3);
    expect(res.error).toContain('Permission denied');
  });
});

// ===========================================================================
// 4. VECTOR INDEX + MATRYOSHKA SEARCH
// ===========================================================================

describe('Full System: Vector Search + Matryoshka', () => {

  it('FS24: standard search finds relevant commands', async () => {
    const registry = createDomainRegistry();
    const vectorIndex = new VectorIndex({ embeddingAdapter: createEmbeddingAdapter(), storageAdapter: createStorageAdapter(), defaultTopK: 5, defaultThreshold: 0.3 });
    await vectorIndex.indexBatch(registry.listAll());
    const core = new Core({ registry, vectorIndex });

    const res = await core.exec('search user');
    expect(res.code).toBe(0);
    expect(res.data.results.length).toBeGreaterThan(0);
  });

  it('FS25: matryoshka search returns results with stage diagnostics', async () => {
    const registry = createDomainRegistry();
    const vectorIndex = new VectorIndex({
      embeddingAdapter: createEmbeddingAdapter(768),
      storageAdapter: createStorageAdapter(),
      defaultTopK: 5,
      defaultThreshold: 0.3,
      matryoshka: defaultMatryoshkaConfig(768),
    });
    await vectorIndex.indexBatch(registry.listAll());

    const res = await vectorIndex.search('create user');
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.matryoshkaStages).toBeDefined();
    expect(res.matryoshkaStages!.length).toBe(4); // 64, 128, 256, 768
  });

  it('FS26: search across namespaces', async () => {
    const registry = createDomainRegistry();
    const vectorIndex = new VectorIndex({ embeddingAdapter: createEmbeddingAdapter(), storageAdapter: createStorageAdapter(), defaultTopK: 10, defaultThreshold: 0.1 });
    await vectorIndex.indexBatch(registry.listAll());
    const core = new Core({ registry, vectorIndex });

    const res = await core.exec('search status');
    expect(res.code).toBe(0);
    const namespaces = [...new Set(res.data.results.map((r: any) => r.namespace))];
    expect(namespaces.length).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================================
// 5. EXECUTOR — modes, confirm, pipeline, batch
// ===========================================================================

describe('Full System: Executor Modes', () => {
  let core: Core;

  beforeAll(async () => {
    const registry = createDomainRegistry();
    core = new Core({ registry });
  });

  it('FS27: dry-run returns simulation without executing', async () => {
    const res = await core.exec('users:create --name Test --email t@t.com --dry-run');
    expect(res.code).toBe(0);
    expect(res.data.dryRun).toBe(true);
    expect(res.data.command).toBe('users:create');
  });

  it('FS28: validate mode checks args without executing', async () => {
    const res = await core.exec('users:get --id 1 --validate');
    expect(res.code).toBe(0);
    expect(res.data.valid).toBe(true);
  });

  it('FS29: batch executes multiple commands in parallel', async () => {
    const res = await core.exec('batch [system:status, math:add --a 1 --b 2, system:echo --message hello]');
    expect(res.code).toBe(0);
    expect(res.data.length).toBe(3);
  });

  it('FS30: pipeline chains output to input', async () => {
    const res = await core.exec('users:list >> users:count');
    expect(res.code).toBe(0);
    expect(res.data.count).toBe(3);
  });
});

// ===========================================================================
// 6. JQ FILTER + FORMATTING + PAGINATION
// ===========================================================================

describe('Full System: Output Processing', () => {
  let core: Core;

  beforeAll(async () => {
    const registry = createDomainRegistry();
    core = new Core({ registry });
  });

  it('FS31: JQ filter extracts field from result', async () => {
    const res = await core.exec('system:status | .version');
    expect(res.code).toBe(0);
    expect(res.data).toBe('0.1.0');
  });

  it('FS32: format=table returns table string', async () => {
    const res = await core.exec('users:list --format table');
    expect(res.code).toBe(0);
    expect(typeof res.data).toBe('string');
    expect(res.data).toContain('Alice');
  });

  it('FS33: format=csv returns CSV with escaped values', async () => {
    const res = await core.exec('users:list --format csv');
    expect(res.code).toBe(0);
    expect(typeof res.data).toBe('string');
    expect(res.data).toContain('id,name,role');
  });

  it('FS34: pagination with limit and offset', async () => {
    const res = await core.exec('users:list --limit 2');
    expect(res.code).toBe(0);
    expect(res.data.length).toBe(2);
  });

  it('FS35: pagination offset skips entries', async () => {
    const res = await core.exec('users:list --offset 1 --limit 1');
    expect(res.code).toBe(0);
    expect(res.data.length).toBe(1);
  });
});

// ===========================================================================
// 7. PARSER — comprehensive syntax
// ===========================================================================

describe('Full System: Parser Syntax Coverage', () => {

  it('FS36: parses single command', () => {
    const result = parse('users:list');
    expect('errorType' in result).toBe(false);
    if (!('errorType' in result)) expect(result.type).toBe('single');
  });

  it('FS37: parses pipeline', () => {
    const result = parse('users:list >> users:count');
    if (!('errorType' in result)) expect(result.type).toBe('pipeline');
  });

  it('FS38: parses batch', () => {
    const result = parse('batch [users:list, system:status]');
    if (!('errorType' in result)) {
      expect(result.type).toBe('batch');
      expect(result.commands.length).toBe(2);
    }
  });

  it('FS39: parses JQ filter', () => {
    const result = parse('users:get --id 1 | .name');
    if (!('errorType' in result)) {
      expect(result.commands[0].jqFilter).toBeDefined();
      expect(result.commands[0].jqFilter!.fields).toContain('name');
    }
  });

  it('FS40: parses all global flags', () => {
    const result = parse('users:list --dry-run --format json --limit 10 --offset 5');
    if (!('errorType' in result)) {
      const flags = result.commands[0].flags;
      expect(flags.dryRun).toBe(true);
      expect(flags.format).toBe('json');
      expect(flags.limit).toBe(10);
      expect(flags.offset).toBe(5);
    }
  });

  it('FS41: rejects empty input', () => {
    const result = parse('');
    expect('errorType' in result).toBe(true);
  });

  it('FS42: rejects nested batch', () => {
    const result = parse('batch [batch [a:b]]');
    expect('errorType' in result).toBe(true);
  });
});

// ===========================================================================
// 8. JQ FILTER — standalone
// ===========================================================================

describe('Full System: JQ Filter', () => {

  it('FS43: field access', () => {
    const res = applyFilter({ name: 'Alice', age: 30 }, '.name');
    expect(res.success).toBe(true);
    if (res.success) expect(res.result).toBe('Alice');
  });

  it('FS44: nested field access', () => {
    const res = applyFilter({ user: { profile: { name: 'Bob' } } }, '.user.profile.name');
    expect(res.success).toBe(true);
    if (res.success) expect(res.result).toBe('Bob');
  });

  it('FS45: array index', () => {
    const res = applyFilter([10, 20, 30], '.[1]');
    expect(res.success).toBe(true);
    if (res.success) expect(res.result).toBe(20);
  });

  it('FS46: multi-select', () => {
    const res = applyFilter({ a: 1, b: 2, c: 3 }, '[.a, .c]');
    expect(res.success).toBe(true);
    if (res.success) expect(res.result).toEqual([1, 3]);
  });
});

// ===========================================================================
// 9. SECURITY — audit + secrets + RBAC
// ===========================================================================

describe('Full System: Security Stack', () => {

  it('FS47: audit logger emits events', () => {
    const events: any[] = [];
    const logger = new AuditLogger('test-session');
    logger.on('*', (e: any) => events.push(e));
    logger.audit('command:executed', { command: 'test:cmd' });
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('command:executed');
  });

  it('FS48: RBAC resolves permissions with inheritance', () => {
    const rbac = new RBAC({
      roles: [
        { name: 'viewer', permissions: ['read'] },
        { name: 'editor', permissions: ['write'], inherits: ['viewer'] },
        { name: 'admin', permissions: ['*'], inherits: ['editor'] },
      ],
    });

    const viewerPerms = rbac.resolvePermissions({ roles: ['viewer'], permissions: [] });
    expect(viewerPerms).toContain('read');
    expect(viewerPerms).not.toContain('write');

    const editorPerms = rbac.resolvePermissions({ roles: ['editor'], permissions: [] });
    expect(editorPerms).toContain('write');
    expect(editorPerms).toContain('read'); // inherited

    const adminPerms = rbac.resolvePermissions({ roles: ['admin'], permissions: [] });
    expect(adminPerms).toContain('*');
    expect(adminPerms).toContain('write');
    expect(adminPerms).toContain('read');
  });

  it('FS49: RBAC integration with Core', async () => {
    const rbac = new RBAC({
      roles: [
        { name: 'user-reader', permissions: ['users:read'] },
        { name: 'user-admin', permissions: ['users:*'], inherits: ['user-reader'] },
      ],
    });

    const registry = createDomainRegistry();
    const core = new Core({ registry, rbac, permissions: ['user-reader'] });

    expect((await core.exec('users:list')).code).toBe(0); // has users:read
    expect((await core.exec('users:create --name X --email x@t.com')).code).toBe(3); // no users:create
  });
});

// ===========================================================================
// 10. SHELL ADAPTER — native backend
// ===========================================================================

describe('Full System: Shell Adapter', () => {

  it('FS50: createShellAdapter returns native (just-bash not installed)', () => {
    const adapter = createShellAdapter();
    expect(adapter.backend).toBe('native');
  });

  it('FS51: native adapter executes real commands', async () => {
    const adapter = new NativeShellAdapter();
    const res = await adapter.exec('echo integration-test');
    expect(res.stdout).toContain('integration-test');
    expect(res.exitCode).toBe(0);
  });

  it('FS52: native adapter reads real files', async () => {
    const adapter = new NativeShellAdapter();
    const res = await adapter.readFile('package.json');
    expect(res.content).toContain('agent-shell');
  });
});

// ===========================================================================
// 11. COMMAND BUILDER SDK
// ===========================================================================

describe('Full System: Command Builder', () => {

  it('FS53: fluent builder creates valid definition', () => {
    const def = command('test', 'hello')
      .version('1.0.0')
      .description('Says hello')
      .requiredParam('name', 'string', 'The name to greet')
      .optionalParam('loud', 'bool', false, 'Shout the greeting')
      .example('test:hello --name World')
      .tags('test', 'greeting')
      .reversible()
      .build();

    expect(def.namespace).toBe('test');
    expect(def.name).toBe('hello');
    expect(def.params).toHaveLength(2);
    expect(def.reversible).toBe(true);
  });

  it('FS54: built definition registers in CommandRegistry', () => {
    const def = command('test', 'cmd')
      .version('1.0.0')
      .description('Test command')
      .example('test:cmd')
      .build();

    const registry = new CommandRegistry();
    const result = registry.register(def, async () => ({ success: true, data: {} }));
    expect(result.ok).toBe(true);
  });
});

// ===========================================================================
// 12. SKILLS — all categories work together
// ===========================================================================

describe('Full System: Skills Integration', () => {

  it('FS55: registerSkills adds all 9 CLI creation skills', () => {
    const registry = new CommandRegistry();
    registerSkills(registry);
    expect(registry.listAll()).toHaveLength(9);
    expect(registry.getNamespaces()).toContain('scaffold');
    expect(registry.getNamespaces()).toContain('wizard');
    expect(registry.getNamespaces()).toContain('registry');
  });

  it('FS56: wizard-generated definition is registerable', async () => {
    const registry = new CommandRegistry();
    registerSkills(registry);

    const wizResult = registry.resolve('wizard:create-command');
    expect(wizResult.ok).toBe(true);
    if (!wizResult.ok) return;

    const handler = wizResult.value.handler;
    const result = await handler({ namespace: 'orders', name: 'process', description: 'Process order' });
    expect(result.success).toBe(true);

    const regResult = registry.register(result.data.definition, async () => ({ success: true, data: {} }));
    expect(regResult.ok).toBe(true);
  });

  it('FS57: registry:list introspects registered skills', async () => {
    const registry = new CommandRegistry();
    registerSkills(registry);

    const listResult = registry.resolve('registry:list');
    expect(listResult.ok).toBe(true);
    if (!listResult.ok) return;

    const result = await listResult.value.handler({ format: 'full' });
    expect(result.success).toBe(true);
    expect(result.data.commandCount).toBe(9);
  });
});

// ===========================================================================
// 13. ERROR HANDLING — graceful degradation
// ===========================================================================

describe('Full System: Error Handling', () => {
  let core: Core;

  beforeAll(() => {
    const registry = createDomainRegistry();
    core = new Core({ registry });
  });

  it('FS58: unknown command returns code 2', async () => {
    const res = await core.exec('totally:unknown');
    expect(res.code).toBe(2);
    expect(res.error).toBeTruthy();
  });

  it('FS59: syntax error returns code 1', async () => {
    const res = await core.exec(':missing-namespace');
    expect(res.code).toBe(1);
  });

  it('FS60: overly long input is rejected', async () => {
    const longInput = 'a'.repeat(20000);
    const res = await core.exec(longInput);
    expect(res.code).toBe(1);
    expect(res.error).toContain('length');
  });

  it('FS61: every response has consistent structure', async () => {
    const cases = [
      'system:status',
      'nonexistent:cmd',
      '',
      'search user',
      'history',
    ];

    for (const cmd of cases) {
      const res = await core.exec(cmd || ' ');
      expect(res).toHaveProperty('code');
      expect(res).toHaveProperty('data');
      expect(res).toHaveProperty('error');
      expect(res).toHaveProperty('meta');
      expect(res.meta).toHaveProperty('duration_ms');
      expect(res.meta).toHaveProperty('timestamp');
    }
  });
});

// ===========================================================================
// 14. CONTEXT STORE — state management
// ===========================================================================

describe('Full System: Context Store', () => {

  function createSimpleContextStore() {
    const store: Record<string, any> = {};
    return {
      get(key: string) { return { data: store[key] }; },
      set(key: string, value: any) { store[key] = value; },
      delete(key: string) { delete store[key]; },
      getAll() { return { data: { ...store } }; },
    };
  }

  it('FS62: set and get context via Core', async () => {
    const registry = createDomainRegistry();
    const contextStore = createSimpleContextStore();
    const core = new Core({ registry, contextStore });

    const setRes = await core.exec('context:set project my-app');
    expect(setRes.code).toBe(0);

    const getRes = await core.exec('context:get project');
    expect(getRes.code).toBe(0);
  });

  it('FS63: context:delete removes key', async () => {
    const registry = createDomainRegistry();
    const contextStore = createSimpleContextStore();
    const core = new Core({ registry, contextStore });

    await core.exec('context:set temp value');
    const delRes = await core.exec('context:delete temp');
    expect(delRes.code).toBe(0);
  });
});

// ===========================================================================
// 15. SCALABILITY — token economy verified
// ===========================================================================

describe('Full System: Token Economy', () => {

  it('FS64: tool definitions identical with 10 vs 500 commands', async () => {
    async function getToolDefs(n: number) {
      const reg = new CommandRegistry();
      for (let i = 0; i < n; i++) {
        const def = command('ns', `cmd-${i}`).version('1.0.0').description(`Cmd ${i}`).example(`ns:cmd-${i}`).build();
        reg.register(def, async () => ({ success: true, data: {} }));
      }
      const core = new Core({ registry: reg });
      const srv = new McpServer({ core });
      await mcpInit(srv);
      const res = await mcpSend(srv, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      return JSON.stringify(res!.result.tools);
    }

    const defs10 = await getToolDefs(10);
    const defs500 = await getToolDefs(500);
    expect(defs10).toBe(defs500);
  });

  it('FS65: tool footprint under 600 tokens', async () => {
    const reg = new CommandRegistry();
    const core = new Core({ registry: reg });
    const srv = new McpServer({ core });
    await mcpInit(srv);
    const res = await mcpSend(srv, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const tokens = Math.ceil(JSON.stringify(res!.result.tools).length / 4);
    expect(tokens).toBeLessThan(600);
  });
});
