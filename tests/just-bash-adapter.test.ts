/**
 * Tests for ShellAdapter (just-bash integration module).
 *
 * Tests NativeShellAdapter directly (always available).
 * Tests JustBashShellAdapter with a mock Bash instance.
 * Tests factory auto-detection and skill registration with adapter injection.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NativeShellAdapter, JustBashShellAdapter } from '../src/just-bash/adapter.js';
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

  it('SK03: registerShellSkills accepts custom adapter', () => {
    const mock = createMockAdapter();
    const registry = new CommandRegistry();

    registerShellSkills(registry, mock);

    const all = registry.listAll();
    expect(all).toHaveLength(18);
    expect(registry.getNamespaces()).toContain('shell');
    expect(registry.getNamespaces()).toContain('file');
    expect(registry.getNamespaces()).toContain('http');
  });

  it('SK04: registerShellSkills without adapter uses default', () => {
    const registry = new CommandRegistry();
    registerShellSkills(registry);

    expect(registry.listAll()).toHaveLength(18);
  });
});
