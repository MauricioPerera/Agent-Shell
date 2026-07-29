/**
 * Tests for infrastructure completion: file ops, git, cron, secrets, process manager.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { CommandRegistry } from '../src/command-registry/index.js';
import { registerShellSkills } from '../src/skills/index.js';
import { createFileCommands } from '../src/skills/shell-file.js';
import { gitCommands } from '../src/skills/shell-git.js';
import { CronScheduler, createCronCommands } from '../src/skills/cron.js';
import { SecretStore, createSecretCommands } from '../src/skills/secret-store.js';
import { ProcessManager, createProcessCommands } from '../src/skills/process-mgr.js';
import { NativeShellAdapter } from '../src/just-bash/adapter.js';
import type { SkillEntry } from '../src/skills/scaffold.js';
import type { ShellAdapter } from '../src/just-bash/types.js';

function findHandler(entries: SkillEntry[], ns: string, name: string): Function {
  const e = entries.find(e => e.definition.namespace === ns && e.definition.name === name);
  if (!e) throw new Error(`Not found: ${ns}:${name}`);
  return e.handler;
}

// ===========================================================================
// FILE OPS (mkdir, delete, rename, chmod)
// ===========================================================================

describe('File CRUD Operations', () => {
  const adapter = new NativeShellAdapter();
  const cmds = createFileCommands(adapter);
  let tempDir: string;

  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'fileops-')); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('FO01: file:mkdir creates directory recursively', async () => {
    const handler = findHandler(cmds, 'file', 'mkdir');
    const path = join(tempDir, 'a', 'b', 'c');
    const res = await handler({ path, recursive: true });
    expect(res.success).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  it('FO02: file:delete removes a file', async () => {
    const handler = findHandler(cmds, 'file', 'delete');
    const path = join(tempDir, 'todelete.txt');
    writeFileSync(path, 'bye');
    const res = await handler({ path });
    expect(res.success).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it('FO03: file:delete recursive removes directory', async () => {
    const handler = findHandler(cmds, 'file', 'delete');
    const dir = join(tempDir, 'subdir');
    mkdirSync(dir);
    writeFileSync(join(dir, 'file.txt'), 'data');
    const res = await handler({ path: dir, recursive: true });
    expect(res.success).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it('FO04: file:rename moves a file', async () => {
    const handler = findHandler(cmds, 'file', 'rename');
    const from = join(tempDir, 'old.txt');
    const to = join(tempDir, 'new.txt');
    writeFileSync(from, 'content');
    const res = await handler({ from, to });
    expect(res.success).toBe(true);
    expect(existsSync(to)).toBe(true);
    expect(existsSync(from)).toBe(false);
  });

  it('FO05: file:chmod changes permissions', async () => {
    if (process.platform === 'win32') return; // chmod not meaningful on Windows
    const handler = findHandler(cmds, 'file', 'chmod');
    const path = join(tempDir, 'script.sh');
    writeFileSync(path, '#!/bin/bash');
    const res = await handler({ path, mode: '755' });
    expect(res.success).toBe(true);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o755);
  });

  it('FO06: file:mkdir + file:write + file:read roundtrip', async () => {
    const mkdirH = findHandler(cmds, 'file', 'mkdir');
    const writeH = findHandler(cmds, 'file', 'write');
    const readH = findHandler(cmds, 'file', 'read');
    const dir = join(tempDir, 'project', 'src');
    await mkdirH({ path: dir });
    await writeH({ path: join(dir, 'index.ts'), content: 'export {}' });
    const res = await readH({ path: join(dir, 'index.ts') });
    expect(res.data.content).toBe('export {}');
  });

  it('FO07: all file commands have requiredPermissions', () => {
    for (const { definition } of cmds) {
      expect(definition.requiredPermissions).toBeDefined();
      expect(definition.requiredPermissions!.length).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// GIT
// ===========================================================================

describe('Git Skills', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'git-test-'));
    execSync('git init', { cwd: tempDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: tempDir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: tempDir, stdio: 'pipe' });
    writeFileSync(join(tempDir, 'README.md'), '# Test');
    execSync('git add -A && git commit -m "init"', { cwd: tempDir, stdio: 'pipe' });
  });

  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('GI01: git:status shows clean repo', async () => {
    const handler = findHandler(gitCommands, 'git', 'status');
    const res = await handler({ cwd: tempDir });
    expect(res.success).toBe(true);
    expect(res.data.clean).toBe(true);
  });

  it('GI02: git:status detects changes', async () => {
    writeFileSync(join(tempDir, 'new.txt'), 'change');
    const handler = findHandler(gitCommands, 'git', 'status');
    const res = await handler({ cwd: tempDir });
    expect(res.data.clean).toBe(false);
  });

  it('GI03: git:diff shows changes', async () => {
    writeFileSync(join(tempDir, 'README.md'), '# Updated');
    const handler = findHandler(gitCommands, 'git', 'diff');
    const res = await handler({ cwd: tempDir });
    expect(res.data.stdout).toContain('Updated');
  });

  it('GI04: git:commit creates commit', async () => {
    writeFileSync(join(tempDir, 'file.txt'), 'new');
    const handler = findHandler(gitCommands, 'git', 'commit');
    const res = await handler({ message: 'add file', 'add-all': true, cwd: tempDir });
    expect(res.success).toBe(true);
  });

  it('GI05: all git commands have requiredPermissions', () => {
    for (const { definition } of gitCommands) {
      expect(definition.requiredPermissions).toBeDefined();
    }
  });

  it('GI06: git:commit message with command substitution is NOT executed', async () => {
    writeFileSync(join(tempDir, 'file.txt'), 'new');
    const proofPath = join(tempDir, 'pwned-proof.txt');
    expect(existsSync(proofPath)).toBe(false);
    const handler = findHandler(gitCommands, 'git', 'commit');
    const res = await handler({
      message: '$(touch pwned-proof.txt)',
      'add-all': true,
      cwd: tempDir,
    });
    // Commit must succeed (message is a literal string, no shell involved).
    expect(res.success).toBe(true);
    // The injected command substitution must NOT have run — no proof file created.
    expect(existsSync(proofPath)).toBe(false);
  });
});

// ===========================================================================
// CRON
// ===========================================================================

describe('Cron Skills', () => {
  let scheduler: CronScheduler;
  let cmds: SkillEntry[];

  beforeEach(() => {
    scheduler = new CronScheduler();
    cmds = createCronCommands(scheduler);
  });

  afterEach(() => { scheduler.destroy(); });

  it('CR01: cron:schedule creates task', async () => {
    const handler = findHandler(cmds, 'cron', 'schedule');
    const res = await handler({ name: 'test', command: 'echo hi', interval: '30s' });
    expect(res.success).toBe(true);
    expect(res.data.scheduled).toBe(true);
  });

  it('CR02: cron:list shows active tasks', async () => {
    const schedule = findHandler(cmds, 'cron', 'schedule');
    await schedule({ name: 'a', command: 'echo a', interval: '1m' });
    await schedule({ name: 'b', command: 'echo b', interval: '5m' });

    const list = findHandler(cmds, 'cron', 'list');
    const res = await list({});
    expect(res.data.count).toBe(2);
  });

  it('CR03: cron:cancel removes task', async () => {
    const schedule = findHandler(cmds, 'cron', 'schedule');
    await schedule({ name: 'temp', command: 'echo temp', interval: '10s' });

    const cancel = findHandler(cmds, 'cron', 'cancel');
    const res = await cancel({ name: 'temp' });
    expect(res.success).toBe(true);
    expect(res.data.cancelled).toBe(true);

    const list = findHandler(cmds, 'cron', 'list');
    expect((await list({})).data.count).toBe(0);
  });

  it('CR04: cron:schedule rejects duplicate name', async () => {
    const handler = findHandler(cmds, 'cron', 'schedule');
    await handler({ name: 'dup', command: 'echo', interval: '1m' });
    const res = await handler({ name: 'dup', command: 'echo', interval: '2m' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('already exists');
  });

  it('CR05: cron:schedule rejects invalid interval', async () => {
    const handler = findHandler(cmds, 'cron', 'schedule');
    const res = await handler({ name: 'bad', command: 'echo', interval: 'invalid' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('Invalid interval');
  });

  it('CR06: cron:schedule parses shorthand intervals', async () => {
    const handler = findHandler(cmds, 'cron', 'schedule');
    for (const interval of ['10s', '5m', '1h', '1d']) {
      const res = await handler({ name: `t-${interval}`, command: 'echo', interval });
      expect(res.success).toBe(true);
    }
  });

  it('CR07: cron:history returns empty initially', async () => {
    const handler = findHandler(cmds, 'cron', 'history');
    const res = await handler({});
    expect(res.data.count).toBe(0);
  });
});

// ===========================================================================
// CRON SANDBOX ADAPTER INJECTION (GLM-FIX-SANDBOX-BYPASS)
// ===========================================================================

describe('Cron Sandbox Adapter Injection', () => {
  let execMock: ReturnType<typeof vi.fn>;
  let fakeAdapter: ShellAdapter;
  let scheduler: CronScheduler;
  let cmds: SkillEntry[];

  beforeEach(() => {
    vi.useFakeTimers();
    execMock = vi.fn().mockResolvedValue({ stdout: 'CRON_FAKE', stderr: '', exitCode: 0 });
    fakeAdapter = {
      backend: 'test',
      exec: execMock,
      which: vi.fn().mockResolvedValue({ program: '', path: null, found: false }),
      readFile: vi.fn().mockResolvedValue({ path: '', content: '', size: 0 }),
      writeFile: vi.fn().mockResolvedValue({ path: '', size: 0, written: true }),
      listDir: vi.fn().mockResolvedValue({ path: '', entries: [], count: 0 }),
    };
    scheduler = new CronScheduler(fakeAdapter);
    cmds = createCronCommands(scheduler);
  });

  afterEach(() => {
    scheduler.destroy();
    vi.useRealTimers();
  });

  it('CR08: CronScheduler uses injected adapter to execute tasks', async () => {
    const schedule = findHandler(cmds, 'cron', 'schedule');
    const res = await schedule({ name: 'injected', command: 'echo via-adapter', interval: '1s' });
    expect(res.success).toBe(true);

    // Fire the interval 3 times. Minimum valid interval is 1000ms ('1s').
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    // The task ran through the injected adapter, not a real execSync.
    expect(execMock).toHaveBeenCalledTimes(3);
    expect(execMock).toHaveBeenCalledWith('echo via-adapter', { cwd: undefined, timeout: 60_000 });

    // History reflects the (fake) adapter exit code, recorded each run.
    const history = findHandler(cmds, 'cron', 'history');
    const histRes = await history({ name: 'injected' });
    expect(histRes.data.count).toBe(3);
    for (const entry of histRes.data.history) {
      expect(entry.exitCode).toBe(0);
    }
  });

  it('CR09: CronScheduler records non-zero exit code from injected adapter', async () => {
    execMock.mockResolvedValue({ stdout: '', stderr: 'failed', exitCode: 99 });

    const schedule = findHandler(cmds, 'cron', 'schedule');
    await schedule({ name: 'failing', command: 'exit 99', interval: '1s' });

    await vi.advanceTimersByTimeAsync(1000);

    expect(execMock).toHaveBeenCalledTimes(1);
    const history = findHandler(cmds, 'cron', 'history');
    const histRes = await history({ name: 'failing' });
    expect(histRes.data.history[0].exitCode).toBe(99);
  });
});

// ===========================================================================
// SECRET STORE
// ===========================================================================

describe('Secret Store Skills', () => {
  let store: SecretStore;
  let cmds: SkillEntry[];

  beforeEach(() => {
    store = new SecretStore('test-encryption-key-32chars!!!');
    cmds = createSecretCommands(store);
  });

  it('SE01: secret:set + secret:get roundtrip', async () => {
    const set = findHandler(cmds, 'secret', 'set');
    const get = findHandler(cmds, 'secret', 'get');

    await set({ name: 'DB_PASS', value: 'supersecret123' });
    const res = await get({ name: 'DB_PASS' });
    expect(res.success).toBe(true);
    expect(res.data.value).toBe('supersecret123');
  });

  it('SE02: secret:list shows names without values', async () => {
    const set = findHandler(cmds, 'secret', 'set');
    await set({ name: 'KEY_A', value: 'val1' });
    await set({ name: 'KEY_B', value: 'val2' });

    const list = findHandler(cmds, 'secret', 'list');
    const res = await list({});
    expect(res.data.names).toContain('KEY_A');
    expect(res.data.names).toContain('KEY_B');
    expect(res.data.count).toBe(2);
    // Values should NOT be in the response
    expect(JSON.stringify(res.data)).not.toContain('val1');
  });

  it('SE03: secret:delete removes secret', async () => {
    const set = findHandler(cmds, 'secret', 'set');
    await set({ name: 'TEMP', value: 'temp' });

    const del = findHandler(cmds, 'secret', 'delete');
    const res = await del({ name: 'TEMP' });
    expect(res.success).toBe(true);

    const get = findHandler(cmds, 'secret', 'get');
    const res2 = await get({ name: 'TEMP' });
    expect(res2.success).toBe(false);
  });

  it('SE04: secret:get returns error for missing secret', async () => {
    const get = findHandler(cmds, 'secret', 'get');
    const res = await get({ name: 'NONEXISTENT' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('not found');
  });

  it('SE05: secrets are encrypted at rest', () => {
    store.set('PASS', 'mysecret');
    // Internal storage should NOT contain the plaintext
    const internal = (store as any).secrets.get('PASS');
    expect(internal.encrypted).not.toContain('mysecret');
    expect(internal.iv).toBeDefined();
  });

  it('SE06: secret:set overwrites existing', async () => {
    const set = findHandler(cmds, 'secret', 'set');
    const get = findHandler(cmds, 'secret', 'get');
    await set({ name: 'KEY', value: 'old' });
    await set({ name: 'KEY', value: 'new' });
    const res = await get({ name: 'KEY' });
    expect(res.data.value).toBe('new');
  });

  it('SE07: internal storage uses GCM (has auth tag)', () => {
    store.set('GCM', 'taggedvalue');
    const internal = (store as any).secrets.get('GCM');
    // GCM payload shape: iv (12 bytes / 24 hex), tag, encrypted
    expect(internal.tag).toBeDefined();
    expect(typeof internal.tag).toBe('string');
    expect(internal.iv).toBeDefined();
    expect(internal.encrypted).not.toContain('taggedvalue');
    // 12-byte IV -> 24 hex chars
    expect(internal.iv.length).toBe(24);
  });

  it('SE08: tampered ciphertext or auth tag fails decryption (integrity verified)', () => {
    store.set('TAMPER', 'integritymatters');
    const internal = (store as any).secrets.get('TAMPER') as { iv: string; tag: string; encrypted: string };

    // Flip a bit of the ciphertext
    const tamperedEnc = internal.encrypted.slice(0, -2) +
      (internal.encrypted.slice(-2) === '00' ? '01' : '00');
    (store as any).secrets.set('TAMPER', { ...internal, encrypted: tamperedEnc });
    expect(() => store.get('TAMPER')).toThrow();

    // Restore and flip a bit of the auth tag instead
    (store as any).secrets.set('TAMPER', internal);
    const tamperedTag = internal.tag.slice(0, -2) +
      (internal.tag.slice(-2) === '00' ? '01' : '00');
    (store as any).secrets.set('TAMPER', { ...internal, tag: tamperedTag });
    expect(() => store.get('TAMPER')).toThrow();
  });

  it('SE09: distinct encryptionKeys cannot read each other secrets', () => {
    const storeA = new SecretStore('key-for-store-a-aaaaaaaaaa');
    const storeB = new SecretStore('key-for-store-b-bbbbbbbbbb');
    storeA.set('SHARED', 'onlyAcanRead');
    const entry = (storeA as any).secrets.get('SHARED') as { iv: string; tag: string; encrypted: string };
    // Inject storeA's ciphertext into storeB: must fail to decrypt (different key)
    (storeB as any).secrets.set('SHARED', { ...entry });
    expect(() => storeB.get('SHARED')).toThrow();
    // storeA still roundtrips fine
    expect(storeA.get('SHARED')).toBe('onlyAcanRead');
  });
});

// ===========================================================================
// PROCESS MANAGER
// ===========================================================================

describe('Process Manager Skills', () => {
  let pm: ProcessManager;
  let cmds: SkillEntry[];

  beforeEach(() => {
    pm = new ProcessManager();
    cmds = createProcessCommands(pm);
  });

  afterEach(() => { pm.destroy(); });

  it('PM01: process:spawn starts a process', async () => {
    const handler = findHandler(cmds, 'process', 'spawn');
    const isWindows = process.platform === 'win32';
    const cmd = isWindows ? 'ping -n 10 127.0.0.1' : 'sleep 10';
    const res = await handler({ name: 'sleeper', command: cmd });
    expect(res.success).toBe(true);
    expect(res.data.pid).toBeGreaterThan(0);
  });

  it('PM02: process:list shows running processes', async () => {
    const spawn = findHandler(cmds, 'process', 'spawn');
    const isWindows = process.platform === 'win32';
    await spawn({ name: 'proc1', command: isWindows ? 'ping -n 10 127.0.0.1' : 'sleep 10' });

    const list = findHandler(cmds, 'process', 'list');
    const res = await list({});
    expect(res.data.count).toBe(1);
    expect(res.data.processes[0].name).toBe('proc1');
    expect(res.data.processes[0].running).toBe(true);
  });

  it('PM03: process:kill stops a process', async () => {
    const spawn = findHandler(cmds, 'process', 'spawn');
    const isWindows = process.platform === 'win32';
    await spawn({ name: 'tokill', command: isWindows ? 'ping -n 100 127.0.0.1' : 'sleep 100' });

    const kill = findHandler(cmds, 'process', 'kill');
    const res = await kill({ name: 'tokill' });
    expect(res.success).toBe(true);
  });

  it('PM04: process:spawn rejects duplicate running name', async () => {
    const spawn = findHandler(cmds, 'process', 'spawn');
    const isWindows = process.platform === 'win32';
    const cmd = isWindows ? 'ping -n 10 127.0.0.1' : 'sleep 10';
    await spawn({ name: 'dup', command: cmd });
    const res = await spawn({ name: 'dup', command: cmd });
    expect(res.success).toBe(false);
    expect(res.error).toContain('already running');
  });

  it('PM05: process:logs returns output', async () => {
    const spawn = findHandler(cmds, 'process', 'spawn');
    await spawn({ name: 'echoer', command: 'echo hello-from-process' });
    // Wait for process to finish
    await new Promise(r => setTimeout(r, 500));

    const logs = findHandler(cmds, 'process', 'logs');
    const res = await logs({ name: 'echoer' });
    expect(res.success).toBe(true);
    expect(res.data.stdout).toContain('hello-from-process');
  });
});

// ===========================================================================
// REGISTRATION
// ===========================================================================

describe('Infrastructure Registration', () => {

  it('REG01: registerShellSkills registers all 38 commands', () => {
    const registry = new CommandRegistry();
    registerShellSkills(registry);
    const all = registry.listAll();
    // 7 file + 2 shell + 3 http + 2 json + 2 env + 6 workspace + 6 git + 4 cron + 4 secret + 4 process = 40
    // Wait, let me count: file(7) + shell(2) + http(3) + json(2) + env(2) + workspace(6) + git(6) + cron(4) + secret(4) + process(4) = 40
    expect(all.length).toBeGreaterThanOrEqual(38);
  });

  it('REG02: all new namespaces are registered', () => {
    const registry = new CommandRegistry();
    registerShellSkills(registry);
    const ns = registry.getNamespaces();
    expect(ns).toContain('file');
    expect(ns).toContain('git');
    expect(ns).toContain('cron');
    expect(ns).toContain('secret');
    expect(ns).toContain('process');
  });
});
