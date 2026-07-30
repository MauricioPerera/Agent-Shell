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
import { AGENT_PROFILES, resolveAgentPermissions } from '../core/agent-profiles.js';
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

/**
 * Validates a raw --profile/AGENT_SHELL_PROFILE/config value against the
 * known profile names. An invalid value (typo, stale config) previously
 * reached AGENT_PROFILES[config.agentProfile] unchecked inside
 * resolveAgentPermissions() and crashed with an uncaught
 * "TypeError: ... is not iterable" — on stdio that's an unhandled
 * exception writing a raw stack trace to stdout, corrupting the protocol
 * stream. Exits with a clear message instead.
 */
export function validateProfile(raw: string | undefined): AgentProfile | undefined {
  if (raw === undefined) return undefined;
  if (!Object.prototype.hasOwnProperty.call(AGENT_PROFILES, raw)) {
    console.error(`Invalid profile: '${raw}'. Valid values: ${Object.keys(AGENT_PROFILES).join(', ')}`);
    process.exit(1);
  }
  return raw as AgentProfile;
}

/**
 * No profile configured means unrestricted access to every registered
 * command (documented, backward-compatible default) — worth a warning as
 * loud as the missing-auth one, since it's just as consequential and just
 * as easy to leave unset by accident.
 */
export function warnIfUnrestricted(profile: AgentProfile | undefined): void {
  if (profile) return;
  console.error('WARNING: No --profile set. The agent has UNRESTRICTED access to every registered command.');
  console.error('Use --profile <admin|operator|reader|restricted> or AGENT_SHELL_PROFILE to scope access.');
}

/**
 * Validates the parsed config file against expected types, dropping (with a
 * warning) any field that doesn't match instead of letting it propagate
 * unchecked — e.g. a non-numeric `port` used to reach `parseInt()` and
 * silently become NaN instead of failing with a clear message.
 */
export function validateConfigFile(raw: Record<string, any>, configPath: string): Record<string, any> {
  const config: Record<string, any> = {};
  const warn = (field: string, expected: string) =>
    console.error(`Warning: ${configPath} field '${field}' should be ${expected}, ignoring it.`);

  if (raw.port !== undefined) {
    if (typeof raw.port === 'number' && Number.isInteger(raw.port)) config.port = raw.port;
    else warn('port', 'an integer');
  }
  if (raw.host !== undefined) {
    if (typeof raw.host === 'string') config.host = raw.host;
    else warn('host', 'a string');
  }
  if (raw.corsOrigin !== undefined) {
    if (typeof raw.corsOrigin === 'string' || (Array.isArray(raw.corsOrigin) && raw.corsOrigin.every((o: any) => typeof o === 'string'))) {
      config.corsOrigin = raw.corsOrigin;
    } else warn('corsOrigin', 'a string or array of strings');
  }
  // agentProfile scopes what the agent can do: warn-and-drop (like the
  // fields above) would silently fall through to "no profile configured" =
  // unrestricted access — the opposite of what a bad config author
  // intended. Fail closed instead, matching validateProfile/validatePort.
  if (raw.agentProfile !== undefined) {
    if (typeof raw.agentProfile === 'string') config.agentProfile = raw.agentProfile;
    else {
      console.error(`${configPath} field 'agentProfile' should be a string, refusing to start with an ambiguous access-control config.`);
      process.exit(1);
    }
  }
  if (raw.auth?.bearerToken !== undefined) {
    if (typeof raw.auth.bearerToken === 'string') config.auth = { bearerToken: raw.auth.bearerToken };
    else warn('auth.bearerToken', 'a string');
  }
  return config;
}

/**
 * Validates a raw --port/AGENT_SHELL_PORT/config value. An unparseable
 * value (e.g. a typo) previously reached parseInt() unchecked, became NaN,
 * and only surfaced later as Node's cryptic
 * "options.port should be >= 0 and < 65536" from server.listen().
 */
