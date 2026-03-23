/**
 * @module skills/registry-admin
 * @description Runtime registry introspection and management skills.
 *
 * Factory pattern: registryAdminCommands(registry) returns command entries
 * with handlers that close over the live registry instance.
 */

import { command } from '../command-builder/index.js';
import type { CommandRegistry } from '../command-registry/index.js';
import type { SkillEntry } from './scaffold.js';

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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function registryAdminCommands(registry: CommandRegistry): SkillEntry[] {
  return [
    {
      definition: listDef,
      handler: async (args: Record<string, any>) => {
        const namespace = args.namespace as string | undefined;
        const format = (args.format as string) || 'compact';

        const defs = namespace
          ? registry.listByNamespace(namespace)
          : registry.listAll();

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
        const allDefs = registry.listAll();
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

        const defs = namespace
          ? registry.listByNamespace(namespace)
          : registry.listAll();

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
