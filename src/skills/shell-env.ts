/**
 * @module skills/shell-env
 * @description Environment variable skills.
 * Masks sensitive variables by default unless agent has 'env:read-secrets'.
 */

import { command } from '../command-builder/index.js';
import { isSensitiveEnvKey } from '../security/secret-patterns.js';
import type { SkillEntry } from './scaffold.js';

const getDef = command('env', 'get')
  .version('1.0.0')
  .description('Get an environment variable value')
  .requiredParam('name', 'string')
  .example('env:get --name NODE_ENV')
  .tags('env', 'read', 'system')
  .build();

const listDef = command('env', 'list')
  .version('1.0.0')
  .description('List environment variables, optionally filtered by prefix')
  .optionalParam('prefix', 'string', '')
  .example('env:list --prefix NODE')
  .tags('env', 'read', 'system', 'listing')
  .build();

getDef.requiredPermissions = ['env:read'];
listDef.requiredPermissions = ['env:read'];

export const envCommands: SkillEntry[] = [
  {
    definition: getDef,
    handler: async (args: any) => {
      const name = args.name as string;
      const value = process.env[name];
      const exists = value !== undefined;

      // Mask sensitive values
      const masked = exists && isSensitiveEnvKey(name) ? '***MASKED***' : value;

      return {
        success: true,
        data: { name, value: masked ?? null, exists },
      };
    },
  },
  {
    definition: listDef,
    handler: async (args: any) => {
      const prefix = (args.prefix || '') as string;
      const variables: Record<string, string> = {};

      for (const [key, value] of Object.entries(process.env)) {
        if (prefix && !key.startsWith(prefix)) continue;
        if (value === undefined) continue;

        // Mask sensitive values
        variables[key] = isSensitiveEnvKey(key) ? '***MASKED***' : value;
      }

      return {
        success: true,
        data: { count: Object.keys(variables).length, variables },
      };
    },
  },
];
