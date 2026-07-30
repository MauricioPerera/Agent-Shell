/**
 * @module skills/workspace
 * @description Persistent workspace with stateful cwd, env, and command history.
 *
 * Unlike shell:exec (stateless, each command is independent), workspace:run
 * maintains working directory and environment variables between calls.
 * Designed for DevOps workflows: clone → install → configure → deploy.
 */

import { command } from '../command-builder/index.js';
import { existsSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import type { SkillEntry } from './scaffold.js';
import type { ShellAdapter } from '../just-bash/types.js';
import { NativeShellAdapter } from '../just-bash/adapter.js';
import { createPathJail } from '../security/path-jail.js';

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

const DEFAULT_SESSION = '__default__';
const MAX_SESSIONS = 200;

/**
 * Bounded per-session store for WorkspaceState, keyed by the sessionId Core
 * now threads through as the handler's 3rd argument.
 *
 * Regresion: this module used to close over ONE shared WorkspaceState for
 * every workspace:* call in the process — on the HTTP transport, where a
 * single Core can serve multiple concurrent callers, one caller's cwd/env
 * mutations (and command history) leaked into every other caller's next
 * request. Undefined/no sessionId (stdio — one agent per process, no
 * cross-tenant risk — plus direct library/test callers that predate this
 * parameter) maps to one shared DEFAULT_SESSION bucket, preserving the
 * original single-shared-instance behavior exactly. A real sessionId
 * (HttpSseTransport always supplies one) gets its own isolated instance.
 */
class WorkspaceSessionStore {
  private readonly sessions = new Map<string, WorkspaceState>();

  constructor(seed?: WorkspaceState) {
    if (seed) this.sessions.set(DEFAULT_SESSION, seed);
  }

  get(sessionId?: string): WorkspaceState {
    const key = sessionId || DEFAULT_SESSION;
    let state = this.sessions.get(key);
    if (!state) {
      // Bound the map BEFORE inserting: an attacker cycling X-Session-Id
      // values shouldn't be able to grow this without limit. Evicts the
      // oldest entry — Map iteration order is insertion order.
      if (this.sessions.size >= MAX_SESSIONS) {
        const oldestKey = this.sessions.keys().next().value;
        if (oldestKey !== undefined) this.sessions.delete(oldestKey);
      }
      state = new WorkspaceState();
      this.sessions.set(key, state);
    }
    return state;
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
 * Creates workspace commands bound to a per-session WorkspaceState store.
 * State persists across workspace:* calls that share the same sessionId
 * (see WorkspaceSessionStore) — the 3rd handler argument Core now threads
 * through from the transport layer.
 *
 * `state`, when provided, seeds the DEFAULT_SESSION bucket only — the
 * bucket used by callers that never pass a sessionId at all (stdio, direct
 * library use, tests calling handlers directly). This keeps that usage
 * byte-identical to before per-session isolation existed.
 *
 * An optional `jailRoot` may be provided to constrain workspace:init/cd to a
 * single subtree, the same containment createFileCommands() offers for
 * file:* — without it, workspace:init could set ws.cwd to anywhere on disk
 * (bypassing any file:* jail entirely) and workspace:run would then execute
 * with that unjailed directory as cwd.
 */
export function createWorkspaceCommands(state?: WorkspaceState, adapter?: ShellAdapter, jailRoot?: string): SkillEntry[] {
  const store = new WorkspaceSessionStore(state);
  const shellAdapter = adapter || new NativeShellAdapter();
  const assertInsideJail = createPathJail(jailRoot);
  const jailRootAbs = jailRoot ? resolve(jailRoot) : null;

  return [
    {
      definition: initDef,
      handler: async (args: any, _previousData?: any, sessionId?: string) => {
        const ws = store.get(sessionId);
        const path = args.path as string;
        const shouldCreate = args.create === true || args.create === 'true';
        const envVars = typeof args.env === 'string' ? JSON.parse(args.env) : (args.env || {});

        const absPath = isAbsolute(path) ? path : resolve(process.cwd(), path);
        const check = assertInsideJail(absPath);
        if (!check.ok) return { success: false, data: null, error: check.error };
        const resolvedPath = check.resolved;

        if (shouldCreate && !existsSync(resolvedPath)) {
          await shellAdapter.mkdir(resolvedPath, { recursive: true });
        }

        if (!existsSync(resolvedPath)) {
          return { success: false, data: null, error: `Directory does not exist: ${resolvedPath}. Use --create true to create it.` };
        }

        ws.cwd = resolvedPath;
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
      handler: async (args: any, _previousData?: any, sessionId?: string) => {
        const ws = store.get(sessionId);
        const cmd = args.command as string;
        const timeout = args.timeout ?? 120_000;
        const start = Date.now();

        const result = await shellAdapter.exec(cmd, {
          cwd: ws.cwd,
          env: ws.env,
          timeout,
        });

        const duration_ms = Date.now() - start;
        ws.recordHistory(cmd, result.exitCode, duration_ms);

        return {
          success: true,
          data: {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            cwd: ws.cwd,
            duration_ms,
          },
        };
      },
    },
    {
      definition: envDef,
      handler: async (args: any, _previousData?: any, sessionId?: string) => {
        const ws = store.get(sessionId);
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
      handler: async (args: any, _previousData?: any, sessionId?: string) => {
        const ws = store.get(sessionId);
        const target = ws.resolvePath(args.path as string);
        const check = assertInsideJail(target);
        if (!check.ok) return { success: false, data: null, error: check.error };
        const resolvedTarget = check.resolved;

        if (!existsSync(resolvedTarget)) {
          return { success: false, data: null, error: `Directory does not exist: ${resolvedTarget}` };
        }

        const previous = ws.cwd;
        ws.cwd = resolvedTarget;

        return {
          success: true,
          data: { previous, current: ws.cwd },
        };
      },
    },
    {
      definition: statusDef,
      handler: async (_args?: any, _previousData?: any, sessionId?: string) => {
        const ws = store.get(sessionId);
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
      handler: async (_args?: any, _previousData?: any, sessionId?: string) => {
        const ws = store.get(sessionId);
        const previousCwd = ws.cwd;
        // Reset inside the jail when one is configured — resetting to
        // process.cwd() unconditionally could put ws.cwd right back
        // outside the jail init/cd just finished enforcing.
        ws.cwd = jailRootAbs || process.cwd();
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
