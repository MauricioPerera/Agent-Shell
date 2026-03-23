/**
 * @module skills/shell-file
 * @description File system skills using ShellAdapter for pluggable backend.
 */

import { command } from '../command-builder/index.js';
import { mkdir, rm, rename, chmod } from 'node:fs/promises';
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

const mkdirDef = command('file', 'mkdir')
  .version('1.0.0')
  .description('Create a directory (recursive by default)')
  .requiredParam('path', 'string')
  .optionalParam('recursive', 'bool', true)
  .example('file:mkdir --path ./src/components')
  .tags('file', 'write', 'filesystem')
  .build();

const deleteDef = command('file', 'delete')
  .version('1.0.0')
  .description('Delete a file or directory')
  .requiredParam('path', 'string')
  .optionalParam('recursive', 'bool', false)
  .example('file:delete --path ./tmp/cache --recursive true')
  .tags('file', 'write', 'filesystem', 'dangerous')
  .build();

const renameDef = command('file', 'rename')
  .version('1.0.0')
  .description('Rename or move a file/directory')
  .requiredParam('from', 'string')
  .requiredParam('to', 'string')
  .example('file:rename --from ./old-name.ts --to ./new-name.ts')
  .tags('file', 'write', 'filesystem')
  .build();

const chmodDef = command('file', 'chmod')
  .version('1.0.0')
  .description('Change file permissions')
  .requiredParam('path', 'string')
  .requiredParam('mode', 'string')
  .example('file:chmod --path ./script.sh --mode 755')
  .tags('file', 'write', 'filesystem', 'permissions')
  .build();

readDef.requiredPermissions = ['file:read'];
writeDef.requiredPermissions = ['file:write'];
listDef.requiredPermissions = ['file:read'];
mkdirDef.requiredPermissions = ['file:write'];
deleteDef.requiredPermissions = ['file:delete'];
renameDef.requiredPermissions = ['file:write'];
chmodDef.requiredPermissions = ['file:write'];

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
    {
      definition: mkdirDef,
      handler: async (args: any) => {
        try {
          await mkdir(args.path, { recursive: args.recursive !== false });
          return { success: true, data: { path: args.path, created: true } };
        } catch (err: any) {
          return { success: false, data: null, error: `file:mkdir failed: ${err.message}` };
        }
      },
    },
    {
      definition: deleteDef,
      handler: async (args: any) => {
        try {
          await rm(args.path, { recursive: args.recursive === true || args.recursive === 'true', force: true });
          return { success: true, data: { path: args.path, deleted: true } };
        } catch (err: any) {
          return { success: false, data: null, error: `file:delete failed: ${err.message}` };
        }
      },
    },
    {
      definition: renameDef,
      handler: async (args: any) => {
        try {
          await rename(args.from, args.to);
          return { success: true, data: { from: args.from, to: args.to, renamed: true } };
        } catch (err: any) {
          return { success: false, data: null, error: `file:rename failed: ${err.message}` };
        }
      },
    },
    {
      definition: chmodDef,
      handler: async (args: any) => {
        try {
          await chmod(args.path, parseInt(args.mode, 8));
          return { success: true, data: { path: args.path, mode: args.mode } };
        } catch (err: any) {
          return { success: false, data: null, error: `file:chmod failed: ${err.message}` };
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
