/**
 * @module skills/shell-git
 * @description Git operations as typed, permissioned commands.
 */

import { command } from '../command-builder/index.js';
import { execSync, execFileSync } from 'node:child_process';
import { resolve, isAbsolute } from 'node:path';
import type { SkillEntry } from './scaffold.js';
import { createPathJail } from '../security/path-jail.js';
import { filterSensitiveEnv } from '../security/secret-patterns.js';

function gitExec(cmd: string, cwd?: string): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execSync(cmd, {
      cwd: cwd || process.cwd(),
      encoding: 'utf-8',
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Same reasoning as NativeShellAdapter.exec (just-bash/adapter.ts):
      // git:* only requires git:read/git:write, not env:read, so a spawned
      // git process (and any hook it runs) inheriting the full host
      // environment verbatim would let an agent read every credential
      // through a side door the env:get/env:list masking never covers.
      env: filterSensitiveEnv(process.env),
    }) as string;
    return { stdout: stdout.trimEnd(), stderr: '', exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: (err.stdout || '').toString().trimEnd(),
      stderr: (err.stderr || '').toString().trimEnd(),
      exitCode: err.status ?? 1,
    };
  }
}

// Argument-vector git execution. No shell is spawned, so each argument is passed
// to git verbatim and never re-parsed by a shell — eliminating command injection
// via interpolation/substitution ($(...), `...`, ;, &&, etc.).
function gitExecArgs(args: string[], cwd?: string): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync('git', args, {
      cwd: cwd || process.cwd(),
      encoding: 'utf-8',
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      env: filterSensitiveEnv(process.env),
    }) as string;
    return { stdout: stdout.trimEnd(), stderr: '', exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: (err.stdout || '').toString().trimEnd(),
      stderr: (err.stderr || '').toString().trimEnd(),
      exitCode: err.status ?? 1,
    };
  }
}

const cloneDef = command('git', 'clone').version('1.0.0')
  .description('Clone a git repository')
  .requiredParam('url', 'string')
  .optionalParam('path', 'string', '.')
  .optionalParam('branch', 'string', '')
  .example('git:clone --url https://github.com/user/repo.git --path ./myproject')
  .tags('git', 'write').build();

const statusDef = command('git', 'status').version('1.0.0')
  .description('Show git repository status')
  .optionalParam('cwd', 'string', '')
  .example('git:status')
  .tags('git', 'read').build();

const diffDef = command('git', 'diff').version('1.0.0')
  .description('Show git diff (staged or unstaged)')
  .optionalParam('staged', 'bool', false)
  .optionalParam('cwd', 'string', '')
  .example('git:diff --staged true')
  .tags('git', 'read').build();

const commitDef = command('git', 'commit').version('1.0.0')
  .description('Create a git commit')
  .requiredParam('message', 'string')
  .optionalParam('add-all', 'bool', false, 'Run git add -A before commit')
  .optionalParam('cwd', 'string', '')
  .example('git:commit --message "feat: add feature" --add-all true')
  .tags('git', 'write').build();

const pushDef = command('git', 'push').version('1.0.0')
  .description('Push to remote repository')
  .optionalParam('remote', 'string', 'origin')
  .optionalParam('branch', 'string', '')
  .optionalParam('cwd', 'string', '')
  .example('git:push --remote origin --branch main')
  // The one command in this registry whose effect is visible outside the
  // local sandbox — a shared remote, possibly triggering CI/CD for
  // others. No --force is implemented, so it can't destroy remote
  // history, but an unconfirmed push is still irreversible from here.
  .tags('git', 'write', 'dangerous')
  .requiresConfirmation()
  .build();

const pullDef = command('git', 'pull').version('1.0.0')
  .description('Pull from remote repository')
  .optionalParam('remote', 'string', 'origin')
  .optionalParam('branch', 'string', '')
  .optionalParam('cwd', 'string', '')
  .example('git:pull --remote origin --branch main')
  .tags('git', 'write').build();

