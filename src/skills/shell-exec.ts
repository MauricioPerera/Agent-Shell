/**
 * @module skills/shell-exec
 * @description System shell execution skills.
 * Uses ShellAdapter for pluggable backend (just-bash sandboxed or native child_process).
 */

import { command } from '../command-builder/index.js';
import type { ShellAdapter } from '../just-bash/types.js';
import type { SkillEntry } from './scaffold.js';

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
 */
export function createShellCommands(adapter: ShellAdapter): SkillEntry[] {
  return [
    {
      definition: execDef,
      handler: async (args: any) => {
        try {
          const result = await adapter.exec(args.command, {
            cwd: args.cwd || undefined,
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

// Legacy export for backward compatibility (uses NativeShellAdapter inline)
export const shellCommands: SkillEntry[] = createShellCommands(
  // Lazy-init native adapter to avoid import issues at module load time
  new Proxy({} as ShellAdapter, {
    get(_, prop) {
      // Deferred init: create real NativeShellAdapter on first use
      const { NativeShellAdapter } = require('../just-bash/adapter.js');
      const real = new NativeShellAdapter();
      return (real as any)[prop].bind(real);
    },
  })
);
