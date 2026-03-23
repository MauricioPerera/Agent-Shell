/**
 * @module skills/shell-exec
 * @description System shell execution skills.
 * These are the most dangerous skills — require explicit 'shell:exec' permission.
 */

import { command } from '../command-builder/index.js';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { SkillEntry } from './scaffold.js';

const execDef = command('shell', 'exec')
  .version('1.0.0')
  .description('Execute a system command and return stdout/stderr')
  .requiredParam('command', 'string')
  .optionalParam('cwd', 'string', '')
  .optionalParam('timeout', 'int', 30000)
  .example('shell:exec --command "ls -la" --timeout 5000')
  .tags('shell', 'exec', 'system', 'dangerous')
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

export const shellCommands: SkillEntry[] = [
  {
    definition: execDef,
    handler: async (args: any) => {
      try {
        const timeout = args.timeout ?? 30000;
        const opts: any = {
          encoding: 'utf-8' as BufferEncoding,
          timeout,
          maxBuffer: 1024 * 1024, // 1MB
          stdio: ['pipe', 'pipe', 'pipe'],
        };
        if (args.cwd) opts.cwd = args.cwd;

        const stdout = execSync(args.command, opts) as string;
        return {
          success: true,
          data: { stdout: stdout.trim(), stderr: '', exitCode: 0, command: args.command },
        };
      } catch (err: any) {
        // execSync throws on non-zero exit code
        return {
          success: true, // still "success" in the sense the command ran
          data: {
            stdout: (err.stdout || '').toString().trim(),
            stderr: (err.stderr || '').toString().trim(),
            exitCode: err.status ?? 1,
            command: args.command,
          },
        };
      }
    },
  },
  {
    definition: whichDef,
    handler: async (args: any) => {
      try {
        const isWindows = process.platform === 'win32';
        const cmd = isWindows ? `where ${args.program}` : `which ${args.program}`;
        const result = execSync(cmd, { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        const path = result.split('\n')[0].trim();
        return { success: true, data: { program: args.program, path, found: true } };
      } catch {
        return { success: true, data: { program: args.program, path: null, found: false } };
      }
    },
  },
];
