/**
 * @module minimemory/vector-storage
 * @description VectorStorageAdapter implementation backed by minimemory HNSW.
 *
 * Provides O(log n) vector search using minimemory's HNSW index, replacing
 * the default O(n) brute-force in-memory storage. Supports quantization
 * for memory efficiency and automatic persistence to .mmdb files.
 *
 * @see https://github.com/MauricioPerera/minimemory
 */

import type {
  VectorStorageAdapter,
  VectorEntry,
  VectorSearchQuery,
  VectorSearchResult,
  CommandMetadata,
  BatchStorageResult,
  HealthStatus,
} from '../vector-index/types.js';

import type {
  MiniMemoryVectorStorageConfig,
  MiniMemoryBinding,
  MiniMemoryVectorDB,
} from './types.js';

export class MiniMemoryVectorStorage implements VectorStorageAdapter {
  private db: MiniMemoryVectorDB;
  private config: MiniMemoryVectorStorageConfig;
  private idSet: Set<string> = new Set();

  /**
   * Creates a new MiniMemoryVectorStorage instance.
   *
   * @param config - Configuration for the vector storage
   * @param binding - Optional pre-loaded minimemory binding (for testing)
   * @throws Error if minimemory binding is not available and no binding provided
   */
  constructor(config: MiniMemoryVectorStorageConfig, binding?: MiniMemoryBinding) {
    this.config = config;

    // Get the binding (either provided or loaded dynamically)
    const mm = binding ?? this.loadBinding();

    const dbConfig: Record<string, unknown> = {
      dimensions: config.dimensions,
      distance: config.distance || 'cosine',
      index_type: config.indexType || 'hnsw',
    };

    if (config.indexType === 'hnsw' || !config.indexType) {
      dbConfig.hnsw_m = config.hnswM || 16;
      dbConfig.hnsw_ef_construction = config.hnswEfConstruction || 200;
    }

    if (config.quantization && config.quantization !== 'none') {
      dbConfig.quantization = config.quantization;
    }

    this.db = new mm.VectorDB(dbConfig);

    // Load from disk if path exists
    if (config.persistPath) {
      try {
        this.db.load(config.persistPath);
        // Rebuild id set from loaded data
        const ids = this.db.list_ids?.() || [];
        for (const id of ids) {
          this.idSet.add(id);
        }
      } catch {
        // File doesn't exist yet - fresh database
      }
    }
  }

  private loadBinding(): MiniMemoryBinding {
    try {
      // Dynamic require for the native binding
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require('minimemory') as MiniMemoryBinding;
    } catch {
      throw new Error(
        'minimemory binding not available. Install with: npm install minimemory ' +
        '(or build from source: https://github.com/MauricioPerera/minimemory)'
      );
    }
  }

  async upsert(entry: VectorEntry): Promise<void> {
    const metadata = this.serializeMetadata(entry.metadata as unknown as Record<string, unknown>);

    if (this.idSet.has(entry.id)) {
      this.db.update(entry.id, entry.vector, metadata);
    } else {
      this.db.insert(entry.id, entry.vector, metadata);
    }

    this.idSet.add(entry.id);
    this.autoPersist();
  }

  async upsertBatch(entries: VectorEntry[]): Promise<BatchStorageResult> {
    let success = 0;
    let failed = 0;

    for (const entry of entries) {
      try {
        const metadata = this.serializeMetadata(entry.metadata as unknown as Record<string, unknown>);
        if (this.idSet.has(entry.id)) {
          this.db.update(entry.id, entry.vector, metadata);
        } else {
          this.db.insert(entry.id, entry.vector, metadata);
        }
        this.idSet.add(entry.id);
        success++;
      } catch {
        failed++;
      }
    }

    this.autoPersist();
    return { success, failed };
  }

  async delete(id: string): Promise<void> {
    if (this.idSet.has(id)) {
      this.db.delete(id);
      this.idSet.delete(id);
      this.autoPersist();
    }
  }

  async deleteBatch(ids: string[]): Promise<BatchStorageResult> {
    let success = 0;
    let failed = 0;

    for (const id of ids) {
      try {
        if (this.idSet.has(id)) {
          this.db.delete(id);
          this.idSet.delete(id);
          success++;
        } else {
          failed++;
        }
      } catch {
        failed++;
      }
    }

    this.autoPersist();
    return { success, failed };
  }

  async search(query: VectorSearchQuery): Promise<VectorSearchResult[]> {
    // Over-fetch for post-filtering
    const rawResults = this.db.search(query.vector, query.topK * 2);

    const results: VectorSearchResult[] = [];

    for (const raw of rawResults) {
      // Convert distance to similarity score (minimemory returns distance)
      const score = 1 - (raw.distance || 0);

      if (query.threshold && score < query.threshold) {
        continue;
      }

      const metadata = this.deserializeMetadata(raw.metadata || {}) as unknown as CommandMetadata;

      // Apply namespace filter
      if (query.filters?.namespace && metadata.namespace !== query.filters.namespace) {
        continue;
      }

      // Apply excludeIds filter
      if (query.filters?.excludeIds?.includes(raw.id)) {
        continue;
      }

      // Apply tags filter
      if (query.filters?.tags && query.filters.tags.length > 0) {
        const entryTags: string[] = metadata.tags || [];
        const hasMatchingTag = query.filters.tags.some(t => entryTags.includes(t));
        if (!hasMatchingTag) continue;
      }

      results.push({ id: raw.id, score, metadata });

      if (results.length >= query.topK) break;
    }

    return results;
  }

  async listIds(): Promise<string[]> {
    return Array.from(this.idSet);
  }

  async count(): Promise<number> {
    return this.idSet.size;
  }

  async clear(): Promise<void> {
    for (const id of this.idSet) {
      try {
        this.db.delete(id);
      } catch {
        // Ignore errors during clear
      }
    }
    this.idSet.clear();
    this.autoPersist();
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      const count = this.idSet.size;
      return {
        status: 'healthy',
        details: `minimemory HNSW: ${count} vectors, ${this.config.dimensions}d, ${this.config.quantization || 'none'} quantization`,
      };
    } catch {
      return { status: 'unhealthy', details: 'minimemory binding error' };
    }
  }

  /** Persist to disk (if persistPath configured) */
  save(): void {
    if (this.config.persistPath) {
      this.db.save(this.config.persistPath);
    }
  }

  /** Get the underlying VectorDB instance for advanced operations */
  getDb(): MiniMemoryVectorDB {
    return this.db;
  }

  /** Get configuration */
  getConfig(): MiniMemoryVectorStorageConfig {
    return { ...this.config };
  }

  private serializeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
    return {
      ...metadata,
      parameters: Array.isArray(metadata.parameters) ? JSON.stringify(metadata.parameters) : metadata.parameters,
      tags: Array.isArray(metadata.tags) ? JSON.stringify(metadata.tags) : metadata.tags,
    };
  }

  private deserializeMetadata(raw: Record<string, unknown>): Record<string, unknown> {
    return {
      ...raw,
      parameters: typeof raw.parameters === 'string' ? JSON.parse(raw.parameters) : (raw.parameters || []),
      tags: typeof raw.tags === 'string' ? JSON.parse(raw.tags) : (raw.tags || []),
    };
  }

  private autoPersist(): void {
    if (this.config.persistPath) {
      try {
        this.db.save(this.config.persistPath);
      } catch {
        // Silent fail on auto-persist - not critical
      }
    }
  }
}
