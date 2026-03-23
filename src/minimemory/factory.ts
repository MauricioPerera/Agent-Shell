/**
 * @module minimemory/factory
 * @description Factory functions for creating vector storage with automatic
 * backend selection. Tries minimemory first, falls back to in-memory.
 *
 * This enables agent-shell to use HNSW when minimemory is installed,
 * while gracefully degrading to brute-force in-memory when it's not.
 */

import type { VectorStorageAdapter, CommandMetadata, VectorSearchResult } from '../vector-index/types.js';
import type { StorageFactoryOptions, StorageFactoryResult, MiniMemoryBinding } from './types.js';
import { MiniMemoryVectorStorage } from './vector-storage.js';

/** Check if minimemory binding is available */
export function isMinimemoryAvailable(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('minimemory');
    return true;
  } catch {
    return false;
  }
}

/** Load minimemory binding or return null */
export function loadMinimemory(): MiniMemoryBinding | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('minimemory') as MiniMemoryBinding;
  } catch {
    return null;
  }
}

/**
 * Creates a vector storage adapter with automatic backend selection.
 *
 * @param options - Configuration options
 * @returns The created storage and metadata about which backend was used
 *
 * @example
 * ```typescript
 * // Auto-select best available backend
 * const { storage, backend } = await createVectorStorage({ dimensions: 768 });
 * console.log(`Using ${backend} backend`);
 *
 * // Prefer minimemory, fail if not available
 * const { storage } = await createVectorStorage({
 *   dimensions: 768,
 *   prefer: 'minimemory',
 *   minimemory: { persistPath: './data.mmdb' }
 * });
 *
 * // Force in-memory (for testing)
 * const { storage } = await createVectorStorage({
 *   dimensions: 768,
 *   prefer: 'memory'
 * });
 * ```
 */
export async function createVectorStorage(options: StorageFactoryOptions): Promise<StorageFactoryResult> {
  const { dimensions, prefer = 'auto', minimemory: mmConfig } = options;
  const available = isMinimemoryAvailable();

  // Force memory backend
  if (prefer === 'memory') {
    return {
      storage: createInMemoryStorage(),
      backend: 'memory',
      minimemoryAvailable: available,
    };
  }

  // Force minimemory backend (throw if not available)
  if (prefer === 'minimemory') {
    if (!available) {
      throw new Error(
        'minimemory backend requested but not available. ' +
        'Install with: npm install minimemory'
      );
    }
    return {
      storage: new MiniMemoryVectorStorage({
        dimensions,
        distance: mmConfig?.distance || 'cosine',
        indexType: mmConfig?.indexType || 'hnsw',
        hnswM: mmConfig?.hnswM,
        hnswEfConstruction: mmConfig?.hnswEfConstruction,
        quantization: mmConfig?.quantization,
        persistPath: mmConfig?.persistPath,
      }),
      backend: 'minimemory',
      minimemoryAvailable: true,
    };
  }

  // Auto: try minimemory first, fallback to memory
  if (available) {
    try {
      const storage = new MiniMemoryVectorStorage({
        dimensions,
        distance: mmConfig?.distance || 'cosine',
        indexType: mmConfig?.indexType || 'hnsw',
        hnswM: mmConfig?.hnswM,
        hnswEfConstruction: mmConfig?.hnswEfConstruction,
        quantization: mmConfig?.quantization,
        persistPath: mmConfig?.persistPath,
      });
      return {
        storage,
        backend: 'minimemory',
        minimemoryAvailable: true,
      };
    } catch {
      // minimemory available but failed to init - fallback
    }
  }

  // Fallback to in-memory
  return {
    storage: createInMemoryStorage(),
    backend: 'memory',
    minimemoryAvailable: available,
  };
}

/**
 * Creates an in-memory vector storage adapter with cosine similarity.
 * This is the fallback when minimemory is not available.
 */
function createInMemoryStorage(): VectorStorageAdapter {
  const entries = new Map<string, { vector: number[]; metadata: CommandMetadata }>();

  return {
    async upsert(entry) {
      entries.set(entry.id, { vector: entry.vector, metadata: entry.metadata });
    },

    async upsertBatch(batch) {
      for (const entry of batch) {
        entries.set(entry.id, { vector: entry.vector, metadata: entry.metadata });
      }
      return { success: batch.length, failed: 0 };
    },

    async delete(id) {
      entries.delete(id);
    },

    async deleteBatch(ids) {
      for (const id of ids) {
        entries.delete(id);
      }
      return { success: ids.length, failed: 0 };
    },

    async search(query) {
      const results: VectorSearchResult[] = [];

      for (const [id, entry] of entries) {
        // Apply filters
        if (query.filters?.namespace && entry.metadata.namespace !== query.filters.namespace) {
          continue;
        }
        if (query.filters?.excludeIds?.includes(id)) {
          continue;
        }

        const score = cosineSimilarity(query.vector, entry.vector);

        if (query.threshold && score < query.threshold) {
          continue;
        }

        if (query.filters?.tags && query.filters.tags.length > 0) {
          const entryTags: string[] = entry.metadata.tags || [];
          const hasMatchingTag = query.filters.tags.some(t => entryTags.includes(t));
          if (!hasMatchingTag) continue;
        }

        results.push({ id, score, metadata: entry.metadata });
      }

      results.sort((a, b) => b.score - a.score);
      return results.slice(0, query.topK);
    },

    async listIds() {
      return Array.from(entries.keys());
    },

    async count() {
      return entries.size;
    },

    async clear() {
      entries.clear();
    },

    async healthCheck() {
      return { status: 'healthy', details: `in-memory: ${entries.size} vectors` };
    },
  };
}

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
