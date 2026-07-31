#!/usr/bin/env node
/**
 * @module server
 * @description Production-ready Agent Shell HTTP server.
 *
 * Reads configuration from environment variables or agent-shell.config.json,
 * bootstraps the stack (registry + skills + an in-memory contextStore +
 * core + MCP), and starts the HTTP/SSE transport with Bearer token auth.
 * No vectorIndex is wired up: `search` needs a real EmbeddingAdapter, which
 * nothing in this codebase provides yet (bring-your-own via CoreConfig if
 * you have one).
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
import { InMemoryStorageAdapter, SessionScopedContextStore } from '../context-store/index.js';
import { AGENT_PROFILES, resolveAgentPermissions } from '../core/agent-profiles.js';
import { AuditLogger } from '../security/audit-logger.js';
import { RBAC } from '../security/rbac.js';
import type { RBACConfig } from '../security/rbac-types.js';
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
  jailRoot: string | null;
  rbac: RBACConfig | null;
}

/**
 * Validates a raw `rbac` config value into an RBACConfig, throwing on any
 * malformed shape — same fail-closed reasoning as agentProfile/permissions/
 * jailRoot below: a wrong-typed rbac config is a security-relevant error,
 * not something to silently drop and fall back to "no rbac configured".
 */
function validateRbacConfig(raw: any, configPath: string): RBACConfig {
  const fail = (msg: string): never => {
    throw new Error(`${configPath} field 'rbac' ${msg}, refusing to start with an ambiguous access-control config.`);
  };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || !Array.isArray(raw.roles)) {
    fail("must be an object with a 'roles' array");
  }
  const roles = (raw.roles as any[]).map((r, i) => {
    if (typeof r !== 'object' || r === null || typeof r.name !== 'string' || r.name.length === 0) {
      fail(`roles[${i}] must be an object with a non-empty string 'name'`);
    }
    if (!Array.isArray(r.permissions) || !r.permissions.every((p: any) => typeof p === 'string')) {
      fail(`roles[${i}] ('${r.name}') 'permissions' must be an array of strings`);
    }
    if (r.inherits !== undefined && (!Array.isArray(r.inherits) || !r.inherits.every((p: any) => typeof p === 'string'))) {
      fail(`roles[${i}] ('${r.name}') 'inherits' must be an array of strings`);
    }
    return r.inherits ? { name: r.name, permissions: r.permissions, inherits: r.inherits } : { name: r.name, permissions: r.permissions };
  });
  if (raw.defaultRole !== undefined && typeof raw.defaultRole !== 'string') {
    fail("'defaultRole' must be a string");
  }
  return raw.defaultRole ? { roles, defaultRole: raw.defaultRole } : { roles };
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

/**
 * Constructs an AuditLogger wired to write structured JSON lines to stderr,
 * keeping it separate from the operational logging on stdout above.
 */
