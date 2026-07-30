#!/usr/bin/env node
/**
 * @module server
 * @description Production-ready Agent Shell HTTP server.
 *
 * Reads configuration from environment variables or agent-shell.config.json,
 * bootstraps the full stack (registry + skills + vectorIndex + core + MCP),
 * and starts the HTTP/SSE transport with Bearer token auth.
 *
 * Usage:
 *   AGENT_SHELL_TOKEN=my-secret npx tsx src/server/index.ts
 *
 * Or with config file:
 *   Create agent-shell.config.json in the working directory
 */

import { CommandRegistry } from '../command-registry/index.js';
import { Core } from '../core/index.js';
import { McpServer } from '../mcp/server.js';
import { HttpSseTransport } from '../mcp/http-transport.js';
import { registerSkills, registerShellSkills } from '../skills/index.js';
import { createShellAdapter } from '../just-bash/factory.js';
import { AGENT_PROFILES, resolveAgentPermissions } from '../core/agent-profiles.js';
import type { AgentProfile } from '../core/agent-profiles.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface ServerConfig {
  port: number;
  host: string;
  auth: { bearerToken: string } | null;
  agentProfile: AgentProfile | null;
  permissions: string[] | null;
  corsOrigin: string | string[] | undefined;
  skills: { cli: boolean; shell: boolean };
  shellAdapter: 'native' | 'just-bash' | 'auto';
}

/**
 * Validates the parsed config file against expected types, dropping (with a
 * warning) any field that doesn't match instead of letting it propagate
 * unchecked — e.g. a non-numeric `port` used to reach parseInt() territory
 * indirectly via HttpSseTransport and fail with a confusing internal error
 * instead of a clear one here.
 */
/**
 * Validates a raw port value from AGENT_SHELL_PORT. An unparseable value
 * previously reached parseInt() unchecked, became NaN, and only surfaced
 * later as Node's cryptic "options.port should be >= 0 and < 65536" error
 * from server.listen() instead of a message pointing at the actual cause.
 */
/**
 * Masks a bearer token for the startup log, revealing only a short suffix
 * scaled to the token's length instead of a fixed first-4/last-4 window —
 * for a short/medium token (e.g. a hand-typed 9-12 char value) first-4+last-4
 * reveals most or all of it, leaving little to brute-force. Never reveals a
 * prefix, matching common key-preview conventions (Stripe/AWS-style).
 */
export function maskToken(token: string): string {
  if (token.length <= 8) return '***';
  const visibleChars = Math.min(4, Math.floor(token.length / 4));
  return `${'*'.repeat(token.length - visibleChars)}${token.slice(-visibleChars)}`;
}

export function validatePort(raw: string): number {
  const port = parseInt(raw, 10);
  if (!Number.isInteger(port) || String(port) !== raw.trim() || port < 0 || port > 65535) {
    throw new Error(`Invalid port: '${raw}'. Must be an integer between 0 and 65535.`);
  }
  return port;
}

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
  if (raw.auth?.bearerToken !== undefined) {
    if (typeof raw.auth.bearerToken === 'string') config.auth = { bearerToken: raw.auth.bearerToken };
    else warn('auth.bearerToken', 'a string');
  }
  // agentProfile/permissions scope what the agent can do: dropping a
  // wrong-typed value here (like the warn-and-ignore fields above) would
  // silently fall through to loadConfig()'s "no profile = unrestricted"
  // default — the opposite of what a bad config author intended. Fail
  // closed instead.
  if (raw.agentProfile !== undefined) {
    if (typeof raw.agentProfile === 'string') config.agentProfile = raw.agentProfile;
    else throw new Error(`${configPath} field 'agentProfile' should be a string, refusing to start with an ambiguous access-control config.`);
  }
  if (raw.permissions !== undefined) {
    if (Array.isArray(raw.permissions) && raw.permissions.every((p: any) => typeof p === 'string')) config.permissions = raw.permissions;
    else throw new Error(`${configPath} field 'permissions' should be an array of strings, refusing to start with an ambiguous access-control config.`);
  }
  if (raw.corsOrigin !== undefined) {
    if (typeof raw.corsOrigin === 'string' || (Array.isArray(raw.corsOrigin) && raw.corsOrigin.every((o: any) => typeof o === 'string'))) {
      config.corsOrigin = raw.corsOrigin;
    } else warn('corsOrigin', 'a string or array of strings');
  }
  if (raw.skills !== undefined) {
    if (typeof raw.skills === 'object' && raw.skills !== null) config.skills = raw.skills;
    else warn('skills', 'an object');
  }
  if (raw.shellAdapter !== undefined) {
    if (typeof raw.shellAdapter === 'string') config.shellAdapter = raw.shellAdapter;
    else warn('shellAdapter', 'a string');
  }
  return config;
}

