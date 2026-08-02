/**
 * @module skills/cron
 * @description Scheduled task execution via a plain repeating interval —
 * NOT general cron grammar. Supported interval shapes: shorthand
 * ('30s'/'5m'/'1h'/'2d'), '*\/N * * * *' (every N minutes), and
 * '0 *\/N * * * *' (every N hours). No ranges, lists, day-of-week/
 * day-of-month, seconds field, or wall-clock alignment — see
 * parseInterval() below. Ronda 38 del audit: renamed away from "cron
 * expressions" in this docstring, which overclaimed the actual grammar
 * supported (the schedule() error message had the same issue, also fixed).
 */

import { command } from '../command-builder/index.js';
import type { SkillEntry } from './scaffold.js';
import type { ShellAdapter } from '../just-bash/types.js';
import { NativeShellAdapter } from '../just-bash/adapter.js';
import { createPathJail } from '../security/path-jail.js';
import { maskSecrets } from '../security/secret-patterns.js';
import { resolve, isAbsolute } from 'node:path';

// ---------------------------------------------------------------------------
// CronScheduler
// ---------------------------------------------------------------------------

interface CronTask {
  name: string;
  command: string;
  interval: string;
  intervalMs: number;
  timer: ReturnType<typeof setInterval>;
  history: Array<{ exitCode: number; duration_ms: number; timestamp: string }>;
  createdAt: string;
  runCount: number;
  // Regresion (ronda 38 del audit, finding #2): sin este flag, un comando
  // mas lento que su propio intervalo (p.ej. --interval 30s con un
  // comando que tarda 45s) apilaba ejecuciones superpuestas sin limite —
  // cada tick de setInterval disparaba una nueva executeTask() sin
  // esperar a que la anterior terminara. Ahora un tick se salta (queda
  // registrado en history con exitCode -1) si la corrida previa sigue
  // activa.
  isRunning: boolean;
  // Regresion (ronda 50 del audit, HIGH): cancel() borraba la entrada del
  // Map incondicionalmente, incluso con una ejecucion en curso — el
  // ShellAdapter no expone forma de abortar esa ejecucion (su interfaz no
  // tiene AbortSignal), asi que el comando seguia corriendo contra un
  // objeto `task` huerfano que nadie podia ver ni parar: el resultado
  // (exit code, duracion) se perdia en silencio, dando al operador una
  // falsa sensacion de "ya esta detenido". Con este flag, cancel() detiene
  // los ticks FUTUROS de inmediato pero deja la entrada viva (visible via
  // cron:list()/cron:history()) en vez de borrarla — mismo patron que
  // ProcessManager, que tampoco borra un proceso ya terminado, solo deja
  // de tratarlo como "corriendo". Un cron:schedule posterior con el MISMO
  // nombre reemplaza una entrada cancelada e inactiva (ver schedule()).
  cancelled?: boolean;
}

const MAX_HISTORY_PER_TASK = 20;

// Regresion (ronda 38 del audit, finding #1 CRITICAL): setInterval/
// setTimeout en Node usan un entero de 32 bits para el delay — cualquier
// valor por encima de este maximo NO se rechaza ni se trata como "muy
// lejos en el futuro": Node lo clampea EN SILENCIO a 1ms
// (TimeoutOverflowWarning). schedule() solo chequeaba `ms < 1000`, asi
// que un intervalo perfectamente razonable como '25d' o '30d' (2,160,000,000
// ms > 2,147,483,647) pasaba la validacion y terminaba re-ejecutando el
// comando programado miles de veces por segundo — un DoS auto-infligido
// disparable con un input completamente normal, sin nada exotico.
const MAX_INTERVAL_MS = 2_147_483_647;

// Same bounded-Map + oldest-eviction pattern as ProcessManager
// (MAX_PROCESSES) and SecretStore (MAX_SECRETS): cron:schedule under
// unique names would otherwise grow `tasks` forever, each entry holding
// a LIVE setInterval that keeps re-running its command indefinitely —
// a more severe resource-exhaustion vector than pure memory growth,
// since MAX_HISTORY_PER_TASK only bounds an array INSIDE each task, not
// the number of tasks/timers itself.
const MAX_TASKS = 200;

