/**
 * @module shared/config-validation
 * @description Config-shape validation shared by cli/index.ts's and
 * server/index.ts's agent-shell.config.json loaders.
 *
 * The two entry points use different failure conventions for
 * access-control fields: cli/index.ts exits immediately (no wrapping catch
 * around config parsing), server/index.ts throws (caught by its top-level
 * main().catch()). Rather than force one convention on both — which would
 * mean rewriting either's control flow — failure is injected via a
 * `fail(message): never` callback, so each entry point keeps its own
 * convention while sharing the actual "what does a valid X look like"
 * shape logic. That logic had drifted between the two copies before this
 * extraction (a real risk for anything reachable only via config, like
 * agentProfile/jailRoot/permissions/rbac).
 */

import { AuditLogger } from '../security/audit-logger.js';
import type { RBACConfig } from '../security/rbac-types.js';

export const VALID_SHELL_ADAPTERS = ['native', 'just-bash', 'auto'] as const;
export type ShellAdapterPreference = (typeof VALID_SHELL_ADAPTERS)[number];

export function isValidShellAdapter(raw: string): raw is ShellAdapterPreference {
  return (VALID_SHELL_ADAPTERS as readonly string[]).includes(raw);
}

/**
 * Validates a raw `rbac` config value into an RBACConfig via the injected
 * `fail` callback — same fail-closed reasoning as the other access-control
 * fields in validateCommonConfigFields: a wrong-typed rbac config is a
 * security-relevant error, not something to silently drop.
 */
export function validateRbacConfigShape(raw: any, configPath: string, fail: (msg: string) => never): RBACConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || !Array.isArray(raw.roles)) {
    fail(`${configPath} field 'rbac' must be an object with a 'roles' array, refusing to start with an ambiguous access-control config.`);
  }
  // RBAC's own Map-keyed-by-name constructor silently keeps only the LAST
  // definition of a duplicated role name (later roles.set() overwrites
  // earlier ones) — a config author who accidentally defines the same role
  // twice (a plausible hand-edited-JSON copy-paste mistake) would get
  // whichever permissions the second definition happens to grant, with no
  // error pointing at the typo. Unlike an unknown `inherits`/`defaultRole`
  // reference (deliberately tolerated at resolution time, see rbac.ts's
  // collectPermissions), there's no legitimate reason to define the same
  // role name twice, so this fails closed like every other rbac shape issue.
  const seenNames = new Set<string>();
  const roles = (raw.roles as any[]).map((r, i) => {
    if (typeof r !== 'object' || r === null || typeof r.name !== 'string' || r.name.length === 0) {
      fail(`${configPath} field 'rbac' roles[${i}] must be an object with a non-empty string 'name', refusing to start with an ambiguous access-control config.`);
    }
    if (seenNames.has(r.name)) {
      fail(`${configPath} field 'rbac' roles[${i}] ('${r.name}') is a duplicate role name — a later definition would silently overwrite the earlier one, refusing to start with an ambiguous access-control config.`);
    }
    seenNames.add(r.name);
    if (!Array.isArray(r.permissions) || !r.permissions.every((p: any) => typeof p === 'string')) {
      fail(`${configPath} field 'rbac' roles[${i}] ('${r.name}') 'permissions' must be an array of strings, refusing to start with an ambiguous access-control config.`);
    }
    if (r.inherits !== undefined && (!Array.isArray(r.inherits) || !r.inherits.every((p: any) => typeof p === 'string'))) {
      fail(`${configPath} field 'rbac' roles[${i}] ('${r.name}') 'inherits' must be an array of strings, refusing to start with an ambiguous access-control config.`);
    }
    return r.inherits ? { name: r.name, permissions: r.permissions, inherits: r.inherits } : { name: r.name, permissions: r.permissions };
  });
  if (raw.defaultRole !== undefined && typeof raw.defaultRole !== 'string') {
    fail(`${configPath} field 'rbac' 'defaultRole' must be a string, refusing to start with an ambiguous access-control config.`);
  }
  return raw.defaultRole ? { roles, defaultRole: raw.defaultRole } : { roles };
}

