/**
 * @module just-bash/adapter
 * @description Shell adapter implementations.
 *
 * JustBashShellAdapter: sandboxed bash interpreter (requires just-bash peer dep)
 * NativeShellAdapter: real child_process + fs (always available, fallback)
 */

import type { ShellAdapter, ShellResult, ShellExecOptions, DirEntry } from './types.js';

// ---------------------------------------------------------------------------
// JustBashShellAdapter — sandboxed TypeScript bash interpreter
// ---------------------------------------------------------------------------

/**
 * Wraps a just-bash Bash instance as a ShellAdapter.
 * Provides sandboxed execution with virtual filesystem and 79 built-in commands.
 */
export class JustBashShellAdapter implements ShellAdapter {
  readonly backend = 'just-bash';
  private bash: any; // just-bash Bash instance

  constructor(bashInstance: any) {
    this.bash = bashInstance;
  }

  async exec(command: string, opts?: ShellExecOptions): Promise<ShellResult> {
    const execOpts: any = {};
    if (opts?.cwd) execOpts.cwd = opts.cwd;
    if (opts?.env) execOpts.env = opts.env;
    if (opts?.timeout) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeout);
      execOpts.signal = controller.signal;
      try {
        const result = await this.bash.exec(command, execOpts);
        clearTimeout(timer);
        return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
      } catch (err: any) {
        clearTimeout(timer);
        if (err.name === 'AbortError') {
          return { stdout: '', stderr: `Timeout after ${opts.timeout}ms`, exitCode: 124 };
        }
        return { stdout: '', stderr: err.message, exitCode: 1 };
      }
    }

    try {
      const result = await this.bash.exec(command, execOpts);
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    } catch (err: any) {
      return { stdout: '', stderr: err.message, exitCode: 1 };
    }
  }

  async which(program: string): Promise<{ program: string; path: string | null; found: boolean }> {
    const result = await this.exec(`which ${program}`);
    if (result.exitCode === 0 && result.stdout.trim()) {
      return { program, path: result.stdout.trim(), found: true };
    }
    return { program, path: null, found: false };
  }

  async readFile(path: string): Promise<{ path: string; content: string; size: number }> {
    const content = await this.bash.readFile(path);
    return { path, content, size: Buffer.byteLength(content, 'utf-8') };
  }

  async writeFile(path: string, content: string): Promise<{ path: string; size: number; written: boolean }> {
    await this.bash.writeFile(path, content);
    return { path, size: Buffer.byteLength(content, 'utf-8'), written: true };
  }

  async listDir(path: string, pattern?: string): Promise<{ path: string; entries: DirEntry[]; count: number }> {
    // Use bash's ls to list directory, parse output
    const result = await this.exec(`ls -la ${path}`);
    if (result.exitCode !== 0) {
      throw new Error(`listDir failed: ${result.stderr}`);
    }

    // Parse ls -la output (skip total line and . / .. entries)
    const lines = result.stdout.trim().split('\n').filter(l => l && !l.startsWith('total'));
    const entries: DirEntry[] = [];

    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length < 9) continue;
      const name = parts.slice(8).join(' ');
      if (name === '.' || name === '..') continue;
      const type = parts[0].startsWith('d') ? 'directory' as const : 'file' as const;
      const size = parseInt(parts[4], 10) || 0;
      entries.push({ name, type, size });
    }

    const filtered = pattern ? entries.filter(e => e.name.includes(pattern)) : entries;
    return { path, entries: filtered, count: filtered.length };
  }
}

// ---------------------------------------------------------------------------
// NativeShellAdapter — real child_process + fs (always available)
// ---------------------------------------------------------------------------

/**
 * Uses Node.js child_process and fs for real system access.
 * This is the fallback when just-bash is not installed.
 */
export class NativeShellAdapter implements ShellAdapter {
  readonly backend = 'native';

  async exec(command: string, opts?: ShellExecOptions): Promise<ShellResult> {
    const { execSync } = await import('node:child_process');
    try {
      const options: any = {
        encoding: 'utf-8',
        timeout: opts?.timeout ?? 30000,
        maxBuffer: 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      };
      if (opts?.cwd) options.cwd = opts.cwd;
      if (opts?.env) options.env = { ...process.env, ...opts.env };

      const stdout = execSync(command, options) as string;
      return { stdout: stdout.trimEnd(), stderr: '', exitCode: 0 };
    } catch (err: any) {
      return {
        stdout: (err.stdout || '').toString().trimEnd(),
        stderr: (err.stderr || '').toString().trimEnd(),
        exitCode: err.status ?? 1,
      };
    }
  }

  async which(program: string): Promise<{ program: string; path: string | null; found: boolean }> {
    const isWindows = process.platform === 'win32';
    const cmd = isWindows ? `where ${program}` : `which ${program}`;
    const result = await this.exec(cmd, { timeout: 5000 });
    if (result.exitCode === 0 && result.stdout.trim()) {
      return { program, path: result.stdout.split('\n')[0].trim(), found: true };
    }
    return { program, path: null, found: false };
  }

  async readFile(path: string, encoding?: string): Promise<{ path: string; content: string; size: number }> {
    const fs = await import('node:fs/promises');
    const content = await fs.readFile(path, { encoding: (encoding || 'utf-8') as BufferEncoding });
    const stats = await fs.stat(path);
    return { path, content, size: stats.size };
  }

  async writeFile(path: string, content: string): Promise<{ path: string; size: number; written: boolean }> {
    const fs = await import('node:fs/promises');
    await fs.writeFile(path, content, 'utf-8');
    return { path, size: Buffer.byteLength(content, 'utf-8'), written: true };
  }

  async listDir(path: string, pattern?: string): Promise<{ path: string; entries: DirEntry[]; count: number }> {
    const fs = await import('node:fs/promises');
    const { join } = await import('node:path');
    const dirEntries = await fs.readdir(path, { withFileTypes: true });

    const entries: DirEntry[] = await Promise.all(
      dirEntries.map(async (entry) => {
        let size = 0;
        try {
          const s = await fs.stat(join(path, entry.name));
          size = s.size;
        } catch { /* ignore */ }
        return {
          name: entry.name,
          type: (entry.isDirectory() ? 'directory' : 'file') as 'file' | 'directory',
          size,
        };
      })
    );

    const filtered = pattern ? entries.filter(e => e.name.includes(pattern)) : entries;
    return { path, entries: filtered, count: filtered.length };
  }
}
