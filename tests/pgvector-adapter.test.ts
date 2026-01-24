/**
 * Tests para el adapter PgVector.
 *
 * Cubre: PgVectorStorageAdapter con mock in-memory del PgClient interface.
 * Sin dependencia de PostgreSQL real - valida la logica del adapter.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PgVectorStorageAdapter } from '../src/vector-index/pgvector-storage-adapter.js';
import type { PgClient, PgQueryResult } from '../src/vector-index/pgvector-types.js';
import type { VectorEntry, VectorSearchQuery } from '../src/vector-index/types.js';

// =====================================================================
// Mock PgClient (in-memory PostgreSQL mock)
// =====================================================================
class MockPgClient implements PgClient {
  public queries: { text: string; values?: any[] }[] = [];
  private rows: Map<string, { id: string; embedding: number[]; metadata: any; created_at: Date; updated_at: Date }> = new Map();
  private extensionCreated = false;
  private tableCreated = false;

  async query(text: string, values?: any[]): Promise<PgQueryResult> {
    this.queries.push({ text, values });
    const upper = text.toUpperCase().trim();

    // SELECT 1 AS ok (health check)
    if (upper.includes('SELECT 1 AS OK')) {
      return { rows: [{ ok: 1 }], rowCount: 1 };
    }

    // CREATE EXTENSION
    if (upper.includes('CREATE EXTENSION')) {
      this.extensionCreated = true;
      return { rows: [], rowCount: 0 };
    }

    // CREATE TABLE
    if (upper.includes('CREATE TABLE')) {
      this.tableCreated = true;
      return { rows: [], rowCount: 0 };
    }

    // CREATE INDEX
    if (upper.includes('CREATE INDEX')) {
      return { rows: [], rowCount: 0 };
    }

    // INSERT ... ON CONFLICT DO UPDATE (upsert)
    if (upper.includes('INSERT INTO') && upper.includes('ON CONFLICT')) {
      const id = values?.[0];
      const embedding = this.parseVector(values?.[1]);
      const metadata = JSON.parse(values?.[2] ?? '{}');
      this.rows.set(id, { id, embedding, metadata, created_at: new Date(), updated_at: new Date() });
      return { rows: [], rowCount: 1 };
    }

    // DELETE ... WHERE id = ANY($1)
    if (upper.includes('DELETE') && upper.includes('ANY')) {
      const ids: string[] = values?.[0] ?? [];
      let deleted = 0;
      for (const id of ids) {
        if (this.rows.delete(id)) deleted++;
      }
      return { rows: [], rowCount: deleted };
    }

    // DELETE ... WHERE id = $1
    if (upper.includes('DELETE')) {
      const id = values?.[0];
      const existed = this.rows.delete(id);
      return { rows: [], rowCount: existed ? 1 : 0 };
    }

    // SELECT COUNT(*) AS cnt
    if (upper.includes('SELECT COUNT(*)')) {
      return { rows: [{ cnt: this.rows.size }], rowCount: 1 };
    }

    // SELECT id FROM ... ORDER BY id
    if (upper.includes('SELECT ID FROM')) {
      const ids = [...this.rows.keys()].sort();
      return { rows: ids.map(id => ({ id })), rowCount: ids.length };
    }

    // TRUNCATE
    if (upper.includes('TRUNCATE')) {
      this.rows.clear();
      return { rows: [], rowCount: 0 };
    }

    // SELECT (search query with vector distance)
    if (upper.includes('SELECT') && upper.includes('SCORE')) {
      return this.executeSearch(text, values ?? []);
    }

    return { rows: [], rowCount: 0 };
  }

  private executeSearch(sql: string, values: any[]): PgQueryResult {
    const queryVector = this.parseVector(values[0]);
    const topK = values[values.length - 1] as number;

    let entries = [...this.rows.values()];

    // Apply namespace filter if present
    const nsParamIdx = values.findIndex((v, i) => i > 0 && i < values.length - 1 && typeof v === 'string');
    if (nsParamIdx > 0 && sql.includes('namespace')) {
      const ns = values[nsParamIdx];
      entries = entries.filter(e => e.metadata.namespace === ns);
    }

    // Compute cosine similarity
    const scored = entries.map(entry => ({
      id: entry.id,
      metadata: entry.metadata,
      score: this.cosineSimilarity(queryVector, entry.embedding),
    }));

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Apply threshold if present (check for numeric value after vector param)
    const thresholdIdx = values.findIndex((v, i) => i > 0 && i < values.length - 1 && typeof v === 'number' && v < 1);
    if (thresholdIdx > 0) {
      const threshold = values[thresholdIdx];
      const filtered = scored.filter(s => s.score >= threshold);
      return { rows: filtered.slice(0, topK), rowCount: filtered.length };
    }

    return { rows: scored.slice(0, topK), rowCount: Math.min(scored.length, topK) };
  }

  private parseVector(str: string): number[] {
    if (!str) return [];
    const cleaned = str.replace(/^\[|\]$/g, '');
    return cleaned.split(',').map(Number);
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dotProduct = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }
}

function createSampleEntry(id: string, vector?: number[]): VectorEntry {
  return {
    id,
    vector: vector ?? [0.1, 0.2, 0.3],
    metadata: {
      namespace: 'users',
      command: id.split(':')[1] ?? 'cmd',
      description: `Command ${id}`,
      signature: `${id} --arg value`,
      parameters: ['arg'],
      tags: ['test'],
      indexedAt: '2026-01-01T00:00:00Z',
      version: '1.0.0',
    },
  };
}

// =====================================================================
// Tests
// =====================================================================
describe('PgVectorStorageAdapter', () => {
  let client: MockPgClient;
  let adapter: PgVectorStorageAdapter;

  beforeEach(async () => {
    client = new MockPgClient();
    adapter = new PgVectorStorageAdapter({ client, dimensions: 3 });
    await adapter.initialize();
  });

  it('T01: initialize crea extension y tabla', () => {
    const queries = client.queries.map(q => q.text.toUpperCase());
    expect(queries.some(q => q.includes('CREATE EXTENSION'))).toBe(true);
    expect(queries.some(q => q.includes('CREATE TABLE'))).toBe(true);
    expect(queries.some(q => q.includes('CREATE INDEX'))).toBe(true);
  });

  it('T02: initialize con autoMigrate=false no crea tablas', async () => {
    const c = new MockPgClient();
    const a = new PgVectorStorageAdapter({ client: c, dimensions: 3, autoMigrate: false });
    await a.initialize();
    expect(c.queries).toHaveLength(0);
  });

  it('T03: upsert sin initialize lanza error', async () => {
    const a = new PgVectorStorageAdapter({ client: new MockPgClient(), dimensions: 3 });
    await expect(a.upsert(createSampleEntry('test:cmd'))).rejects.toThrow('not initialized');
  });

  it('T04: upsert almacena una entrada', async () => {
    await adapter.upsert(createSampleEntry('users:list'));
    const count = await adapter.count();
    expect(count).toBe(1);
  });

  it('T05: upsert actualiza entrada existente', async () => {
    await adapter.upsert(createSampleEntry('users:list', [0.1, 0.2, 0.3]));
    await adapter.upsert(createSampleEntry('users:list', [0.4, 0.5, 0.6]));
    const count = await adapter.count();
    expect(count).toBe(1);
  });

  it('T06: upsertBatch almacena multiples entradas', async () => {
    const result = await adapter.upsertBatch([
      createSampleEntry('users:list'),
      createSampleEntry('users:create'),
      createSampleEntry('users:delete'),
    ]);
    expect(result.success).toBe(3);
    expect(result.failed).toBe(0);
    expect(await adapter.count()).toBe(3);
  });

  it('T07: delete elimina una entrada', async () => {
    await adapter.upsert(createSampleEntry('users:list'));
    await adapter.delete('users:list');
    expect(await adapter.count()).toBe(0);
  });

  it('T08: deleteBatch elimina multiples entradas', async () => {
    await adapter.upsertBatch([
      createSampleEntry('users:list'),
      createSampleEntry('users:create'),
      createSampleEntry('users:delete'),
    ]);
    const result = await adapter.deleteBatch(['users:list', 'users:create']);
    expect(result.success).toBe(2);
    expect(await adapter.count()).toBe(1);
  });

  it('T09: search retorna resultados ordenados por similaridad', async () => {
    await adapter.upsertBatch([
      createSampleEntry('users:list', [1, 0, 0]),
      createSampleEntry('users:create', [0, 1, 0]),
      createSampleEntry('users:delete', [0.9, 0.1, 0]),
    ]);

    const results = await adapter.search({
      vector: [1, 0, 0],
      topK: 3,
    });

    expect(results).toHaveLength(3);
    // Exact match should be first
    expect(results[0].id).toBe('users:list');
    expect(results[0].score).toBeCloseTo(1.0, 5);
    // Similar vector second
    expect(results[1].id).toBe('users:delete');
    expect(results[1].score).toBeGreaterThan(0.9);
  });

  it('T10: search respeta topK', async () => {
    await adapter.upsertBatch([
      createSampleEntry('cmd:1', [1, 0, 0]),
      createSampleEntry('cmd:2', [0, 1, 0]),
      createSampleEntry('cmd:3', [0, 0, 1]),
    ]);

    const results = await adapter.search({ vector: [1, 0, 0], topK: 2 });
    expect(results).toHaveLength(2);
  });

  it('T11: search con threshold filtra resultados bajos', async () => {
    await adapter.upsertBatch([
      createSampleEntry('cmd:match', [1, 0, 0]),
      createSampleEntry('cmd:nomatch', [0, 1, 0]),
    ]);

    const results = await adapter.search({
      vector: [1, 0, 0],
      topK: 10,
      threshold: 0.9,
    });

    expect(results.length).toBeLessThanOrEqual(1);
    if (results.length > 0) {
      expect(results[0].score).toBeGreaterThanOrEqual(0.9);
    }
  });

  it('T12: search con filtro de namespace', async () => {
    const entry1 = createSampleEntry('users:list', [1, 0, 0]);
    const entry2 = createSampleEntry('orders:list', [0.9, 0.1, 0]);
    entry2.metadata.namespace = 'orders';

    await adapter.upsertBatch([entry1, entry2]);

    const results = await adapter.search({
      vector: [1, 0, 0],
      topK: 10,
      filters: { namespace: 'users' },
    });

    expect(results.every(r => r.metadata.namespace === 'users')).toBe(true);
  });

  it('T13: listIds retorna todos los IDs ordenados', async () => {
    await adapter.upsertBatch([
      createSampleEntry('users:create'),
      createSampleEntry('users:list'),
      createSampleEntry('orders:list'),
    ]);

    const ids = await adapter.listIds();
    expect(ids).toEqual(['orders:list', 'users:create', 'users:list']);
  });

  it('T14: count retorna 0 para tabla vacia', async () => {
    expect(await adapter.count()).toBe(0);
  });

  it('T15: clear elimina todas las entradas', async () => {
    await adapter.upsertBatch([
      createSampleEntry('cmd:1'),
      createSampleEntry('cmd:2'),
    ]);
    await adapter.clear();
    expect(await adapter.count()).toBe(0);
  });

  it('T16: healthCheck retorna healthy con conexion OK', async () => {
    const health = await adapter.healthCheck();
    expect(health.status).toBe('healthy');
  });

  it('T17: healthCheck retorna unhealthy si query falla', async () => {
    const failClient: PgClient = {
      async query() { throw new Error('Connection refused'); },
    };
    const a = new PgVectorStorageAdapter({ client: failClient, dimensions: 3, autoMigrate: false });
    await a.initialize();
    const health = await a.healthCheck();
    expect(health.status).toBe('unhealthy');
    expect(health.details).toContain('Connection refused');
  });

  it('T18: search retorna metadata correcta', async () => {
    const entry = createSampleEntry('users:list', [1, 0, 0]);
    entry.metadata.description = 'List all users';
    entry.metadata.tags = ['crud', 'admin'];

    await adapter.upsert(entry);
    const results = await adapter.search({ vector: [1, 0, 0], topK: 1 });

    expect(results[0].metadata.description).toBe('List all users');
    expect(results[0].metadata.tags).toEqual(['crud', 'admin']);
  });

  it('T19: initialize crea indice HNSW con config custom', async () => {
    const c = new MockPgClient();
    const a = new PgVectorStorageAdapter({
      client: c,
      dimensions: 768,
      hnswOptions: { m: 32, efConstruction: 128 },
    });
    await a.initialize();

    const indexQuery = c.queries.find(q => q.text.toUpperCase().includes('CREATE INDEX'));
    expect(indexQuery).toBeDefined();
    expect(indexQuery!.text).toContain('m = 32');
    expect(indexQuery!.text).toContain('ef_construction = 128');
  });

  it('T20: createIndex=false no crea indice', async () => {
    const c = new MockPgClient();
    const a = new PgVectorStorageAdapter({ client: c, dimensions: 3, createIndex: false });
    await a.initialize();

    const hasIndex = c.queries.some(q => q.text.toUpperCase().includes('CREATE INDEX'));
    expect(hasIndex).toBe(false);
  });

  it('T21: tabla custom via tableName', async () => {
    const c = new MockPgClient();
    const a = new PgVectorStorageAdapter({ client: c, dimensions: 3, tableName: 'my_vectors' });
    await a.initialize();

    const tableQuery = c.queries.find(q => q.text.toUpperCase().includes('CREATE TABLE'));
    expect(tableQuery!.text).toContain('my_vectors');
  });

  it('T22: distanceType l2 usa operador correcto', async () => {
    const c = new MockPgClient();
    const a = new PgVectorStorageAdapter({ client: c, dimensions: 3, distanceType: 'l2' });
    await a.initialize();

    const indexQuery = c.queries.find(q => q.text.toUpperCase().includes('CREATE INDEX'));
    expect(indexQuery!.text).toContain('vector_l2_ops');
  });

  it('T23: distanceType inner_product usa operador correcto', async () => {
    const c = new MockPgClient();
    const a = new PgVectorStorageAdapter({ client: c, dimensions: 3, distanceType: 'inner_product' });
    await a.initialize();

    const indexQuery = c.queries.find(q => q.text.toUpperCase().includes('CREATE INDEX'));
    expect(indexQuery!.text).toContain('vector_ip_ops');
  });

  it('T24: deleteBatch con array vacio retorna success=0', async () => {
    const result = await adapter.deleteBatch([]);
    expect(result.success).toBe(0);
    expect(result.failed).toBe(0);
  });

  it('T25: vector format usa notacion pgvector correcta', async () => {
    await adapter.upsert(createSampleEntry('test:cmd', [0.1, 0.2, 0.3]));
    const insertQuery = client.queries.find(q => q.text.includes('INSERT'));
    expect(insertQuery!.values![1]).toBe('[0.1,0.2,0.3]');
  });
});
