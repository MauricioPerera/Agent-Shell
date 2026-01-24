/**
 * Opcion B: SQLite con streaming iterator + min-heap para top-K.
 *
 * A diferencia de Option A que carga TODOS los vectores a un array JS,
 * este enfoque usa .iterate() para procesar fila por fila sin acumular
 * todo en memoria. Mantiene solo un min-heap de tamaño K.
 *
 * Diferencia clave de memoria: O(K) vs O(N) de Option A.
 * Trade-off: la deserializacion por fila puede ser mas lenta que batch.
 */

import { Database } from 'bun:sqlite';
import type {
  VectorStorageAdapter,
  VectorEntry,
  VectorSearchQuery,
  VectorSearchResult,
  BatchStorageResult,
  HealthStatus,
} from '../../src/vector-index/types.js';

export interface SqliteStreamingStorageConfig {
  dbPath?: string; // default: './vectors-streaming.db'
}

export class SqliteNativeVectorStorage implements VectorStorageAdapter {
  private db: Database;

  constructor(config: SqliteStreamingStorageConfig = {}) {
    const dbPath = config.dbPath || './vectors-streaming.db';
    this.db = new Database(dbPath);
    this.db.exec('PRAGMA journal_mode=WAL');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vectors (
        id TEXT PRIMARY KEY,
        vector BLOB NOT NULL,
        metadata TEXT NOT NULL,
        namespace TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_vectors_namespace ON vectors(namespace)
    `);
  }

  async upsert(entry: VectorEntry): Promise<void> {
    const vectorBlob = Buffer.from(new Float32Array(entry.vector).buffer);
    const metadataJson = JSON.stringify(entry.metadata);

    this.db.prepare(`
      INSERT OR REPLACE INTO vectors (id, vector, metadata, namespace)
      VALUES (?, ?, ?, ?)
    `).run(entry.id, vectorBlob, metadataJson, entry.metadata.namespace);
  }

  async upsertBatch(entries: VectorEntry[]): Promise<BatchStorageResult> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO vectors (id, vector, metadata, namespace)
      VALUES (?, ?, ?, ?)
    `);

    let success = 0;
    let failed = 0;

    const transaction = this.db.transaction(() => {
      for (const entry of entries) {
        try {
          const vectorBlob = Buffer.from(new Float32Array(entry.vector).buffer);
          stmt.run(entry.id, vectorBlob, JSON.stringify(entry.metadata), entry.metadata.namespace);
          success++;
        } catch {
          failed++;
        }
      }
    });

    transaction();
    return { success, failed };
  }

  async delete(id: string): Promise<void> {
    this.db.prepare('DELETE FROM vectors WHERE id = ?').run(id);
  }

  async deleteBatch(ids: string[]): Promise<BatchStorageResult> {
    const stmt = this.db.prepare('DELETE FROM vectors WHERE id = ?');
    let success = 0;
    let failed = 0;

    const transaction = this.db.transaction(() => {
      for (const id of ids) {
        try {
          stmt.run(id);
          success++;
        } catch {
          failed++;
        }
      }
    });

    transaction();
    return { success, failed };
  }

  async search(query: VectorSearchQuery): Promise<VectorSearchResult[]> {
    // Streaming approach: iterate row by row, maintain a min-heap of size topK
    const namespace = query.filters?.namespace;
    const threshold = query.threshold || 0;
    const topK = query.topK;

    const sql = namespace
      ? 'SELECT id, vector, metadata FROM vectors WHERE namespace = ?'
      : 'SELECT id, vector, metadata FROM vectors';

    const stmt = namespace
      ? this.db.prepare(sql).bind(namespace)
      : this.db.prepare(sql);

    // Min-heap: keeps the K best results. Heap[0] is the worst of the top-K.
    const heap: VectorSearchResult[] = [];

    for (const row of stmt.iterate() as Iterable<any>) {
      const storedVec = new Float32Array(
        row.vector.buffer,
        row.vector.byteOffset,
        row.vector.byteLength / 4
      );
      const score = cosineSimilarity(query.vector, storedVec);

      if (score < threshold) continue;

      if (heap.length < topK) {
        heap.push({ id: row.id, score, metadata: JSON.parse(row.metadata) });
        if (heap.length === topK) heapify(heap);
      } else if (score > heap[0].score) {
        // Replace the minimum element
        heap[0] = { id: row.id, score, metadata: JSON.parse(row.metadata) };
        siftDown(heap, 0);
      }
      // If score <= heap[0].score, skip (don't even parse metadata)
    }

    // Sort final results descending
    heap.sort((a, b) => b.score - a.score);
    return heap;
  }

  async listIds(): Promise<string[]> {
    const rows = this.db.prepare('SELECT id FROM vectors').all() as any[];
    return rows.map(r => r.id);
  }

  async count(): Promise<number> {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM vectors').get() as any;
    return row.cnt;
  }

  async clear(): Promise<void> {
    this.db.exec('DELETE FROM vectors');
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      this.db.prepare('SELECT 1').get();
      return { status: 'healthy' };
    } catch {
      return { status: 'unhealthy', details: 'SQLite connection failed' };
    }
  }

  close(): void {
    this.db.close();
  }
}

// --- Cosine similarity ---
function cosineSimilarity(a: number[] | Float32Array, b: Float32Array): number {
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

// --- Min-heap utilities (by score ascending, so heap[0] is smallest) ---
function heapify(arr: VectorSearchResult[]): void {
  for (let i = Math.floor(arr.length / 2) - 1; i >= 0; i--) {
    siftDown(arr, i);
  }
}

function siftDown(arr: VectorSearchResult[], i: number): void {
  const n = arr.length;
  while (true) {
    let smallest = i;
    const left = 2 * i + 1;
    const right = 2 * i + 2;
    if (left < n && arr[left].score < arr[smallest].score) smallest = left;
    if (right < n && arr[right].score < arr[smallest].score) smallest = right;
    if (smallest === i) break;
    [arr[i], arr[smallest]] = [arr[smallest], arr[i]];
    i = smallest;
  }
}