function createAuditLogger(): AuditLogger {
  const auditLogger = new AuditLogger('default');
  auditLogger.onAudit('*', (event) => {
    console.error(`[audit] ${JSON.stringify(event)}`);
  });
  return auditLogger;
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
  // jailRoot scopes what paths file:*/git:*/workspace:* can touch: same
  // reasoning as agentProfile/permissions above — a wrong-typed value must
  // abort startup rather than silently fall through to "no jail configured".
  if (raw.jailRoot !== undefined) {
    if (typeof raw.jailRoot === 'string') config.jailRoot = raw.jailRoot;
    else throw new Error(`${configPath} field 'jailRoot' should be a string, refusing to start with an ambiguous access-control config.`);
  }
  // rbac defines the role graph that `permissions` (below) resolves against
  // — same fail-closed reasoning as agentProfile/permissions/jailRoot above.
  if (raw.rbac !== undefined) {
    config.rbac = validateRbacConfig(raw.rbac, configPath);
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
    jailRoot: null,
    rbac: null,
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
      if (fileConfig.jailRoot) config.jailRoot = fileConfig.jailRoot;
      if (fileConfig.rbac) config.rbac = fileConfig.rbac;
    }
  }

  // Env vars override file config
  if (process.env.AGENT_SHELL_PORT) config.port = validatePort(process.env.AGENT_SHELL_PORT);
  if (process.env.AGENT_SHELL_HOST) config.host = process.env.AGENT_SHELL_HOST;
  if (process.env.AGENT_SHELL_TOKEN) config.auth = { bearerToken: process.env.AGENT_SHELL_TOKEN };
  if (process.env.AGENT_SHELL_PROFILE) config.agentProfile = process.env.AGENT_SHELL_PROFILE as AgentProfile;
  if (process.env.AGENT_SHELL_CORS_ORIGIN) config.corsOrigin = process.env.AGENT_SHELL_CORS_ORIGIN;
  if (process.env.AGENT_SHELL_ADAPTER) config.shellAdapter = process.env.AGENT_SHELL_ADAPTER as any;
  if (process.env.AGENT_SHELL_JAIL_ROOT) config.jailRoot = process.env.AGENT_SHELL_JAIL_ROOT;

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

  // An unrecognized shellAdapter (typo in config/env) previously fell
  // through createShellAdapter()'s prefer checks unnoticed into the 'auto'
  // branch — silently swapping an intended forced sandbox for whatever
  // 'auto' resolves to (typically the unsandboxed native backend), with no
  // indication the value was misspelled. Same fail-closed reasoning as the
  // agentProfile check above.
  const VALID_SHELL_ADAPTERS = ['native', 'just-bash', 'auto'];
  if (!VALID_SHELL_ADAPTERS.includes(config.shellAdapter)) {
    throw new Error(`Invalid shellAdapter: '${config.shellAdapter}'. Valid values: ${VALID_SHELL_ADAPTERS.join(', ')}`);
  }

  console.log('Agent Shell Server starting...');
  console.log(`  Port: ${config.port}`);
  console.log(`  Host: ${config.host}`);
  console.log(`  Auth: ${config.auth ? 'Bearer token enabled' : 'DISABLED (not recommended)'}`);
  console.log(`  Profile: ${config.agentProfile || 'none (unrestricted)'}`);
  console.log(`  Shell adapter: ${config.shellAdapter}`);
  console.log(`  Jail root: ${config.jailRoot || 'none (unrestricted filesystem access)'}`);
  console.log(`  RBAC: ${config.rbac ? `${config.rbac.roles.length} role(s) defined` : 'none (permissions, if set, are used as-is)'}`);

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

  // When rbac is configured, `permissions` (above) is no longer taken as
  // literal permission strings — resolveAgentPermissions() treats it as a
  // list of role names to resolve against this RBAC's role graph instead
  // (see core/agent-profiles.ts). agentProfile still takes priority over
  // both, same precedence as before rbac existed.
  const rbac = config.rbac ? new RBAC(config.rbac) : undefined;

  // Resolved ahead of Core (which computes the same thing internally from
  // the same fields) so registry:list/describe/export can filter what
  // they reveal by the caller's own permissions, not just gate on
  // registry:read for the whole command — see registryAdminCommands.
  const agentPermissions = resolveAgentPermissions({
    agentProfile: config.agentProfile ?? undefined,
    permissions: config.permissions ?? undefined,
    rbac,
  });

  // Skills
  if (config.skills.cli) {
    registerSkills(registry, agentPermissions);
    console.log('  CLI skills: 9 commands registered');
  }
  if (config.skills.shell) {
    const adapter = createShellAdapter({ prefer: config.shellAdapter });
    registerShellSkills(registry, adapter, config.jailRoot ?? undefined);
    console.log(`  Shell skills: 12 commands registered (${adapter.backend} backend)`);
  }

  const totalCommands = registry.listAll().length;
  console.log(`  Total commands: ${totalCommands}`);

  // Core
  const coreConfig: any = { registry };
  if (config.agentProfile) coreConfig.agentProfile = config.agentProfile;
  if (config.permissions) coreConfig.permissions = config.permissions;
  if (rbac) coreConfig.rbac = rbac;
  // In-memory only (no persistence across restarts, no external dependency)
  // — enables context:get/set/delete. Safe for this transport's concurrent
  // sessions: sessionId is threaded per-call through to a per-session
  // ContextStore instance (see SessionScopedContextStore), not one shared
  // instance. `search`/vectorIndex stays disabled — see the module docstring.
  coreConfig.contextStore = new SessionScopedContextStore(new InMemoryStorageAdapter());
  coreConfig.auditLogger = createAuditLogger();
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

  transport.onMessage(async (msg, sessionId) => {
    const response = await mcpServer.handleMessage(msg, sessionId);
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
