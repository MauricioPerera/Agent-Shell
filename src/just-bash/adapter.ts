/**
 * @module just-bash/adapter
 * @description Shell adapter implementations.
 *
 * JustBashShellAdapter: sandboxed bash interpreter (requires just-bash peer dep)
 * NativeShellAdapter: real child_process + fs (always available, fallback)
 */

import type { ShellAdapter, ShellResult, ShellExecOptions, DirEntry } from './types.js';
import { filterSensitiveEnv } from '../security/secret-patterns.js';

/**
 * POSIX single-quote escaping: wraps `value` so a shell parses it as one
 * literal argument, regardless of embedded spaces, `;`, `&`, `|`, `$`, `` ` ``,
 * etc. Used wherever an argument is interpolated into a command string that
 * gets parsed by a shell (just-bash's sandboxed bash interpreter here) —
 * the alternative (raw interpolation) lets that argument break out into a
 * second shell command.
 */
function shellQuoteSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

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
    const result = await this.exec(`which ${shellQuoteSingle(program)}`);
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
    const result = await this.exec(`ls -la ${shellQuoteSingle(path)}`);
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

  async mkdir(path: string, opts?: { recursive?: boolean }): Promise<{ path: string; created: boolean }> {
    const flag = opts?.recursive !== false ? '-p ' : '';
    const result = await this.exec(`mkdir ${flag}${shellQuoteSingle(path)}`);
    if (result.exitCode !== 0) {
      throw new Error(`mkdir failed: ${result.stderr}`);
    }
    return { path, created: true };
  }

  async remove(path: string, opts?: { recursive?: boolean }): Promise<{ path: string; deleted: boolean }> {
    const flags = opts?.recursive ? '-rf' : '-f';
    const result = await this.exec(`rm ${flags} ${shellQuoteSingle(path)}`);
    if (result.exitCode !== 0) {
      throw new Error(`remove failed: ${result.stderr}`);
    }
    return { path, deleted: true };
  }

  async rename(from: string, to: string): Promise<{ from: string; to: string; renamed: boolean }> {
    const result = await this.exec(`mv ${shellQuoteSingle(from)} ${shellQuoteSingle(to)}`);
    if (result.exitCode !== 0) {
      throw new Error(`rename failed: ${result.stderr}`);
    }
    return { from, to, renamed: true };
  }

  async chmod(path: string, mode: number): Promise<{ path: string; mode: number }> {
    const octal = (mode & 0o777).toString(8).padStart(3, '0');
    const result = await this.exec(`chmod ${octal} ${shellQuoteSingle(path)}`);
    if (result.exitCode !== 0) {
      throw new Error(`chmod failed: ${result.stderr}`);
    }
    return { path, mode };
  }
}

// ---------------------------------------------------------------------------
// NativeShellAdapter — real child_process + fs (always available)
// ---------------------------------------------------------------------------

/** Hard ceiling on exec timeout, regardless of what the caller (an agent) requests. */
export const MAX_EXEC_TIMEOUT_MS = 5 * 60 * 1000;

/** Clamps a caller-requested timeout into [0, MAX_EXEC_TIMEOUT_MS]. Exported for direct unit testing. */
export function clampExecTimeout(requested?: number): number {
  return Math.min(Math.max(requested ?? 30000, 0), MAX_EXEC_TIMEOUT_MS);
}

/**
 * Uses Node.js child_process and fs for real system access.
 * This is the fallback when just-bash is not installed.
 */
export class NativeShellAdapter implements ShellAdapter {
  readonly backend = 'native';

  async exec(command: string, opts?: ShellExecOptions): Promise<ShellResult> {
    // Async exec (not execSync): execSync blocks Node's entire event loop —
    // not just this call — for the whole duration, so an agent-controlled
    // timeout with no server-side ceiling was a DoS of the whole process,
    // not just its own request. exec() lets other requests keep running
    // while this one is in flight, and the timeout below bounds the worst case.
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);

    const timeout = clampExecTimeout(opts?.timeout);

    try {
      const options: any = {
        encoding: 'utf-8',
        timeout,
        maxBuffer: 1024 * 1024,
      };
      if (opts?.cwd) options.cwd = opts.cwd;
      // Never inherit process.env verbatim: shell:exec only requires the
      // `shell:exec` permission, not `env:read`, so a child process that
      // silently inherited the full host environment let an agent read
      // every credential (`env`, `printenv`, etc.) without the masking
      // env:get/env:list already apply — an unmasked read through a side
      // door. Strip anything that looks sensitive by name; explicit
      // `opts.env` entries (set by trusted internal callers, not the raw
      // agent-supplied command string) still pass through unfiltered.
      options.env = { ...filterSensitiveEnv(process.env), ...opts?.env };

      const { stdout } = await execAsync(command, options);
      // Matches the previous execSync-based behavior: stderr is only
      // surfaced on failure, not alongside a successful exit.
      return { stdout: stdout.toString().trimEnd(), stderr: '', exitCode: 0 };
    } catch (err: any) {
      return {
        stdout: (err.stdout || '').toString().trimEnd(),
        stderr: (err.stderr || '').toString().trimEnd(),
        exitCode: typeof err.code === 'number' ? err.code : 1,
      };
    }
  }

  async which(program: string): Promise<{ program: string; path: string | null; found: boolean }> {
    // execFileSync (array args, no shell) instead of a shell command string —
    // `program` never reaches a shell, so it can't break out into a second command.
    const { execFileSync } = await import('node:child_process');
    const isWindows = process.platform === 'win32';
    const bin = isWindows ? 'where' : 'which';
    try {
      const stdout = execFileSync(bin, [program], { encoding: 'utf-8', timeout: 5000 }) as string;
      const path = stdout.split('\n')[0].trim();
      if (path) return { program, path, found: true };
      return { program, path: null, found: false };
    } catch {
      return { program, path: null, found: false };
    }
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

  async mkdir(path: string, opts?: { recursive?: boolean }): Promise<{ path: string; created: boolean }> {
    const fs = await import('node:fs/promises');
    await fs.mkdir(path, { recursive: opts?.recursive !== false });
    return { path, created: true };
  }

  async remove(path: string, opts?: { recursive?: boolean }): Promise<{ path: string; deleted: boolean }> {
    const fs = await import('node:fs/promises');
    await fs.rm(path, { recursive: opts?.recursive === true, force: true });
    return { path, deleted: true };
  }

  async rename(from: string, to: string): Promise<{ from: string; to: string; renamed: boolean }> {
    const fs = await import('node:fs/promises');
    await fs.rename(from, to);
    return { from, to, renamed: true };
  }

  async chmod(path: string, mode: number): Promise<{ path: string; mode: number }> {
    const fs = await import('node:fs/promises');
    const masked = mode & 0o777;
    await fs.chmod(path, masked);
    return { path, mode: masked };
  }
}
