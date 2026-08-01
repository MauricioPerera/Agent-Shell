/**
 * @module skills/shell-exec
 * @description System shell execution skills.
 * Uses ShellAdapter for pluggable backend (just-bash sandboxed or native child_process).
 */

import { command } from '../command-builder/index.js';
import { NativeShellAdapter } from '../just-bash/adapter.js';
import type { ShellAdapter } from '../just-bash/types.js';
import type { SkillEntry } from './scaffold.js';
import { createPathJail } from '../security/path-jail.js';
import { resolve, isAbsolute } from 'node:path';

const execDef = command('shell', 'exec')
  .version('1.0.0')
  .description('Execute a system command and return stdout/stderr')
  .requiredParam('command', 'string')
  .optionalParam('cwd', 'string', '')
  .optionalParam('timeout', 'int', 30000)
  .example('shell:exec --command "ls -la" --timeout 5000')
  .tags('shell', 'exec', 'system')
  .build();

const whichDef = command('shell', 'which')
  .version('1.0.0')
  .description('Check if a program exists in PATH')
  .requiredParam('program', 'string')
  .example('shell:which --program curl')
  .tags('shell', 'read', 'system')
  .build();

execDef.requiredPermissions = ['shell:exec'];
whichDef.requiredPermissions = ['shell:read'];

/**
 * Creates shell command entries bound to a ShellAdapter.
 * Called by registerShellSkills() with the active adapter.
 *
 * An optional `jailRoot` constrains shell:exec's `--cwd` the same way
 * file:*, git:*, workspace:*, process:*, and cron:* are constrained — but this is
 * necessarily partial containment: the command STRING itself can `cd`
 * elsewhere or reference absolute paths directly, and nothing here (or
 * anywhere) restricts what an arbitrary shell command can touch once
 * running. shell:exec's whole purpose is unrestricted command execution;
 * jailing --cwd narrows the accidental/default case without pretending to
 * sandbox the command itself — the same caveat process:spawn/cron:schedule
 * already carry, which is why both require shell:exec as a co-permission
 * rather than treating their own cwd jail as sufficient on its own.
 */
export function createShellCommands(adapter: ShellAdapter, jailRoot?: string): SkillEntry[] {
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
    {
      definition: execDef,
      handler: async (args: any) => {
        try {
          const cwdCheck = resolveCwd(args.cwd || undefined);
          if (!cwdCheck.ok) return { success: false, data: null, error: cwdCheck.error };
          const result = await adapter.exec(args.command, {
            cwd: cwdCheck.cwd,
            timeout: args.timeout ?? 30000,
          });
          return {
            success: true,
            data: { ...result, command: args.command, backend: adapter.backend },
          };
        } catch (err: any) {
          return { success: false, data: null, error: `shell:exec failed: ${err.message}` };
        }
      },
    },
    {
      definition: whichDef,
      handler: async (args: any) => {
        try {
          const result = await adapter.which(args.program);
          return { success: true, data: result };
        } catch (err: any) {
          return { success: true, data: { program: args.program, path: null, found: false } };
        }
      },
    },
  ];
}

// Legacy export for backward compatibility (uses NativeShellAdapter inline).
// Previously lazy-loaded NativeShellAdapter via a bare require() inside a
// Proxy to "avoid import issues at module load time" — but it's a sibling
// module within this same package (not an external npm dependency), so
// there's nothing to lazily resolve: a normal static import already works,
// and the bare require() broke entirely under this package's ESM-only
// build (bundling inlines the target file, so the relative path require()
// tried to resolve at runtime no longer exists on disk as a separate file).
export const shellCommands: SkillEntry[] = createShellCommands(new NativeShellAdapter());
