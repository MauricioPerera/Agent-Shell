/**
 * @module core/types
 * @description Tipos del modulo Core (Orquestador) de Agent Shell.
 *
 * Define las interfaces de Response estandar, configuracion
 * y dependencias inyectables del Core.
 */

/** Respuesta estandar de toda operacion del Core. */
export interface CoreResponse {
  code: number;
  data: any;
  error: string | null;
  meta: ResponseMeta;
}

/** Metadata de una respuesta. */
export interface ResponseMeta {
  duration_ms: number;
  command: string;
  mode: string;
  timestamp: string;
}

/** Entrada de log estructurada. */
export interface LogEntry {
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  module: string;
  message: string;
  data?: Record<string, any>;
  timestamp: string;
}

/** Interfaz minima del registry consumida por Core. */
export interface CoreRegistry {
  /** Returns a registered command or a falsy value if not found. */
  get(namespace: string, name: string): any;
}

/** Interfaz minima del vector index consumida por Core. */
export interface CoreVectorIndex {
  search(query: string, options?: any): Promise<any>;
}

/** Interfaz minima del context store consumida por Core. */
export interface CoreContextStore {
  get(key: string): { data?: any };
  set(key: string, value: any): void;
  delete(key: string): void;
  getAll(): { data?: Record<string, any> };
}

/** Configuracion del Core. */
export interface CoreConfig {
  registry: CoreRegistry;
  vectorIndex?: CoreVectorIndex;
  contextStore?: CoreContextStore;
  /** Agent permissions for this Core instance. If set, enforces access control. */
  permissions?: string[];
  /** Optional RBAC instance for role-based permission resolution. */
  rbac?: import('../security/rbac.js').RBAC;
  /** Predefined agent profile. Takes precedence over permissions[]. */
  agentProfile?: import('./agent-profiles.js').AgentProfile;
  maxInputLength?: number;
  timeouts?: {
    parser_ms?: number;
    search_ms?: number;
    executor_ms?: number;
    jq_ms?: number;
    global_ms?: number;
  };
  rateLimit?: {
    maxRequests?: number;
    windowMs?: number;
    burstSize?: number;
  };
  logging?: {
    level?: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
    onLog?: (entry: LogEntry) => void;
  };
  defaults?: {
    format?: 'json' | 'table' | 'csv';
    limit?: number;
    offset?: number;
  };
}
