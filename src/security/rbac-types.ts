/**
 * @module security/rbac-types
 * @description Tipos para el sistema RBAC (Role-Based Access Control).
 */

/** Definicion de un rol con permisos y herencia. */
export interface Role {
  name: string;
  permissions: string[];
  inherits?: string[];
}

/** Configuracion del sistema RBAC. */
export interface RBACConfig {
  roles: Role[];
  defaultRole?: string;
}

/** Contexto RBAC para resolucion de permisos. */
export interface RBACContext {
  roles: string[];
  permissions?: string[];
}
