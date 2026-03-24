/**
 * @module scalability-promise
 * @description Validates the core promise of Agent Shell:
 *
 *   "Solves the tool scalability problem in AI agents via a 2-tool + vector
 *    discovery pattern: ~600 constant tokens in context, independent of
 *    the number of available commands."
 *
 * These tests prove that:
 *   1. The MCP surface is exactly 2 tools (cli_help, cli_exec) — always.
 *   2. The token footprint of tool definitions is CONSTANT regardless of
 *      how many commands are registered (5, 50, or 500).
 *   3. An LLM agent can discover, describe, and execute any command
 *      using only these 2 tools.
 *   4. Adding commands does NOT change what the LLM sees in its context.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { McpServer } from '../src/mcp/server.js';
import { Core } from '../src/core/index.js';
import type { JsonRpcRequest, JsonRpcResponse } from '../src/mcp/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simulates a JSON-RPC message to the MCP server. */
async function send(server: McpServer, request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  return (server as any).handleMessage(request);
}

/** Sends initialize + returns the server ready to use. */
async function initServer(server: McpServer): Promise<McpServer> {
  await send(server, { jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } });
  return server;
}

/**
 * Rough token estimation for a JSON payload.
 * Uses the common heuristic: ~4 chars per token for English + JSON syntax.
 * This is intentionally conservative — real tokenizers (cl100k_base) produce fewer tokens.
 */
function estimateTokens(obj: any): number {
  const json = JSON.stringify(obj);
  return Math.ceil(json.length / 4);
}

/** Creates a mock registry with N generated commands across multiple namespaces. */
function createScalableRegistry(commandCount: number) {
  const commands = new Map<string, any>();
  const namespaces = ['users', 'orders', 'products', 'invoices', 'reports', 'analytics', 'auth', 'notifications', 'settings', 'workflows'];

  for (let i = 0; i < commandCount; i++) {
    const ns = namespaces[i % namespaces.length];
    const name = `cmd-${i}`;
    const key = `${ns}:${name}`;

    commands.set(key, {
      namespace: ns,
      name,
      version: '1.0.0',
      description: `Command ${i} in ${ns} namespace — performs operation #${i} with various parameters and side effects`,
      params: [
        { name: 'id', type: 'int', required: true },
        { name: 'filter', type: 'string', required: false },
        { name: 'limit', type: 'int', required: false, default: 10 },
      ],
      handler: async (args: any) => ({ success: true, data: { id: args.id, command: key } }),
    });
  }

  return {
    get(namespace: string, name: string) {
      const cmd = commands.get(`${namespace}:${name}`);
      if (!cmd) return { ok: false, error: { code: 'COMMAND_NOT_FOUND', message: 'Not found' } };
      return { ok: true, value: { definition: cmd, handler: cmd.handler, registeredAt: new Date().toISOString() } };
    },
    listAll() {
      return Array.from(commands.values());
    },
  };
}

/** Creates a mock vector index that returns search results from the registry. */
function createMockVectorIndex(registry: ReturnType<typeof createScalableRegistry>) {
  return {
    async search(query: string) {
      const all = registry.listAll();
      const matching = all
        .filter((cmd: any) => cmd.description.toLowerCase().includes(query.toLowerCase()) || cmd.name.includes(query))
        .slice(0, 5)
        .map((cmd: any, idx: number) => ({
          commandId: `${cmd.namespace}:${cmd.name}`,
          score: 0.95 - idx * 0.05,
          command: cmd.name,
          namespace: cmd.namespace,
          description: cmd.description,
          signature: `${cmd.namespace}:${cmd.name} --id: int`,
          example: `${cmd.namespace}:${cmd.name} --id 1`,
        }));
      return { query, results: matching, totalIndexed: all.length, searchTimeMs: 1, model: 'mock' };
    },
  };
}

/** Creates a full stack: registry + vectorIndex + Core + McpServer. */
async function createStack(commandCount: number) {
  const registry = createScalableRegistry(commandCount);
  const vectorIndex = createMockVectorIndex(registry);
  const core = new Core({ registry, vectorIndex });
  const server = new McpServer({ core, name: 'test', version: '1.0.0' });
  await initServer(server);
  return { registry, vectorIndex, core, server };
}

// ===========================================================================
// TEST SUITE
// ===========================================================================

