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
import { registerSkills, registerShellSkills, ProcessManager, CronScheduler } from '../skills/index.js';
import { createShellAdapter } from '../just-bash/factory.js';
import { InMemoryStorageAdapter, SessionScopedContextStore } from '../context-store/index.js';
import { RBAC } from '../security/rbac.js';
import {
  VALID_SHELL_ADAPTERS,
  isValidShellAdapter,
  validatePortShape,
  validateCommonConfigFields,
  createAuditLoggerToStderr,
  type ShellAdapterPreference,
  type JustBashConfigShape,
} from '../shared/config-validation.js';
import { AGENT_PROFILES, resolveAgentPermissions } from '../core/agent-profiles.js';
import type { AgentProfile } from '../core/agent-profiles.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const VERSION = '0.1.0';

const USAGE = `
agent-shell - AI-first CLI framework (2 tools + in-memory context store)

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
  --jail-root <path>        Confine file:*/git:*/workspace:* to this directory
  --shell-adapter <string>  Shell backend: native|just-bash|auto (default: auto)
  --no-cli-skills           Skip registering CLI creation skills
  --no-shell-skills         Skip registering system shell skills

Environment Variables:
  AGENT_SHELL_PORT          HTTP port
  AGENT_SHELL_HOST          HTTP host
  AGENT_SHELL_TOKEN         Bearer token
  AGENT_SHELL_PROFILE       Agent profile
  AGENT_SHELL_CORS_ORIGIN   CORS origin
  AGENT_SHELL_JAIL_ROOT     Path-jail root
  AGENT_SHELL_ADAPTER       Shell backend

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
 * Validates a raw --shell-adapter/AGENT_SHELL_ADAPTER/config value. An
 * unrecognized value (e.g. a typo like 'jsut-bash') previously fell through
 * createShellAdapter()'s prefer checks unnoticed into the 'auto' branch —
 * silently swapping an intended forced sandbox for whatever 'auto' resolves
 * to (typically the unsandboxed native backend), with no indication the
 * flag was misspelled. Same fail-closed reasoning as validateProfile above.
 */
export function validateShellAdapter(raw: string | undefined): ShellAdapterPreference | undefined {
  if (raw === undefined) return undefined;
  if (!isValidShellAdapter(raw)) {
    console.error(`Invalid shell adapter: '${raw}'. Valid values: ${VALID_SHELL_ADAPTERS.join(', ')}`);
    process.exit(1);
  }
  return raw;
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
 * unchecked, or aborting the process for access-control fields — see
 * shared/config-validation.ts's validateCommonConfigFields for the shape
 * logic; this wrapper only supplies cli/index.ts's failure convention
 * (process.exit(1), since config parsing here has no wrapping catch).
 */
export function validateConfigFile(raw: Record<string, any>, configPath: string): Record<string, any> {
  return validateCommonConfigFields(raw, configPath, {
    fail: (message: string): never => {
      console.error(message);
      process.exit(1);
    },
    warn: (field: string, expected: string) =>
      console.error(`Warning: ${configPath} field '${field}' should be ${expected}, ignoring it.`),
  });
}

/**
 * Validates a raw --port/AGENT_SHELL_PORT/config value — see
 * shared/config-validation.ts's validatePortShape for the shape logic;
 * this wrapper only supplies cli/index.ts's failure convention.
 */
export function validatePort(raw: string): number {
  return validatePortShape(raw, (message: string): never => {
    console.error(message);
    process.exit(1);
  });
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

function buildRegistry(args: string[], agentPermissions?: string[] | null, jailRoot?: string, shellAdapterPreference?: ShellAdapterPreference, justBashConfig?: JustBashConfigShape): { registry: CommandRegistry; processManager: ProcessManager; cronScheduler: CronScheduler } {
  const registry = new CommandRegistry();
  // Constructed unconditionally (even if --no-shell-skills means it never
  // actually gets any spawned processes/scheduled tasks) so callers always
  // have a real instance to destroy() on shutdown — see
  // registerShellSkills' docstring.
  const processManager = new ProcessManager();
  // Placeholder (default adapter, never actually reachable if shell skills
  // stay disabled below) so destroy() always has a real instance to call —
  // replaced with a real one bound to the SAME adapter cron:schedule's
  // handlers use as soon as shell skills are enabled, matching what
  // createCronCommands() used to construct internally.
  let cronScheduler = new CronScheduler();

  if (!hasFlag(args, '--no-cli-skills')) {
    registerSkills(registry, agentPermissions);
  }

  if (!hasFlag(args, '--no-shell-skills')) {
    // Regresion (ronda 60 del audit, MEDIUM): network/executionLimits nunca
    // se pasaban aca, asi que un `--shell-adapter just-bash` real corria
    // sin ninguna restriccion propia — ver el comentario de
    // validateJustBashConfigShape en shared/config-validation.ts.
    const adapter = createShellAdapter({
      prefer: shellAdapterPreference,
      network: justBashConfig?.network,
      executionLimits: justBashConfig?.executionLimits,
    });
    cronScheduler = new CronScheduler(adapter);
    registerShellSkills(registry, adapter, jailRoot, processManager, cronScheduler);
  }

  return { registry, processManager, cronScheduler };
}

function serveStdio(args: string[]): void {
  const fileConfig = loadConfigFile();
  const profile = validateProfile(parseFlag(args, '--profile') || process.env.AGENT_SHELL_PROFILE || fileConfig.agentProfile);
  warnIfUnrestricted(profile);
  const jailRoot = parseFlag(args, '--jail-root') || process.env.AGENT_SHELL_JAIL_ROOT || fileConfig.jailRoot;
  const shellAdapterPreference = validateShellAdapter(parseFlag(args, '--shell-adapter') || process.env.AGENT_SHELL_ADAPTER || fileConfig.shellAdapter);
  // rbac/permissions are config-file only (no flag/env var), same as on
  // server/index.ts. When rbac is set, permissions is treated as role names
  // instead of literal permission strings — see resolveAgentPermissions().
  const rbac: RBAC | undefined = fileConfig.rbac ? new RBAC(fileConfig.rbac) : undefined;

  // Resolved ahead of Core (which computes the same thing internally) so
  // registry:list/describe/export can filter what they reveal by the
  // caller's own permissions — see registryAdminCommands.
  const agentPermissions = resolveAgentPermissions({ agentProfile: profile, permissions: fileConfig.permissions, rbac });
  const { registry, processManager, cronScheduler } = buildRegistry(args, agentPermissions, jailRoot, shellAdapterPreference, fileConfig.justBash);
  const coreConfig: any = { registry };
  if (profile) coreConfig.agentProfile = profile;
  if (fileConfig.permissions) coreConfig.permissions = fileConfig.permissions;
  if (rbac) coreConfig.rbac = rbac;
  // In-memory only (no persistence across restarts, no external dependency)
  // — enables context:get/set/delete, which every real entry point left
  // permanently unreachable before this. `search`/vectorIndex stays
  // disabled: it needs a real EmbeddingAdapter, which nothing in this
  // codebase provides.
  coreConfig.contextStore = new SessionScopedContextStore(new InMemoryStorageAdapter());
  coreConfig.auditLogger = createAuditLoggerToStderr();

  const core = new Core(coreConfig);
  const server = new McpServer({ core, version: VERSION });

  // Regresion (ronda 47 del audit, HIGH): ProcessManager.destroy() existia
  // pero nunca se llamaba desde ningun shutdown real — un proceso spawneado
  // via process:spawn quedaba huerfano (y sin forma de matarlo, ya que el
  // registry entero moria con el proceso) al recibir SIGINT/SIGTERM.
  // Regresion (ronda 50 del audit, HIGH): mismo hueco en CronScheduler —
  // ni siquiera existia un parametro para pasar la instancia hasta ahora.
  // Regresion (ronda 75 del audit, MEDIUM): la cadena de shutdown era un
  // `await` secuencial sin try/catch — si processManager.destroy() (o
  // cualquier paso previo) tiraba, cronScheduler.destroy() nunca corria y
  // el proceso quedaba colgado sin llegar a process.exit(0). Cada paso va
  // envuelto individualmente para que el fallo de uno no le impida correr
  // a los demas.
  const shutdownStdio = async (): Promise<void> => {
    try { server.stop(); } catch (err) { console.error('Error stopping server:', err); }
    try { await processManager.destroy(); } catch (err) { console.error('Error destroying processManager:', err); }
    try { cronScheduler.destroy(); } catch (err) { console.error('Error destroying cronScheduler:', err); }
    process.exit(0);
  };
  process.on('SIGINT', shutdownStdio);
  process.on('SIGTERM', shutdownStdio);

  server.start();
}

async function serveHttp(args: string[]): Promise<void> {
  const fileConfig = loadConfigFile();

  // Regresion (ronda 75 del audit, LOW/MEDIUM): `||` trata 0 como falsy —
  // `fileConfig.port: 0` (un valor VALIDO, pedirle al SO un puerto
  // efimero) se descartaba en silencio y caia al default '3000' en vez de
  // respetarse. Los otros dos origenes (parseFlag/env var) son siempre
  // strings no vacios cuando estan presentes, asi que `??` (que solo
  // cae al default en null/undefined, no en 0/"") es un cambio seguro y
  // mas correcto para los tres.
  const port = validatePort(String(parseFlag(args, '--port') ?? process.env.AGENT_SHELL_PORT ?? fileConfig.port ?? '3000'));
  const host = parseFlag(args, '--host') || process.env.AGENT_SHELL_HOST || fileConfig.host || '0.0.0.0';
  const token = parseFlag(args, '--token') || process.env.AGENT_SHELL_TOKEN || fileConfig.auth?.bearerToken;
  const profile = validateProfile(parseFlag(args, '--profile') || process.env.AGENT_SHELL_PROFILE || fileConfig.agentProfile);
  // No cross-origin default: a wildcard would let any website the operator's
  // browser visits reach this server directly once its CORS preflight
  // succeeds, defeating the Content-Type CSRF check on the common
  // loopback-with-no-auth deployment. Opt in explicitly via --cors-origin.
  const corsOrigin = parseFlag(args, '--cors-origin') || process.env.AGENT_SHELL_CORS_ORIGIN || fileConfig.corsOrigin;
  const jailRoot = parseFlag(args, '--jail-root') || process.env.AGENT_SHELL_JAIL_ROOT || fileConfig.jailRoot;
  const shellAdapterPreference = validateShellAdapter(parseFlag(args, '--shell-adapter') || process.env.AGENT_SHELL_ADAPTER || fileConfig.shellAdapter);
  // rbac/permissions are config-file only (no flag/env var), same as on
  // server/index.ts. When rbac is set, permissions is treated as role names
  // instead of literal permission strings — see resolveAgentPermissions().
  const rbac: RBAC | undefined = fileConfig.rbac ? new RBAC(fileConfig.rbac) : undefined;

  const agentPermissions = resolveAgentPermissions({ agentProfile: profile, permissions: fileConfig.permissions, rbac });
  const { registry, processManager, cronScheduler } = buildRegistry(args, agentPermissions, jailRoot, shellAdapterPreference, fileConfig.justBash);
  const totalCommands = registry.listAll().length;

  const coreConfig: any = { registry };
  if (profile) coreConfig.agentProfile = profile;
  if (fileConfig.permissions) coreConfig.permissions = fileConfig.permissions;
  if (rbac) coreConfig.rbac = rbac;
  // See the same contextStore comment in serveStdio() above — sessionId is
  // threaded per-call now, so this is safe for HttpSseTransport's
  // concurrent sessions too (each gets its own isolated context).
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
  const mcpServer = new McpServer({ core, version: VERSION });

  const transport = new HttpSseTransport({
    port, host, corsOrigin,
    auth: token ? { bearerToken: token } : undefined,
    auditLogger,
  });

  transport.onMessage(async (msg, sessionId, hasExplicitSessionId) => mcpServer.handleMessage(msg, sessionId, hasExplicitSessionId));
  await transport.start();

  console.log(`Agent Shell v${VERSION}`);
  console.log(`  ${totalCommands} commands registered`);
  console.log(`  Auth: ${token ? 'Bearer token' : 'DISABLED'}`);
  console.log(`  Profile: ${profile || 'unrestricted'}`);
  console.log(`  Jail root: ${jailRoot || 'none (unrestricted filesystem access)'}`);
  console.log(`  RBAC: ${rbac ? `${fileConfig.rbac.roles.length} role(s) defined` : 'none (permissions, if set, are used as-is)'}`);
  console.log(`  Shell adapter: ${shellAdapterPreference || 'auto'}`);
  console.log(`  just-bash restrictions: ${fileConfig.justBash ? 'configured (see agent-shell.config.json)' : 'none (sandbox package defaults apply, if just-bash is the active backend)'}`);
  console.log(`  Listening: http://${host}:${port}`);

  if (!token) {
    console.warn('\n  WARNING: No auth token set. Server is open.');
    console.warn('  Use --token <value> or AGENT_SHELL_TOKEN env var.\n');
  }

  if (!profile) {
    console.warn('  WARNING: No --profile set. The agent has UNRESTRICTED access to every registered command.');
    console.warn('  Use --profile <admin|operator|reader|restricted> or AGENT_SHELL_PROFILE to scope access.\n');
  }

  // Regresion (ronda 47 del audit, HIGH): mismo fix que serveStdio() arriba
  // — sin esto, un proceso spawneado via process:spawn quedaba huerfano al
  // recibir SIGINT/SIGTERM. Regresion (ronda 50 del audit, HIGH): mismo
  // hueco para CronScheduler. Regresion (ronda 75 del audit, MEDIUM): mismo
  // fix de try/catch por paso que serveStdio() arriba — un `await` fallido
  // no debe impedir que los pasos restantes de shutdown corran.
  const shutdownHttp = async (): Promise<void> => {
    try { await transport.stop(); } catch (err) { console.error('Error stopping transport:', err); }
    try { await processManager.destroy(); } catch (err) { console.error('Error destroying processManager:', err); }
    try { cronScheduler.destroy(); } catch (err) { console.error('Error destroying cronScheduler:', err); }
    process.exit(0);
  };
  process.on('SIGINT', shutdownHttp);
  process.on('SIGTERM', shutdownHttp);
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