export function validatePort(raw: string): number {
  const port = parseInt(raw, 10);
  if (!Number.isInteger(port) || String(port) !== raw.trim() || port < 0 || port > 65535) {
    console.error(`Invalid port: '${raw}'. Must be an integer between 0 and 65535.`);
    process.exit(1);
  }
  return port;
}

function loadConfigFile(): Record<string, any> {
  const configPath = resolve(process.cwd(), 'agent-shell.config.json');
  if (!existsSync(configPath)) return {};
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    return validateConfigFile(raw, configPath);
  } catch (err) {
    console.error(`Warning: Failed to parse ${configPath}:`, (err as Error).message);
    return {};
  }
}

function buildRegistry(args: string[], agentPermissions?: string[] | null): CommandRegistry {
  const registry = new CommandRegistry();

  if (!hasFlag(args, '--no-cli-skills')) {
    registerSkills(registry, agentPermissions);
  }

  if (!hasFlag(args, '--no-shell-skills')) {
    const adapter = createShellAdapter();
    registerShellSkills(registry, adapter);
  }

  return registry;
}

function serveStdio(args: string[]): void {
  const fileConfig = loadConfigFile();
  const profile = validateProfile(parseFlag(args, '--profile') || process.env.AGENT_SHELL_PROFILE || fileConfig.agentProfile);
  warnIfUnrestricted(profile);

  // Resolved ahead of Core (which computes the same thing internally) so
  // registry:list/describe/export can filter what they reveal by the
  // caller's own permissions — see registryAdminCommands.
  const agentPermissions = resolveAgentPermissions({ agentProfile: profile });
  const registry = buildRegistry(args, agentPermissions);
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

  const port = validatePort(String(parseFlag(args, '--port') || process.env.AGENT_SHELL_PORT || fileConfig.port || '3000'));
  const host = parseFlag(args, '--host') || process.env.AGENT_SHELL_HOST || fileConfig.host || '0.0.0.0';
  const token = parseFlag(args, '--token') || process.env.AGENT_SHELL_TOKEN || fileConfig.auth?.bearerToken;
  const profile = validateProfile(parseFlag(args, '--profile') || process.env.AGENT_SHELL_PROFILE || fileConfig.agentProfile);
  // No cross-origin default: a wildcard would let any website the operator's
  // browser visits reach this server directly once its CORS preflight
  // succeeds, defeating the Content-Type CSRF check on the common
  // loopback-with-no-auth deployment. Opt in explicitly via --cors-origin.
  const corsOrigin = parseFlag(args, '--cors-origin') || process.env.AGENT_SHELL_CORS_ORIGIN || fileConfig.corsOrigin;

  const agentPermissions = resolveAgentPermissions({ agentProfile: profile });
  const registry = buildRegistry(args, agentPermissions);
  const totalCommands = registry.listAll().length;

  const coreConfig: any = { registry };
  if (profile) coreConfig.agentProfile = profile;

  const core = new Core(coreConfig);
  const mcpServer = new McpServer({ core, version: VERSION });

  const transport = new HttpSseTransport({
    port, host, corsOrigin,
    auth: token ? { bearerToken: token } : undefined,
  });

  transport.onMessage(async (msg, sessionId) => mcpServer.handleMessage(msg, sessionId));
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

  if (!profile) {
    console.warn('  WARNING: No --profile set. The agent has UNRESTRICTED access to every registered command.');
    console.warn('  Use --profile <admin|operator|reader|restricted> or AGENT_SHELL_PROFILE to scope access.\n');
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
      // Not awaited (main() is sync), but must still be caught: an
      // unhandled rejection here (bad port, EADDRINUSE, the fail-closed
      // no-auth-on-non-loopback check) used to print a raw stack trace
      // and crash instead of a clean exit(1).
      serveHttp(args).catch((err) => {
        console.error('Failed to start:', err.message);
        process.exit(1);
      });
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
