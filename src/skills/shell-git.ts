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
import { assertHostnameSafe } from './shell-http.js';

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

/**
 * True if `value` would be parsed by git as an OPTION instead of literal
 * data — i.e. starts with '-'. execFileSync (used by gitExecArgs below)
 * already eliminates SHELL injection (no `$(...)`/backticks/`;` — see that
 * function's own comment), but it does nothing about GIT's own argv
 * parser: a bare positional argument like `url`/`remote`/`branch` that
 * happens to start with '-' is still git's problem to interpret, and git
 * has a long, well-documented history of dangerous options reachable this
 * way (ronda 42 del audit):
 *   - `git clone --upload-pack=<cmd> <target>` / `git pull --upload-pack=
 *     <cmd>` runs `<cmd>` as the program git uses to fetch — local RCE,
 *     no network hop needed for a local-path clone.
 *   - `git push --exec=<cmd>` / `--receive-pack=<cmd>` is the push-side
 *     equivalent — same RCE.
 *   - `git push --force`/`-f`/`--delete`/`--mirror` reachable via a
 *     `branch` value of literally "--force" etc. — silently contradicts
 *     this file's own documented claim ("No --force is implemented, so
 *     it can't destroy remote history").
 * Every one of these is exploitable specifically because `url`/`remote`/
 * `branch` are passed as BARE positional argv elements with no leading
 * '-' rejection and no '--'/'--end-of-options' separator before them —
 * unlike `-m <message>`/`-b <branch>`, which consume the very next argv
 * element as literal data regardless of its content, and are therefore
 * NOT vulnerable to this class of bug.
 */
function looksLikeGitFlag(value: string): boolean {
  return value.startsWith('-');
}

/**
 * Regresion (ronda 68 del audit, CRITICAL): git:clone/push/pull accept a
 * caller-controlled remote URL (scheme://host/... or the SCP-like
 * user@host:path form) that was passed straight to git with NO host/IP
 * validation of any kind — none of the SSRF hardening built for
 * shell-http.ts (private/reserved-IP blocklist, cloud-metadata-endpoint
 * blocking) was ever reused here. An agent holding only git:write (not
 * http:read/write) could reach an internal-only host or the cloud metadata
 * endpoint via `git:clone --url http://169.254.169.254/...` — git performs
 * the real TCP connect + HTTP GET (or SSH handshake) regardless of whether
 * the target is a real git repository, enough for internal reachability/
 * port-scanning. Extracts the bare hostname from either URL shape so it can
 * be checked with shell-http.ts's assertHostnameSafe() before git ever runs.
 */
