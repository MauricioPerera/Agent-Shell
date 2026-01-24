/**
 * Opcion A: SQLite como persistencia + busqueda coseno en JS.
 *
 * Almacena vectores y metadata en SQLite. Al buscar, carga los vectores
 * relevantes a memoria y computa cosine similarity en JavaScript.
 * Beneficio: persistencia (no re-indexar al reiniciar).
 */

import { Database } from 'bun:sqlite';
import type {
  VectorStorageAdapter,
  VectorEntry,
  VectorSearchQuery,
  VectorSearchResult,
  BatchStorageResult,
  HealthStatus,
  CommandMetadata,
} from '../../src/vector-index/types.js';

export interface SqliteStorageConfig {
  dbPath?: string; // default: './vectors.db'
}

export class SqliteVectorStorage implements VectorStorageAdapter {
  private db: Database;

  constructor(config: SqliteStorageConfig = {}) {
    const dbPath = config.dbPath || './vectors.db';
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
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
  }

  async upsert(entry: VectorEntry): Promise<void> {
    const vectorBlob = Buffer.from(new Float32Array(entry.vector).buffer);
    const metadataJson = JSON.stringify(entry.metadata);

    this.db.prepare(`
      INSERT OR REPLACE INTO vectors (id, vector, metadata) VALUES (?, ?, ?)
    `).run(entry.id, vectorBlob, metadataJson);
  }

  async upsertBatch(entries: VectorEntry[]): Promise<BatchStorageResult> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO vectors (id, vector, metadata) VALUES (?, ?, ?)
    `);

    let success = 0;
    let failed = 0;

    const transaction = this.db.transaction(() => {
      for (const entry of entries) {
        try {
          const vectorBlob = Buffer.from(new Float32Array(entry.vector).buffer);
          stmt.run(entry.id, vectorBlob, JSON.stringify(entry.metadata));
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
    // Load all vectors from DB and compute cosine similarity in JS
    const rows = this.db.prepare('SELECT id, vector, metadata FROM vectors').all() as any[];

    const results: VectorSearchResult[] = [];
    const queryVec = query.vector;

    for (const row of rows) {
      const storedVec = new Float32Array(row.vector.buffer);
      const metadata: CommandMetadata = JSON.parse(row.metadata);

      // Apply namespace filter if present
      if (query.filters?.namespace && metadata.namespace !== query.filters.namespace) {
        continue;
      }

      const score = cosineSimilarity(queryVec, storedVec);

      if (score >= (query.threshold || 0)) {
        results.push({ id: row.id, score, metadata });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, query.topK);
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
