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

/** Configuracion del Core. */
export interface CoreConfig {
  registry: any;
  vectorIndex?: any;
  contextStore?: any;
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
