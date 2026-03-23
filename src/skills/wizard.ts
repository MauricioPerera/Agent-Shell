/**
 * @module skills/wizard
 * @description Interactive command creation wizard for Agent Shell.
 *
 * Generates CommandDefinition objects and handler skeletons from structured input.
 * Validates all fields against registry rules before returning.
 */

import { command } from '../command-builder/index.js';
import type { CommandDefinition, CommandParam } from '../command-registry/types.js';
import { BASE_PARAM_TYPES, ENUM_TYPE_PATTERN, ARRAY_TYPE_PATTERN } from '../command-registry/types.js';
import type { SkillEntry } from './scaffold.js';

const NAME_REGEX = /^[a-z][a-z0-9-]{0,49}$/;

function validateName(value: string, label: string): string | null {
  if (!NAME_REGEX.test(value)) {
    return `Invalid ${label}: '${value}' must match ^[a-z][a-z0-9-]{0,49}$`;
  }
  return null;
}

function isValidParamType(type: string): boolean {
  if (BASE_PARAM_TYPES.includes(type)) return true;
  if (ENUM_TYPE_PATTERN.test(type)) return true;
  if (ARRAY_TYPE_PATTERN.test(type)) return true;
  return false;
}

function buildDefinition(
  namespace: string,
  name: string,
  description: string,
  params: any[],
  opts: { outputType?: string; tags?: string[]; reversible?: boolean; requiresConfirmation?: boolean; example?: string },
): CommandDefinition {
  const parsedParams: CommandParam[] = (params || []).map((p: any) => ({
    name: p.name,
    type: p.type || 'string',
    required: p.required ?? false,
    default: p.default,
    constraints: p.constraints,
    description: p.description,
  }));

  const autoExample = opts.example ||
    `${namespace}:${name}${parsedParams.length ? ' --' + parsedParams[0].name + ' value' : ''}`;

  return {
    namespace,
    name,
    version: '1.0.0',
    description,
    params: parsedParams,
    output: { type: opts.outputType || 'object' },
    example: autoExample,
    tags: opts.tags || [namespace],
    reversible: opts.reversible ?? false,
    requiresConfirmation: opts.requiresConfirmation ?? false,
    deprecated: false,
  };
}

function generateHandlerSkeleton(namespace: string, name: string): string {
  return `async function handler(args: Record<string, any>, input?: any) {
  // TODO: implement ${namespace}:${name}
  return { success: true, data: { ...args } };
}`;
}

// ---------------------------------------------------------------------------
// Skill Definitions
// ---------------------------------------------------------------------------

const createCommandDef = command('wizard', 'create-command')
  .version('1.0.0')
  .description('Create a complete CommandDefinition from structured input')
  .requiredParam('namespace', 'string')
  .requiredParam('name', 'string')
  .requiredParam('description', 'string')
  .optionalParam('params', 'json', null)
  .optionalParam('output-type', 'string', 'object')
  .optionalParam('tags', 'json', null)
  .optionalParam('reversible', 'bool', false)
  .optionalParam('example', 'string', '')
  .example('wizard:create-command --namespace users --name create --description "Creates a user" --params \'[{"name":"email","type":"string","required":true}]\'')
  .tags('wizard', 'command', 'creation')
  .build();

const createNamespaceDef = command('wizard', 'create-namespace')
  .version('1.0.0')
  .description('Create multiple CommandDefinitions for a namespace at once')
  .requiredParam('namespace', 'string')
  .requiredParam('commands', 'json')
  .example('wizard:create-namespace --namespace users --commands \'[{"name":"create","description":"Creates a user"},{"name":"list","description":"Lists users"}]\'')
  .tags('wizard', 'namespace', 'creation')
  .build();

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleCreateCommand(args: Record<string, any>) {
  const namespace = args.namespace as string;
  const name = args.name as string;
  const description = args.description as string;
  const params = typeof args.params === 'string' ? JSON.parse(args.params) : (args.params || []);
  const tags = typeof args.tags === 'string' ? JSON.parse(args.tags) : args.tags;

  const nsErr = validateName(namespace, 'namespace');
  if (nsErr) return { success: false, data: null, error: nsErr };

  const nameErr = validateName(name, 'command name');
  if (nameErr) return { success: false, data: null, error: nameErr };

  // Validate param types
  for (const p of params) {
    if (p.type && !isValidParamType(p.type)) {
      return { success: false, data: null, error: `Unknown param type: '${p.type}'. Valid: int, float, string, bool, date, json, enum(), array<>` };
    }
  }

  const definition = buildDefinition(namespace, name, description, params, {
    outputType: args['output-type'],
    tags,
    reversible: args.reversible,
    example: args.example,
  });

  return {
    success: true,
    data: {
      definition,
      handlerSkeleton: generateHandlerSkeleton(namespace, name),
      registrationCode: `registry.register(definition, handler);`,
    },
  };
}

async function handleCreateNamespace(args: Record<string, any>) {
  const namespace = args.namespace as string;
  const commands = typeof args.commands === 'string' ? JSON.parse(args.commands) : args.commands;

  const nsErr = validateName(namespace, 'namespace');
  if (nsErr) return { success: false, data: null, error: nsErr };

  if (!Array.isArray(commands) || commands.length === 0) {
    return { success: false, data: null, error: 'commands must be a non-empty array' };
  }

  const definitions: CommandDefinition[] = [];
  const handlerSkeletons: Record<string, string> = {};

  for (const cmd of commands) {
    if (!cmd.name || !cmd.description) {
      return { success: false, data: null, error: `Each command must have 'name' and 'description'. Got: ${JSON.stringify(cmd)}` };
    }

    const nameErr = validateName(cmd.name, 'command name');
    if (nameErr) return { success: false, data: null, error: nameErr };

    // Validate param types
    for (const p of (cmd.params || [])) {
      if (p.type && !isValidParamType(p.type)) {
        return { success: false, data: null, error: `Unknown param type '${p.type}' in command '${cmd.name}'` };
      }
    }

    const def = buildDefinition(namespace, cmd.name, cmd.description, cmd.params || [], {
      outputType: cmd.outputType,
      tags: cmd.tags,
    });
    definitions.push(def);
    handlerSkeletons[cmd.name] = generateHandlerSkeleton(namespace, cmd.name);
  }

  return {
    success: true,
    data: {
      namespace,
      commandCount: definitions.length,
      definitions,
      handlerSkeletons,
    },
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const wizardCommands: SkillEntry[] = [
  { definition: createCommandDef, handler: handleCreateCommand },
  { definition: createNamespaceDef, handler: handleCreateNamespace },
];
