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

  /** Can execute and modify, but not delete or administer. */
  operator: [
    '*:read', '*:list', '*:get', '*:create', '*:update', '*:execute',
    'search', 'describe', 'context', 'history',
    'http:read', 'http:write', 'json:read', 'file:read', 'shell:exec', 'shell:read', 'env:read',
  ],

  /** Read-only. Can discover and describe, but not execute actions. */
  reader: [
    '*:read', '*:list', '*:get',
    'search', 'describe', 'context',
    'http:read', 'json:read', 'file:read', 'shell:read', 'env:read',
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
 * 3. permissions alone → uses as-is
 * 4. nothing → returns null (no enforcement, backward compatible)
 */
export function resolveAgentPermissions(config: PermissionConfig): string[] | null {
  if (config.agentProfile) {
    return [...AGENT_PROFILES[config.agentProfile]];
  }

  if (config.rbac && config.permissions) {
    return config.rbac.resolvePermissions({
      roles: config.permissions,
      permissions: [],
    });
  }

  if (config.permissions && config.permissions.length > 0) {
    return [...config.permissions];
  }

  return null; // No enforcement
}