cloneDef.requiredPermissions = ['git:write'];
statusDef.requiredPermissions = ['git:read'];
diffDef.requiredPermissions = ['git:read'];
commitDef.requiredPermissions = ['git:write'];
pushDef.requiredPermissions = ['git:write'];
pullDef.requiredPermissions = ['git:write'];

/**
 * Creates git command entries. An optional `jailRoot` constrains every
 * command's `--cwd` (and clone's `--path`) to a single subtree, the same
 * containment createFileCommands() offers for file:* — without it, `--cwd`
 * accepted any path on the host, letting a `git:write` grant intended for
 * one project operate on any other git repository the process can reach.
 *
 * Without jailRoot, every handler behaves byte-identical to before this
 * option existed (unresolved `args.cwd`, natural child_process cwd default).
 */
export function createGitCommands(jailRoot?: string): SkillEntry[] {
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
    { definition: cloneDef, handler: async (args: any) => {
      const branch = args.branch ? String(args.branch) : '';
      let target = String(args.path || '.');
      if (jailRootAbs) {
        const abs = isAbsolute(target) ? target : resolve(jailRootAbs, target);
        const check = assertInsideJail(abs);
        if (!check.ok) return { success: false, data: null, error: check.error };
        target = check.resolved;
      }
      const res = gitExecArgs(
        ['clone', ...(branch ? ['-b', branch] : []), String(args.url), target],
      );
      return { success: res.exitCode === 0, data: res, error: res.exitCode !== 0 ? res.stderr : undefined };
    }},
    { definition: statusDef, handler: async (args: any) => {
      const cwdCheck = resolveCwd(args.cwd || undefined);
      if (!cwdCheck.ok) return { success: false, data: null, error: cwdCheck.error };
      const res = gitExec('git status --porcelain', cwdCheck.cwd);
      const clean = res.stdout.trim() === '';
      return { success: true, data: { ...res, clean, cwd: cwdCheck.cwd || process.cwd() } };
    }},
    { definition: diffDef, handler: async (args: any) => {
      const cwdCheck = resolveCwd(args.cwd || undefined);
      if (!cwdCheck.ok) return { success: false, data: null, error: cwdCheck.error };
      const cmd = args.staged ? 'git diff --staged' : 'git diff';
      const res = gitExec(cmd, cwdCheck.cwd);
      return { success: true, data: res };
    }},
    { definition: commitDef, handler: async (args: any) => {
      const cwdCheck = resolveCwd(args.cwd || undefined);
      if (!cwdCheck.ok) return { success: false, data: null, error: cwdCheck.error };
      const cwd = cwdCheck.cwd;
      if (args['add-all']) gitExecArgs(['add', '-A'], cwd);
      const res = gitExecArgs(['commit', '-m', String(args.message)], cwd);
      return { success: res.exitCode === 0, data: res, error: res.exitCode !== 0 ? res.stderr : undefined };
    }},
    { definition: pushDef, handler: async (args: any) => {
      const cwdCheck = resolveCwd(args.cwd || undefined);
      if (!cwdCheck.ok) return { success: false, data: null, error: cwdCheck.error };
      const remote = args.remote || 'origin';
      const branch = args.branch ? String(args.branch) : '';
      const res = gitExecArgs(['push', remote, ...(branch ? [branch] : [])], cwdCheck.cwd);
      return { success: res.exitCode === 0, data: res, error: res.exitCode !== 0 ? res.stderr : undefined };
    }},
    { definition: pullDef, handler: async (args: any) => {
      const cwdCheck = resolveCwd(args.cwd || undefined);
      if (!cwdCheck.ok) return { success: false, data: null, error: cwdCheck.error };
      const remote = args.remote || 'origin';
      const branch = args.branch ? String(args.branch) : '';
      const res = gitExecArgs(['pull', remote, ...(branch ? [branch] : [])], cwdCheck.cwd);
      return { success: res.exitCode === 0, data: res, error: res.exitCode !== 0 ? res.stderr : undefined };
    }},
  ];
}

// Legacy export for backward compatibility (no jail — identical to this
// module's behavior before jailRoot support existed).
export const gitCommands: SkillEntry[] = createGitCommands();