// Regresion (ronda 50 del audit, HIGH): cuando cancel() se llama sobre una
// tarea en ejecucion, executeTask() la borra de `tasks` recien cuando esa
// corrida termina (ver el finally() de executeTask) — sin este archivo
// aparte, getHistory(name) buscaria la tarea en `tasks`, no la
// encontraria (ya borrada) y devolveria [] en silencio, perdiendo el
// resultado igual que antes del fix, solo que un tick mas tarde. Acotado
// igual que MAX_HISTORY_PER_TASK.
const MAX_CANCELLED_HISTORY = 50;

export class CronScheduler {
  private tasks: Map<string, CronTask> = new Map();
  private cancelledTaskHistory: Array<{ task: string; exitCode: number; duration_ms: number; timestamp: string }> = [];
  private readonly adapter: ShellAdapter;

  constructor(adapter?: ShellAdapter) {
    this.adapter = adapter || new NativeShellAdapter();
  }

  schedule(name: string, cmd: string, interval: string, cwd?: string): { success: boolean; error?: string } {
    if (this.tasks.has(name)) {
      return { success: false, error: `Task '${name}' already exists. Cancel it first.` };
    }

    const ms = parseInterval(interval);
    if (ms === null || ms < 1000) {
      return { success: false, error: `Invalid interval: '${interval}'. Only '*/N * * * *' (every N minutes), '0 */N * * * *' (every N hours), or shorthand (30s, 5m, 1h, 2d) are supported — general cron grammar (ranges, lists, day-of-week/day-of-month, seconds) is not implemented.` };
    }
    if (ms > MAX_INTERVAL_MS) {
      return { success: false, error: `Invalid interval: '${interval}' (${ms}ms) exceeds the maximum supported interval of ${MAX_INTERVAL_MS}ms (~24.8 days) — Node's setInterval silently misfires above this.` };
    }

    // Bound BEFORE inserting. Unlike the other bounded stores, the
    // evictee here holds a live timer that must be stopped — dropping it
    // from the Map alone would leave its setInterval running forever,
    // orphaned but still executing the scheduled command.
    if (this.tasks.size >= MAX_TASKS) {
      const oldestKey = this.tasks.keys().next().value;
      if (oldestKey !== undefined) {
        const oldest = this.tasks.get(oldestKey)!;
        clearInterval(oldest.timer);
        this.tasks.delete(oldestKey);
      }
    }

    const task: CronTask = {
      name, command: cmd, interval, intervalMs: ms,
      history: [], createdAt: new Date().toISOString(), runCount: 0, isRunning: false,
      timer: setInterval(() => { void this.executeTask(task, cwd); }, ms),
    };

    this.tasks.set(name, task);
    return { success: true };
  }

  /**
   * Stops future ticks immediately. If the task has an execution in
   * flight right now, the Map entry is kept alive (marked `cancelled`)
   * until that execution's own finally block removes it, instead of
   * discarding its still-pending result — see CronTask.cancelled above.
   */
  cancel(name: string): { cancelled: boolean; stillRunning: boolean } | null {
    const task = this.tasks.get(name);
    if (!task) return null;
    clearInterval(task.timer);
    if (task.isRunning) {
      task.cancelled = true;
      return { cancelled: true, stillRunning: true };
    }
    this.tasks.delete(name);
    return { cancelled: true, stillRunning: false };
  }

  list(): Array<{ name: string; command: string; interval: string; runCount: number; createdAt: string; cancelling?: boolean }> {
    // Regresion (ronda 39 del audit, HIGH): expuesto sin masquear a
    // CUALQUIER sesion con solo cron:read (cross-session — CronScheduler
    // es una unica instancia compartida por todas las sesiones del
    // proceso), igual que el finding gemelo en ProcessManager.list().
    // A diferencia de ese caso, aca NO se puede masquear en el momento
    // de guardar: executeTask() re-lee task.command en CADA tick para
    // efectivamente ejecutarlo (linea ~167) — masquear el valor guardado
    // rompería la tarea programada (ejecutaria el placeholder redactado en
    // vez del comando real). Se enmascara aca, solo en la lectura de
    // salida, dejando task.command intacto para la ejecucion real.
    return Array.from(this.tasks.values()).map(t => ({
      name: t.name, command: maskSecrets(t.command), interval: t.interval,
      runCount: t.runCount, createdAt: t.createdAt,
      // Present only while a cancelled task's in-flight execution hasn't
      // finished yet — see CronTask.cancelled.
      ...(t.cancelled ? { cancelling: true } : {}),
    }));
  }

