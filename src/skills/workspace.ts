/**
 * @module skills/workspace
 * @description Persistent workspace with stateful cwd, env, and command history.
 *
 * Unlike shell:exec (stateless, each command is independent), workspace:run
 * maintains working directory and environment variables between calls.
 * Designed for DevOps workflows: clone → install → configure → deploy.
 */

import { command } from '../command-builder/index.js';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import type { SkillEntry } from './scaffold.js';

// ---------------------------------------------------------------------------
// WorkspaceState — persistent state across commands
// ---------------------------------------------------------------------------

const MAX_HISTORY = 100;

export class WorkspaceState {
  cwd: string = process.cwd();
  env: Record<string, string> = {};
  history: Array<{ command: string; exitCode: number; duration_ms: number; timestamp: string }> = [];
  initialized = false;

  mergedEnv(): Record<string, string> {
    return { ...process.env, ...this.env } as Record<string, string>;
  }

  recordHistory(cmd: string, exitCode: number, duration_ms: number): void {
    this.history.push({ command: cmd, exitCode, duration_ms, timestamp: new Date().toISOString() });
    while (this.history.length > MAX_HISTORY) this.history.shift();
  }

  resolvePath(path: string): string {
    return isAbsolute(path) ? path : resolve(this.cwd, path);
  }
}

// ---------------------------------------------------------------------------
// Command Definitions
// ---------------------------------------------------------------------------

const initDef = command('workspace', 'init')
  .version('1.0.0')
  .description('Initialize workspace with a working directory')
  .requiredParam('path', 'string')
  .optionalParam('env', 'json', null)
  .optionalParam('create', 'bool', false, 'Create directory if it does not exist')
  .example('workspace:init --path /opt/myapp --create true')
  .tags('workspace', 'init')
  .build();

const runDef = command('workspace', 'run')
  .version('1.0.0')
  .description('Execute a command in the workspace (persists cwd and env)')
  .requiredParam('command', 'string')
  .optionalParam('timeout', 'int', 120000)
  .example('workspace:run --command "npm install" --timeout 180000')
  .tags('workspace', 'exec', 'run')
  .build();

const envDef = command('workspace', 'env')
  .version('1.0.0')
  .description('Manage workspace environment variables')
  .optionalParam('set', 'string', '', 'Set variable: KEY=value')
  .optionalParam('unset', 'string', '', 'Remove variable by key')
  .optionalParam('list', 'bool', false, 'List all workspace env vars')
  .example('workspace:env --set DATABASE_URL=postgres://localhost/mydb')
  .tags('workspace', 'env')
  .build();

const cdDef = command('workspace', 'cd')
  .version('1.0.0')
  .description('Change workspace working directory')
  .requiredParam('path', 'string')
  .example('workspace:cd --path src/server')
  .tags('workspace', 'navigation')
  .build();

const statusDef = command('workspace', 'status')
  .version('1.0.0')
  .description('Show current workspace state: cwd, env count, recent commands')
  .example('workspace:status')
  .tags('workspace', 'status', 'info')
  .build();

const resetDef = command('workspace', 'reset')
  .version('1.0.0')
  .description('Reset workspace to clean state')
  .example('workspace:reset')
  .tags('workspace', 'reset')
  .build();

initDef.requiredPermissions = ['workspace:write'];
runDef.requiredPermissions = ['workspace:write'];
envDef.requiredPermissions = ['workspace:write'];
cdDef.requiredPermissions = ['workspace:write'];
statusDef.requiredPermissions = ['workspace:read'];
resetDef.requiredPermissions = ['workspace:write'];

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates workspace commands bound to a shared WorkspaceState.
 * The state persists across all workspace:* calls within the same process.
 */
