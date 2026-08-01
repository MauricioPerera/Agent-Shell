/**
 * @module core/agent-profiles
 * @description Predefined agent permission profiles and resolution logic.
 *
 * Profiles define what an agent can discover and execute. When no profile
 * or permissions are set, the agent has unrestricted access (backward compatible).
 */

import type { RBAC } from '../security/rbac.js';

/** Predefined agent profile names. */
export type AgentProfile = 'admin' | 'operator' | 'reader' | 'restricted';

/** Permission sets for each predefined profile. */
export const AGENT_PROFILES: Record<AgentProfile, string[]> = {
  /** Full access. No restrictions. */
  admin: ['*'],

  /**
   * Can execute and modify, but not delete or administer.
   *
   * Regression: this list granted 'file:delete' instead of 'file:write' —
   * every other namespace here has its own explicit ':write' entry
   * (http/git/cron/process/scaffold/wizard), file was the one exception,
   * and the delete grant directly contradicted both this comment and
   * AP04's `not.toContain('*:delete')` check. Net effect: file:write/
   * file:mkdir/file:chmod (all gated on file:write) were unreachable for
   * the profile docs/deployment.md recommends for production ("CRUD"),
   * while file:delete worked — the opposite of "modify, but not delete".
   */
  operator: [
    '*:read', '*:list', '*:get', '*:create', '*:update', '*:execute',
    'search', 'describe', 'context', 'history',
    'http:read', 'http:write', 'json:read', 'file:read', 'file:write', 'shell:exec', 'shell:read', 'env:read',
    'workspace:write', 'workspace:read',
    'git:read', 'git:write', 'cron:read', 'cron:write', 'secret:read', 'process:read', 'process:write',
    'registry:read', 'scaffold:write', 'wizard:write',
  ],

  /** Read-only. Can discover and describe, but not execute actions. */
  reader: [
    '*:read', '*:list', '*:get',
    'search', 'describe', 'context',
    'http:read', 'json:read', 'file:read', 'shell:read', 'env:read',
    'workspace:read',
    'git:read', 'cron:read', 'secret:read', 'process:read',
    'registry:read',
  ],

  /** No access. Must receive explicit permissions. */
  restricted: [],
};

/** Config shape consumed by resolveAgentPermissions. */
interface PermissionConfig {
  agentProfile?: AgentProfile;
  permissions?: string[];
  rbac?: RBAC;
}

/**
 * Resolves the effective permission set for an agent.
 *
 * Priority:
 * 1. agentProfile → uses AGENT_PROFILES lookup
 * 2. rbac + permissions → treats permissions as role names, resolves via RBAC
 * 3. rbac alone (no permissions) → resolves via RBAC with an empty role
 *    list, letting RBAC's own defaultRole fallback (or deny-all, if no
 *    defaultRole is configured) decide — never "no enforcement"
 * 4. permissions alone → uses as-is
 * 5. nothing → returns null (no enforcement, backward compatible)
 */
export function resolveAgentPermissions(config: PermissionConfig): string[] | null {
  if (config.agentProfile) {
    return [...AGENT_PROFILES[config.agentProfile]];
  }

  if (config.rbac) {
    // Regresion (ronda 34 del audit): esta rama solo se entraba si
    // config.permissions tambien estaba seteado (`config.rbac &&
    // config.permissions`) — un operador que configuraba `rbac` con roles
    // y `defaultRole` pero NO seteaba el array `permissions` de nivel
    // superior (ni --profile) caia de largo hasta el `return null` del
    // final, dando acceso SIN NINGUNA restriccion en vez de aplicar
    // defaultRole. defaultRole es la propia respuesta de RBAC a "el
    // caller no trae rol" — resolvePermissions() con roles:[] activa
    // exactamente esa logica (ver rbac.ts), incluyendo el caso sin
    // defaultRole configurado, que correctamente deniega todo en vez de
    // abrir todo.
    if (config.permissions === undefined) {
      return config.rbac.resolvePermissions({ roles: [], permissions: [] });
    }
    // An explicit empty array is the same deny-all signal handled below —
    // RBAC.resolvePermissions() falls back to its configured defaultRole
    // when given an empty roles list, which would silently upgrade an
    // explicit "no permissions" into whatever defaultRole grants instead
    // of denying, exactly the bug the !== undefined check below exists to
    // prevent for the no-rbac case.
    if (config.permissions.length === 0) return [];
    return config.rbac.resolvePermissions({
      roles: config.permissions,
      permissions: [],
    });
  }

  // `!== undefined` (not a truthy/length check) is deliberate: permissions:[]
  // must mean "explicitly no permissions" (deny-all, same as agentProfile:
  // 'restricted'), not fall through to the unrestricted default below. A
  // truthy/length check treated an explicit empty array the same as "not
  // configured", silently granting full access to a caller that asked for
  // the opposite.
  if (config.permissions !== undefined) {
    return [...config.permissions];
  }

  return null; // No enforcement (permissions genuinely not configured)
}