  getHistory(name?: string): Array<{ task: string; exitCode: number; duration_ms: number; timestamp: string }> {
    if (name) {
      const task = this.tasks.get(name);
      if (task) return task.history.map(h => ({ task: name, ...h }));
      // The task itself may already be gone — cancel() on a still-running
      // task keeps its Map entry alive only until that run finishes (see
      // executeTask()'s finally), at which point it's removed and its
      // final result is archived here instead of vanishing with it.
      return this.cancelledTaskHistory.filter(h => h.task === name);
    }
    const all: Array<{ task: string; exitCode: number; duration_ms: number; timestamp: string }> = [];
    for (const [n, t] of this.tasks) {
      for (const h of t.history) all.push({ task: n, ...h });
    }
    all.push(...this.cancelledTaskHistory);
    all.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return all.slice(0, 20);
  }

  destroy(): void {
    for (const task of this.tasks.values()) clearInterval(task.timer);
    this.tasks.clear();
  }

  private async executeTask(task: CronTask, cwd?: string): Promise<void> {
    // Regresion (ronda 38 del audit, finding #2): sin este guard, un tick
    // que llega mientras la corrida anterior todavia esta activa disparaba
    // otra ejecucion superpuesta, sin limite de cuantas podian acumularse
    // en paralelo para el mismo task. Se salta el tick (y queda una
    // entrada en history, exitCode -1, para que quede visible via
    // cron:history en vez de desaparecer en silencio).
    if (task.isRunning) {
      task.history.push({ exitCode: -1, duration_ms: 0, timestamp: new Date().toISOString() });
      while (task.history.length > MAX_HISTORY_PER_TASK) task.history.shift();
      return;
    }

    task.isRunning = true;
    const start = Date.now();
    try {
      // Regresion (ronda 38 del audit, finding #3): sin este try/catch, un
      // ShellAdapter INYECTADO (constructor(adapter?: ShellAdapter) acepta
      // cualquier implementacion — createCronCommands()/CronScheduler no
      // estan atados a los 2 adapters builtin, que nunca rechazan) cuyo
      // exec() rechace produce una promesa no manejada en cada tick — no
      // hay ningun handler de unhandledRejection en todo el repo, asi que
      // eso tumba el proceso entero. Ahora degrada a una corrida fallida
      // registrada en history, en vez de crashear.
      const result = await this.adapter.exec(task.command, { cwd, timeout: 60_000 });
      task.runCount++;
      task.history.push({ exitCode: result.exitCode, duration_ms: Date.now() - start, timestamp: new Date().toISOString() });
    } catch {
      task.runCount++;
      task.history.push({ exitCode: -1, duration_ms: Date.now() - start, timestamp: new Date().toISOString() });
    } finally {
      while (task.history.length > MAX_HISTORY_PER_TASK) task.history.shift();
      task.isRunning = false;
      // cancel() left this entry alive specifically so the run above could
      // still record its result — now that it has, archive that result
      // (getHistory(name) would otherwise return [] the instant this task
      // is gone from `tasks`) and actually remove it.
      if (task.cancelled) {
        const last = task.history[task.history.length - 1];
        if (last) {
          this.cancelledTaskHistory.push({ task: task.name, ...last });
          while (this.cancelledTaskHistory.length > MAX_CANCELLED_HISTORY) this.cancelledTaskHistory.shift();
        }
        this.tasks.delete(task.name);
      }
    }
  }
}

