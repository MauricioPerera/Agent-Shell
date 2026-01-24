/**
 * @module security/rbac
 * @description Sistema RBAC (Role-Based Access Control).
 *
 * Permite definir roles con permisos y herencia,
 * y resolver el conjunto completo de permisos para un contexto dado.
 */

import type { Role, RBACConfig, RBACContext } from './rbac-types.js';
import { matchPermission, matchPermissions, getMissingPermissions, type PermissionMatchOptions } from './permission-matcher.js';

export class RBAC {
  private roles: Map<string, Role> = new Map();
  private readonly defaultRole: string | null;

  constructor(config: RBACConfig) {
    for (const role of config.roles) {
      this.roles.set(role.name, role);
    }
    this.defaultRole = config.defaultRole ?? null;
  }

  /** Resuelve todos los permisos para un contexto (roles + directos). */
  resolvePermissions(context: RBACContext): string[] {
    const permissions = new Set<string>(context.permissions ?? []);

    const roles = context.roles.length > 0
      ? context.roles
      : (this.defaultRole ? [this.defaultRole] : []);

    for (const roleName of roles) {
      this.collectPermissions(roleName, permissions, new Set());
    }

    return [...permissions];
  }

  /** Verifica si un contexto tiene un permiso especifico (soporta resource-level y wildcards). */
  checkPermission(context: RBACContext, required: string, options?: PermissionMatchOptions): boolean {
    const userPermissions = this.resolvePermissions(context);
    return matchPermission(userPermissions, required, options);
  }

  /** Verifica si un contexto tiene TODOS los permisos requeridos. */
  checkPermissions(context: RBACContext, required: string[], options?: PermissionMatchOptions): boolean {
    const userPermissions = this.resolvePermissions(context);
    return matchPermissions(userPermissions, required, options);
  }

  /** Retorna los permisos que faltan para un contexto dado. */
  getMissingPermissions(context: RBACContext, required: string[], options?: PermissionMatchOptions): string[] {
    const userPermissions = this.resolvePermissions(context);
    return getMissingPermissions(userPermissions, required, options);
  }

  /** Verifica si un rol existe en la configuracion. */
  hasRole(roleName: string): boolean {
    return this.roles.has(roleName);
  }

  /** Retorna todos los nombres de roles registrados. */
  getRoles(): string[] {
    return [...this.roles.keys()];
  }

  /** Retorna los permisos directos de un rol (sin herencia). */
  getRolePermissions(roleName: string): string[] {
    const role = this.roles.get(roleName);
    return role ? [...role.permissions] : [];
  }

  private collectPermissions(roleName: string, permissions: Set<string>, visited: Set<string>): void {
    if (visited.has(roleName)) return;
    visited.add(roleName);

    const role = this.roles.get(roleName);
    if (!role) return;

    for (const perm of role.permissions) {
      permissions.add(perm);
    }

    if (role.inherits) {
      for (const parent of role.inherits) {
        this.collectPermissions(parent, permissions, visited);
      }
    }
  }
}
