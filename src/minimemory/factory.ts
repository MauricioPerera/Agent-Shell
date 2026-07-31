/**
 * @module minimemory/factory
 * @description Factory functions for creating vector storage with automatic
 * backend selection. Tries minimemory first, falls back to in-memory.
 *
 * This enables agent-shell to use HNSW when minimemory is installed,
 * while gracefully degrading to brute-force in-memory when it's not.
 */

import { createRequire } from 'node:module';
import type { VectorStorageAdapter, CommandMetadata, VectorSearchResult } from '../vector-index/types.js';
import type { StorageFactoryOptions, StorageFactoryResult, MiniMemoryBinding } from './types.js';
import { MiniMemoryVectorStorage } from './vector-storage.js';
import { cosineSimilarity } from '../vector-index/similarity.js';

// This package builds to ESM only (tsup.config.ts: format: ['esm']). The bare
// `require` identifier doesn't exist at runtime in ESM, and bundlers rewrite a
// literal `require(...)` call into a shim that unconditionally throws ("Dynamic
// require of X is not supported") regardless of whether the package is
// actually installed — silently making isMinimemoryAvailable()/loadMinimemory()
// always report "not available" and forcing every caller onto the slower
// in-memory brute-force fallback (same class of bug as just-bash/factory.ts).
// createRequire gives a real, working CJS require in ESM.
const require = createRequire(import.meta.url);

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
  // Single require('minimemory') for this whole call, reused below instead
  // of probing with isMinimemoryAvailable() and then having
  // MiniMemoryVectorStorage's constructor require() it again internally.
  const binding = loadMinimemory();
  const available = binding !== null;

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
    if (!binding) {
      throw new Error(
        'minimemory backend requested but not available. ' +
        'Install with: npm install minimemory'
      );
    }
    // Unlike 'auto' below, prefer:'minimemory' is an explicit request for
    // this backend, so a construction failure should surface (not silently
    // fall back to memory) — but with a clear, actionable message instead
    // of whatever internal error the binding happened to throw (e.g. a raw
    // native-addon stack trace for an ABI/platform mismatch).
    try {
      return {
        storage: new MiniMemoryVectorStorage({
          dimensions,
          distance: mmConfig?.distance || 'cosine',
          indexType: mmConfig?.indexType || 'hnsw',
          hnswM: mmConfig?.hnswM,
          hnswEfConstruction: mmConfig?.hnswEfConstruction,
          quantization: mmConfig?.quantization,
          persistPath: mmConfig?.persistPath,
        }, binding),
        backend: 'minimemory',
        minimemoryAvailable: true,
      };
    } catch (err) {
      throw new Error(
        `minimemory backend requested but failed to initialize: ${(err as Error)?.message ?? err}`,
        { cause: err }
      );
    }
  }

  // Auto: try minimemory first, fallback to memory
  if (binding) {
    try {
      const storage = new MiniMemoryVectorStorage({
        dimensions,
        distance: mmConfig?.distance || 'cosine',
        indexType: mmConfig?.indexType || 'hnsw',
        hnswM: mmConfig?.hnswM,
        hnswEfConstruction: mmConfig?.hnswEfConstruction,
        quantization: mmConfig?.quantization,
        persistPath: mmConfig?.persistPath,
      }, binding);
      return {
        storage,
        backend: 'minimemory',
        minimemoryAvailable: true,
      };
    } catch (err) {
      // minimemory available but failed to init - fallback
      warnFallback(`failed to initialize: ${(err as Error)?.message ?? err}`);
    }
  } else {
    warnFallback('package not installed');
  }

  // Fallback to in-memory
  return {
    storage: createInMemoryStorage(),
    backend: 'memory',
    minimemoryAvailable: available,
  };
}

/**
 * Logs which vector storage backend ended up active. `auto` silently
 * degrading from HNSW to brute-force in-memory search is exactly the
 * failure mode this module exists to prevent — surface it instead of
 * staying quiet, mirroring just-bash/factory.ts's warnFallback().
 */
function warnFallback(reason: string): void {
  // eslint-disable-next-line no-console
  console.error(`[agent-shell] minimemory backend not available (${reason}); vector search will use the slower in-memory brute-force fallback.`);
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

        if (query.threshold !== undefined && score < query.threshold) {
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
