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

import { resolve, sep } from 'node:path';

export type JailCheckResult = { ok: true; resolved: string } | { ok: false; error: string };

/**
 * Creates a path-containment checker scoped to `jailRoot`. When `jailRoot`
 * is omitted, the returned checker is a no-op (passes the input through
 * unresolved) — identical to no jail configured, for backward compatibility
 * with callers that never opted in.
 *
 * NOTE: this is a SYNTACTIC containment check. It does not resolve
 * symlinks, so a symlink that lives inside the jail but points outside it
 * would still pass. Hardening that with `fs.realpath` is a separate, known
 * limitation shared by every caller of this function.
 */
export function createPathJail(jailRoot?: string): (inputPath: string) => JailCheckResult {
  const jailRootAbs = jailRoot ? resolve(jailRoot) : null;

  return (inputPath: string): JailCheckResult => {
    if (!jailRootAbs) return { ok: true, resolved: inputPath };
    // resolve(jailRootAbs, inputPath): a relative inputPath is resolved
    // inside the jail; an absolute inputPath is returned as-is (resolve
    // ignores the first arg in that case), which the startsWith check below
    // then blocks.
    const resolved = resolve(jailRootAbs, inputPath);
    const withinJail = resolved === jailRootAbs || resolved.startsWith(jailRootAbs + sep);
    if (!withinJail) {
      return { ok: false, error: `Blocked: path '${inputPath}' resolves outside jail root '${jailRootAbs}'` };
    }
    return { ok: true, resolved };
  };
}
