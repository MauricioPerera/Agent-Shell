/**
 * @module skills/shell-file
 * @description File system skills using fs/promises.
 */

import { command } from '../command-builder/index.js';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
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

export const fileCommands: SkillEntry[] = [
  {
    definition: readDef,
    handler: async (args: any) => {
      try {
        const encoding = (args.encoding || 'utf-8') as BufferEncoding;
        const content = await readFile(args.path, { encoding });
        const stats = await stat(args.path);
        return { success: true, data: { path: args.path, content, size: stats.size } };
      } catch (err: any) {
        return { success: false, data: null, error: `file:read failed: ${err.message}` };
      }
    },
  },
  {
    definition: writeDef,
    handler: async (args: any) => {
      try {
        await writeFile(args.path, args.content, 'utf-8');
        const size = Buffer.byteLength(args.content, 'utf-8');
        return { success: true, data: { path: args.path, size, written: true } };
      } catch (err: any) {
        return { success: false, data: null, error: `file:write failed: ${err.message}` };
      }
    },
  },
  {
    definition: listDef,
    handler: async (args: any) => {
      try {
        const dirEntries = await readdir(args.path, { withFileTypes: true });
        let entries = await Promise.all(
          dirEntries.map(async (entry) => {
            const fullPath = join(args.path, entry.name);
            let size = 0;
            try {
              const s = await stat(fullPath);
              size = s.size;
            } catch { /* ignore */ }
            return {
              name: entry.name,
              type: entry.isDirectory() ? 'directory' : 'file',
              size,
            };
          })
        );

        if (args.pattern) {
          entries = entries.filter(e => e.name.includes(args.pattern));
        }

        return { success: true, data: { path: args.path, entries, count: entries.length } };
      } catch (err: any) {
        return { success: false, data: null, error: `file:list failed: ${err.message}` };
      }
    },
  },
];
