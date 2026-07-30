/**
 * @module security/permission-matcher
 * @description Utilidad para matching de permisos con soporte de recursos.
 *
 * Soporta permisos de 2 niveles (namespace:action) y 3 niveles (namespace:action:resourceId).
 * Permite wildcards (*) y placeholders ($param) que se resuelven contra args.
 *
 * Jerarquia de matching:
 * - Exact match: "users:delete:123" matchea "users:delete:123"
 * - Resource wildcard: "users:delete:*" matchea "users:delete:123"
 * - Namespace wildcard: "users:*" matchea "users:delete" y "users:delete:123"
 * - Action wildcard: "*:delete" matchea "users:delete" y "orders:delete" (cualquier namespace)
 * - Global wildcard: "*" matchea todo
 * - Placeholders: "users:delete:$id" se resuelve a "users:delete:123" con args={id:123}
 */

export interface PermissionMatchOptions {
  args?: Record<string, any>;
}

/**
 * Resuelve placeholders $param en un permiso contra los args proporcionados.
 */
export function resolvePermission(permission: string, args?: Record<string, any>): string {
  return permission.replace(/\$([a-zA-Z_]\w*)/g, (_, name) => {
    return args?.[name] !== undefined ? String(args[name]) : `$${name}`;
  });
}

/**
 * Verifica si un conjunto de permisos del usuario satisface un permiso requerido.
 * Soporta matching exacto, wildcards de recurso/namespace/global, y placeholders.
 */
export function matchPermission(
  userPermissions: string[],
  required: string,
  options?: PermissionMatchOptions
): boolean {
  const resolved = resolvePermission(required, options?.args);

  // Exact match
  if (userPermissions.includes(resolved)) return true;

  const parts = resolved.split(':');
  const [ns, action] = parts;

  // Resource wildcard: "ns:action:*" matches "ns:action:123". `parts.length
  // === 3` alone missed resourceIds that themselves contain ':' (e.g. a
  // Windows path like "C:\foo") — split() gives more than 3 parts, and the
  // wildcard silently stopped applying (fail-closed direction, but still a
  // functional bug: denies more than intended). The check itself doesn't
  // need the resourceId's actual value (it's a wildcard), so `>= 3` alone
  // is the fix.
  if (parts.length >= 3) {
    if (userPermissions.includes(`${ns}:${action}:*`)) return true;
  }

  // Namespace wildcard: "ns:*" matches "ns:action" or "ns:action:resource"
  if (userPermissions.includes(`${ns}:*`)) return true;

  // Action wildcard: "*:action" matches "ns:action" or "ns:action:resource" for any namespace.
  // (AGENT_PROFILES' built-in reader/operator profiles rely on this form, e.g. '*:read'.)
  if (action && userPermissions.includes(`*:${action}`)) return true;

  // Global wildcard
  if (userPermissions.includes('*')) return true;

  return false;
}

/**
 * Verifica si un conjunto de permisos del usuario satisface TODOS los permisos requeridos.
 */
export function matchPermissions(
  userPermissions: string[],
  required: string[],
  options?: PermissionMatchOptions
): boolean {
  return required.every(perm => matchPermission(userPermissions, perm, options));
}

/**
 * Retorna los permisos requeridos que NO se satisfacen.
 * Util para reportar que permisos faltan.
 */
export function getMissingPermissions(
  userPermissions: string[],
  required: string[],
  options?: PermissionMatchOptions
): string[] {
  return required.filter(perm => !matchPermission(userPermissions, perm, options));
}
