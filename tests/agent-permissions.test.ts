/**
 * Tests for agent permission enforcement in Core.
 *
 * Validates:
 * - Agent profiles (admin, operator, reader, restricted)
 * - Permission checking in command execution
 * - Permission filtering in discovery (search, describe)
 * - Pipeline permission enforcement
 * - Backward compatibility (no permissions = no restrictions)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Core } from '../src/core/index.js';
import { resolveAgentPermissions, AGENT_PROFILES } from '../src/core/agent-profiles.js';
import type { AgentProfile } from '../src/core/agent-profiles.js';

// ---------------------------------------------------------------------------
// Mock Registry
// ---------------------------------------------------------------------------

function createPermissionRegistry() {
  const commands = new Map<string, any>();

  // Public command (no requiredPermissions)
  commands.set('system:status', {
    namespace: 'system',
    name: 'status',
    description: 'System status',
    params: [],
    handler: async () => ({ success: true, data: { status: 'ok' } }),
  });

  // Read-only command
  commands.set('users:list', {
    namespace: 'users',
    name: 'list',
    description: 'List all users',
    params: [],
    requiredPermissions: ['users:read'],
    handler: async () => ({ success: true, data: [{ id: 1, name: 'Alice' }] }),
  });

  // Write command
  commands.set('users:create', {
    namespace: 'users',
    name: 'create',
    description: 'Create a user',
    params: [{ name: 'name', type: 'string', required: true }],
    requiredPermissions: ['users:create'],
    handler: async (args: any) => ({ success: true, data: { id: 42, name: args.name } }),
  });

  // Delete command (dangerous)
  commands.set('users:delete', {
    namespace: 'users',
    name: 'delete',
    description: 'Delete a user',
    params: [{ name: 'id', type: 'int', required: true }],
    requiredPermissions: ['users:delete'],
    handler: async (args: any) => ({ success: true, data: { deleted: args.id } }),
  });

  // Admin command
  commands.set('admin:reset', {
    namespace: 'admin',
    name: 'reset',
    description: 'Reset the system',
    params: [],
    requiredPermissions: ['admin:reset'],
    handler: async () => ({ success: true, data: { reset: true } }),
  });

  return {
    get(namespace: string, name: string) {
      return commands.get(`${namespace}:${name}`) ?? null;
    },
  };
}

/** Mock vector index that returns all commands as search results. */
function createMockVectorIndex(registry: ReturnType<typeof createPermissionRegistry>) {
  const allCommands = [
    { namespace: 'system', command: 'status' },
    { namespace: 'users', command: 'list' },
    { namespace: 'users', command: 'create' },
    { namespace: 'users', command: 'delete' },
    { namespace: 'admin', command: 'reset' },
  ];
  return {
    async search(query: string) {
      return {
        query,
        results: allCommands.map((c, i) => ({
          commandId: `${c.namespace}:${c.command}`,
          score: 0.9 - i * 0.05,
          command: c.command,
          namespace: c.namespace,
          description: `${c.namespace}:${c.command}`,
          signature: `${c.namespace}:${c.command}`,
          example: '',
        })),
        totalIndexed: allCommands.length,
        searchTimeMs: 1,
        model: 'mock',
      };
    },
  };
}

// ===========================================================================
// Agent Profiles
// ===========================================================================

describe('Agent Profiles', () => {

  it('AP01: resolveAgentPermissions returns profile permissions', () => {
    const perms = resolveAgentPermissions({ agentProfile: 'admin' });
    expect(perms).toContain('*');
  });

  it('AP02: resolveAgentPermissions returns null when nothing set', () => {
    const perms = resolveAgentPermissions({});
    expect(perms).toBeNull();
  });

  it('AP03: resolveAgentPermissions returns custom permissions array', () => {
    const perms = resolveAgentPermissions({ permissions: ['users:read', 'users:create'] });
    expect(perms).toEqual(['users:read', 'users:create']);
  });

  it('AP04: all profiles have correct permission structure', () => {
    expect(AGENT_PROFILES.admin).toContain('*');
    expect(AGENT_PROFILES.reader).toContain('*:read');
    expect(AGENT_PROFILES.reader).not.toContain('*:create');
    expect(AGENT_PROFILES.operator).toContain('*:create');
    expect(AGENT_PROFILES.operator).not.toContain('*:delete');
    expect(AGENT_PROFILES.restricted).toHaveLength(0);
  });

  it('AP05: agentProfile takes precedence over permissions', () => {
    const perms = resolveAgentPermissions({
      agentProfile: 'restricted',
      permissions: ['users:read', 'users:create'],
    });
    expect(perms).toEqual([]); // restricted wins
  });
});

// ===========================================================================
// Core Permission Enforcement
// ===========================================================================