export function createWorkspaceCommands(state?: WorkspaceState): SkillEntry[] {
  const ws = state || new WorkspaceState();

  return [
    {
      definition: initDef,
      handler: async (args: any) => {
        const path = args.path as string;
        const shouldCreate = args.create === true || args.create === 'true';
        const envVars = typeof args.env === 'string' ? JSON.parse(args.env) : (args.env || {});

        const absPath = isAbsolute(path) ? path : resolve(process.cwd(), path);

        if (shouldCreate && !existsSync(absPath)) {
          mkdirSync(absPath, { recursive: true });
        }

        if (!existsSync(absPath)) {
          return { success: false, data: null, error: `Directory does not exist: ${absPath}. Use --create true to create it.` };
        }

        ws.cwd = absPath;
        ws.env = { ...ws.env, ...envVars };
        ws.initialized = true;

        return {
          success: true,
          data: {
            cwd: ws.cwd,
            envCount: Object.keys(ws.env).length,
            initialized: true,
          },
        };
      },
    },
    {
      definition: runDef,
      handler: async (args: any) => {
        const cmd = args.command as string;
        const timeout = args.timeout ?? 120_000;
        const start = Date.now();

        try {
          const stdout = execSync(cmd, {
            cwd: ws.cwd,
            env: ws.mergedEnv(),
            timeout,
            encoding: 'utf-8',
            maxBuffer: 10 * 1024 * 1024, // 10MB
            stdio: ['pipe', 'pipe', 'pipe'],
          }) as string;

          const duration_ms = Date.now() - start;
          ws.recordHistory(cmd, 0, duration_ms);

          return {
            success: true,
            data: {
              stdout: stdout.trimEnd(),
              stderr: '',
              exitCode: 0,
              cwd: ws.cwd,
              duration_ms,
            },
          };
        } catch (err: any) {
          const duration_ms = Date.now() - start;
          const exitCode = err.status ?? 1;
          ws.recordHistory(cmd, exitCode, duration_ms);

          return {
            success: true,
            data: {
              stdout: (err.stdout || '').toString().trimEnd(),
              stderr: (err.stderr || '').toString().trimEnd(),
              exitCode,
              cwd: ws.cwd,
              duration_ms,
            },
          };
        }
      },
    },
    {
      definition: envDef,
      handler: async (args: any) => {
        // Set
        if (args.set && args.set.includes('=')) {
          const eqIdx = (args.set as string).indexOf('=');
          const key = (args.set as string).substring(0, eqIdx);
          const value = (args.set as string).substring(eqIdx + 1);
          ws.env[key] = value;
          return { success: true, data: { action: 'set', key, value, envCount: Object.keys(ws.env).length } };
        }

        // Unset
        if (args.unset) {
          const key = args.unset as string;
          const existed = key in ws.env;
          delete ws.env[key];
          return { success: true, data: { action: 'unset', key, existed, envCount: Object.keys(ws.env).length } };
        }

        // List
        return {
          success: true,
          data: { action: 'list', variables: { ...ws.env }, count: Object.keys(ws.env).length },
        };
      },
    },
    {
      definition: cdDef,
      handler: async (args: any) => {
        const target = ws.resolvePath(args.path as string);

        if (!existsSync(target)) {
          return { success: false, data: null, error: `Directory does not exist: ${target}` };
        }

        const previous = ws.cwd;
        ws.cwd = target;

        return {
          success: true,
          data: { previous, current: ws.cwd },
        };
      },
    },
    {
      definition: statusDef,
      handler: async () => {
        return {
          success: true,
          data: {
            initialized: ws.initialized,
            cwd: ws.cwd,
            envCount: Object.keys(ws.env).length,
            envKeys: Object.keys(ws.env),
            historyCount: ws.history.length,
            recentCommands: ws.history.slice(-10),
          },
        };
      },
    },
    {
      definition: resetDef,
      handler: async () => {
        const previousCwd = ws.cwd;
        ws.cwd = process.cwd();
        ws.env = {};
        ws.history = [];
        ws.initialized = false;

        return {
          success: true,
          data: { reset: true, previousCwd, newCwd: ws.cwd },
        };
      },
    },
  ];
}

// Legacy export
export const workspaceCommands: SkillEntry[] = createWorkspaceCommands();
