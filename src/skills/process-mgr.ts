/**
 * @module skills/process-mgr
 * @description Background process management.
 * Spawns long-running processes and tracks their output.
 */

import { command } from '../command-builder/index.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve, isAbsolute } from 'node:path';
import type { SkillEntry } from './scaffold.js';
import { filterSensitiveEnv, maskSecrets } from '../security/secret-patterns.js';
import { createPathJail } from '../security/path-jail.js';

// ---------------------------------------------------------------------------
// ProcessManager
// ---------------------------------------------------------------------------

/** Chunks of captured output plus a running byte total, so eviction doesn't need to re-sum the array on every push. */
interface OutputBuffer {
  chunks: string[];
  bytes: number;
}

interface ManagedProcess {
  name: string;
  command: string;
  pid: number;
  process: ChildProcess;
  stdout: OutputBuffer;
  stderr: OutputBuffer;
  startedAt: string;
  exitCode: number | null;
}

/**
 * Regresion (ronda 47 del audit, MEDIUM F3): el cap anterior (200 chunks)
 * acotaba la CANTIDAD de eventos 'data' guardados, no los bytes — pese al
 * nombre, no hacia split por linea, asi que un solo chunk podia ser de
 * cualquier tamano tal como lo entrega el pipe del SO. Mas debil que el
 * cap por bytes que este mismo repo ya aplica en sinks comparables
 * (shell-git.ts y NativeShellAdapter.exec via `maxBuffer: 10 * 1024 *
 * 1024`). Este cap aplica el mismo limite, por bytes, independientemente
 * para stdout y stderr de cada proceso trackeado.
 */
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/** Appends `data` to `buffer`, evicting the oldest chunks (FIFO) while over MAX_OUTPUT_BYTES. */
function appendCapped(buffer: OutputBuffer, data: Buffer): void {
  const text = data.toString();
  buffer.chunks.push(text);
  buffer.bytes += Buffer.byteLength(text, 'utf-8');
  while (buffer.bytes > MAX_OUTPUT_BYTES && buffer.chunks.length > 0) {
    const removed = buffer.chunks.shift()!;
    buffer.bytes -= Buffer.byteLength(removed, 'utf-8');
  }
}

/**
 * Grace period between SIGTERM and escalating to SIGKILL (ronda 47 del
 * audit, MEDIUM F2). Every signal-sending path in this file previously
 * sent SIGTERM only, with no escalation and no verification the process
 * actually died — terminate() below is now the single place that does
 * both, used by kill(), destroy(), and the MAX_PROCESSES eviction path.
 */
const TERMINATE_GRACE_MS = 3000;
/** Bound on how long terminate() waits for the close event after SIGKILL — a process stuck in an uninterruptible syscall must not hang the caller forever. */
const KILL_WAIT_MS = 2000;