describe('Core Permission Enforcement', () => {
  const registry = createPermissionRegistry();
  const vectorIndex = createMockVectorIndex(registry);

  it('PE01: no permissions config = no restrictions (backward compatible)', async () => {
    const core = new Core({ registry, vectorIndex });
    const res = await core.exec('users:delete --id 1');
    expect(res.code).toBe(0);
  });

  it('PE02: admin profile allows everything', async () => {
    const core = new Core({ registry, vectorIndex, agentProfile: 'admin' });

    const res1 = await core.exec('users:list');
    expect(res1.code).toBe(0);

    const res2 = await core.exec('users:create --name Test');
    expect(res2.code).toBe(0);

    const res3 = await core.exec('admin:reset');
    expect(res3.code).toBe(0);
  });

  it('PE03: custom permissions allow specific commands', async () => {
    const core = new Core({ registry, vectorIndex, permissions: ['users:read'] });

    const res = await core.exec('users:list');
    expect(res.code).toBe(0);
  });

  it('PE04: custom permissions deny unauthorized commands', async () => {
    const core = new Core({ registry, vectorIndex, permissions: ['users:read'] });

    const res = await core.exec('users:create --name Test');
    expect(res.code).toBe(3); // permission denied
    expect(res.error).toContain('Permission denied');
  });

  it('PE05: restricted profile denies all protected commands', async () => {
    const core = new Core({ registry, vectorIndex, agentProfile: 'restricted' });

    const res = await core.exec('users:list');
    expect(res.code).toBe(3);
  });

  it('PE06: public commands (no requiredPermissions) are always accessible', async () => {
    const core = new Core({ registry, vectorIndex, agentProfile: 'restricted' });

    const res = await core.exec('system:status');
    expect(res.code).toBe(0);
    expect(res.data.status).toBe('ok');
  });

  it('PE07: wildcard namespace permission grants access', async () => {
    const core = new Core({ registry, vectorIndex, permissions: ['users:*'] });

    const r1 = await core.exec('users:list');
    expect(r1.code).toBe(0);

    const r2 = await core.exec('users:create --name Test');
    expect(r2.code).toBe(0);

    const r3 = await core.exec('users:delete --id 1');
    expect(r3.code).toBe(0);

    // But not admin namespace
    const r4 = await core.exec('admin:reset');
    expect(r4.code).toBe(3);
  });
});

// ===========================================================================
// Discovery Filtering
// ===========================================================================

describe('Discovery Permission Filtering', () => {
  const registry = createPermissionRegistry();
  const vectorIndex = createMockVectorIndex(registry);

  it('DF01: search hides commands without permission', async () => {
    const core = new Core({ registry, vectorIndex, permissions: ['users:read'] });
    const res = await core.exec('search user');

    expect(res.code).toBe(0);
    const results = res.data.results;
    // Should see: system:status (public) + users:list (has users:read)
    // Should NOT see: users:create, users:delete, admin:reset
    const ids = results.map((r: any) => r.commandId);
    expect(ids).toContain('system:status');
    expect(ids).toContain('users:list');
    expect(ids).not.toContain('users:create');
    expect(ids).not.toContain('users:delete');
    expect(ids).not.toContain('admin:reset');
  });

  it('DF02: search shows all commands with admin profile', async () => {
    const core = new Core({ registry, vectorIndex, agentProfile: 'admin' });
    const res = await core.exec('search user');

    expect(res.code).toBe(0);
    expect(res.data.results.length).toBe(5); // all commands visible
  });

  it('DF03: search shows public commands even for restricted', async () => {
    const core = new Core({ registry, vectorIndex, agentProfile: 'restricted' });
    const res = await core.exec('search status');

    const ids = res.data.results.map((r: any) => r.commandId);
    expect(ids).toContain('system:status'); // public, no permissions required
  });

  it('DF04: describe denies access to protected command', async () => {
    const core = new Core({ registry, vectorIndex, permissions: ['users:read'] });
    const res = await core.exec('describe admin:reset');

    expect(res.code).toBe(3);
    expect(res.error).toContain('Permission denied');
  });

  it('DF05: describe allows access when agent has permission', async () => {
    const core = new Core({ registry, vectorIndex, permissions: ['users:read'] });
    const res = await core.exec('describe users:list');

    expect(res.code).toBe(0);
  });

  it('DF06: describe allows public commands for restricted agent', async () => {
    const core = new Core({ registry, vectorIndex, agentProfile: 'restricted' });
    const res = await core.exec('describe system:status');

    expect(res.code).toBe(0);
  });

  it('DF07: no permissions config = search returns all', async () => {
    const core = new Core({ registry, vectorIndex });
    const res = await core.exec('search user');

    expect(res.data.results.length).toBe(5);
  });
});

// ===========================================================================
// Pipeline Permission Enforcement
// ===========================================================================

describe('Pipeline Permission Enforcement', () => {

  function createPipelineRegistry() {
    const commands = new Map<string, any>();

    commands.set('data:fetch', {
      namespace: 'data',
      name: 'fetch',
      params: [],
      requiredPermissions: ['data:read'],
      handler: async (_args: any, _input: any) => ({
        success: true,
        data: [{ id: 1, value: 'a' }, { id: 2, value: 'b' }],
      }),
    });

    commands.set('data:transform', {
      namespace: 'data',
      name: 'transform',
      params: [],
      requiredPermissions: ['data:write'],
      handler: async (_args: any, input: any) => ({
        success: true,
        data: input,
      }),
    });

    return {
      get(namespace: string, name: string) {
        return commands.get(`${namespace}:${name}`) ?? null;
      },
    };
  }

  it('PL01: pipeline fails if any step requires unauthorized permission', async () => {
    const registry = createPipelineRegistry();
    const core = new Core({ registry, permissions: ['data:read'] });

    const res = await core.exec('data:fetch >> data:transform');
    expect(res.code).toBe(3);
    expect(res.error).toContain('Permission denied at pipeline step');
  });

  it('PL02: pipeline succeeds when agent has all required permissions', async () => {
    const registry = createPipelineRegistry();
    const core = new Core({ registry, permissions: ['data:read', 'data:write'] });

    const res = await core.exec('data:fetch >> data:transform');
    expect(res.code).toBe(0);
  });

  it('PL03: admin profile executes full pipeline', async () => {
    const registry = createPipelineRegistry();
    const core = new Core({ registry, agentProfile: 'admin' });

    const res = await core.exec('data:fetch >> data:transform');
    expect(res.code).toBe(0);
  });
});
