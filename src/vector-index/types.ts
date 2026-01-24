/**
 * @module vector-index/types
 * @description Tipos del modulo Vector Index de Agent Shell.
 *
 * Define las interfaces para el motor de descubrimiento semantico:
 * adapters de embedding y storage vectorial, resultados de busqueda,
 * reportes de sincronizacion y estadisticas del indice.
 */

/** Resultado de generar un embedding vectorial. */
export interface EmbeddingResult {
  vector: number[];
  dimensions: number;
  tokenCount: number;
  model: string;
}

/** Adapter para generar embeddings vectoriales a partir de texto. */
export interface EmbeddingAdapter {
  embed(text: string): Promise<EmbeddingResult>;
  embedBatch(texts: string[]): Promise<EmbeddingResult[]>;
  getDimensions(): number;
  getModelId(): string;
}

/** Metadata asociada a un comando indexado en el storage vectorial. */
export interface CommandMetadata {
  namespace: string;
  command: string;
  description: string;
  signature: string;
  parameters: string[];
  tags: string[];
  indexedAt: string;
  version: string;
  example?: string;
}

/** Entrada almacenada en el storage vectorial. */
export interface VectorEntry {
  id: string;
  vector: number[];
  metadata: CommandMetadata;
}

/** Query de busqueda vectorial. */
export interface VectorSearchQuery {
  vector: number[];
  topK: number;
  threshold?: number;
  filters?: SearchFilters;
}

/** Filtros opcionales para busqueda. */
export interface SearchFilters {
  namespace?: string;
  tags?: string[];
  excludeIds?: string[];
}

/** Resultado individual de busqueda vectorial del storage. */
export interface VectorSearchResult {
  id: string;
  score: number;
  metadata: CommandMetadata;
}

/** Resultado de operacion batch del storage. */
export interface BatchStorageResult {
  success: number;
  failed: number;
}

/** Estado de salud del sistema. */
export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  details?: string;
}

/** Adapter para almacenamiento vectorial. */
export interface VectorStorageAdapter {
  upsert(entry: VectorEntry): Promise<void>;
  upsertBatch(entries: VectorEntry[]): Promise<BatchStorageResult>;
  delete(id: string): Promise<void>;
  deleteBatch(ids: string[]): Promise<BatchStorageResult>;
  search(query: VectorSearchQuery): Promise<VectorSearchResult[]>;
  listIds(): Promise<string[]>;
  count(): Promise<number>;
  clear(): Promise<void>;
  healthCheck(): Promise<HealthStatus>;
}

/** Definicion de comando para indexacion. */
export interface CommandDefinition {
  namespace: string;
  name: string;
  version: string;
  description: string;
  longDescription?: string;
  params?: { name: string; type: string; description?: string; [key: string]: any }[];
  tags?: string[];
  example?: string;
  examples?: string[];
  aliases?: string[];
}

/** Resultado de indexar un comando individual. */
export interface IndexResult {
  id: string;
  success: boolean;
}

/** Resultado de indexar un batch de comandos. */
export interface BatchIndexResult {
  total: number;
  success: number;
  failed: number;
  errors: any[];
}

/** Item individual en la respuesta de busqueda. */
export interface SearchResultItem {
  commandId: string;
  score: number;
  command: string;
  namespace: string;
  description: string;
  signature: string;
  example: string;
}

/** Respuesta completa de una busqueda semantica. */
export interface SearchResponse {
  query: string;
  results: SearchResultItem[];
  totalIndexed: number;
  searchTimeMs: number;
  model: string;
}

/** Opciones para busqueda semantica. */
export interface SearchOptions {
  topK?: number;
  threshold?: number;
  namespace?: string;
  tags?: string[];
  excludeIds?: string[];
}

/** Reporte de sincronizacion con el Command Registry. */
export interface SyncReport {
  added: number;
  updated: number;
  removed: number;
  duration_ms: number;
}

/** Estadisticas del indice vectorial. */
export interface IndexStats {
  totalIndexed: number;
  lastSyncAt: string | null;
  adapterModel: string;
  storageName: string;
}

/** Configuracion del VectorIndex. */
export interface VectorIndexConfig {
  embeddingAdapter: EmbeddingAdapter;
  storageAdapter: VectorStorageAdapter;
  defaultTopK: number;
  defaultThreshold: number;
  batchSize?: number;
  indexableFields?: string[];
}

/** Limite maximo de resultados por query. */
export const MAX_RESULTS = 20;

/** Codigos de error tipados del VectorIndex. */
export const VECTOR_ERROR_CODES = {
  E001: 'EMBEDDING_FAILED',
  E002: 'STORAGE_UPSERT_FAILED',
  E003: 'STORAGE_DELETE_FAILED',
  E004: 'STORAGE_SEARCH_FAILED',
  E005: 'INVALID_QUERY',
  E006: 'BATCH_PARTIAL_FAILURE',
  E007: 'SYNC_FAILED',
  E008: 'CIRCUIT_OPEN',
  E009: 'HEALTH_CHECK_FAILED',
  E010: 'UNKNOWN_ERROR',
} as const;

/** Error tipado del VectorIndex con codigo estructurado. */
export class VectorIndexError extends Error {
  readonly errorCode: keyof typeof VECTOR_ERROR_CODES;
  readonly details?: Record<string, any>;

  constructor(code: keyof typeof VECTOR_ERROR_CODES, message: string, details?: Record<string, any>) {
    super(message);
    this.name = 'VectorIndexError';
    this.errorCode = code;
    this.details = details;
  }
}
