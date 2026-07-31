/**
 * @module skills/process-mgr
 * @description Background process management.
 * Spawns long-running processes and tracks their output.
 */

import { command } from '../command-builder/index.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve, isAbsolute } from 'node:path';
import type { SkillEntry } from './scaffold.js';
import { filterSensitiveEnv } from '../security/secret-patterns.js';
import { createPathJail } from '../security/path-jail.js';

// ---------------------------------------------------------------------------
// ProcessManager
// ---------------------------------------------------------------------------

interface ManagedProcess {
  name: string;
  command: string;
  pid: number;
  process: ChildProcess;
  stdout: string[];
  stderr: string[];
  startedAt: string;
  exitCode: number | null;
}

const MAX_OUTPUT_LINES = 200;

export class ProcessManager {
  private processes: Map<string, ManagedProcess> = new Map();

  spawn(name: string, cmd: string, cwd?: string): { success: boolean; pid?: number; error?: string } {
    if (this.processes.has(name)) {
      const existing = this.processes.get(name)!;
      if (existing.exitCode === null) {
        return { success: false, error: `Process '${name}' is already running (pid ${existing.pid})` };
      }
      // Replace finished process
      this.processes.delete(name);
    }

    // Pass the whole command as a single string with shell:true so the shell
    // itself parses quoting/args. Splitting on whitespace and passing that as
    // an args array together with shell:true is the anti-pattern Node flags
    // via DEP0190: args reach the shell unescaped, and quoted arguments
    // (e.g. `--name "my app"`) get split apart incorrectly.
    const proc = spawn(cmd, {
      cwd: cwd || process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      shell: true,
      // Same reasoning as NativeShellAdapter.exec (just-bash/adapter.ts) and
      // gitExec (shell-git.ts): process:spawn only requires process:write,
      // not env:read, so a background process inheriting the full host
      // environment verbatim would let an agent read every credential
      // (e.g. via `process:spawn --command env`, then process:logs) through
      // a side door the env:get/env:list masking never covers.
      env: filterSensitiveEnv(process.env),
    });

    if (!proc.pid) {
      return { success: false, error: `Failed to spawn process: ${cmd}` };
    }

    const managed: ManagedProcess = {
      name, command: cmd, pid: proc.pid, process: proc,
      stdout: [], stderr: [], startedAt: new Date().toISOString(), exitCode: null,
    };

    proc.stdout?.on('data', (data: Buffer) => {
      managed.stdout.push(data.toString());
      while (managed.stdout.length > MAX_OUTPUT_LINES) managed.stdout.shift();
    });

    proc.stderr?.on('data', (data: Buffer) => {
      managed.stderr.push(data.toString());
      while (managed.stderr.length > MAX_OUTPUT_LINES) managed.stderr.shift();
    });

    proc.on('close', (code) => {
      managed.exitCode = code ?? 1;
    });

    this.processes.set(name, managed);
    return { success: true, pid: proc.pid };
  }

  list(): Array<{ name: string; command: string; pid: number; running: boolean; exitCode: number | null; startedAt: string; uptimeMs: number }> {
    return Array.from(this.processes.values()).map(p => ({
      name: p.name, command: p.command, pid: p.pid,
      running: p.exitCode === null,
      exitCode: p.exitCode, startedAt: p.startedAt,
      uptimeMs: Date.now() - new Date(p.startedAt).getTime(),
    }));
  }

  kill(name: string): boolean {
    const proc = this.processes.get(name);
    if (!proc || proc.exitCode !== null) return false;
    try { proc.process.kill('SIGTERM'); } catch { /* ignore */ }
    return true;
  }

  logs(name: string): { stdout: string; stderr: string } | null {
    const proc = this.processes.get(name);
    if (!proc) return null;
    return { stdout: proc.stdout.join(''), stderr: proc.stderr.join('') };
  }