describe('Scalability Promise: 2 tools + ~600 constant tokens', () => {

  // -------------------------------------------------------------------------
  // Claim 1: Exactly 2 tools, always
  // -------------------------------------------------------------------------

  describe('Claim: exactly 2 MCP tools exposed', () => {

    it('S01: tools/list returns exactly cli_help and cli_exec with 5 commands', async () => {
      const { server } = await createStack(5);
      const res = await send(server, { jsonrpc: '2.0', id: 1, method: 'tools/list' });

      const tools = res!.result.tools;
      expect(tools).toHaveLength(2);
      expect(tools.map((t: any) => t.name).sort()).toEqual(['cli_exec', 'cli_help']);
    });

    it('S02: tools/list returns exactly cli_help and cli_exec with 500 commands', async () => {
      const { server } = await createStack(500);
      const res = await send(server, { jsonrpc: '2.0', id: 1, method: 'tools/list' });

      const tools = res!.result.tools;
      expect(tools).toHaveLength(2);
      expect(tools.map((t: any) => t.name).sort()).toEqual(['cli_exec', 'cli_help']);
    });

    it('S03: no registered command leaks into tool definitions', async () => {
      const { server } = await createStack(100);
      const res = await send(server, { jsonrpc: '2.0', id: 1, method: 'tools/list' });

      const toolsJson = JSON.stringify(res!.result.tools);
      // No command names, namespaces, or descriptions should appear in tool definitions
      expect(toolsJson).not.toContain('users:cmd-');
      expect(toolsJson).not.toContain('orders:cmd-');
      expect(toolsJson).not.toContain('operation #');
    });
  });

  // -------------------------------------------------------------------------
  // Claim 2: ~600 constant tokens, independent of command count
  // -------------------------------------------------------------------------

  describe('Claim: ~600 constant tokens regardless of command count', () => {
    let tokensWith5: number;
    let tokensWith50: number;
    let tokensWith500: number;
    let toolDefWith5: string;
    let toolDefWith500: string;

    beforeEach(async () => {
      const stack5 = await createStack(5);
      const stack50 = await createStack(50);
      const stack500 = await createStack(500);

      const res5 = await send(stack5.server, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      const res50 = await send(stack50.server, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      const res500 = await send(stack500.server, { jsonrpc: '2.0', id: 1, method: 'tools/list' });

      tokensWith5 = estimateTokens(res5!.result.tools);
      tokensWith50 = estimateTokens(res50!.result.tools);
      tokensWith500 = estimateTokens(res500!.result.tools);
      toolDefWith5 = JSON.stringify(res5!.result.tools);
      toolDefWith500 = JSON.stringify(res500!.result.tools);
    });

    it('S04: tool definitions are IDENTICAL with 5 vs 500 commands', () => {
      expect(toolDefWith5).toBe(toolDefWith500);
    });

    it('S05: token count is exactly the same with 5, 50, and 500 commands', () => {
      expect(tokensWith5).toBe(tokensWith50);
      expect(tokensWith50).toBe(tokensWith500);
    });

    it('S06: token footprint is under 600 tokens (the ~600 promise)', () => {
      // The 2 tool definitions should be well under 600 tokens
      expect(tokensWith5).toBeLessThan(600);
    });

    it('S07: token footprint stays constant even at 1000 commands', async () => {
      const stack1000 = await createStack(1000);
      const res = await send(stack1000.server, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      const tokensWith1000 = estimateTokens(res!.result.tools);

      expect(tokensWith1000).toBe(tokensWith5);
    });

    it('S08: contrast with naive approach — N tools would cost O(N) tokens', () => {
      // If each of 500 commands were a separate tool, the token cost would be enormous
      // A single tool def is roughly ~50 tokens. 500 tools = ~25,000 tokens.
      // Agent Shell keeps it at ~600 regardless.
      const naiveTokensPer = 50; // conservative estimate per tool
      const naiveTotal500 = 500 * naiveTokensPer;

      expect(tokensWith500).toBeLessThan(naiveTotal500 / 10); // at least 10x better
      expect(tokensWith500).toBeLessThan(600);
    });
  });

  // -------------------------------------------------------------------------
  // Claim 3: cli_help returns the interaction protocol
  // -------------------------------------------------------------------------

  describe('Claim: cli_help returns complete interaction protocol', () => {

    it('S09: cli_help returns protocol with discovery, execution, and composition docs', async () => {
      const { server } = await createStack(10);
      const res = await send(server, {
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'cli_help' },
      });

      const text = res!.result.content[0].text;
      expect(text).toContain('search');
      expect(text).toContain('describe');
      expect(text).toContain('dry-run');
      expect(text).toContain('Pipeline');
      expect(text).toContain('Batch');
      expect(text).toContain('context');
      expect(text).toContain('history');
    });

    it('S10: cli_help protocol is static — same output regardless of commands', async () => {
      const stack5 = await createStack(5);
      const stack500 = await createStack(500);

      const res5 = await send(stack5.server, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cli_help' } });
      const res500 = await send(stack500.server, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cli_help' } });

      expect(res5!.result.content[0].text).toBe(res500!.result.content[0].text);
    });
  });

  // -------------------------------------------------------------------------
  // Claim 4: Full agent workflow via only 2 tools
  // -------------------------------------------------------------------------

  describe('Claim: full agent workflow through cli_help + cli_exec only', () => {

    it('S11: agent flow — help → search → describe → execute', async () => {
      const { server } = await createStack(50);

      // Step 1: Agent calls cli_help to learn the protocol
      const helpRes = await send(server, {
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'cli_help' },
      });
      expect(helpRes!.result.content[0].text).toContain('search');

      // Step 2: Agent discovers commands via search
      const searchRes = await send(server, {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'cli_exec', arguments: { command: 'search cmd-0' } },
      });
      const searchData = JSON.parse(searchRes!.result.content[0].text);
      expect(searchData.code).toBe(0);
      expect(searchData.data.results.length).toBeGreaterThan(0);
      const firstCommand = searchData.data.results[0].commandId;

      // Step 3: Agent describes the found command
      const describeRes = await send(server, {
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'cli_exec', arguments: { command: `describe ${firstCommand}` } },
      });
      const describeData = JSON.parse(describeRes!.result.content[0].text);
      expect(describeData.code).toBe(0);

      // Step 4: Agent executes the command
      const execRes = await send(server, {
        jsonrpc: '2.0', id: 4, method: 'tools/call',
        params: { name: 'cli_exec', arguments: { command: `${firstCommand} --id 42` } },
      });
      const execData = JSON.parse(execRes!.result.content[0].text);
      expect(execData.code).toBe(0);
      expect(execData.data.id).toBe('42');
    });

    it('S12: agent can discover across namespaces without knowing them in advance', async () => {
      const { server } = await createStack(100);

      // Search for commands in "orders" namespace — agent doesn't need to know it exists
      const res = await send(server, {
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'cli_exec', arguments: { command: 'search orders' } },
      });
      const data = JSON.parse(res!.result.content[0].text);
      expect(data.code).toBe(0);
      expect(data.data.results.length).toBeGreaterThan(0);
      expect(data.data.results[0].namespace).toBe('orders');
    });

    it('S13: agent gets structured error for non-existent command (no crash)', async () => {
      const { server } = await createStack(10);

      const res = await send(server, {
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'cli_exec', arguments: { command: 'nonexistent:cmd --id 1' } },
      });
      const data = JSON.parse(res!.result.content[0].text);
      expect(data.code).toBe(2); // command not found
      expect(data.error).toBeTruthy();
    });

    it('S14: all interactions happen through exactly 2 tool names', async () => {
      const { server } = await createStack(50);
      const toolsRes = await send(server, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      const toolNames = toolsRes!.result.tools.map((t: any) => t.name);

      // These are the ONLY tools the agent ever needs
      expect(toolNames).toEqual(['cli_help', 'cli_exec']);

      // And through cli_exec alone, the agent can:
      const ops = [
        'search create user',                     // discover
        'describe users:cmd-0',                    // inspect
        'users:cmd-0 --id 1',                      // execute
        'users:cmd-0 --id 1 --dry-run',            // simulate
        'users:cmd-0 --id 1 --validate',           // validate
        'users:cmd-0 --id 1 | .id',                // filter
        'users:cmd-0 --id 1 --format table',       // format
        'context',                                  // view state
        'history',                                  // view history
      ];

      for (const op of ops) {
        const res = await send(server, {
          jsonrpc: '2.0', id: 99, method: 'tools/call',
          params: { name: 'cli_exec', arguments: { command: op } },
        });
        // Every operation returns a valid response (no crashes)
        expect(res!.result.content).toBeDefined();
        expect(res!.result.content[0].type).toBe('text');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Claim 5: Scales to large command catalogs
  // -------------------------------------------------------------------------

  describe('Claim: scales to large command catalogs', () => {

    it('S15: 1000 commands — tool definitions unchanged, search still works', async () => {
      const { server } = await createStack(1000);

      // Tool surface is still 2 tools
      const toolsRes = await send(server, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      expect(toolsRes!.result.tools).toHaveLength(2);

      // Search finds commands in the large catalog
      const searchRes = await send(server, {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'cli_exec', arguments: { command: 'search analytics' } },
      });
      const data = JSON.parse(searchRes!.result.content[0].text);
      expect(data.code).toBe(0);
      expect(data.data.results.length).toBeGreaterThan(0);
      expect(data.data.totalIndexed).toBe(1000);
    });

    it('S16: execution works identically whether there are 5 or 500 commands', async () => {
      const stack5 = await createStack(5);
      const stack500 = await createStack(500);

      // Execute the same command in both stacks
      const cmd = 'users:cmd-0 --id 42';

      const res5 = await send(stack5.server, {
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'cli_exec', arguments: { command: cmd } },
      });
      const res500 = await send(stack500.server, {
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'cli_exec', arguments: { command: cmd } },
      });

      const data5 = JSON.parse(res5!.result.content[0].text);
      const data500 = JSON.parse(res500!.result.content[0].text);

      expect(data5.code).toBe(data500.code);
      expect(data5.data).toEqual(data500.data);
    });
  });
});
