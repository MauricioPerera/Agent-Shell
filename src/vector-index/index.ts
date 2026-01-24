/**
 * @module vector-index
 * @description Motor de descubrimiento semantico de Agent Shell.
 *
 * Indexa definiciones de comandos como embeddings vectoriales y responde
 * queries en lenguaje natural retornando los comandos mas relevantes
 * por similaridad. Agnostico al proveedor de embeddings y storage vectorial.
 */

import type {
  EmbeddingAdapter,
  VectorStorageAdapter,
  CommandDefinition,
  CommandMetadata,
  VectorEntry,
  IndexResult,
  BatchIndexResult,
  SearchResponse,
  SearchResultItem,
  SearchOptions,
  SyncReport,
  IndexStats,
  HealthStatus,
  VectorIndexConfig,
} from './types.js';
import { MAX_RESULTS, VectorIndexError } from './types.js';

export { VectorIndex };
export { PgVectorStorageAdapter } from './pgvector-storage-adapter.js';
export type { PgClient, PgVectorConfig, PgQueryResult } from './pgvector-types.js';
export type {
  EmbeddingAdapter,
  VectorStorageAdapter,
  CommandDefinition,
  CommandMetadata,
  VectorEntry,
  IndexResult,
  BatchIndexResult,
  SearchResponse,
  SearchResultItem,
  SearchOptions,
  SyncReport,
  IndexStats,
  HealthStatus,
  VectorIndexConfig,
} from './types.js';
export { VectorIndexError, VECTOR_ERROR_CODES } from './types.js';

interface CircuitBreakerState {
  status: 'closed' | 'open' | 'half-open';
  failureCount: number;
  successCount: number;
  lastFailureAt: number | null;
  cooldownMs: number;
}

/**
 * Motor de descubrimiento semantico para comandos de Agent Shell.
 *
 * Convierte definiciones de comandos en embeddings vectoriales y permite
 * busquedas por similaridad semantica usando lenguaje natural.
 */
class VectorIndex {
  private readonly embeddingAdapter: EmbeddingAdapter;
  private readonly storageAdapter: VectorStorageAdapter;
  private readonly defaultTopK: number;
  private readonly defaultThreshold: number;
  private readonly config: VectorIndexConfig;

  /** Mapa interno de comandos indexados: id -> { version, vector, metadata } */
  private readonly indexed: Map<string, { version: string; vector: number[]; metadata: CommandMetadata }> = new Map();
  private lastSyncAt: string | null = null;

  private circuitBreaker: CircuitBreakerState = {
    status: 'closed',
    failureCount: 0,
    successCount: 0,
    lastFailureAt: null,
    cooldownMs: 30_000,
  };

  constructor(config: VectorIndexConfig) {
    this.config = config;
    this.embeddingAdapter = config.embeddingAdapter;
    this.storageAdapter = config.storageAdapter;
    this.defaultTopK = config.defaultTopK;
    this.defaultThreshold = config.defaultThreshold;
  }

  private checkCircuit(): void {
    if (this.circuitBreaker.status === 'open') {
      const elapsed = Date.now() - (this.circuitBreaker.lastFailureAt || 0);
      if (elapsed >= this.circuitBreaker.cooldownMs) {
        this.circuitBreaker.status = 'half-open';
        this.circuitBreaker.successCount = 0;
      } else {
        throw new VectorIndexError('E008', 'Circuit breaker is open: embedding service unavailable');
      }
    }
  }

  private recordSuccess(): void {
    if (this.circuitBreaker.status === 'half-open') {
      this.circuitBreaker.successCount++;
      if (this.circuitBreaker.successCount >= 3) {
        this.circuitBreaker.status = 'closed';
        this.circuitBreaker.failureCount = 0;
      }
    } else {
      this.circuitBreaker.failureCount = 0;
    }
  }

  private recordFailure(): void {
    this.circuitBreaker.failureCount++;
    this.circuitBreaker.lastFailureAt = Date.now();
    if (this.circuitBreaker.failureCount >= 5) {
      this.circuitBreaker.status = 'open';
    }
  }

  /**
   * Indexa un comando individual generando su embedding y almacenandolo.
   */
  async indexCommand(command: CommandDefinition): Promise<IndexResult> {
    const id = `${command.namespace}:${command.name}`;
    const text = buildIndexableText(command, this.config.indexableFields);

    this.checkCircuit();
    let embResult;
    try {
      embResult = await this.embeddingAdapter.embed(text);
      this.recordSuccess();
    } catch (err) {
      this.recordFailure();
      throw new VectorIndexError('E001', `Embedding failed for ${id}: ${(err as Error).message}`, { id });
    }

    const metadata: CommandMetadata = {
      namespace: command.namespace,
      command: command.name,
      description: command.description,
      signature: buildSignature(command),
      parameters: (command.params || []).map(p => p.name),
      tags: command.tags || [],
      indexedAt: new Date().toISOString(),
      version: command.version,
      example: command.example || (command.examples?.[0] ?? ''),
    };

    const entry: VectorEntry = {
      id,
      vector: embResult.vector,
      metadata,
    };

    try {
      await this.storageAdapter.upsert(entry);
    } catch (err) {
      throw new VectorIndexError('E002', `Storage upsert failed for ${id}: ${(err as Error).message}`, { id });
    }

    this.indexed.set(id, { version: command.version, vector: embResult.vector, metadata });
    return { id, success: true };
  }

