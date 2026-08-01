/**
 * Tests for workspace skills — persistent state across commands.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WorkspaceState, createWorkspaceCommands } from '../src/skills/workspace.js';
import { CommandRegistry } from '../src/command-registry/index.js';
import { registerShellSkills } from '../src/skills/index.js';
import { mkdtempSync, rmSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SkillEntry } from '../src/skills/scaffold.js';
import type { ShellAdapter } from '../src/just-bash/types.js';

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

  /**
   * Regresion (ronda 21 del audit): workspace:run alcanza el mismo sink de
   * ejecucion que shell:exec (via ShellAdapter.exec()), pero solo exigia
   * workspace:write — un caller con ese permiso pero deliberadamente sin
   * shell:exec conseguia ejecucion arbitraria de comandos igual. Mismo
   * razonamiento ya aplicado a cron:schedule (ver cron.ts).
   */
  it('WS00: workspace:run exige tambien shell:exec, no solo workspace:write', () => {
    const runDef = cmds.find(c => c.definition.name === 'run')!.definition;
    expect(runDef.requiredPermissions).toEqual(expect.arrayContaining(['workspace:write', 'shell:exec']));
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

/**
 * Regresion: workspace:init/cd no tenian ningun concepto de jail — a
 * diferencia de file:*, que ya soporta un jailRoot opcional via
 * createFileCommands(adapter, jailRoot). workspace:init llamaba
 * mkdirSync directo (bypaseando el adapter) y workspace:cd aceptaba
 * cualquier path absoluto o con ../, dejando que workspace:run ejecutara
 * luego con ese cwd fuera de cualquier jail configurado.
 */
describe('Workspace jailRoot containment', () => {
  let jailDir: string;
  let outsideDir: string;
  let state: WorkspaceState;
  let cmds: SkillEntry[];

  beforeEach(() => {
    // realpathSync: on Windows, tmpdir() can return an 8.3 short-name path
    // (e.g. ADMINI~1) that's really an alias for the canonical long-name
    // directory — createPathJail's symlink-resolution (ronda 36 del audit)
    // now canonicalizes this the same way it would a real symlink, so tests
    // comparing against jailDir need the same canonical form.
    jailDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'ws-jail-')));
    outsideDir = mkdtempSync(join(tmpdir(), 'ws-outside-'));
    state = new WorkspaceState();
    cmds = createWorkspaceCommands(state, undefined, jailDir);
  });

  afterEach(() => {
    rmSync(jailDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it('WSJ01: init dentro del jail funciona', async () => {
    const init = findHandler(cmds, 'workspace', 'init');
    const res = await init({ path: jailDir });

    expect(res.success).toBe(true);
    expect(state.cwd).toBe(jailDir);
  });

  it('WSJ02: init fuera del jail es bloqueado', async () => {
    const init = findHandler(cmds, 'workspace', 'init');
    const res = await init({ path: outsideDir });

    expect(res.success).toBe(false);
    expect(res.error).toContain('outside jail root');
    expect(state.initialized).toBe(false);
  });

  it('WSJ03: init --create true no crea directorios fuera del jail', async () => {
    const init = findHandler(cmds, 'workspace', 'init');
    const escapedPath = join(outsideDir, 'should-not-exist');
    const res = await init({ path: escapedPath, create: true });

    expect(res.success).toBe(false);
    expect(existsSync(escapedPath)).toBe(false);
  });

  it('WSJ04: cd con ../ que escapa del jail es bloqueado', async () => {
    const init = findHandler(cmds, 'workspace', 'init');
    await init({ path: jailDir });

    const cd = findHandler(cmds, 'workspace', 'cd');
    const res = await cd({ path: '../../../' });

    expect(res.success).toBe(false);
    expect(res.error).toContain('outside jail root');
    expect(state.cwd).toBe(jailDir); // unchanged
  });

  it('WSJ05: cd a un path absoluto fuera del jail es bloqueado', async () => {
    const init = findHandler(cmds, 'workspace', 'init');
    await init({ path: jailDir });

    const cd = findHandler(cmds, 'workspace', 'cd');
    const res = await cd({ path: outsideDir });

    expect(res.success).toBe(false);
    expect(state.cwd).toBe(jailDir);
  });

  it('WSJ06: reset vuelve al jailRoot, no a process.cwd()', async () => {
    const init = findHandler(cmds, 'workspace', 'init');
    await init({ path: jailDir });

    const reset = findHandler(cmds, 'workspace', 'reset');
    const res = await reset({});

    expect(res.data.newCwd).toBe(jailDir);
    expect(state.cwd).toBe(jailDir);
  });

  it('WSJ07: sin jailRoot, el comportamiento es el de siempre (sin restriccion)', async () => {
    const unjailed = createWorkspaceCommands(new WorkspaceState());
    const init = findHandler(unjailed, 'workspace', 'init');
    const res = await init({ path: outsideDir });

    expect(res.success).toBe(true);
  });

  /**
   * Regresion (auditoria post-jail): una sesion NUEVA (nunca vista) recibia
   * un WorkspaceState con cwd = process.cwd() sin importar el jailRoot
   * configurado. Si el PRIMER comando de esa sesion era workspace:run (sin
   * workspace:init antes), ejecutaba fuera del jail sin ningun chequeo —
   * a diferencia de init/cd, que si validaban. No pasar `state` a
   * createWorkspaceCommands fuerza a store.get() a crear una sesion
   * genuinamente nueva, reproduciendo el escenario real.
   */
  it('WSJ08: workspace:run como primer comando de una sesion nueva (sin init previo) arranca DENTRO del jail, no en process.cwd()', async () => {
    const jailedCmds = createWorkspaceCommands(undefined, undefined, jailDir);
    const run = findHandler(jailedCmds, 'workspace', 'run');
    const res = await run({ command: 'echo hi' });

    expect(res.success).toBe(true);
    expect(res.data.cwd).toBe(jailDir);
  });

  it('WSJ09: workspace:status como primer comando de una sesion nueva tambien refleja el jailRoot, no process.cwd()', async () => {
    const jailedCmds = createWorkspaceCommands(undefined, undefined, jailDir);
    const status = findHandler(jailedCmds, 'workspace', 'status');
    const res = await status({});

    expect(res.data.cwd).toBe(jailDir);
    expect(res.data.initialized).toBe(false); // aun no se llamo workspace:init
  });
});

// ===========================================================================
// Sandbox adapter injection (GLM-FIX-SANDBOX-BYPASS)
// ===========================================================================

describe('Workspace Sandbox Adapter Injection', () => {
  let state: WorkspaceState;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ws-sandbox-'));
    state = new WorkspaceState();
    state.cwd = tempDir;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('WS21: workspace:run routes through injected ShellAdapter (not execSync)', async () => {
    const execMock = vi.fn().mockResolvedValue({ stdout: 'FAKE_OUTPUT', stderr: '', exitCode: 0 });
    const fakeAdapter: ShellAdapter = {
      backend: 'test',
      exec: execMock,
      which: vi.fn().mockResolvedValue({ program: '', path: null, found: false }),
      readFile: vi.fn().mockResolvedValue({ path: '', content: '', size: 0 }),
      writeFile: vi.fn().mockResolvedValue({ path: '', size: 0, written: true }),
      listDir: vi.fn().mockResolvedValue({ path: '', entries: [], count: 0 }),
      mkdir: vi.fn().mockResolvedValue({ path: '', created: true }),
      remove: vi.fn().mockResolvedValue({ path: '', deleted: true }),
      rename: vi.fn().mockResolvedValue({ from: '', to: '', renamed: true }),
      chmod: vi.fn().mockResolvedValue({ path: '', mode: 0 }),
    };

    const cmds = createWorkspaceCommands(state, fakeAdapter);
    const run = findHandler(cmds, 'workspace', 'run');
    const res = await run({ command: 'cualquier cosa' });

    // (a) output came from the fake adapter, not a real execSync
    expect(res.success).toBe(true);
    expect(res.data.stdout).toBe('FAKE_OUTPUT');
    expect(res.data.exitCode).toBe(0);

    // (b) adapter.exec was called with the command and the workspace cwd
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(execMock).toHaveBeenCalledWith('cualquier cosa', {
      cwd: tempDir,
      env: state.env,
      timeout: 120_000,
    });
  });

  it('WS22: workspace:run propagates non-zero exit code from injected adapter', async () => {
    const execMock = vi.fn().mockResolvedValue({ stdout: '', stderr: 'boom', exitCode: 7 });
    const fakeAdapter: ShellAdapter = {
      backend: 'test',
      exec: execMock,
      which: vi.fn().mockResolvedValue({ program: '', path: null, found: false }),
      readFile: vi.fn().mockResolvedValue({ path: '', content: '', size: 0 }),
      writeFile: vi.fn().mockResolvedValue({ path: '', size: 0, written: true }),
      listDir: vi.fn().mockResolvedValue({ path: '', entries: [], count: 0 }),
      mkdir: vi.fn().mockResolvedValue({ path: '', created: true }),
      remove: vi.fn().mockResolvedValue({ path: '', deleted: true }),
      rename: vi.fn().mockResolvedValue({ from: '', to: '', renamed: true }),
      chmod: vi.fn().mockResolvedValue({ path: '', mode: 0 }),
    };

    const cmds = createWorkspaceCommands(state, fakeAdapter);
    const run = findHandler(cmds, 'workspace', 'run');
    const res = await run({ command: 'failing command' });

    expect(res.success).toBe(true);
    expect(res.data.exitCode).toBe(7);
    expect(res.data.stderr).toBe('boom');
    expect(execMock).toHaveBeenCalledTimes(1);
  });
});
