/**
 * Tests for workspace skills — persistent state across commands.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WorkspaceState, createWorkspaceCommands } from '../src/skills/workspace.js';
import { CommandRegistry } from '../src/command-registry/index.js';
import { registerShellSkills } from '../src/skills/index.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SkillEntry } from '../src/skills/scaffold.js';

function findHandler(entries: SkillEntry[], ns: string, name: string): Function {
  const e = entries.find(e => e.definition.namespace === ns && e.definition.name === name);
  if (!e) throw new Error(`Not found: ${ns}:${name}`);
  return e.handler;
}

describe('Workspace Skills', () => {
  let state: WorkspaceState;
  let cmds: SkillEntry[];
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ws-test-'));
    writeFileSync(join(tempDir, 'hello.txt'), 'world');
    state = new WorkspaceState();
    cmds = createWorkspaceCommands(state);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // workspace:init
  // -----------------------------------------------------------------------

  it('WS01: init sets cwd to given path', async () => {
    const init = findHandler(cmds, 'workspace', 'init');
    const res = await init({ path: tempDir });

    expect(res.success).toBe(true);
    expect(res.data.cwd).toBe(tempDir);
    expect(state.cwd).toBe(tempDir);
    expect(state.initialized).toBe(true);
  });

  it('WS02: init creates directory when --create true', async () => {
    const init = findHandler(cmds, 'workspace', 'init');
    const newDir = join(tempDir, 'subdir', 'deep');
    const res = await init({ path: newDir, create: true });

    expect(res.success).toBe(true);
    expect(state.cwd).toBe(newDir);
  });

  it('WS03: init fails if directory does not exist and no --create', async () => {
    const init = findHandler(cmds, 'workspace', 'init');
    const res = await init({ path: '/nonexistent/dir/xyz' });

    expect(res.success).toBe(false);
    expect(res.error).toContain('does not exist');
  });

  it('WS04: init sets initial env variables', async () => {
    const init = findHandler(cmds, 'workspace', 'init');
    await init({ path: tempDir, env: { DB_URL: 'postgres://localhost/test' } });

    expect(state.env.DB_URL).toBe('postgres://localhost/test');
  });

  // -----------------------------------------------------------------------
  // workspace:run
  // -----------------------------------------------------------------------

  it('WS05: run executes command in workspace cwd', async () => {
    state.cwd = tempDir;
    const run = findHandler(cmds, 'workspace', 'run');
    const res = await run({ command: 'cat hello.txt' });

    expect(res.success).toBe(true);
    expect(res.data.stdout).toContain('world');
    expect(res.data.exitCode).toBe(0);
    expect(res.data.cwd).toBe(tempDir);
  });

  it('WS06: run uses workspace env variables', async () => {
    state.cwd = tempDir;
    state.env.MY_VAR = 'hello123';
    const run = findHandler(cmds, 'workspace', 'run');

    const isWindows = process.platform === 'win32';
    const cmd = isWindows ? 'echo %MY_VAR%' : 'echo $MY_VAR';
    const res = await run({ command: cmd });

    expect(res.success).toBe(true);
    expect(res.data.stdout).toContain('hello123');
  });

  it('WS07: run records history', async () => {
    state.cwd = tempDir;
    const run = findHandler(cmds, 'workspace', 'run');

    await run({ command: 'echo one' });
    await run({ command: 'echo two' });

    expect(state.history).toHaveLength(2);
    expect(state.history[0].command).toBe('echo one');
    expect(state.history[1].command).toBe('echo two');
  });

  it('WS08: run captures non-zero exit code', async () => {
    state.cwd = tempDir;
    const run = findHandler(cmds, 'workspace', 'run');
    const res = await run({ command: 'exit 42' });

    expect(res.data.exitCode).not.toBe(0);
  });

  it('WS09: run includes duration_ms', async () => {
    state.cwd = tempDir;
    const run = findHandler(cmds, 'workspace', 'run');
    const res = await run({ command: 'echo fast' });

    expect(res.data.duration_ms).toBeGreaterThanOrEqual(0);
  });

  // -----------------------------------------------------------------------
  // workspace:cd
  // -----------------------------------------------------------------------

  it('WS10: cd changes workspace cwd', async () => {
    state.cwd = tempDir;
    const cd = findHandler(cmds, 'workspace', 'cd');

    mkdtempSync(join(tempDir, 'sub-')); // create a subdir
    const sub = join(tempDir, 'sub-test');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(sub, { recursive: true });

    const res = await cd({ path: sub });
    expect(res.success).toBe(true);
    expect(state.cwd).toBe(sub);
    expect(res.data.previous).toBe(tempDir);
  });

  it('WS11: cd fails for nonexistent directory', async () => {
    state.cwd = tempDir;
    const cd = findHandler(cmds, 'workspace', 'cd');
    const res = await cd({ path: '/does/not/exist' });

    expect(res.success).toBe(false);
    expect(res.error).toContain('does not exist');
  });

  // -----------------------------------------------------------------------
  // workspace:env
  // -----------------------------------------------------------------------

  it('WS12: env set adds variable', async () => {
    const env = findHandler(cmds, 'workspace', 'env');
    const res = await env({ set: 'API_KEY=secret123' });

    expect(res.success).toBe(true);
    expect(res.data.action).toBe('set');
    expect(state.env.API_KEY).toBe('secret123');
  });

  it('WS13: env set handles values with = signs', async () => {
    const env = findHandler(cmds, 'workspace', 'env');
    await env({ set: 'DB_URL=postgres://user:pass@host/db?opt=val' });

    expect(state.env.DB_URL).toBe('postgres://user:pass@host/db?opt=val');
  });

  it('WS14: env unset removes variable', async () => {
    state.env.TEMP_VAR = 'value';
    const env = findHandler(cmds, 'workspace', 'env');
    const res = await env({ unset: 'TEMP_VAR' });

    expect(res.success).toBe(true);
    expect(res.data.existed).toBe(true);
    expect(state.env.TEMP_VAR).toBeUndefined();
  });

  it('WS15: env list returns all workspace variables', async () => {
    state.env = { A: '1', B: '2', C: '3' };
    const env = findHandler(cmds, 'workspace', 'env');
    const res = await env({ list: true });

    expect(res.data.count).toBe(3);
    expect(res.data.variables.A).toBe('1');
  });

  // -----------------------------------------------------------------------
  // workspace:status
  // -----------------------------------------------------------------------

  it('WS16: status returns current workspace state', async () => {
    state.cwd = tempDir;
    state.env = { X: '1' };
    state.initialized = true;
    state.history = [{ command: 'echo test', exitCode: 0, duration_ms: 5, timestamp: new Date().toISOString() }];

    const status = findHandler(cmds, 'workspace', 'status');
    const res = await status({});

    expect(res.success).toBe(true);
    expect(res.data.cwd).toBe(tempDir);
    expect(res.data.initialized).toBe(true);
    expect(res.data.envCount).toBe(1);
    expect(res.data.envKeys).toContain('X');
    expect(res.data.recentCommands).toHaveLength(1);
  });

  // -----------------------------------------------------------------------
  // workspace:reset
  // -----------------------------------------------------------------------

  it('WS17: reset clears all workspace state', async () => {
    state.cwd = tempDir;
    state.env = { X: '1' };
    state.initialized = true;
    state.history = [{ command: 'echo', exitCode: 0, duration_ms: 1, timestamp: '' }];

    const reset = findHandler(cmds, 'workspace', 'reset');
    const res = await reset({});

    expect(res.success).toBe(true);
    expect(state.initialized).toBe(false);
    expect(state.env).toEqual({});
    expect(state.history).toHaveLength(0);
    expect(res.data.previousCwd).toBe(tempDir);
  });

  // -----------------------------------------------------------------------
  // Integration
  // -----------------------------------------------------------------------

  it('WS18: full DevOps workflow: init → env → run → status', async () => {
    const init = findHandler(cmds, 'workspace', 'init');
    const env = findHandler(cmds, 'workspace', 'env');
    const run = findHandler(cmds, 'workspace', 'run');
    const status = findHandler(cmds, 'workspace', 'status');

    // 1. Init
    await init({ path: tempDir });
    expect(state.cwd).toBe(tempDir);

    // 2. Set env
    await env({ set: 'PROJECT=test-app' });
    expect(state.env.PROJECT).toBe('test-app');

    // 3. Run commands
    await run({ command: 'echo "setup done"' });
    await run({ command: 'cat hello.txt' });

    // 4. Check status
    const statusRes = await status({});
    expect(statusRes.data.historyCount).toBe(2);
    expect(statusRes.data.envKeys).toContain('PROJECT');
  });

  it('WS19: registerShellSkills includes workspace commands', () => {
    const registry = new CommandRegistry();
    registerShellSkills(registry);

    const namespaces = registry.getNamespaces();
    expect(namespaces).toContain('workspace');

    const all = registry.listAll();
    const wsCommands = all.filter(d => d.namespace === 'workspace');
    expect(wsCommands).toHaveLength(6);
  });

  it('WS20: all workspace commands have requiredPermissions', () => {
    for (const { definition } of cmds) {
      expect(definition.requiredPermissions).toBeDefined();
      expect(definition.requiredPermissions!.length).toBeGreaterThan(0);
    }
  });
});