function parseInterval(interval: string): number | null {
  // Shorthand: 30s, 5m, 1h, 2d
  const shorthand = interval.match(/^(\d+)(s|m|h|d)$/);
  if (shorthand) {
    const val = parseInt(shorthand[1], 10);
    switch (shorthand[2]) {
      case 's': return val * 1000;
      case 'm': return val * 60_000;
      case 'h': return val * 3_600_000;
      case 'd': return val * 86_400_000;
    }
  }
  // Simple cron: parse */N for minutes
  const cronMinute = interval.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
  if (cronMinute) return parseInt(cronMinute[1], 10) * 60_000;
  // Cron every N hours
  const cronHour = interval.match(/^0\s+\*\/(\d+)\s+\*\s+\*\s+\*$/);
  if (cronHour) return parseInt(cronHour[1], 10) * 3_600_000;
  return null;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const scheduleDef = command('cron', 'schedule').version('1.0.0')
  .description('Schedule a recurring task')
  .requiredParam('name', 'string').requiredParam('command', 'string').requiredParam('interval', 'string')
  .optionalParam('cwd', 'string', '')
  .example('cron:schedule --name backup --command "tar czf /tmp/backup.tar.gz /data" --interval 1h --cwd /data')
  .tags('cron', 'schedule', 'automation').build();

const listDef = command('cron', 'list').version('1.0.0')
  .description('List active scheduled tasks')
  .example('cron:list').tags('cron', 'read').build();

const cancelDef = command('cron', 'cancel').version('1.0.0')
  .description('Cancel a scheduled task')
  .requiredParam('name', 'string')
  .example('cron:cancel --name backup').tags('cron', 'write').build();

const historyDef = command('cron', 'history').version('1.0.0')
  .description('Show execution history for scheduled tasks')
  .optionalParam('name', 'string', '')
  .example('cron:history --name backup').tags('cron', 'read').build();

// Also requires shell:exec: executeTask() runs task.command through the same
// ShellAdapter.exec() sink shell:exec uses, on a timer outside the normal
// request pipeline. Without this, a role granted cron:write but deliberately
// NOT shell:exec (e.g. "can manage schedules but not run ad-hoc commands")
// gets arbitrary command execution anyway via cron:schedule.
scheduleDef.requiredPermissions = ['cron:write', 'shell:exec'];
listDef.requiredPermissions = ['cron:read'];
cancelDef.requiredPermissions = ['cron:write'];
historyDef.requiredPermissions = ['cron:read'];

/**
 * Creates cron command entries. An optional `jailRoot` constrains
 * cron:schedule's `--cwd` to a single subtree, the same containment
 * createFileCommands()/createGitCommands()/createWorkspaceCommands()/
 * createProcessCommands() offer — executeTask() runs task.command through
 * the same ShellAdapter.exec() sink process:spawn uses, so leaving --cwd
 * unrestricted here would reopen the exact escape process:spawn's jailRoot
 * support was added to close.
 *
 * Without jailRoot, behavior is byte-identical to before this option
 * existed (unresolved `args.cwd`, natural child_process cwd default).
 */
export function createCronCommands(scheduler?: CronScheduler, adapter?: ShellAdapter, jailRoot?: string): SkillEntry[] {
  const cron = scheduler || new CronScheduler(adapter);
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
    { definition: scheduleDef, handler: async (args: any) => {
      const cwdCheck = resolveCwd(args.cwd || undefined);
      if (!cwdCheck.ok) return { success: false, data: null, error: cwdCheck.error };
      const res = cron.schedule(args.name, args.command, args.interval, cwdCheck.cwd);
      return res.success
        ? { success: true, data: { name: args.name, command: args.command, interval: args.interval, scheduled: true } }
        : { success: false, data: null, error: res.error };
    }},
    { definition: listDef, handler: async () => {
      return { success: true, data: { tasks: cron.list(), count: cron.list().length } };
    }},
    { definition: cancelDef, handler: async (args: any) => {
      const result = cron.cancel(args.name);
      if (!result) return { success: false, data: null, error: `Task '${args.name}' not found` };
      return {
        success: true,
        data: {
          name: args.name,
          cancelled: true,
          // ShellAdapter has no cancellation primitive (no AbortSignal in
          // its exec() contract) — an in-flight run can't be aborted, only
          // prevented from firing again. Surfaced explicitly so a caller
          // doesn't assume "cancelled" means "stopped right now".
          ...(result.stillRunning
            ? { note: `Task '${args.name}' had an execution in progress — it was not aborted (no future runs will fire). Check cron:history shortly for its result.` }
            : {}),
        },
      };
    }},
    { definition: historyDef, handler: async (args: any) => {
      const history = cron.getHistory(args.name || undefined);
      return { success: true, data: { history, count: history.length } };
    }},
  ];
}

export const cronCommands: SkillEntry[] = createCronCommands();
