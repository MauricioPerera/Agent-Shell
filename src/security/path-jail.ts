/**
 * @module security/path-jail
 * @description Shared syntactic path-containment check for skills that
 * accept a caller-controlled filesystem path or working directory
 * (file:*, workspace:*, git:*, process:*'s --cwd, cron:*'s --cwd, and
 * shell:exec's --cwd).
 *
 * IMPORTANT: shell:exec's containment is necessarily partial — jailing
 * --cwd only narrows where a command STARTS, not what it can touch once
 * running (the command string itself can `cd` elsewhere or reference
 * absolute paths directly). Granting shell:exec to any agent — directly,
 * or transitively via process:spawn/cron:schedule, which both require it
 * as a co-permission — means that agent can read/write/delete anywhere
 * the host process can reach, REGARDLESS of jailRoot. Do not rely on
 * jailRoot as a security boundary for any deployment that grants
 * shell:exec (this includes the built-in `operator` profile).
 */

import { resolve, sep, dirname, basename } from 'node:path';
import { realpathSync } from 'node:fs';

export type JailCheckResult = { ok: true; resolved: string } | { ok: false; error: string };

/**
 * Resolves symlinks along `path`'s existing ancestors, re-appending any
 * trailing segments that don't exist yet (legitimate for a write target,
 * e.g. file:write/file:mkdir/file:rename's destination — it's normal for
 * that leaf to not exist BEFORE the operation creates it). Closes the
 * classic jail-escape (ronda 36 del audit) where a symlink already living
 * INSIDE the jail points OUTSIDE it: a purely syntactic startsWith check
 * never touches the filesystem, so it follows the symlink without ever
 * noticing where it actually leads.
 */
function realpathExistingAncestor(path: string): string {
  try {
    return realpathSync.native(path);
  } catch (err: any) {
    if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') throw err;
    const parent = dirname(path);
    if (parent === path) return path; // reached the filesystem root
    return resolve(realpathExistingAncestor(parent), basename(path));
  }
}

/**
 * Creates a path-containment checker scoped to `jailRoot`. When `jailRoot`
 * is omitted, the returned checker is a no-op (passes the input through
 * unresolved) — identical to no jail configured, for backward compatibility
 * with callers that never opted in.
 *
 * Resolves symlinks (via `realpathExistingAncestor`) on both `jailRoot`
 * itself and every checked path before comparing, so a symlink inside the
 * jail pointing outside it is blocked rather than silently followed. The
 * checker never throws: any unexpected filesystem error while resolving
 * (permissions, races, etc.) fails CLOSED — returns `{ok: false}` — rather
 * than propagating and crashing the caller's handler.
 */
export function createPathJail(jailRoot?: string): (inputPath: string) => JailCheckResult {
  let jailRootAbs: string | null = null;
  if (jailRoot) {
    try {
      jailRootAbs = realpathExistingAncestor(resolve(jailRoot));
    } catch {
      // Startup-time fallback: if jailRoot's ancestors can't be resolved
      // (e.g. a permissions issue at process boot), don't crash server
      // startup over it — fall back to the syntactic form, same behavior
      // this module had before symlink resolution existed.
      jailRootAbs = resolve(jailRoot);
    }
  }

  return (inputPath: string): JailCheckResult => {
    if (!jailRootAbs) return { ok: true, resolved: inputPath };
    // resolve(jailRootAbs, inputPath): a relative inputPath is resolved
    // inside the jail; an absolute inputPath is returned as-is (resolve
    // ignores the first arg in that case), which the containment check
    // below then blocks.
    const resolvedSyntactic = resolve(jailRootAbs, inputPath);
    let resolved: string;
    try {
      resolved = realpathExistingAncestor(resolvedSyntactic);
    } catch {
      return { ok: false, error: `Blocked: unable to resolve path '${inputPath}' for containment check` };
    }
    const withinJail = resolved === jailRootAbs || resolved.startsWith(jailRootAbs + sep);
    if (!withinJail) {
      return { ok: false, error: `Blocked: path '${inputPath}' resolves outside jail root '${jailRootAbs}'` };
    }
    return { ok: true, resolved };
  };
}
