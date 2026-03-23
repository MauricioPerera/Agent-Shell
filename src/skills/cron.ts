/**
 * @module skills/cron
 * @description Scheduled task execution with cron expressions or shorthand intervals.
 */

import { command } from '../command-builder/index.js';
import { execSync } from 'node:child_process';
import type { SkillEntry } from './scaffold.js';

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

export class CronScheduler {
  private tasks: Map<string, CronTask> = new Map();

  schedule(name: string, cmd: string, interval: string, cwd?: string): { success: boolean; error?: string } {
    if (this.tasks.has(name)) {
      return { success: false, error: `Task '${name}' already exists. Cancel it first.` };
    }

    const ms = parseInterval(interval);
    if (ms === null || ms < 1000) {
      return { success: false, error: `Invalid interval: '${interval}'. Use cron (*/5 * * * *) or shorthand (30s, 5m, 1h).` };
    }

    const task: CronTask = {
      name, command: cmd, interval, intervalMs: ms,
      history: [], createdAt: new Date().toISOString(), runCount: 0,
      timer: setInterval(() => this.executeTask(task, cwd), ms),
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

  private executeTask(task: CronTask, cwd?: string): void {
    const start = Date.now();
    let exitCode = 0;
    try {
      execSync(task.command, { cwd, encoding: 'utf-8', timeout: 60_000, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err: any) {
      exitCode = err.status ?? 1;
    }
    task.runCount++;
    task.history.push({ exitCode, duration_ms: Date.now() - start, timestamp: new Date().toISOString() });
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
  .example('cron:schedule --name backup --command "tar czf /tmp/backup.tar.gz /data" --interval 1h')
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

scheduleDef.requiredPermissions = ['cron:write'];
listDef.requiredPermissions = ['cron:read'];
cancelDef.requiredPermissions = ['cron:write'];
historyDef.requiredPermissions = ['cron:read'];

export function createCronCommands(scheduler?: CronScheduler): SkillEntry[] {
  const cron = scheduler || new CronScheduler();

  return [
    { definition: scheduleDef, handler: async (args: any) => {
      const res = cron.schedule(args.name, args.command, args.interval);
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