/** Shape of the optional `justBash` config-file field (see validateJustBashConfigShape). */
export interface JustBashConfigShape {
  network?: { allowedUrlPrefixes?: string[]; allowedMethods?: string[] };
  executionLimits?: { maxCommandCount?: number; maxLoopIterations?: number; maxCallDepth?: number };
}

/**
 * Regresion (ronda 60 del audit, MEDIUM): `ShellAdapterConfig.network`/
 * `.executionLimits` (just-bash's own network-allowlist and loop/call/
 * command-count caps) existed in just-bash/types.ts and were already
 * forwarded by createShellAdapter() -> createBashInstance() if present —
 * but NEITHER cli/index.ts NOR server/index.ts ever populated them from
 * anywhere, so every real `--shell-adapter just-bash` deployment ran on
 * whatever the (unvendored) just-bash package defaults to for outbound
 * network access and loop/call bounds, with no way for an operator to
 * actually restrict it. Exposed via the config file (not CLI flags/env
 * vars) because these are nested arrays/objects, matching how `rbac` is
 * already config-file-only for the same shape reason.
 *
 * Treated as `fail`-closed like the other access-control fields
 * (agentProfile/jailRoot/permissions/rbac): a malformed restriction
 * config silently becoming "no restriction" is exactly the failure mode
 * those fields already guard against — `warn`-and-drop here would mean a
 * typo'd network allowlist quietly falls back to the sandbox's own
 * (likely permissive) defaults instead of aborting startup.
 */
export function validateJustBashConfigShape(raw: any, configPath: string, fail: (msg: string) => never): JustBashConfigShape {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail(`${configPath} field 'justBash' must be an object, refusing to start with an ambiguous sandbox-restriction config.`);
  }
  const result: JustBashConfigShape = {};

  if (raw.network !== undefined) {
    const net = raw.network;
    if (typeof net !== 'object' || net === null || Array.isArray(net)) {
      fail(`${configPath} field 'justBash.network' must be an object, refusing to start with an ambiguous sandbox-restriction config.`);
    }
    const network: NonNullable<JustBashConfigShape['network']> = {};
    if (net.allowedUrlPrefixes !== undefined) {
      if (!Array.isArray(net.allowedUrlPrefixes) || !net.allowedUrlPrefixes.every((p: any) => typeof p === 'string')) {
        fail(`${configPath} field 'justBash.network.allowedUrlPrefixes' must be an array of strings, refusing to start with an ambiguous sandbox-restriction config.`);
      }
      network.allowedUrlPrefixes = net.allowedUrlPrefixes;
    }
    if (net.allowedMethods !== undefined) {
      if (!Array.isArray(net.allowedMethods) || !net.allowedMethods.every((m: any) => typeof m === 'string')) {
        fail(`${configPath} field 'justBash.network.allowedMethods' must be an array of strings, refusing to start with an ambiguous sandbox-restriction config.`);
      }
      network.allowedMethods = net.allowedMethods;
    }
    result.network = network;
  }

  if (raw.executionLimits !== undefined) {
    const lim = raw.executionLimits;
    if (typeof lim !== 'object' || lim === null || Array.isArray(lim)) {
      fail(`${configPath} field 'justBash.executionLimits' must be an object, refusing to start with an ambiguous sandbox-restriction config.`);
    }
    const executionLimits: NonNullable<JustBashConfigShape['executionLimits']> = {};
    for (const key of ['maxCommandCount', 'maxLoopIterations', 'maxCallDepth'] as const) {
      if (lim[key] !== undefined) {
        if (typeof lim[key] !== 'number' || !Number.isInteger(lim[key]) || lim[key] <= 0) {
          fail(`${configPath} field 'justBash.executionLimits.${key}' must be a positive integer, refusing to start with an ambiguous sandbox-restriction config.`);
        }
        executionLimits[key] = lim[key];
      }
    }
    result.executionLimits = executionLimits;
  }

  return result;
}

/**
 * Validates a raw --port/AGENT_SHELL_PORT/config value via the injected
 * `fail` callback. An unparseable value (e.g. a typo) previously reached
 * parseInt() unchecked, became NaN, and only surfaced later as Node's
 * cryptic "options.port should be >= 0 and < 65536" from server.listen().
 */