function extractGitRemoteHost(url: string): string | null {
  const scpMatch = url.match(/^[^\s/\\]+@([^\s:/\\]+):/);
  if (scpMatch) return scpMatch[1];
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
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

  // git accepts a bare filesystem path (relative, absolute, or file://) as
// --url with no scheme required — only these forms are genuinely remote.
// The SCP-like shorthand (user@host:path) has no leading slash before its
// first ':', which is what distinguishes it from a Windows drive letter
// path like 'C:\foo'.
const REMOTE_GIT_URL_RE = /^(https?|ssh|git|ftps?):\/\//i;
const SCP_LIKE_GIT_URL_RE = /^[^\s/\\]+@[^\s:/\\]+:/;

function isRemoteGitUrl(url: string): boolean {
  return REMOTE_GIT_URL_RE.test(url) || SCP_LIKE_GIT_URL_RE.test(url);
}

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
      const url = String(args.url);
      // Regresion (ronda 42 del audit, CRITICAL): sin este chequeo, --url
      // "--upload-pack=<cmd>" llegaba a git como argv bare positional,
      // adyacente al parser de opciones de `git clone` — git lo interpreta
      // como la opcion --upload-pack (el programa que usa para el fetch),
      // no como el nombre de un repo, logrando RCE local sin necesitar red.
      // El chequeo de jail de mas abajo NO cubre esto: valida un path
      // RESUELTO, pero el string original sin modificar es lo que termina
      // en el argv de git de todas formas (ver el separador '--' agregado
      // abajo tambien, defensa en profundidad).
      if (looksLikeGitFlag(url)) {
        return { success: false, data: null, error: `git:clone --url must not start with '-' (would be parsed as a git option, not a repository): '${url}'` };
      }
      if (isRemoteGitUrl(url)) {
        const host = extractGitRemoteHost(url);
        if (host) {
          try {
            await assertHostnameSafe(host);
          } catch (err: any) {
            return { success: false, data: null, error: `git:clone --url ${err.message}` };
          }
        }
      }
      if (jailRootAbs) {
        const abs = isAbsolute(target) ? target : resolve(jailRootAbs, target);
        const check = assertInsideJail(abs);
        if (!check.ok) return { success: false, data: null, error: check.error };
        target = check.resolved;

        // --path (the destination) was already jail-checked above, but git
        // also accepts a bare filesystem path as --url (the SOURCE) with no
        // scheme required — without this check, a caller holding only
        // git:write could clone any repo elsewhere on the host INTO the
        // jail, exfiltrating its tracked files (readable afterwards via
        // file:read) despite jailRoot being configured.
        if (!isRemoteGitUrl(url)) {
          const rawSource = url.replace(/^file:\/\//i, '');
          const sourceAbs = isAbsolute(rawSource) ? rawSource : resolve(jailRootAbs, rawSource);
          const sourceCheck = assertInsideJail(sourceAbs);
          if (!sourceCheck.ok) return { success: false, data: null, error: `git:clone --url ${sourceCheck.error}` };
        }
      }
      // '--' separates options from operands (git clone's own usage:
      // "[<options>] [--] <repo> [<dir>]") — a second, independent layer
      // of defense on top of the looksLikeGitFlag() rejection above.
      const res = gitExecArgs(
        ['clone', ...(branch ? ['-b', branch] : []), '--', url, target],
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
      // Regresion (ronda 42 del audit, CRITICAL + HIGH): --remote
      // "--exec=<cmd>"/"--receive-pack=<cmd>" es el equivalente del lado
      // push a clone's --upload-pack RCE de arriba. --branch "--force" (o
      // -f/--delete/--mirror/--all) contradice directamente el propio
      // comentario de este archivo ("No --force is implemented, so it
      // can't destroy remote history") — ambos parametros llegaban a git
      // como argv bare positional, sin chequeo ni separador.
      if (looksLikeGitFlag(remote)) {
        return { success: false, data: null, error: `git:push --remote must not start with '-' (would be parsed as a git option): '${remote}'` };
      }
      if (branch && looksLikeGitFlag(branch)) {
        return { success: false, data: null, error: `git:push --branch must not start with '-' (would be parsed as a git option, e.g. --force): '${branch}'` };
      }
      if (isRemoteGitUrl(remote)) {
        const host = extractGitRemoteHost(remote);
        if (host) {
          try {
            await assertHostnameSafe(host);
          } catch (err: any) {
            return { success: false, data: null, error: `git:push --remote ${err.message}` };
          }
        }
      }
      // '--end-of-options' separates options from operands for push/pull
      // (unlike clone, plain '--' has a DIFFERENT meaning here — ref vs
      // pathspec disambiguation — so git added this dedicated separator).
      // Second, independent layer of defense on top of the checks above.
      const res = gitExecArgs(['push', '--end-of-options', remote, ...(branch ? [branch] : [])], cwdCheck.cwd);
      return { success: res.exitCode === 0, data: res, error: res.exitCode !== 0 ? res.stderr : undefined };
    }},
    { definition: pullDef, handler: async (args: any) => {
      const cwdCheck = resolveCwd(args.cwd || undefined);
      if (!cwdCheck.ok) return { success: false, data: null, error: cwdCheck.error };
      const remote = args.remote || 'origin';
      const branch = args.branch ? String(args.branch) : '';
      // Regresion (ronda 42 del audit, CRITICAL): --remote
      // "--upload-pack=<cmd>" es el mismo RCE que en clone — git pull
      // tambien acepta --upload-pack como opcion de fetch.
      if (looksLikeGitFlag(remote)) {
        return { success: false, data: null, error: `git:pull --remote must not start with '-' (would be parsed as a git option): '${remote}'` };
      }
      if (branch && looksLikeGitFlag(branch)) {
        return { success: false, data: null, error: `git:pull --branch must not start with '-' (would be parsed as a git option): '${branch}'` };
      }
      if (isRemoteGitUrl(remote)) {
        const host = extractGitRemoteHost(remote);
        if (host) {
          try {
            await assertHostnameSafe(host);
          } catch (err: any) {
            return { success: false, data: null, error: `git:pull --remote ${err.message}` };
          }
        }
      }
      const res = gitExecArgs(['pull', '--end-of-options', remote, ...(branch ? [branch] : [])], cwdCheck.cwd);
      return { success: res.exitCode === 0, data: res, error: res.exitCode !== 0 ? res.stderr : undefined };
    }},
  ];
}

// Legacy export for backward compatibility (no jail — identical to this
// module's behavior before jailRoot support existed).
export const gitCommands: SkillEntry[] = createGitCommands();
