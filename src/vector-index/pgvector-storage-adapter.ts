/**
 * @module vector-index/pgvector-storage-adapter
 * @description VectorStorageAdapter para PostgreSQL con pgvector extension.
 *
 * Implementa VectorStorageAdapter usando PostgreSQL como backend con la
 * extension pgvector para almacenamiento y busqueda vectorial nativa.
 *
 * Requiere:
 * - PostgreSQL 14+ con extension pgvector instalada
 * - Un cliente que satisfaga la interfaz PgClient (compatible con `pg`)
 *
 * Zero dependencias runtime - acepta cualquier cliente PostgreSQL inyectado.
 */

import type {
  VectorStorageAdapter,
  VectorEntry,
  VectorSearchQuery,
  VectorSearchResult,
  BatchStorageResult,
  HealthStatus,
} from './types.js';
import type { PgClient, PgVectorConfig } from './pgvector-types.js';

export class PgVectorStorageAdapter implements VectorStorageAdapter {
  private readonly client: PgClient;
  private readonly tableName: string;
  private readonly dimensions: number;
  private readonly distanceType: 'cosine' | 'l2' | 'inner_product';
  private readonly autoMigrate: boolean;
  private readonly createIndex: boolean;
  private readonly hnswOptions: { m: number; efConstruction: number };
  private initialized = false;

  constructor(config: PgVectorConfig) {
    this.client = config.client;
    this.tableName = config.tableName ?? 'vector_entries';
    this.dimensions = config.dimensions;
    this.distanceType = config.distanceType ?? 'cosine';
    this.autoMigrate = config.autoMigrate ?? true;
    this.createIndex = config.createIndex ?? true;
    this.hnswOptions = {
      m: config.hnswOptions?.m ?? 16,
      efConstruction: config.hnswOptions?.efConstruction ?? 64,
    };
  }

  /** Inicializa el adapter: crea extension, tabla e indices si autoMigrate=true. */
  async initialize(): Promise<void> {
    if (!this.autoMigrate) {
      this.initialized = true;
      return;
    }

    await this.client.query('CREATE EXTENSION IF NOT EXISTS vector');

    await this.client.query(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        id TEXT PRIMARY KEY,
        embedding vector(${this.dimensions}),
        metadata JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    if (this.createIndex) {
      const opClass = this.getOpClass();
      await this.client.query(`
        CREATE INDEX IF NOT EXISTS idx_${this.tableName}_embedding
        ON ${this.tableName}
        USING hnsw (embedding ${opClass})
        WITH (m = ${this.hnswOptions.m}, ef_construction = ${this.hnswOptions.efConstruction})
      `);
    }

    this.initialized = true;
  }

  async upsert(entry: VectorEntry): Promise<void> {
    this.ensureInitialized();
    const vectorStr = this.vectorToString(entry.vector);

    await this.client.query(
      `INSERT INTO ${this.tableName} (id, embedding, metadata, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (id) DO UPDATE SET
         embedding = EXCLUDED.embedding,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()`,
      [entry.id, vectorStr, JSON.stringify(entry.metadata)]
    );
  }

  async upsertBatch(entries: VectorEntry[]): Promise<BatchStorageResult> {
    this.ensureInitialized();
    let success = 0;
    let failed = 0;

    for (const entry of entries) {
      try {
        await this.upsert(entry);
        success++;
      } catch {
        failed++;
      }
    }

    return { success, failed };
  }

  async delete(id: string): Promise<void> {
    this.ensureInitialized();
    await this.client.query(
      `DELETE FROM ${this.tableName} WHERE id = $1`,
      [id]
    );
  }

  async deleteBatch(ids: string[]): Promise<BatchStorageResult> {
    this.ensureInitialized();
    if (ids.length === 0) return { success: 0, failed: 0 };

    const result = await this.client.query(
      `DELETE FROM ${this.tableName} WHERE id = ANY($1)`,
      [ids]
    );

    const deleted = result.rowCount ?? 0;
    return { success: deleted, failed: ids.length - deleted };
  }

  async search(query: VectorSearchQuery): Promise<VectorSearchResult[]> {
    this.ensureInitialized();
    const vectorStr = this.vectorToString(query.vector);
    const distanceExpr = this.getDistanceExpression('embedding', '$1');
    const similarityExpr = this.getSimilarityExpression(distanceExpr);

    let sql = `
      SELECT id, metadata, ${similarityExpr} AS score
      FROM ${this.tableName}
    `;

    const values: any[] = [vectorStr];
    const conditions: string[] = [];
    let paramIdx = 2;

    // Apply filters
    if (query.filters?.namespace) {
      conditions.push(`metadata->>'namespace' = $${paramIdx}`);
      values.push(query.filters.namespace);
      paramIdx++;
    }

    if (query.filters?.tags && query.filters.tags.length > 0) {
      conditions.push(`metadata->'tags' ?| $${paramIdx}`);
      values.push(query.filters.tags);
      paramIdx++;
    }

    if (query.filters?.excludeIds && query.filters.excludeIds.length > 0) {
      conditions.push(`id != ALL($${paramIdx})`);
      values.push(query.filters.excludeIds);
      paramIdx++;
    }

    if (query.threshold !== undefined) {
      conditions.push(`${similarityExpr} >= $${paramIdx}`);
      values.push(query.threshold);
      paramIdx++;
    }

    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }

    sql += ` ORDER BY ${this.getDistanceExpression('embedding', '$1')} ASC`;
    sql += ` LIMIT $${paramIdx}`;
    values.push(query.topK);

    const result = await this.client.query(sql, values);

    return result.rows.map(row => ({
      id: row.id,
      score: parseFloat(row.score),
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
    }));
  }