function loadConfig(): ServerConfig {
  // Defaults
  const config: ServerConfig = {
    port: 3000,
    host: '0.0.0.0',
    auth: null,
    agentProfile: null,
    permissions: null,
    // No cross-origin access by default. A wildcard here would let ANY
    // website the operator's browser visits call this server directly
    // (browsers happily send a real request once a '*' preflight succeeds),
    // which is exactly the loopback-with-no-auth deployment the fail-closed
    // auth check above intentionally still allows. Cross-origin browser
    // clients must opt in explicitly via corsOrigin / AGENT_SHELL_CORS_ORIGIN.
    corsOrigin: undefined,
    skills: { cli: true, shell: true },
    shellAdapter: 'auto',
  };

  // Try config file
  const configPath = resolve(process.cwd(), 'agent-shell.config.json');
  if (existsSync(configPath)) {
    let raw: Record<string, any>;
    try {
      raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch (err) {
      console.error(`Warning: Failed to parse ${configPath}:`, (err as Error).message);
      raw = null as any;
    }
    if (raw) {
      // Not wrapped in the try/catch above: a malformed agentProfile/permissions
      // value is a security-relevant config error and must abort startup, not
      // be swallowed into the same warn-and-continue path as a JSON syntax typo.
      const fileConfig = validateConfigFile(raw, configPath);
      if (fileConfig.port) config.port = fileConfig.port;
      if (fileConfig.host) config.host = fileConfig.host;
      if (fileConfig.auth?.bearerToken) config.auth = { bearerToken: fileConfig.auth.bearerToken };
      if (fileConfig.agentProfile) config.agentProfile = fileConfig.agentProfile;
      if (fileConfig.permissions) config.permissions = fileConfig.permissions;
      if (fileConfig.corsOrigin) config.corsOrigin = fileConfig.corsOrigin;
      if (fileConfig.skills) config.skills = { ...config.skills, ...fileConfig.skills };
      if (fileConfig.shellAdapter) config.shellAdapter = fileConfig.shellAdapter;
    }
  }

  // Env vars override file config
  if (process.env.AGENT_SHELL_PORT) config.port = validatePort(process.env.AGENT_SHELL_PORT);
  if (process.env.AGENT_SHELL_HOST) config.host = process.env.AGENT_SHELL_HOST;
  if (process.env.AGENT_SHELL_TOKEN) config.auth = { bearerToken: process.env.AGENT_SHELL_TOKEN };
  if (process.env.AGENT_SHELL_PROFILE) config.agentProfile = process.env.AGENT_SHELL_PROFILE as AgentProfile;
  if (process.env.AGENT_SHELL_CORS_ORIGIN) config.corsOrigin = process.env.AGENT_SHELL_CORS_ORIGIN;
  if (process.env.AGENT_SHELL_ADAPTER) config.shellAdapter = process.env.AGENT_SHELL_ADAPTER as any;

  return config;
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function main() {
  const config = loadConfig();

  // An invalid agentProfile (typo in config/env) previously reached
  // AGENT_PROFILES[config.agentProfile] unchecked inside
  // resolveAgentPermissions() and crashed with an uncaught
  // "TypeError: ... is not iterable". main().catch() below turns that into
  // a clean exit(1), but the message was a confusing internal TypeError
  // rather than something an operator could act on.
  if (config.agentProfile && !Object.prototype.hasOwnProperty.call(AGENT_PROFILES, config.agentProfile)) {
    throw new Error(`Invalid agentProfile: '${config.agentProfile}'. Valid values: ${Object.keys(AGENT_PROFILES).join(', ')}`);
  }

  console.log('Agent Shell Server starting...');
  console.log(`  Port: ${config.port}`);
  console.log(`  Host: ${config.host}`);
  console.log(`  Auth: ${config.auth ? 'Bearer token enabled' : 'DISABLED (not recommended)'}`);
  console.log(`  Profile: ${config.agentProfile || 'none (unrestricted)'}`);
  console.log(`  Shell adapter: ${config.shellAdapter}`);

  if (!config.auth) {
    console.warn('\n  WARNING: No authentication configured. Server is open to anyone.');
    console.warn('  Set AGENT_SHELL_TOKEN=<token> or add auth.bearerToken to config.\n');
  }

  if (!config.agentProfile) {
    console.warn('  WARNING: No agentProfile configured. The agent has UNRESTRICTED access to every registered command.');
    console.warn('  Set AGENT_SHELL_PROFILE=<admin|operator|reader|restricted> or agentProfile in config.\n');
  }

  // Registry
  const registry = new CommandRegistry();

  // Resolved ahead of Core (which computes the same thing internally from
  // the same two fields) so registry:list/describe/export can filter what
  // they reveal by the caller's own permissions, not just gate on
  // registry:read for the whole command — see registryAdminCommands.
  const agentPermissions = resolveAgentPermissions({
    agentProfile: config.agentProfile ?? undefined,
    permissions: config.permissions ?? undefined,
  });

  // Skills
  if (config.skills.cli) {
    registerSkills(registry, agentPermissions);
    console.log('  CLI skills: 9 commands registered');
  }
  if (config.skills.shell) {
    const adapter = createShellAdapter({ prefer: config.shellAdapter });
    registerShellSkills(registry, adapter);
    console.log(`  Shell skills: 12 commands registered (${adapter.backend} backend)`);
  }

  const totalCommands = registry.listAll().length;
  console.log(`  Total commands: ${totalCommands}`);

  // Core
  const coreConfig: any = { registry };
  if (config.agentProfile) coreConfig.agentProfile = config.agentProfile;
  if (config.permissions) coreConfig.permissions = config.permissions;
  const core = new Core(coreConfig);

  // MCP Server
  const mcpServer = new McpServer({ core, name: 'agent-shell', version: '0.1.0' });

  // HTTP Transport
  const transport = new HttpSseTransport({
    port: config.port,
    host: config.host,
    corsOrigin: config.corsOrigin,
    auth: config.auth || undefined,
  });

  transport.onMessage(async (msg) => {
    const response = await mcpServer.handleMessage(msg);
    return response;
  });

  await transport.start();

  console.log(`\nAgent Shell Server running at http://${config.host}:${config.port}`);
  console.log(`  RPC endpoint: POST http://${config.host}:${config.port}/rpc`);
  console.log(`  SSE endpoint: GET  http://${config.host}:${config.port}/sse`);
  console.log(`  Health check: GET  http://${config.host}:${config.port}/health`);

  if (config.auth) {
    // The real token is deliberately NOT printed here: this block goes to
    // stdout, which on a typical deployment ends up in a systemd journal,
    // docker logs, a process manager's log file, or CI output — all places
    // a bearer token shouldn't land in plaintext. The operator already has
    // the real value (they set it via AGENT_SHELL_TOKEN or the config file);
    // substitute it back into the snippet below manually.
    const maskedToken = maskToken(config.auth.bearerToken);
    console.log(`\nClaude Desktop config (replace <TOKEN> with the value you configured):`);
    console.log(JSON.stringify({
      mcpServers: {
        'agent-shell': {
          url: `http://${config.host === '0.0.0.0' ? 'YOUR-VPS-IP' : config.host}:${config.port}/sse`,
          headers: { Authorization: `Bearer <TOKEN>` },
        },
      },
    }, null, 2));
    console.log(`(configured token: ${maskedToken})`);
  }

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await transport.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await transport.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Failed to start:', err.message);
  process.exit(1);
});
