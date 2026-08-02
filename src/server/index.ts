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
import { registerSkills, registerShellSkills, ProcessManager, CronScheduler } from '../skills/index.js';
import { createShellAdapter } from '../just-bash/factory.js';
import { InMemoryStorageAdapter, SessionScopedContextStore } from '../context-store/index.js';
import { AGENT_PROFILES, resolveAgentPermissions } from '../core/agent-profiles.js';
import { RBAC } from '../security/rbac.js';
import type { RBACConfig } from '../security/rbac-types.js';
import {
  VALID_SHELL_ADAPTERS,
  validatePortShape,
  validateCommonConfigFields,
  createAuditLoggerToStderr,
} from '../shared/config-validation.js';
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
 * Validates a raw --port/AGENT_SHELL_PORT/config value — see
 * shared/config-validation.ts's validatePortShape for the shape logic;
 * this wrapper only supplies server/index.ts's failure convention (throw,
 * caught by main().catch() at the bottom of this file).
 */
export function validatePort(raw: string): number {
  return validatePortShape(raw, (message: string): never => {
    throw new Error(message);
  });
}

/**
 * Validates the parsed config file against expected types — see
 * shared/config-validation.ts's validateCommonConfigFields for the shape
 * logic (port/host/corsOrigin/agentProfile/auth/jailRoot/permissions/rbac/
 * shellAdapter); this wrapper adds server-only fields (`skills`) and
 * supplies server/index.ts's failure convention.
 */
export function validateConfigFile(raw: Record<string, any>, configPath: string): Record<string, any> {
  const config = validateCommonConfigFields(raw, configPath, {
    fail: (message: string): never => {
      throw new Error(message);
    },
    warn: (field: string, expected: string) =>
      console.error(`Warning: ${configPath} field '${field}' should be ${expected}, ignoring it.`),
  });

  // skills is server-only: cli/index.ts has no config-file equivalent, only
  // --no-cli-skills/--no-shell-skills flags.
  if (raw.skills !== undefined) {
    if (typeof raw.skills === 'object' && raw.skills !== null) config.skills = raw.skills;
    else console.error(`Warning: ${configPath} field 'skills' should be an object, ignoring it.`);
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
  // Every other ServerConfig field has an env-var override; skills was the
  // one exception, reachable only by hand-editing agent-shell.config.json —
  // unlike cli/index.ts, this file has no CLI flags at all (env/config only,
  // see the module docstring), so an env var is this file's equivalent of
  // cli/index.ts's --no-cli-skills/--no-shell-skills.
  if (process.env.AGENT_SHELL_SKILLS_CLI !== undefined) config.skills.cli = process.env.AGENT_SHELL_SKILLS_CLI === 'true';
  if (process.env.AGENT_SHELL_SKILLS_SHELL !== undefined) config.skills.shell = process.env.AGENT_SHELL_SKILLS_SHELL === 'true';

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
  if (!(VALID_SHELL_ADAPTERS as readonly string[]).includes(config.shellAdapter)) {
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
  // Constructed unconditionally (even if config.skills.shell is false, so
  // it never gets any spawned processes/scheduled tasks) so the shutdown
  // handler below always has a real instance to destroy() — see
  // registerShellSkills' docstring (ronda 47/50 del audit, HIGH).
  const processManager = new ProcessManager();
  let cronScheduler = new CronScheduler();
  if (config.skills.cli) {
    const before = registry.listAll().length;
    registerSkills(registry, agentPermissions);
    console.log(`  CLI skills: ${registry.listAll().length - before} commands registered`);
  }
  if (config.skills.shell) {
    const before = registry.listAll().length;
    const adapter = createShellAdapter({ prefer: config.shellAdapter });
    // Bound to the SAME adapter cron:schedule's handlers use, matching
    // what createCronCommands() used to construct internally.
    cronScheduler = new CronScheduler(adapter);
    registerShellSkills(registry, adapter, config.jailRoot ?? undefined, processManager, cronScheduler);
    console.log(`  Shell skills: ${registry.listAll().length - before} commands registered (${adapter.backend} backend)`);
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
  const auditLogger = createAuditLoggerToStderr();
  coreConfig.contextStore = new SessionScopedContextStore(
    new InMemoryStorageAdapter(),
    // onExpired only ever fires if a future config also sets ttl_ms (not
    // currently exposed as a CLI flag/env var — session TTL expiry is
    // opt-in and unconfigured today). Wired anyway so the audit plumbing
    // is correct the moment it IS configured, rather than needing this
    // exact same fix applied a second time later.
    { onExpired: (sessionId) => auditLogger.audit('session:expired', { sessionId }, sessionId) },
    (sessionId) => auditLogger.audit('session:created', { sessionId }, sessionId),
  );
  coreConfig.auditLogger = auditLogger;
  const core = new Core(coreConfig);

  // MCP Server
  const mcpServer = new McpServer({ core, name: 'agent-shell', version: '0.1.0' });

  // HTTP Transport
  const transport = new HttpSseTransport({
    port: config.port,
    host: config.host,
    corsOrigin: config.corsOrigin,
    auth: config.auth || undefined,
    auditLogger,
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

  // Graceful shutdown. ProcessManager.destroy() existed but was never
  // reachable from any real shutdown path — a process spawned via
  // process:spawn orphaned (unkillable, since the whole registry died with
  // this process) on SIGINT/SIGTERM (ronda 47 del audit, HIGH). Same gap
  // for CronScheduler (ronda 50 del audit, HIGH) — there wasn't even a
  // parameter to pass the instance through until now.
  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await transport.stop();
    await processManager.destroy();
    cronScheduler.destroy();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await transport.stop();
    await processManager.destroy();
    cronScheduler.destroy();
    process.exit(0);
  });
}

// Guarded the same way cli/index.ts is: without this, importing this module
// for its named exports (maskToken/validatePort/validateConfigFile) would
// also run main() as a side effect and bind a real HTTP listener — which is
// exactly why this file had zero test coverage until now.
const isDirectExecution = process.argv[1]?.includes('agent-shell') ||
  process.argv[1]?.endsWith('/server/index.js') ||
  process.argv[1]?.endsWith('\\server\\index.js');

if (isDirectExecution) {
  main().catch((err) => {
    console.error('Failed to start:', err.message);
    process.exit(1);
  });
}
