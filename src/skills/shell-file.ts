/**
 * @module skills/shell-file
 * @description File system skills using ShellAdapter for pluggable backend.
 */

import { command } from '../command-builder/index.js';
import type { ShellAdapter } from '../just-bash/types.js';
import type { SkillEntry } from './scaffold.js';

const readDef = command('file', 'read')
  .version('1.0.0')
  .description('Read the contents of a file')
  .requiredParam('path', 'string')
  .optionalParam('encoding', 'string', 'utf-8')
  .example('file:read --path ./config.json')
  .tags('file', 'read', 'filesystem')
  .build();

const writeDef = command('file', 'write')
  .version('1.0.0')
  .description('Write content to a file')
  .requiredParam('path', 'string')
  .requiredParam('content', 'string')
  .example('file:write --path ./output.txt --content "Hello World"')
  .tags('file', 'write', 'filesystem')
  .build();

const listDef = command('file', 'list')
  .version('1.0.0')
  .description('List files and directories in a path')
  .requiredParam('path', 'string')
  .optionalParam('pattern', 'string', '')
  .example('file:list --path ./src --pattern .ts')
  .tags('file', 'read', 'filesystem', 'listing')
  .build();

readDef.requiredPermissions = ['file:read'];
writeDef.requiredPermissions = ['file:write'];
listDef.requiredPermissions = ['file:read'];

/**
 * Creates file command entries bound to a ShellAdapter.
 * Called by registerShellSkills() with the active adapter.
 */
export function createFileCommands(adapter: ShellAdapter): SkillEntry[] {
  return [
    {
      definition: readDef,
      handler: async (args: any) => {
        try {
          const data = await adapter.readFile(args.path, args.encoding);
          return { success: true, data };
        } catch (err: any) {
          return { success: false, data: null, error: `file:read failed: ${err.message}` };
        }
      },
    },
    {
      definition: writeDef,
      handler: async (args: any) => {
        try {
          const data = await adapter.writeFile(args.path, args.content);
          return { success: true, data };
        } catch (err: any) {
          return { success: false, data: null, error: `file:write failed: ${err.message}` };
        }
      },
    },
    {
      definition: listDef,
      handler: async (args: any) => {
        try {
          const data = await adapter.listDir(args.path, args.pattern || undefined);
          return { success: true, data };
        } catch (err: any) {
          return { success: false, data: null, error: `file:list failed: ${err.message}` };
        }
      },
    },
  ];
}

// Legacy export for backward compatibility
export const fileCommands: SkillEntry[] = createFileCommands(
  new Proxy({} as ShellAdapter, {
    get(_, prop) {
      const { NativeShellAdapter } = require('../just-bash/adapter.js');
      const real = new NativeShellAdapter();
      return (real as any)[prop].bind(real);
    },
  })
);