  destroy(): void {
    for (const proc of this.processes.values()) {
      if (proc.exitCode === null) {
        try { proc.process.kill('SIGTERM'); } catch { /* ignore */ }
      }
    }
    this.processes.clear();
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const spawnDef = command('process', 'spawn').version('1.0.0')
  .description('Start a background process')
  .requiredParam('command', 'string').requiredParam('name', 'string')
  .optionalParam('cwd', 'string', '')
  .example('process:spawn --name devserver --command "npm run dev" --cwd /opt/myapp')
  .tags('process', 'write', 'background').build();

const listDef = command('process', 'list').version('1.0.0')
  .description('List managed background processes')
  .example('process:list')
  .tags('process', 'read').build();

const killDef = command('process', 'kill').version('1.0.0')
  .description('Kill a background process by name')
  .requiredParam('name', 'string')
  .example('process:kill --name devserver')
  .tags('process', 'write').build();

const logsDef = command('process', 'logs').version('1.0.0')
  .description('Get stdout/stderr from a background process')
  .requiredParam('name', 'string')
  .example('process:logs --name devserver')
  .tags('process', 'read').build();

spawnDef.requiredPermissions = ['process:write'];
listDef.requiredPermissions = ['process:read'];
killDef.requiredPermissions = ['process:write'];
logsDef.requiredPermissions = ['process:read'];

/**
 * Creates process command entries. An optional `jailRoot` constrains
 * process:spawn's `--cwd` to a single subtree, the same containment
 * createFileCommands()/createGitCommands()/createWorkspaceCommands() offer
 * — without it, a caller holding only `process:write` could spawn a shell
 * command with an arbitrary `--cwd` anywhere on disk, fully escaping a jail
 * configured for file:*, git:*, or workspace:*.
 *
 * Without jailRoot, behavior is byte-identical to before this option
 * existed (unresolved `args.cwd`, natural child_process cwd default).
 */
export function createProcessCommands(manager?: ProcessManager, jailRoot?: string): SkillEntry[] {
  const pm = manager || new ProcessManager();
  const assertInsideJail = createPathJail(jailRoot);
  const jailRootAbs = jailRoot ? resolve(jailRoot) : null;

  function resolveCwd(rawCwd: string | undefined): { ok: true; cwd: string | undefined } | { ok: false; error: string } {
    if (!jailRootAbs) return { ok: true, cwd: rawCwd || undefined };
    const base = rawCwd ? (isAbsolute(rawCwd) ? rawCwd : resolve(jailRootAbs, rawCwd)) : jailRootAbs;
    const check = assertInsideJail(base);
    if (!check.ok) return { ok: false, error: check.error };
    return { ok: true, cwd: check.resolved };
  }

  return [
    { definition: spawnDef, handler: async (args: any) => {
      const cwdCheck = resolveCwd(args.cwd || undefined);
      if (!cwdCheck.ok) return { success: false, data: null, error: cwdCheck.error };
      const res = pm.spawn(args.name, args.command, cwdCheck.cwd);
      return res.success
        ? { success: true, data: { name: args.name, pid: res.pid, command: args.command, spawned: true } }
        : { success: false, data: null, error: res.error };
    }},
    { definition: listDef, handler: async () => {
      const procs = pm.list();
      return { success: true, data: { processes: procs, count: procs.length } };
    }},
    { definition: killDef, handler: async (args: any) => {
      const killed = pm.kill(args.name);
      return killed
        ? { success: true, data: { name: args.name, killed: true } }
        : { success: false, data: null, error: `Process '${args.name}' not found or already stopped` };
    }},
    { definition: logsDef, handler: async (args: any) => {
      const logs = pm.logs(args.name);
      if (!logs) return { success: false, data: null, error: `Process '${args.name}' not found` };
      return { success: true, data: { name: args.name, ...logs } };
    }},
  ];
}

export const processCommands: SkillEntry[] = createProcessCommands();
