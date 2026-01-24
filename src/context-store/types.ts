/**
 * @module context-store/types
 * @description Tipos del modulo Context Store de Agent Shell.
 *
 * Define las interfaces para el almacen de estado de sesion,
 * historial de comandos, snapshots de undo, y el adaptador de storage.
 */

/** Entrada individual del contexto clave-valor. */
export interface ContextEntry {
  key: string;
  value: any;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  set_at: string;
  updated_at: string;
  version: number;
}

/** Entrada del historial de comandos ejecutados. */
export interface HistoryEntry {
  id: string;
  command: string;
  namespace: string;
  args: Record<string, any>;
  executed_at: string;
  duration_ms: number;
  exit_code: number;
  result_summary: string;
  undoable: boolean;
  undo_status: 'available' | 'applied' | 'expired' | null;
  snapshot_id: string | null;
}

/** Snapshot del estado previo para operaciones de undo. */
export interface UndoSnapshot {
  id: string;
  command_id: string;
  created_at: string;
  state_before: Record<string, any>;
  rollback_command: string | null;
  metadata: Record<string, any>;
}

/** Resultado de una operacion del Context Store. */
export interface OperationResult {
  status: number;
  data?: any;
  error?: { code: string; message: string };
  meta?: {
    session_id?: string;
    timestamp?: string;
    count?: number;
    total?: number;
    warnings?: string[];
  };
}

/** Estructura completa del store persistido por sesion. */
export interface SessionStore {
  context: {
    entries: Record<string, ContextEntry>;
  };
  history: HistoryEntry[];
  undo_snapshots: UndoSnapshot[];
  createdAt?: string;
  lastAccessAt?: string;
}

/** Configuracion del Context Store. */
export interface ContextStoreConfig {
  /** TTL de sesion en ms. Si se supera, la sesion se destruye. */
  ttl_ms?: number;
  /** Callback invocado cuando una sesion expira. */
  onExpired?: (sessionId: string) => void;
  /** Deteccion de secretos en valores almacenados. */
  secretDetection?: {
    mode: 'warn' | 'reject';
    patterns?: import('../security/types.js').SecretPattern[];
  };
  /** Politica de retencion para historial. */
  retentionPolicy?: RetentionPolicy;
}

/** Politica de retencion de historial. */
export interface RetentionPolicy {
  /** Eliminar entries mas viejas que este valor (ms). */
  maxAge_ms?: number;
  /** Mantener solo las N entries mas recientes. */
  maxEntries?: number;
}

/** Interface del adaptador de storage. */
export interface StorageAdapter {
  readonly name: string;
  initialize(session_id: string): Promise<void>;
  load(session_id: string): Promise<SessionStore | null>;
  save(session_id: string, store: SessionStore): Promise<void>;
  destroy(session_id: string): Promise<void>;
  healthCheck(): Promise<boolean>;
  dispose(): Promise<void>;
}

/** Longitud maxima de clave. */
export const MAX_KEY_LENGTH = 128;

/** Tamano maximo de valor serializado (64KB). */
export const MAX_VALUE_SIZE = 64 * 1024;

/** Cantidad maxima de claves por sesion. */
export const MAX_KEYS = 1000;

/** Cantidad maxima de entradas en historial (FIFO). */
export const MAX_HISTORY = 10000;

/** Limite default al consultar historial. */
export const DEFAULT_HISTORY_LIMIT = 20;

/** Patron de validacion para claves. */
export const KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9._-]*$/;