// Unlike a finished process (whose entry only holds inert buffered
// output), an unbounded number of DISTINCT names spawned over the
// server's lifetime (e.g. timestamp/UUID-suffixed job names, a normal
// devops pattern) previously accumulated forever — kill()/close never
// removed a Map entry, only re-spawning the SAME name did. Same
// bounded-Map + oldest-eviction pattern as WorkspaceSessionStore /
// SessionScopedContextStore (MAX_SESSIONS=200).
const MAX_PROCESSES = 200;

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

    // Bound the map BEFORE inserting. A still-running evictee is killed
    // first — dropping it from the map alone wouldn't reclaim anything,
    // since its own stdout/stderr/close listeners keep it referenced (and
    // the OS process running) for as long as node keeps the ChildProcess
    // alive. Map iteration order is insertion order, so this evicts the
    // oldest entry.
    if (this.processes.size >= MAX_PROCESSES) {
      const oldestKey = this.processes.keys().next().value;
      if (oldestKey !== undefined) {
        const oldest = this.processes.get(oldestKey)!;
        // Fire-and-forget: spawn() stays synchronous (evicting process #201
        // must not block spawning process #202), but the evictee still gets
        // the same SIGTERM->SIGKILL escalation as kill()/destroy() instead
        // of a single best-effort SIGTERM that could leave it running
        // forever if it ignores SIGTERM (ronda 47 del audit, MEDIUM F2).
        if (oldest.exitCode === null) {
          this.terminate(oldest).catch(() => { /* ignore */ });
        }
        this.processes.delete(oldestKey);
      }
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
      // Regresion (ronda 39 del audit, HIGH): ManagedProcess.command
      // guardaba el string crudo, expuesto sin masquear via process:list()
      // a CUALQUIER sesion con solo process:read — un permiso sin ninguna
      // relacion con el origen de la credencial que el comando original
      // pudiera llevar (p.ej. --command "curl -H 'Authorization: Bearer
      // sk-XXX' ..."). ProcessManager es una unica instancia compartida
      // por TODAS las sesiones del proceso (mismo registry, mismo Core),
      // asi que esto persistia cross-session hasta MAX_PROCESSES=200
      // entradas. maskSecrets() se aplica aca, sobre el valor GUARDADO
      // (spawn() ya corrio con el `cmd` real momentos antes) — no afecta
      // la ejecucion real, solo lo que list() expone despues.
      name, command: maskSecrets(cmd), pid: proc.pid, process: proc,
      stdout: { chunks: [], bytes: 0 }, stderr: { chunks: [], bytes: 0 },
      startedAt: new Date().toISOString(), exitCode: null,
    };

    proc.stdout?.on('data', (data: Buffer) => appendCapped(managed.stdout, data));
    proc.stderr?.on('data', (data: Buffer) => appendCapped(managed.stderr, data));

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

  /**
   * Sends SIGTERM and waits for the process to actually exit before
   * resolving `true` — unlike the previous fire-and-forget version, a
   * caller awaiting kill() now gets a real signal of whether the process
   * died, not just that a signal was sent (ronda 47 del audit, MEDIUM F2).
   * Escalation/verification itself lives in terminate() below, shared
   * with destroy() and the MAX_PROCESSES eviction path.
   */
  async kill(name: string): Promise<boolean> {
    const proc = this.processes.get(name);
    if (!proc || proc.exitCode !== null) return false;
    await this.terminate(proc);
    return true;
  }

  logs(name: string): { stdout: string; stderr: string } | null {
    const proc = this.processes.get(name);
    if (!proc) return null;
    return { stdout: proc.stdout.chunks.join(''), stderr: proc.stderr.chunks.join('') };
  }

  /** Resolves true once `proc` closes, or false if `timeoutMs` elapses first. */
  private waitForExit(proc: ManagedProcess, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolveWait) => {
      if (proc.exitCode !== null) { resolveWait(true); return; }
      const onClose = () => { clearTimeout(timer); resolveWait(true); };
      const timer = setTimeout(() => { proc.process.off('close', onClose); resolveWait(false); }, timeoutMs);
      proc.process.once('close', onClose);
    });
  }

  /**
   * Sends SIGTERM, waits up to TERMINATE_GRACE_MS for the process to exit,
   * and escalates to SIGKILL (waiting up to KILL_WAIT_MS more) if it's
   * still alive — the single place every signal-sending path in this file
   * routes through (kill(), destroy(), MAX_PROCESSES eviction). Previously
   * each path sent only SIGTERM with no escalation and no verification the
   * process actually died (ronda 47 del audit, MEDIUM F2).
   */
  private async terminate(proc: ManagedProcess): Promise<void> {
    if (proc.exitCode !== null) return;
    try { proc.process.kill('SIGTERM'); } catch { /* ignore */ }
    const exited = await this.waitForExit(proc, TERMINATE_GRACE_MS);
    if (exited || proc.exitCode !== null) return;
    try { proc.process.kill('SIGKILL'); } catch { /* ignore */ }
    await this.waitForExit(proc, KILL_WAIT_MS);
  }

  /**
   * Terminates all managed processes and waits for each to actually exit
   * (not just for the kill signal to be sent) before resolving. On Windows,
   * a child process keeps its `cwd` directory locked until it fully exits —
   * a caller that deletes that directory right after destroy() (e.g. test
   * cleanup) previously hit an intermittent EPERM because destroy() only
   * fired SIGTERM and returned immediately.
   */
  async destroy(): Promise<void> {
    const waits = Array.from(this.processes.values())
      .filter((proc) => proc.exitCode === null)
      .map((proc) => this.terminate(proc));
    await Promise.all(waits);
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

// process:spawn runs an arbitrary shell command via child_process.spawn
// with shell:true — the same command-execution sink as shell:exec.
// Same reasoning as cron:schedule's requiredPermissions (see cron.ts):
// without shell:exec here too, a role granted process:write but
// deliberately not shell:exec gets arbitrary command execution anyway
// via process:spawn (readable back via process:logs).
spawnDef.requiredPermissions = ['process:write', 'shell:exec'];
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
      const killed = await pm.kill(args.name);
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
