/**
 * @module executor/types
 * @description Tipos del modulo Executor de Agent Shell.
 *
 * Define las interfaces de resultado de ejecucion, contexto,
 * pipeline, batch y configuracion del executor.
 */

import type { AuditLogger } from '../security/audit-logger.js';

/** Resultado de una ejecucion simple de comando. */
export interface ExecutionResult {
  code: 0 | 1 | 2 | 3 | 4;
  success: boolean;
  data: any | null;
  error: ExecutionError | null;
  meta: ExecutionMeta;
}

/** Error estructurado de ejecucion. */
export interface ExecutionError {
  code: number;
  type: string;
  message: string;
  details?: Record<string, any>;
}

/** Metadata de una ejecucion. */
export interface ExecutionMeta {
  command: string;
  mode: 'normal' | 'dry-run' | 'validate' | 'confirm';
  duration_ms: number;
  timestamp: string;
  historyId: string | null;
  reversible: boolean;
}

/** Resultado de una ejecucion batch. */
export interface BatchResult {
  code: 0 | 1;
  success: boolean;
  results: ExecutionResult[];
  meta: { total: number; succeeded: number; failed: number; duration_ms: number };
}

/** Resultado de una ejecucion pipeline. */
export interface PipelineResult {
  code: 0 | 1 | 2 | 3 | 4;
  success: boolean;
  data: any | null;
  error: ExecutionError | null;
  meta: { steps: PipelineStep[]; duration_ms: number; failedAt: number | null };
}

/** Detalle de un paso en un pipeline. */
export interface PipelineStep {
  command: string;
  code: number;
  duration_ms: number;
  inputReceived: boolean;
  mode?: string;
}

/** Contexto de ejecucion provisto al Executor. */
export interface ExecutionContext {
  sessionId: string;
  permissions: string[];
  state: Record<string, any>;
  config: ExecutorConfig;
  history: HistoryStore;
  auditLogger?: AuditLogger;
}

/** Configuracion del Executor. */
export interface ExecutorConfig {
  timeout_ms: number;
  maxPipelineDepth: number;
  maxBatchSize: number;
  undoTTL_ms: number;
  enableHistory: boolean;
  confirmTTL_ms?: number;
  rateLimit?: {
    maxRequests: number;
    windowMs: number;
  };
}

/** Interfaz del almacen de historial. */
export interface HistoryStore {
  entries: any[];
  append(entry: any): void;
  getById(id: string): any | null;
}
