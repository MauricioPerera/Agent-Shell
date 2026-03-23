/**
 * @module skills/scaffold
 * @description Project scaffolding skills for Agent Shell CLIs.
 *
 * Generates project structure, namespace directories, and command files
 * as string output (no filesystem side effects — the agent or user saves to disk).
 */

import { command } from '../command-builder/index.js';
import type { CommandDefinition } from '../command-registry/types.js';

export type SkillEntry = { definition: CommandDefinition; handler: Function };

const NAME_REGEX = /^[a-z][a-z0-9-]{0,49}$/;

function validateName(value: string, label: string): string | null {
  if (!NAME_REGEX.test(value)) {
    return `Invalid ${label}: '${value}' must match ^[a-z][a-z0-9-]{0,49}$`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Templates (pure functions)
// ---------------------------------------------------------------------------

function generatePackageJson(name: string, description: string, author: string): string {
  return JSON.stringify({
    name,
    version: '0.1.0',
    type: 'module',
    description,
    author,
    scripts: {
      build: 'tsup src/index.ts --format esm --dts',
      dev: 'tsx src/index.ts',
    },
    dependencies: {
      'agent-shell': '^0.1.0',
    },
    devDependencies: {
      tsup: '^8.0.0',
      tsx: '^4.0.0',
      typescript: '^5.0.0',
    },
  }, null, 2);
}

function generateTsConfig(): string {
  return JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      declaration: true,
      declarationMap: true,
      sourceMap: true,
      outDir: './dist',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
    },
    include: ['src'],
  }, null, 2);
}

function generateEntryPoint(name: string): string {
  return `/**
 * ${name} — Built with Agent Shell
 */

import { CommandRegistry, Core, McpServer } from 'agent-shell';
import { commands } from './commands/index.js';

// --- Setup ---
const registry = new CommandRegistry();

for (const { definition, handler } of commands) {
  const result = registry.register(definition, handler);
  if (!result.ok) {
    console.error('Failed to register:', result.error.message);
  }
}

const core = new Core({ registry });

// --- Start MCP Server ---
const server = new McpServer({ core, name: '${name}' });
server.start();
`;
}

function generateCommandsBarrel(): string {
  return `/**
 * Command registry — add your commands here.
 *
 * Each entry exports { definition, handler } that gets registered in the Core.
 */

import type { CommandDefinition } from 'agent-shell';

export type CommandEntry = { definition: CommandDefinition; handler: Function };

// Import your command modules here:
// import { definition as usersCreate, handler as usersCreateHandler } from './users/create.js';

export const commands: CommandEntry[] = [
  // { definition: usersCreate, handler: usersCreateHandler },
];
`;
}

function generateNamespaceBarrel(namespace: string, description: string): string {
  return `/**
 * Namespace: ${namespace}
 * ${description}
 *
 * Add command imports here and re-export them.
 */

import type { CommandDefinition } from 'agent-shell';

export type CommandEntry = { definition: CommandDefinition; handler: Function };

// Import command modules:
// import { definition as create, handler as createHandler } from './create.js';

export const commands: CommandEntry[] = [
  // { definition: create, handler: createHandler },
];
`;
}

function generateCommandFile(namespace: string, name: string, description: string, params?: any[]): string {
  const paramLines = (params || []).map((p: any) => {
    const req = p.required ? '.required()' : '';
    const def = p.default !== undefined ? `.default(${JSON.stringify(p.default)})` : '';
    const desc = p.description ? `.description('${p.description}')` : '';
    return `  .param('${p.name}', '${p.type || 'string'}', p => p${req}${def}${desc})`;
  }).join('\n');

  const paramBlock = paramLines ? '\n' + paramLines : '';

  return `import { command } from 'agent-shell';

export const definition = command('${namespace}', '${name}')
  .version('1.0.0')
  .description('${description}')${paramBlock}
  .example('${namespace}:${name}${params?.length ? ' --' + params[0].name + ' value' : ''}')
  .tags('${namespace}')
  .build();

export async function handler(args: Record<string, any>, input?: any) {
  // TODO: implement ${namespace}:${name}
  return { success: true, data: { ...args } };
}
`;
}

// ---------------------------------------------------------------------------
// Skill Definitions
// ---------------------------------------------------------------------------

const initDef = command('scaffold', 'init')
  .version('1.0.0')
  .description('Generate a new Agent Shell CLI project structure')
  .requiredParam('name', 'string')
  .optionalParam('description', 'string', 'An Agent Shell CLI')
  .optionalParam('author', 'string', '')
  .example('scaffold:init --name my-cli --description "My awesome CLI"')
  .tags('scaffold', 'project', 'generator')
  .build();

const addNamespaceDef = command('scaffold', 'add-namespace')
  .version('1.0.0')
  .description('Generate a namespace directory with barrel export')
  .requiredParam('namespace', 'string')
  .optionalParam('description', 'string', '')
  .example('scaffold:add-namespace --namespace users --description "User management"')
  .tags('scaffold', 'namespace', 'generator')
  .build();

const addCommandDef = command('scaffold', 'add-command')
  .version('1.0.0')
  .description('Generate a command file with handler boilerplate')
  .requiredParam('namespace', 'string')
  .requiredParam('name', 'string')
  .optionalParam('description', 'string', 'TODO: describe this command')
  .optionalParam('params', 'json', null)
  .example('scaffold:add-command --namespace users --name create --description "Creates a user"')
  .tags('scaffold', 'command', 'generator')
  .build();

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleInit(args: Record<string, any>) {
  const name = args.name as string;
  const description = (args.description as string) || 'An Agent Shell CLI';
  const author = (args.author as string) || '';

  const err = validateName(name, 'project name');
  if (err) return { success: false, data: null, error: err };

  return {
    success: true,
    data: {
      projectName: name,
      files: {
        'package.json': generatePackageJson(name, description, author),
        'tsconfig.json': generateTsConfig(),
        'src/index.ts': generateEntryPoint(name),
        'src/commands/index.ts': generateCommandsBarrel(),
      },
      instructions: `Create directory '${name}/' and write each file. Then run: cd ${name} && npm install`,
    },
  };
}

async function handleAddNamespace(args: Record<string, any>) {
  const namespace = args.namespace as string;
  const description = (args.description as string) || '';

  const err = validateName(namespace, 'namespace');
  if (err) return { success: false, data: null, error: err };

  return {
    success: true,
    data: {
      namespace,
      files: {
        [`src/commands/${namespace}/index.ts`]: generateNamespaceBarrel(namespace, description),
      },
      instructions: `Create the directory and file, then import from src/commands/index.ts`,
    },
  };
}

async function handleAddCommand(args: Record<string, any>) {
  const namespace = args.namespace as string;
  const name = args.name as string;
  const description = (args.description as string) || 'TODO: describe this command';
  const params = typeof args.params === 'string' ? JSON.parse(args.params) : (args.params || []);

  const nsErr = validateName(namespace, 'namespace');
  if (nsErr) return { success: false, data: null, error: nsErr };

  const nameErr = validateName(name, 'command name');
  if (nameErr) return { success: false, data: null, error: nameErr };

  return {
    success: true,
    data: {
      namespace,
      name,
      files: {
        [`src/commands/${namespace}/${name}.ts`]: generateCommandFile(namespace, name, description, params),
      },
      instructions: `Write the file and add it to src/commands/${namespace}/index.ts barrel export`,
    },
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const scaffoldCommands: SkillEntry[] = [
  { definition: initDef, handler: handleInit },
  { definition: addNamespaceDef, handler: handleAddNamespace },
  { definition: addCommandDef, handler: handleAddCommand },
];
