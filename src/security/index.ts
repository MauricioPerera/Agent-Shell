/**
 * @module security
 * @description Modulo de seguridad de Agent Shell.
 *
 * Exporta utilidades para audit logging, deteccion de secretos, y RBAC.
 */

export { AuditLogger } from './audit-logger.js';
export { maskSecrets, containsSecret, DEFAULT_SECRET_PATTERNS } from './secret-patterns.js';
export { RBAC } from './rbac.js';
export { matchPermission, matchPermissions, resolvePermission, getMissingPermissions } from './permission-matcher.js';
export type { PermissionMatchOptions } from './permission-matcher.js';
export type { AuditEvent, AuditEventType, AuditListener, SecretPattern } from './types.js';
export type { Role, RBACConfig, RBACContext } from './rbac-types.js';
