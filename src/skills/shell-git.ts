/**
 * @module skills/shell-git
 * @description Git operations as typed, permissioned commands.
 */

import { command } from '../command-builder/index.js';
import { execSync, execFileSync } from 'node:child_process';
import type { SkillEntry } from './scaffold.js';

function gitExec(cmd: string, cwd?: string): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execSync(cmd, {
      cwd: cwd || process.cwd(),
      encoding: 'utf-8',
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
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
  .tags('git', 'write').build();

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

export const gitCommands: SkillEntry[] = [
  { definition: cloneDef, handler: async (args: any) => {
    const branch = args.branch ? String(args.branch) : '';
    const target = args.path || '.';
    const res = gitExecArgs(
      ['clone', ...(branch ? ['-b', branch] : []), String(args.url), String(target)],
    );
    return { success: res.exitCode === 0, data: res, error: res.exitCode !== 0 ? res.stderr : undefined };
  }},
  { definition: statusDef, handler: async (args: any) => {
    const res = gitExec('git status --porcelain', args.cwd || undefined);
    const clean = res.stdout.trim() === '';
    return { success: true, data: { ...res, clean, cwd: args.cwd || process.cwd() } };
  }},
  { definition: diffDef, handler: async (args: any) => {
    const cmd = args.staged ? 'git diff --staged' : 'git diff';
    const res = gitExec(cmd, args.cwd || undefined);
    return { success: true, data: res };
  }},
  { definition: commitDef, handler: async (args: any) => {
    const cwd = args.cwd || undefined;
    if (args['add-all']) gitExecArgs(['add', '-A'], cwd);
    const res = gitExecArgs(['commit', '-m', String(args.message)], cwd);
    return { success: res.exitCode === 0, data: res, error: res.exitCode !== 0 ? res.stderr : undefined };
  }},
  { definition: pushDef, handler: async (args: any) => {
    const remote = args.remote || 'origin';
    const branch = args.branch ? String(args.branch) : '';
    const res = gitExecArgs(['push', remote, ...(branch ? [branch] : [])], args.cwd || undefined);
    return { success: res.exitCode === 0, data: res, error: res.exitCode !== 0 ? res.stderr : undefined };
  }},
  { definition: pullDef, handler: async (args: any) => {
    const remote = args.remote || 'origin';
    const branch = args.branch ? String(args.branch) : '';
    const res = gitExecArgs(['pull', remote, ...(branch ? [branch] : [])], args.cwd || undefined);
    return { success: res.exitCode === 0, data: res, error: res.exitCode !== 0 ? res.stderr : undefined };
  }},
];