  /**
   * Indexa multiples comandos en batch usando una sola llamada a embedBatch.
   */
  async indexBatch(commands: CommandDefinition[]): Promise<BatchIndexResult> {
    if (commands.length === 0) {
      return { total: 0, success: 0, failed: 0, errors: [] };
    }

    const batchSize = this.config.batchSize ?? 50;
    const chunks = chunkArray(commands, batchSize);
    let totalSuccess = 0;
    let totalFailed = 0;
    const allErrors: any[] = [];
    const retryQueue: CommandDefinition[] = [];

    for (const chunk of chunks) {
      try {
        this.checkCircuit();
        const texts = chunk.map((cmd: CommandDefinition) => buildIndexableText(cmd, this.config.indexableFields));
        const embeddings = await this.embeddingAdapter.embedBatch(texts);
        this.recordSuccess();

        for (let i = 0; i < chunk.length; i++) {
          try {
            const cmd = chunk[i];
            const id = `${cmd.namespace}:${cmd.name}`;
            const embResult = embeddings[i];

            const metadata: CommandMetadata = {
              namespace: cmd.namespace,
              command: cmd.name,
              description: cmd.description,
              signature: buildSignature(cmd),
              parameters: (cmd.params || []).map((p: { name: string }) => p.name),
              tags: cmd.tags || [],
              indexedAt: new Date().toISOString(),
              version: cmd.version,
              example: cmd.example || (cmd.examples?.[0] ?? ''),
            };

            const entry: VectorEntry = { id, vector: embResult.vector, metadata };
            await this.storageAdapter.upsert(entry);
            this.indexed.set(id, { version: cmd.version, vector: embResult.vector, metadata });
            totalSuccess++;
          } catch (err) {
            totalFailed++;
            allErrors.push({ id: `${chunk[i].namespace}:${chunk[i].name}`, error: err });
          }
        }
      } catch (err) {
        this.recordFailure();
        // Buffer failed chunk for retry
        retryQueue.push(...chunk);
      }
    }

    // Retry failed chunks individually
    for (const cmd of retryQueue) {
      try {
        await this.indexCommand(cmd);
        totalSuccess++;
      } catch (err) {
        totalFailed++;
        allErrors.push({ id: `${cmd.namespace}:${cmd.name}`, error: err });
      }
    }

    return { total: commands.length, success: totalSuccess, failed: totalFailed, errors: allErrors };
  }

  /**
   * Busca comandos por similaridad semantica.
   *
   * @throws Error si el query es vacio
   */
  async search(query: string, options?: SearchOptions): Promise<SearchResponse> {
    if (!query || query.trim().length === 0) {
      throw new VectorIndexError('E005', 'Invalid search query: query cannot be empty');
    }

    const startTime = Date.now();

    const topK = Math.min(options?.topK ?? this.defaultTopK, MAX_RESULTS);
    const threshold = options?.threshold ?? this.defaultThreshold;

    this.checkCircuit();
    let embResult;
    try {
      embResult = await this.embeddingAdapter.embed(query);
      this.recordSuccess();
    } catch (err) {
      this.recordFailure();
      throw new VectorIndexError('E001', `Embedding failed for search query: ${(err as Error).message}`);
    }
    const queryVector = embResult.vector;

    // Compute cosine similarity against all indexed vectors
    let candidates: { id: string; score: number; metadata: CommandMetadata }[] = [];

    for (const [id, entry] of this.indexed) {
      // Namespace filter
      if (options?.namespace && entry.metadata.namespace !== options.namespace) {
        continue;
      }
      // Tags filter (all tags must match)
      if (options?.tags && options.tags.length > 0) {
        const entryTags = entry.metadata.tags || [];
        const hasAllTags = options.tags.every(t => entryTags.includes(t));
        if (!hasAllTags) continue;
      }
      // ExcludeIds filter
      if (options?.excludeIds && options.excludeIds.includes(id)) {
        continue;
      }

      const score = cosineSimilarity(queryVector, entry.vector);
      if (score >= threshold) {
        candidates.push({ id, score, metadata: entry.metadata });
      }
    }

    // Sort by score descending and limit to topK
    candidates.sort((a, b) => b.score - a.score);
    candidates = candidates.slice(0, topK);

    const totalIndexed = this.indexed.size;
    const searchTimeMs = Date.now() - startTime;

    const results: SearchResultItem[] = candidates.map(r => ({
      commandId: r.id,
      score: r.score,
      command: r.metadata.command,
      namespace: r.metadata.namespace,
      description: r.metadata.description,
      signature: r.metadata.signature,
      example: r.metadata.example || '',
    }));

    return {
      query,
      results,
      totalIndexed,
      searchTimeMs,
      model: this.embeddingAdapter.getModelId(),
    };
  }

