/**
 * @module skills/registry-admin
 * @description Runtime registry introspection and management skills.
 *
 * Factory pattern: registryAdminCommands(registry) returns command entries
 * with handlers that close over the live registry instance.
 */

import { command } from '../command-builder/index.js';
import type { CommandRegistry } from '../command-registry/index.js';
import type { CommandDefinition } from '../command-registry/types.js';
import type { SkillEntry } from './scaffold.js';
import { matchPermissions } from '../security/permission-matcher.js';

// ---------------------------------------------------------------------------
// Skill Definitions
// ---------------------------------------------------------------------------

const listDef = command('registry', 'list')
  .version('1.0.0')
  .description('List all registered commands with optional namespace filter')
  .optionalParam('namespace', 'string', '')
  .optionalParam('format', 'string', 'compact')
  .example('registry:list --namespace users --format compact')
  .tags('registry', 'introspection', 'listing')
  .build();

const describeDef = command('registry', 'describe')
  .version('1.0.0')
  .description('Show full definition of a registered command')
  .requiredParam('command', 'string')
  .example('registry:describe --command users:create')
  .tags('registry', 'introspection', 'detail')
  .build();

const statsDef = command('registry', 'stats')
  .version('1.0.0')
  .description('Show registry statistics: command count, namespaces, tags')
  .example('registry:stats')
  .tags('registry', 'introspection', 'stats')
  .build();

const exportDef = command('registry', 'export')
  .version('1.0.0')
  .description('Export all command definitions as JSON')
  .optionalParam('namespace', 'string', '')
  .optionalParam('pretty', 'bool', true)
  .example('registry:export --namespace users')
  .tags('registry', 'export', 'json')
  .build();

listDef.requiredPermissions = ['registry:read'];
describeDef.requiredPermissions = ['registry:read'];
statsDef.requiredPermissions = ['registry:read'];
exportDef.requiredPermissions = ['registry:read'];

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Drops any definition the caller's own permissions don't satisfy, mirroring
 * the per-item filter Core.executeBuiltin('search'/'describe') already
 * applies. Without this, registry:list/describe/export exposed every
 * command's full definition (including requiredPermissions) regardless of
 * whether the caller could actually invoke it — a lower-privileged agent
 * (e.g. 'reader') could use registry:describe to recon commands it's denied
 * from running via search/describe. null/undefined means "no enforcement
 * configured", matching Core's own convention.
 */
function filterByPermissions(defs: CommandDefinition[], agentPermissions?: string[] | null): CommandDefinition[] {
  if (!agentPermissions) return defs;
  return defs.filter(def => !def.requiredPermissions?.length || matchPermissions(agentPermissions, def.requiredPermissions));
}

export function registryAdminCommands(registry: CommandRegistry, agentPermissions?: string[] | null): SkillEntry[] {
  return [
    {
      definition: listDef,
      handler: async (args: Record<string, any>) => {
        const namespace = args.namespace as string | undefined;
        const format = (args.format as string) || 'compact';

        const allDefs = namespace
          ? registry.listByNamespace(namespace)
          : registry.listAll();
        const defs = filterByPermissions(allDefs, agentPermissions);

        const namespaces = registry.getNamespaces();

        let commands: any;
        if (format === 'compact') {
          commands = registry.toCompactTextBatch(defs);
        } else {
          commands = defs;
        }

        return {
          success: true,
          data: { namespaces, commandCount: defs.length, commands },
        };
      },
    },
    {
      definition: describeDef,
      handler: async (args: Record<string, any>) => {
        const fullName = args.command as string;

        if (!fullName || !fullName.includes(':')) {
          return { success: false, data: null, error: 'Usage: registry:describe --command namespace:name' };
        }

        const result = registry.resolve(fullName);
        if (!result.ok) {
          return { success: false, data: null, error: result.error.message };
        }

        const definition = result.value.definition;
        if (filterByPermissions([definition], agentPermissions).length === 0) {
          return { success: false, data: null, error: `Permission denied: cannot describe ${fullName}` };
        }
        const compact = registry.toCompactText(definition);

        return {
          success: true,
          data: { definition, compact },
        };
      },
    },
    {
      definition: statsDef,
      handler: async () => {
        const allDefs = filterByPermissions(registry.listAll(), agentPermissions);
        const namespaces = registry.getNamespaces();

        const namespaceCounts: Record<string, number> = {};
        const allTags = new Set<string>();
        let reversibleCount = 0;
        let deprecatedCount = 0;

        for (const def of allDefs) {
          namespaceCounts[def.namespace] = (namespaceCounts[def.namespace] || 0) + 1;
          for (const tag of def.tags) allTags.add(tag);
          if (def.reversible) reversibleCount++;
          if (def.deprecated) deprecatedCount++;
        }

        return {
          success: true,
          data: {
            totalCommands: allDefs.length,
            totalNamespaces: namespaces.length,
            namespaces: namespaceCounts,
            tagsUsed: [...allTags].sort(),
            reversibleCount,
            deprecatedCount,
          },
        };
      },
    },
    {
      definition: exportDef,
      handler: async (args: Record<string, any>) => {
        const namespace = args.namespace as string | undefined;

        const allDefs = namespace
          ? registry.listByNamespace(namespace)
          : registry.listAll();
        const defs = filterByPermissions(allDefs, agentPermissions);

        return {
          success: true,
          data: {
            exportedAt: new Date().toISOString(),
            count: defs.length,
            definitions: defs,
          },
        };
      },
    },
  ];
}