  async listIds(): Promise<string[]> {
    this.ensureInitialized();
    const result = await this.client.query(
      `SELECT id FROM ${this.tableName} ORDER BY id`
    );
    return result.rows.map(r => r.id);
  }

  async count(): Promise<number> {
    this.ensureInitialized();
    const result = await this.client.query(
      `SELECT COUNT(*) AS cnt FROM ${this.tableName}`
    );
    return parseInt(result.rows[0].cnt);
  }

  async clear(): Promise<void> {
    this.ensureInitialized();
    await this.client.query(`TRUNCATE ${this.tableName}`);
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      const result = await this.client.query('SELECT 1 AS ok');
      if (result.rows[0]?.ok === 1) {
        return { status: 'healthy' };
      }
      return { status: 'degraded', details: 'Unexpected query result' };
    } catch (err: any) {
      return { status: 'unhealthy', details: err.message ?? 'Connection failed' };
    }
  }

  /** Convierte un vector numerico al formato string de pgvector: '[1,2,3]'. */
  private vectorToString(vector: number[]): string {
    return `[${vector.join(',')}]`;
  }

  /** Retorna el operador de distancia segun el tipo configurado. */
  private getDistanceOperator(): string {
    switch (this.distanceType) {
      case 'cosine': return '<=>';
      case 'l2': return '<->';
      case 'inner_product': return '<#>';
    }
  }

  /** Retorna la clase de operador para el indice HNSW. */
  private getOpClass(): string {
    switch (this.distanceType) {
      case 'cosine': return 'vector_cosine_ops';
      case 'l2': return 'vector_l2_ops';
      case 'inner_product': return 'vector_ip_ops';
    }
  }

  /** Genera la expresion SQL de distancia. */
  private getDistanceExpression(column: string, param: string): string {
    return `${column} ${this.getDistanceOperator()} ${param}::vector`;
  }

  /** Convierte distancia a score de similaridad (0-1). */
  private getSimilarityExpression(distanceExpr: string): string {
    switch (this.distanceType) {
      case 'cosine':
        return `1 - (${distanceExpr})`;
      case 'l2':
        return `1 / (1 + (${distanceExpr}))`;
      case 'inner_product':
        return `-(${distanceExpr})`;
    }
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('PgVectorStorageAdapter not initialized. Call initialize() first.');
    }
  }
}
