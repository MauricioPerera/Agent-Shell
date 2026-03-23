/**
 * @module skills/shell-json
 * @description JSON filtering and parsing skills.
 * Reuses the existing jq-filter module for filtering.
 */

import { command } from '../command-builder/index.js';
import { applyFilter } from '../jq-filter/index.js';
import type { SkillEntry } from './scaffold.js';

const filterDef = command('json', 'filter')
  .version('1.0.0')
  .description('Filter JSON data using jq-like expressions (.field, .[N], [.a, .b])')
  .requiredParam('expression', 'string')
  .optionalParam('input', 'json', null)
  .example('json:filter --expression .users.[0].name --input \'{"users":[{"name":"Alice"}]}\'')
  .tags('json', 'filter', 'transform')
  .build();

const parseDef = command('json', 'parse')
  .version('1.0.0')
  .description('Parse a JSON string into a structured object')
  .requiredParam('text', 'string')
  .example('json:parse --text \'{"key":"value"}\'')
  .tags('json', 'parse')
  .build();

filterDef.requiredPermissions = ['json:read'];
parseDef.requiredPermissions = ['json:read'];

export const jsonCommands: SkillEntry[] = [
  {
    definition: filterDef,
    handler: async (args: any, input?: any) => {
      const data = args.input || input;
      if (data === null || data === undefined) {
        return { success: false, data: null, error: 'No input data. Provide --input or pipe via pipeline.' };
      }
      const parsed = typeof data === 'string' ? JSON.parse(data) : data;
      const result = applyFilter(parsed, args.expression);
      if (result.success) {
        return { success: true, data: result.result };
      }
      return { success: false, data: null, error: result.error?.message || 'Filter failed' };
    },
  },
  {
    definition: parseDef,
    handler: async (args: any) => {
      try {
        const parsed = JSON.parse(args.text);
        return { success: true, data: parsed };
      } catch (err: any) {
        return { success: false, data: null, error: `Invalid JSON: ${err.message}` };
      }
    },
  },
];
