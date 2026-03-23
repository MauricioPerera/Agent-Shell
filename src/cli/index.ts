#!/usr/bin/env node
/**
 * @module cli
 * @description Entry point CLI de Agent Shell.
 *
 * Subcommands:
 *   serve   - Start MCP server (stdio, http, or production HTTP with auth)
 *   help    - Show CLI help
 *   version - Show version
 */

import { McpServer } from '../mcp/server.js';
import { HttpSseTransport } from '../mcp/http-transport.js';
import { Core } from '../core/index.js';
import { CommandRegistry } from '../command-registry/index.js';
import { registerSkills, registerShellSkills } from '../skills/index.js';
import { createShellAdapter } from '../just-bash/factory.js';
import type { AgentProfile } from '../core/agent-profiles.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const VERSION = '0.1.0';

const USAGE = `
agent-shell - AI-first CLI framework (2 tools + vector discovery)

Usage:
  agent-shell <command> [options]

Commands:
  serve       Start MCP server with all skills registered
  version     Show version
  help        Show this help message

Serve Options:
  --transport <stdio|http>  Transport (default: stdio)
  --port <number>           HTTP port (default: 3000)
  --host <string>           HTTP host (default: 0.0.0.0)
  --token <string>          Bearer token for auth (or env: AGENT_SHELL_TOKEN)
  --profile <string>        Agent profile: admin|operator|reader|restricted
  --cors-origin <origin>    CORS origin (default: *)
  --no-cli-skills           Skip registering CLI creation skills
  --no-shell-skills         Skip registering system shell skills

Environment Variables:
  AGENT_SHELL_PORT          HTTP port
  AGENT_SHELL_HOST          HTTP host
  AGENT_SHELL_TOKEN         Bearer token
  AGENT_SHELL_PROFILE       Agent profile
  AGENT_SHELL_CORS_ORIGIN   CORS origin

Config File:
  agent-shell.config.json   Loaded from working directory (env vars override)

Examples:
  agent-shell serve                                    Stdio transport
  agent-shell serve --transport http --token secret    HTTP with auth
  AGENT_SHELL_TOKEN=secret agent-shell serve --transport http

For deployment guide: docs/deployment.md
`.trim();

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function loadConfigFile(): Record<string, any> {
  const configPath = resolve(process.cwd(), 'agent-shell.config.json');
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    return {};
  }
}

function buildRegistry(args: string[]): CommandRegistry {
  const registry = new CommandRegistry();

  if (!hasFlag(args, '--no-cli-skills')) {
    registerSkills(registry);
  }

  if (!hasFlag(args, '--no-shell-skills')) {
    const adapter = createShellAdapter();
    registerShellSkills(registry, adapter);
  }

  return registry;
}

function serveStdio(args: string[]): void {
  const fileConfig = loadConfigFile();
  const profile = (parseFlag(args, '--profile') || process.env.AGENT_SHELL_PROFILE || fileConfig.agentProfile) as AgentProfile | undefined;

  const registry = buildRegistry(args);
  const coreConfig: any = { registry };
  if (profile) coreConfig.agentProfile = profile;

  const core = new Core(coreConfig);
  const server = new McpServer({ core, version: VERSION });

  process.on('SIGINT', () => { server.stop(); process.exit(0); });
  process.on('SIGTERM', () => { server.stop(); process.exit(0); });

  server.start();
}

async function serveHttp(args: string[]): Promise<void> {
  const fileConfig = loadConfigFile();

  const port = parseInt(parseFlag(args, '--port') || process.env.AGENT_SHELL_PORT || fileConfig.port || '3000', 10);
  const host = parseFlag(args, '--host') || process.env.AGENT_SHELL_HOST || fileConfig.host || '0.0.0.0';
  const token = parseFlag(args, '--token') || process.env.AGENT_SHELL_TOKEN || fileConfig.auth?.bearerToken;
  const profile = (parseFlag(args, '--profile') || process.env.AGENT_SHELL_PROFILE || fileConfig.agentProfile) as AgentProfile | undefined;
  const corsOrigin = parseFlag(args, '--cors-origin') || process.env.AGENT_SHELL_CORS_ORIGIN || fileConfig.corsOrigin || '*';

  const registry = buildRegistry(args);
  const totalCommands = registry.listAll().length;

  const coreConfig: any = { registry };
  if (profile) coreConfig.agentProfile = profile;

  const core = new Core(coreConfig);
  const mcpServer = new McpServer({ core, version: VERSION });

  const transport = new HttpSseTransport({
    port, host, corsOrigin,
    auth: token ? { bearerToken: token } : undefined,
  });

  transport.onMessage(async (msg) => mcpServer.handleMessage(msg));
  await transport.start();

  console.log(`Agent Shell v${VERSION}`);
  console.log(`  ${totalCommands} commands registered`);
  console.log(`  Auth: ${token ? 'Bearer token' : 'DISABLED'}`);
  console.log(`  Profile: ${profile || 'unrestricted'}`);
  console.log(`  Listening: http://${host}:${port}`);

  if (!token) {
    console.warn('\n  WARNING: No auth token set. Server is open.');
    console.warn('  Use --token <value> or AGENT_SHELL_TOKEN env var.\n');
  }

  process.on('SIGINT', async () => { await transport.stop(); process.exit(0); });
  process.on('SIGTERM', async () => { await transport.stop(); process.exit(0); });
}

/** CLI entry point. */
export function main(args: string[] = process.argv.slice(2)): void {
  const command = args[0];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE);
    return;
  }

  if (command === 'version' || command === '--version' || command === '-v') {
    console.log(`agent-shell v${VERSION}`);
    return;
  }

  if (command === 'serve') {
    const transport = parseFlag(args, '--transport') || 'stdio';

    if (transport === 'http') {
      serveHttp(args);
      return;
    }

    if (transport === 'stdio') {
      serveStdio(args);
      return;
    }

    console.error(`Unknown transport: ${transport}. Use "stdio" or "http".`);
    process.exit(1);
    return;
  }

  console.error(`Unknown command: ${command}`);
  console.error('Run "agent-shell help" for usage information.');
  process.exit(1);
}

// Auto-execute when run directly
const isDirectExecution = process.argv[1]?.includes('agent-shell') ||
  process.argv[1]?.endsWith('/cli/index.js') ||
  process.argv[1]?.endsWith('\\cli\\index.js');

if (isDirectExecution) {
  main();
}
