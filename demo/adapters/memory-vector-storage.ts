/**
 * VectorStorageAdapter in-memory con cosine similarity real.
 */

import type {
  VectorStorageAdapter,
  VectorEntry,
  VectorSearchQuery,
  VectorSearchResult,
  BatchStorageResult,
  HealthStatus,
} from '../../src/vector-index/types.js';

export class MemoryVectorStorage implements VectorStorageAdapter {
  private entries: Map<string, VectorEntry> = new Map();

  async upsert(entry: VectorEntry): Promise<void> {
    this.entries.set(entry.id, entry);
  }

  async upsertBatch(entries: VectorEntry[]): Promise<BatchStorageResult> {
    for (const entry of entries) {
      this.entries.set(entry.id, entry);
    }
    return { success: entries.length, failed: 0 };
  }

  async delete(id: string): Promise<void> {
    this.entries.delete(id);
  }

  async deleteBatch(ids: string[]): Promise<BatchStorageResult> {
    for (const id of ids) {
      this.entries.delete(id);
    }
    return { success: ids.length, failed: 0 };
  }

  async search(query: VectorSearchQuery): Promise<VectorSearchResult[]> {
    const results: VectorSearchResult[] = [];

    for (const entry of this.entries.values()) {
      // Apply namespace filter
      if (query.filters?.namespace && entry.metadata.namespace !== query.filters.namespace) {
        continue;
      }
      // Apply exclude filter
      if (query.filters?.excludeIds?.includes(entry.id)) {
        continue;
      }

      const score = cosineSimilarity(query.vector, entry.vector);

      if (query.threshold && score < query.threshold) {
        continue;
      }

      results.push({ id: entry.id, score, metadata: entry.metadata });
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, query.topK);
  }

  async listIds(): Promise<string[]> {
    return Array.from(this.entries.keys());
  }

  async count(): Promise<number> {
    return this.entries.size;
  }

  async clear(): Promise<void> {
    this.entries.clear();
  }

  async healthCheck(): Promise<HealthStatus> {
    return { status: 'healthy' };
  }
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