  /**
   * Elimina un comando del indice. No-op si no existe.
   */
  async removeCommand(commandId: string): Promise<void> {
    await this.storageAdapter.delete(commandId);
    this.indexed.delete(commandId);
  }

  /**
   * Sincroniza el indice con el Command Registry.
   *
   * @param mode - 'full' reconstruye completamente, 'delta' solo aplica diferencias
   * @param registry - Objeto con metodo listAll() que retorna CommandDefinition[]
   */
  async sync(mode: 'full' | 'delta', registry?: any): Promise<SyncReport> {
    const startTime = Date.now();

    if (!registry) {
      return { added: 0, updated: 0, removed: 0, duration_ms: Date.now() - startTime };
    }

    const registryCommands: CommandDefinition[] = registry.listAll();

    if (mode === 'full') {
      return this.syncFull(registryCommands, startTime);
    }

    return this.syncDelta(registryCommands, startTime);
  }

  /**
   * Retorna estadisticas del indice.
   */
  async getStats(): Promise<IndexStats> {
    const totalIndexed = await this.storageAdapter.count();
    return {
      totalIndexed,
      lastSyncAt: this.lastSyncAt,
      adapterModel: this.embeddingAdapter.getModelId(),
      storageName: 'vector-storage',
    };
  }

  /**
   * Verifica la salud del servicio delegando al storage adapter.
   */
  async healthCheck(): Promise<HealthStatus> {
    return this.storageAdapter.healthCheck();
  }

  // --- Private methods ---

  private async syncFull(commands: CommandDefinition[], startTime: number): Promise<SyncReport> {
    await this.storageAdapter.clear();
    this.indexed.clear();

    let added = 0;
    for (const cmd of commands) {
      await this.indexCommand(cmd);
      added++;
    }

    this.lastSyncAt = new Date().toISOString();
    return { added, updated: 0, removed: 0, duration_ms: Date.now() - startTime };
  }

  private async syncDelta(commands: CommandDefinition[], startTime: number): Promise<SyncReport> {
    const registryMap = new Map<string, CommandDefinition>();
    for (const cmd of commands) {
      registryMap.set(`${cmd.namespace}:${cmd.name}`, cmd);
    }

    const indexedIds = await this.storageAdapter.listIds();
    const indexedSet = new Set(indexedIds);

    let added = 0;
    let updated = 0;
    let removed = 0;

    // Detect new and updated commands
    for (const [id, cmd] of registryMap) {
      if (!indexedSet.has(id)) {
        // New command
        await this.indexCommand(cmd);
        added++;
      } else {
        // Check version for update
        const current = this.indexed.get(id);
        if (current && current.version !== cmd.version) {
          await this.indexCommand(cmd);
          updated++;
        }
      }
    }

    // Detect removed commands
    for (const id of indexedIds) {
      if (!registryMap.has(id)) {
        await this.storageAdapter.delete(id);
        this.indexed.delete(id);
        removed++;
      }
    }

    this.lastSyncAt = new Date().toISOString();
    return { added, updated, removed, duration_ms: Date.now() - startTime };
  }
}

/**
 * Calcula la similaridad coseno entre dos vectores.
 * Retorna un valor entre -1 y 1 (1 = identico, 0 = ortogonal).
 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Construye el texto indexable a partir de la definicion del comando.
 * Combina descripcion, identificacion, namespace, parametros con sus descripciones, y tags.
 */
function buildIndexableText(cmd: CommandDefinition, indexableFields?: string[]): string {
  const allParts: Record<string, string> = {
    description: cmd.description,
    longDescription: cmd.longDescription || '',
    command: `comando: ${cmd.namespace}:${cmd.name}`,
    namespace: `namespace: ${cmd.namespace}`,
    params: (cmd.params || []).map(p => p.description ? `${p.name}: ${p.description}` : p.name).join(', '),
    tags: (cmd.tags || []).join(', '),
    example: cmd.example || '',
  };

  if (indexableFields && indexableFields.length > 0) {
    const parts = indexableFields.map(f => allParts[f] || '').filter(Boolean);
    return parts.join(' | ');
  }

  return Object.values(allParts).filter(Boolean).join(' | ');
}

/**
 * Construye la firma compacta del comando.
 */
function buildSignature(cmd: CommandDefinition): string {
  const params = (cmd.params || []).map(p => `--${p.name}: ${p.type}`).join(' ');
  return params ? `${cmd.namespace}:${cmd.name} ${params}` : `${cmd.namespace}:${cmd.name}`;
}

/** Divide un array en chunks de tamano fijo. */
function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
