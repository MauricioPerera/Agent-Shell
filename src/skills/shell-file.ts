/**
 * @module skills/shell-file
 * @description File system skills using ShellAdapter for pluggable backend.
 */

import { command } from '../command-builder/index.js';
import { resolve, sep } from 'node:path';
import { NativeShellAdapter } from '../just-bash/adapter.js';
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
 *
 * An optional `jailRoot` may be provided to constrain all filesystem operations
 * to a single subtree (syntactic containment: blocks `../` traversal and absolute
 * paths that resolve outside the root). When omitted, behavior is unrestricted,
 * identical to the historical default. See `assertInsideJail` for limitations.
 */
export function createFileCommands(adapter: ShellAdapter, jailRoot?: string): SkillEntry[] {
  const jailRootAbs = jailRoot ? resolve(jailRoot) : null;

  /**
   * Validate that `inputPath` resolves inside the jail root. Returns the resolved
   * path on success so callers operate on exactly what was validated.
   *
   * NOTE: this is a SYNTACTIC containment check. It does not resolve symlinks, so
   * a symlink that lives inside the jail but points outside it would still pass.
   * Hardening that with `fs.realpath` is a separate, known limitation.
   */
  function assertInsideJail(inputPath: string): { ok: true; resolved: string } | { ok: false; error: string } {
    if (!jailRootAbs) return { ok: true, resolved: inputPath };
    // resolve(jailRootAbs, inputPath): relative inputPath is resolved inside the
    // jail; an absolute inputPath is returned as-is (resolve ignores the first
    // arg in that case), which the startsWith check below then blocks.
    const resolved = resolve(jailRootAbs, inputPath);
    const withinJail = resolved === jailRootAbs || resolved.startsWith(jailRootAbs + sep);
    if (!withinJail) {
      return { ok: false, error: `Blocked: path '${inputPath}' resolves outside jail root '${jailRootAbs}'` };
    }
    return { ok: true, resolved };
  }

  return [
    {
      definition: readDef,
      handler: async (args: any) => {
        try {
          const check = assertInsideJail(args.path);
          if (!check.ok) return { success: false, data: null, error: check.error };
          const data = await adapter.readFile(check.resolved, args.encoding);
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
          const check = assertInsideJail(args.path);
          if (!check.ok) return { success: false, data: null, error: check.error };
          const data = await adapter.writeFile(check.resolved, args.content);
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
          const check = assertInsideJail(args.path);
          if (!check.ok) return { success: false, data: null, error: check.error };
          const data = await adapter.listDir(check.resolved, args.pattern || undefined);
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
          const check = assertInsideJail(args.path);
          if (!check.ok) return { success: false, data: null, error: check.error };
          const data = await adapter.mkdir(check.resolved, { recursive: args.recursive !== false });
          return { success: true, data };
        } catch (err: any) {
          return { success: false, data: null, error: `file:mkdir failed: ${err.message}` };
        }
      },
    },
    {
      definition: deleteDef,
      handler: async (args: any) => {
        try {
          const check = assertInsideJail(args.path);
          if (!check.ok) return { success: false, data: null, error: check.error };
          const data = await adapter.remove(check.resolved, { recursive: args.recursive === true || args.recursive === 'true' });
          return { success: true, data };
        } catch (err: any) {
          return { success: false, data: null, error: `file:delete failed: ${err.message}` };
        }
      },
    },
    {
      definition: renameDef,
      handler: async (args: any) => {
        try {
          const fromCheck = assertInsideJail(args.from);
          if (!fromCheck.ok) return { success: false, data: null, error: fromCheck.error };
          const toCheck = assertInsideJail(args.to);
          if (!toCheck.ok) return { success: false, data: null, error: toCheck.error };
          const data = await adapter.rename(fromCheck.resolved, toCheck.resolved);
          return { success: true, data };
        } catch (err: any) {
          return { success: false, data: null, error: `file:rename failed: ${err.message}` };
        }
      },
    },
    {
      definition: chmodDef,
      handler: async (args: any) => {
        try {
          const check = assertInsideJail(args.path);
          if (!check.ok) return { success: false, data: null, error: check.error };
          await adapter.chmod(check.resolved, parseInt(args.mode, 8));
          return { success: true, data: { path: check.resolved, mode: args.mode } };
        } catch (err: any) {
          return { success: false, data: null, error: `file:chmod failed: ${err.message}` };
        }
      },
    },
  ];
}

// Legacy export for backward compatibility. Previously lazy-loaded
// NativeShellAdapter via a bare require() inside a Proxy — see
// shell-exec.ts's shellCommands for why that's both unnecessary (it's a
// sibling module, not an external dependency) and broken under this
// package's ESM-only build.
export const fileCommands: SkillEntry[] = createFileCommands(new NativeShellAdapter());
