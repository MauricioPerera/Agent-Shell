/**
 * Tests for CLI creation skills.
 *
 * Validates scaffold (project generation), wizard (command creation),
 * and registry admin (runtime introspection) skills.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CommandRegistry } from '../src/command-registry/index.js';
import { scaffoldCommands } from '../src/skills/scaffold.js';
import { wizardCommands } from '../src/skills/wizard.js';
import { registryAdminCommands } from '../src/skills/registry-admin.js';
import { registerSkills } from '../src/skills/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findHandler(entries: any[], namespace: string, name: string): Function {
  const entry = entries.find((e: any) => e.definition.namespace === namespace && e.definition.name === name);
  if (!entry) throw new Error(`Handler not found: ${namespace}:${name}`);
  return entry.handler;
}

// ===========================================================================
// Scaffold Skills
// ===========================================================================

describe('Scaffold Skills', () => {

  it('SC01: scaffold:init generates 4 project files', async () => {
    const handler = findHandler(scaffoldCommands, 'scaffold', 'init');
    const result = await handler({ name: 'my-cli', description: 'Test CLI', author: 'Test' });

    expect(result.success).toBe(true);
    const files = Object.keys(result.data.files);
    expect(files).toHaveLength(4);
    expect(files).toContain('package.json');
    expect(files).toContain('tsconfig.json');
    expect(files).toContain('src/index.ts');
    expect(files).toContain('src/commands/index.ts');
  });

  it('SC02: generated package.json contains project name and agent-shell dep', async () => {
    const handler = findHandler(scaffoldCommands, 'scaffold', 'init');
    const result = await handler({ name: 'my-cli', description: 'Cool CLI' });

    const pkg = JSON.parse(result.data.files['package.json']);
    expect(pkg.name).toBe('my-cli');
    expect(pkg.description).toBe('Cool CLI');
    expect(pkg.dependencies['agent-shell']).toBeDefined();
    expect(pkg.type).toBe('module');
  });

  it('SC03: generated src/index.ts imports from agent-shell', async () => {
    const handler = findHandler(scaffoldCommands, 'scaffold', 'init');
    const result = await handler({ name: 'test-app' });

    const entryPoint = result.data.files['src/index.ts'];
    expect(entryPoint).toContain("from 'agent-shell'");
    expect(entryPoint).toContain('CommandRegistry');
    expect(entryPoint).toContain('Core');
    expect(entryPoint).toContain('McpServer');
  });

  it('SC04: scaffold:init rejects invalid project name', async () => {
    const handler = findHandler(scaffoldCommands, 'scaffold', 'init');
    const result = await handler({ name: 'Invalid-Name' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid project name');
  });

  it('SC05: scaffold:add-namespace generates barrel file', async () => {
    const handler = findHandler(scaffoldCommands, 'scaffold', 'add-namespace');
    const result = await handler({ namespace: 'users', description: 'User management' });

    expect(result.success).toBe(true);
    expect(result.data.files['src/commands/users/index.ts']).toBeDefined();
    expect(result.data.files['src/commands/users/index.ts']).toContain('users');
  });

  it('SC06: scaffold:add-namespace rejects invalid namespace', async () => {
    const handler = findHandler(scaffoldCommands, 'scaffold', 'add-namespace');
    const result = await handler({ namespace: 'INVALID' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid namespace');
  });

  it('SC07: scaffold:add-command generates command file with builder', async () => {
    const handler = findHandler(scaffoldCommands, 'scaffold', 'add-command');
    const result = await handler({ namespace: 'users', name: 'create', description: 'Creates a user' });

    expect(result.success).toBe(true);
    const file = result.data.files['src/commands/users/create.ts'];
    expect(file).toContain("command('users', 'create')");
    expect(file).toContain('Creates a user');
    expect(file).toContain('handler');
  });

  it('SC08: scaffold:add-command includes params in generated code', async () => {
    const handler = findHandler(scaffoldCommands, 'scaffold', 'add-command');
    const result = await handler({
      namespace: 'users', name: 'create', description: 'Creates a user',
      params: [{ name: 'email', type: 'string', required: true }],
    });

    const file = result.data.files['src/commands/users/create.ts'];
    expect(file).toContain("'email'");
    expect(file).toContain("'string'");
    expect(file).toContain('.required()');
  });

  it('SC09: scaffold:add-command rejects invalid command name', async () => {
    const handler = findHandler(scaffoldCommands, 'scaffold', 'add-command');
    const result = await handler({ namespace: 'users', name: '123bad' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid command name');
  });

  it('SC10: scaffold:add-command parses JSON string params', async () => {
    const handler = findHandler(scaffoldCommands, 'scaffold', 'add-command');
    const result = await handler({
      namespace: 'users', name: 'create', description: 'Test',
      params: '[{"name":"id","type":"int"}]',
    });

    expect(result.success).toBe(true);
    const file = result.data.files['src/commands/users/create.ts'];
    expect(file).toContain("'id'");
    expect(file).toContain("'int'");
  });
});

// ===========================================================================
// Wizard Skills
// ===========================================================================

describe('Wizard Skills', () => {

  it('WZ01: wizard:create-command returns valid CommandDefinition', async () => {
    const handler = findHandler(wizardCommands, 'wizard', 'create-command');
    const result = await handler({
      namespace: 'users', name: 'create', description: 'Creates a user',
      params: [{ name: 'email', type: 'string', required: true }],
    });

    expect(result.success).toBe(true);
    const def = result.data.definition;
    expect(def.namespace).toBe('users');
    expect(def.name).toBe('create');
    expect(def.description).toBe('Creates a user');
    expect(def.version).toBe('1.0.0');
    expect(def.params).toHaveLength(1);
    expect(def.params[0].name).toBe('email');
    expect(def.example).toBeDefined();
  });

  it('WZ02: wizard:create-command validates param types', async () => {
    const handler = findHandler(wizardCommands, 'wizard', 'create-command');
    const result = await handler({
      namespace: 'users', name: 'create', description: 'Test',
      params: [{ name: 'x', type: 'invalid-type' }],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown param type');
  });

  it('WZ03: wizard:create-command accepts valid param types', async () => {
    const handler = findHandler(wizardCommands, 'wizard', 'create-command');

    for (const type of ['int', 'float', 'string', 'bool', 'date', 'json', 'enum(a,b)', 'array<string>']) {
      const result = await handler({
        namespace: 'test', name: 'cmd', description: 'Test',
        params: [{ name: 'p', type }],
      });
      expect(result.success).toBe(true);
    }
  });

  it('WZ04: wizard:create-command auto-generates example', async () => {
    const handler = findHandler(wizardCommands, 'wizard', 'create-command');
    const result = await handler({
      namespace: 'users', name: 'create', description: 'Test',
      params: [{ name: 'name', type: 'string' }],
    });

    expect(result.data.definition.example).toContain('users:create');
    expect(result.data.definition.example).toContain('--name');
  });

  it('WZ05: wizard:create-command rejects invalid namespace', async () => {
    const handler = findHandler(wizardCommands, 'wizard', 'create-command');
    const result = await handler({ namespace: 'BAD', name: 'create', description: 'Test' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid namespace');
  });

  it('WZ06: wizard:create-command includes handler skeleton', async () => {
    const handler = findHandler(wizardCommands, 'wizard', 'create-command');
    const result = await handler({ namespace: 'users', name: 'create', description: 'Test' });

    expect(result.data.handlerSkeleton).toContain('async function handler');
    expect(result.data.handlerSkeleton).toContain('users:create');
    expect(result.data.registrationCode).toContain('registry.register');
  });

  it('WZ07: wizard:create-namespace returns N definitions', async () => {
    const handler = findHandler(wizardCommands, 'wizard', 'create-namespace');
    const result = await handler({
      namespace: 'users',
      commands: [
        { name: 'create', description: 'Creates a user' },
        { name: 'list', description: 'Lists users' },
        { name: 'delete', description: 'Deletes a user' },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.data.definitions).toHaveLength(3);
    expect(result.data.commandCount).toBe(3);
    expect(result.data.handlerSkeletons).toHaveProperty('create');
    expect(result.data.handlerSkeletons).toHaveProperty('list');
    expect(result.data.handlerSkeletons).toHaveProperty('delete');
  });

  it('WZ08: wizard:create-namespace validates each command', async () => {
    const handler = findHandler(wizardCommands, 'wizard', 'create-namespace');
    const result = await handler({
      namespace: 'users',
      commands: [
        { name: 'create', description: 'OK' },
        { name: 'BAD-NAME', description: 'Invalid' },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid command name');
  });
});

// ===========================================================================
// Registry Admin Skills
// ===========================================================================

describe('Registry Admin Skills', () => {
  let registry: CommandRegistry;
  let adminEntries: ReturnType<typeof registryAdminCommands>;

  beforeEach(() => {
    registry = new CommandRegistry();

    // Register some sample commands
    for (const { definition, handler } of scaffoldCommands) {
      registry.register(definition, handler);
    }
    for (const { definition, handler } of wizardCommands) {
      registry.register(definition, handler);
    }

    adminEntries = registryAdminCommands(registry);
    for (const { definition, handler } of adminEntries) {
      registry.register(definition, handler);
    }
  });

  it('RA01: registry:list returns all commands', async () => {
    const handler = findHandler(adminEntries, 'registry', 'list');
    const result = await handler({ format: 'full' });

    expect(result.success).toBe(true);
    expect(result.data.commandCount).toBe(9); // 3 scaffold + 2 wizard + 4 registry
    expect(result.data.namespaces).toContain('scaffold');
    expect(result.data.namespaces).toContain('wizard');
    expect(result.data.namespaces).toContain('registry');
  });

  it('RA02: registry:list filters by namespace', async () => {
    const handler = findHandler(adminEntries, 'registry', 'list');
    const result = await handler({ namespace: 'scaffold', format: 'full' });

    expect(result.success).toBe(true);
    expect(result.data.commandCount).toBe(3);
    for (const def of result.data.commands) {
      expect(def.namespace).toBe('scaffold');
    }
  });

  it('RA03: registry:list compact format returns text', async () => {
    const handler = findHandler(adminEntries, 'registry', 'list');
    const result = await handler({ format: 'compact' });

    expect(result.success).toBe(true);
    expect(typeof result.data.commands).toBe('string');
    expect(result.data.commands).toContain('scaffold:init');
  });

  it('RA04: registry:describe returns definition + compact text', async () => {
    const handler = findHandler(adminEntries, 'registry', 'describe');
    const result = await handler({ command: 'scaffold:init' });

    expect(result.success).toBe(true);
    expect(result.data.definition.namespace).toBe('scaffold');
    expect(result.data.definition.name).toBe('init');
    expect(typeof result.data.compact).toBe('string');
    expect(result.data.compact).toContain('scaffold:init');
  });

  it('RA05: registry:describe returns error for unknown command', async () => {
    const handler = findHandler(adminEntries, 'registry', 'describe');
    const result = await handler({ command: 'nonexistent:cmd' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('RA06: registry:stats returns correct counts', async () => {
    const handler = findHandler(adminEntries, 'registry', 'stats');
    const result = await handler({});

    expect(result.success).toBe(true);
    expect(result.data.totalCommands).toBe(9);
    expect(result.data.totalNamespaces).toBe(3);
    expect(result.data.namespaces.scaffold).toBe(3);
    expect(result.data.namespaces.wizard).toBe(2);
    expect(result.data.namespaces.registry).toBe(4);
    expect(result.data.tagsUsed.length).toBeGreaterThan(0);
  });

  it('RA07: registry:export returns all definitions as JSON', async () => {
    const handler = findHandler(adminEntries, 'registry', 'export');
    const result = await handler({});

    expect(result.success).toBe(true);
    expect(result.data.count).toBe(9);
    expect(result.data.definitions).toHaveLength(9);
    expect(result.data.exportedAt).toBeDefined();
  });

  it('RA08: registry:export filters by namespace', async () => {
    const handler = findHandler(adminEntries, 'registry', 'export');
    const result = await handler({ namespace: 'wizard' });

    expect(result.success).toBe(true);
    expect(result.data.count).toBe(2);
    for (const def of result.data.definitions) {
      expect(def.namespace).toBe('wizard');
    }
  });
});

// ===========================================================================
// Integration
// ===========================================================================

describe('Skills Integration', () => {

  it('INT01: registerSkills registers all 9 commands', () => {
    const registry = new CommandRegistry();
    registerSkills(registry);

    const all = registry.listAll();
    expect(all).toHaveLength(9);
  });

  it('INT02: all skill definitions pass registry validation', () => {
    const registry = new CommandRegistry();
    registerSkills(registry);

    const namespaces = registry.getNamespaces();
    expect(namespaces).toContain('scaffold');
    expect(namespaces).toContain('wizard');
    expect(namespaces).toContain('registry');
  });

  it('INT03: registry admin can introspect the skills themselves', async () => {
    const registry = new CommandRegistry();
    registerSkills(registry);

    const adminEntries = registryAdminCommands(registry);
    const statsHandler = findHandler(adminEntries, 'registry', 'stats');
    const result = await statsHandler({});

    expect(result.data.totalCommands).toBe(9);
    expect(result.data.totalNamespaces).toBe(3);
  });

  it('INT04: wizard-generated definitions can be registered', async () => {
    const registry = new CommandRegistry();
    registerSkills(registry);

    // Use wizard to create a new command
    const wizHandler = findHandler(wizardCommands, 'wizard', 'create-command');
    const wizResult = await wizHandler({
      namespace: 'orders', name: 'create', description: 'Creates an order',
      params: [{ name: 'product', type: 'string', required: true }],
    });

    // Register the generated definition
    const def = wizResult.data.definition;
    const dummyHandler = async () => ({ success: true, data: {} });
    const regResult = registry.register(def, dummyHandler);

    expect(regResult.ok).toBe(true);
    expect(registry.listAll()).toHaveLength(10);
  });
});