export function validatePortShape(raw: string, fail: (msg: string) => never): number {
  const port = parseInt(raw, 10);
  if (!Number.isInteger(port) || String(port) !== raw.trim() || port < 0 || port > 65535) {
    fail(`Invalid port: '${raw}'. Must be an integer between 0 and 65535.`);
  }
  return port;
}

export interface ConfigFieldHelpers {
  /** Called for access-control fields (agentProfile/jailRoot/permissions/rbac): a wrong type must abort startup. */
  fail(message: string): never;
  /** Called for non-security fields (port/host/corsOrigin/shellAdapter): a wrong type is dropped with a warning. */
  warn(field: string, expected: string): void;
}

/**
 * Validates the config fields common to both entry points'
 * agent-shell.config.json schema: port, host, corsOrigin, agentProfile,
 * auth.bearerToken, jailRoot, permissions, rbac, shellAdapter. Does NOT
 * cover `skills` (server-only — cli/index.ts has no config-file equivalent,
 * only --no-cli-skills/--no-shell-skills flags); callers merge that in
 * separately.
 */
export function validateCommonConfigFields(raw: Record<string, any>, configPath: string, helpers: ConfigFieldHelpers): Record<string, any> {
  const config: Record<string, any> = {};
  const { fail, warn } = helpers;

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
  // agentProfile/permissions/jailRoot/rbac scope what the agent can do:
  // warn-and-drop (like the fields above) would silently fall through to
  // "not configured" = unrestricted access — the opposite of what a bad
  // config author intended. Fail closed instead.
  if (raw.agentProfile !== undefined) {
    if (typeof raw.agentProfile === 'string') config.agentProfile = raw.agentProfile;
    else fail(`${configPath} field 'agentProfile' should be a string, refusing to start with an ambiguous access-control config.`);
  }
  // Regresion (ronda 75 del audit, MEDIUM): a diferencia de sus hermanos de
  // control de acceso (agentProfile/jailRoot/permissions/rbac, todos arriba
  // y abajo), este campo usaba warn-and-drop. Un auth.bearerToken malformado
  // (ej. un bug de templating de config que lo deja como numero/objeto) se
  // descartaba con solo un warning, y el server arrancaba SIN autenticacion
  // y sin fallo de arranque — exactamente el modo de falla que fail() en los
  // demas campos de acceso ya existe para evitar. Fail closed, igual que los otros.
  if (raw.auth?.bearerToken !== undefined) {
    if (typeof raw.auth.bearerToken === 'string') config.auth = { bearerToken: raw.auth.bearerToken };
    else fail(`${configPath} field 'auth.bearerToken' should be a string, refusing to start with an ambiguous access-control config.`);
  }
  if (raw.jailRoot !== undefined) {
    if (typeof raw.jailRoot === 'string') config.jailRoot = raw.jailRoot;
    else fail(`${configPath} field 'jailRoot' should be a string, refusing to start with an ambiguous access-control config.`);
  }
  if (raw.permissions !== undefined) {
    if (Array.isArray(raw.permissions) && raw.permissions.every((p: any) => typeof p === 'string')) config.permissions = raw.permissions;
    else fail(`${configPath} field 'permissions' should be an array of strings, refusing to start with an ambiguous access-control config.`);
  }
  if (raw.rbac !== undefined) {
    config.rbac = validateRbacConfigShape(raw.rbac, configPath, fail);
  }
  if (raw.shellAdapter !== undefined) {
    if (typeof raw.shellAdapter === 'string') config.shellAdapter = raw.shellAdapter;
    else warn('shellAdapter', 'a string');
  }
  if (raw.justBash !== undefined) {
    config.justBash = validateJustBashConfigShape(raw.justBash, configPath, fail);
  }
  return config;
}

/**
 * Constructs an AuditLogger wired to write structured JSON lines to
 * stderr — never stdout, which on the stdio transport is the JSON-RPC
 * protocol stream itself; writing anything else there would corrupt it.
 * (server/index.ts has no stdio path, but shares this for consistency.)
 */
export function createAuditLoggerToStderr(): AuditLogger {
  const auditLogger = new AuditLogger('default');
  auditLogger.onAudit('*', (event) => {
    console.error(`[audit] ${JSON.stringify(event)}`);
  });
  return auditLogger;
}
