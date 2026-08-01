/**
 * @module skills/cron
 * @description Scheduled task execution with cron expressions or shorthand intervals.
 */

import { command } from '../command-builder/index.js';
import type { SkillEntry } from './scaffold.js';
import type { ShellAdapter } from '../just-bash/types.js';
import { NativeShellAdapter } from '../just-bash/adapter.js';
import { createPathJail } from '../security/path-jail.js';
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
}

const MAX_HISTORY_PER_TASK = 20;

// Same bounded-Map + oldest-eviction pattern as ProcessManager
// (MAX_PROCESSES) and SecretStore (MAX_SECRETS): cron:schedule under
// unique names would otherwise grow `tasks` forever, each entry holding
// a LIVE setInterval that keeps re-running its command indefinitely —
// a more severe resource-exhaustion vector than pure memory growth,
// since MAX_HISTORY_PER_TASK only bounds an array INSIDE each task, not
// the number of tasks/timers itself.
const MAX_TASKS = 200;

export class CronScheduler {
  private tasks: Map<string, CronTask> = new Map();
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
      return { success: false, error: `Invalid interval: '${interval}'. Use cron (*/5 * * * *) or shorthand (30s, 5m, 1h).` };
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
      history: [], createdAt: new Date().toISOString(), runCount: 0,
      timer: setInterval(() => { void this.executeTask(task, cwd); }, ms),
    };

    this.tasks.set(name, task);
    return { success: true };
  }

  cancel(name: string): boolean {
    const task = this.tasks.get(name);
    if (!task) return false;
    clearInterval(task.timer);
    this.tasks.delete(name);
    return true;
  }

  list(): Array<{ name: string; command: string; interval: string; runCount: number; createdAt: string }> {
    return Array.from(this.tasks.values()).map(t => ({
      name: t.name, command: t.command, interval: t.interval,
      runCount: t.runCount, createdAt: t.createdAt,
    }));
  }

  getHistory(name?: string): Array<{ task: string; exitCode: number; duration_ms: number; timestamp: string }> {
    if (name) {
      const task = this.tasks.get(name);
      if (!task) return [];
      return task.history.map(h => ({ task: name, ...h }));
    }
    const all: Array<{ task: string; exitCode: number; duration_ms: number; timestamp: string }> = [];
    for (const [n, t] of this.tasks) {
      for (const h of t.history) all.push({ task: n, ...h });
    }
    all.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return all.slice(0, 20);
  }

  destroy(): void {
    for (const task of this.tasks.values()) clearInterval(task.timer);
    this.tasks.clear();
  }

  private async executeTask(task: CronTask, cwd?: string): Promise<void> {
    const start = Date.now();
    const result = await this.adapter.exec(task.command, { cwd, timeout: 60_000 });
    task.runCount++;
    task.history.push({ exitCode: result.exitCode, duration_ms: Date.now() - start, timestamp: new Date().toISOString() });
    while (task.history.length > MAX_HISTORY_PER_TASK) task.history.shift();
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
      const cancelled = cron.cancel(args.name);
      return cancelled
        ? { success: true, data: { name: args.name, cancelled: true } }
        : { success: false, data: null, error: `Task '${args.name}' not found` };
    }},
    { definition: historyDef, handler: async (args: any) => {
      const history = cron.getHistory(args.name || undefined);
      return { success: true, data: { history, count: history.length } };
    }},
  ];
}

export const cronCommands: SkillEntry[] = createCronCommands();
