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

import { createHash } from 'node:crypto';
import type {
  VectorStorageAdapter,
  VectorEntry,
  VectorSearchQuery,
  VectorSearchResult,
  BatchStorageResult,
  HealthStatus,
} from './types.js';
import type { PgClient, PgVectorConfig } from './pgvector-types.js';

/**
 * Regresion (ronda 77 del audit, MEDIUM): el nombre del indice HNSW se
 * construia como `idx_${tableName}_embedding` sin considerar el limite de
 * 63 bytes de PostgreSQL para identificadores (NAMEDATALEN-1). tableName
 * ya estaba validado para permitir hasta 63 caracteres (constructor de
 * esta clase), asi que `idx_` (4) + tableName (hasta 63) + `_embedding`
 * (10) podia llegar a 77 bytes — Postgres trunca el identificador en
 * silencio a los primeros 63 bytes al ejecutar el DDL, sin error. Dos
 * PgVectorStorageAdapter con tableNames DISTINTOS que comparten el mismo
 * prefijo de ~49 caracteres (ej. dos tenants con nombres de tabla largos
 * y un sufijo distinto) terminan generando el MISMO nombre de indice
 * truncado — el segundo `CREATE INDEX IF NOT EXISTS` hace no-op contra el
 * indice de la PRIMERA tabla en vez de crear el suyo propio, dejando esa
 * segunda tabla sin indice HNSW (degrada en silencio a sequential scan,
 * sin ningun error que lo delate). Si el tableName completo cabe dentro
 * del limite, el nombre no cambia (compatibilidad con instalaciones
 * existentes); si no cabe, se trunca dejando espacio fijo para un hash
 * corto del tableName COMPLETO, haciendo que dos tableNames que comparten
 * el mismo prefijo largo terminen en nombres de indice distintos.
 */
function buildIndexName(tableName: string): string {
  const PREFIX = 'idx_';
  const SUFFIX = '_embedding';
  const MAX_IDENTIFIER_LENGTH = 63;
  const HASH_LENGTH = 8;
  const available = MAX_IDENTIFIER_LENGTH - PREFIX.length - SUFFIX.length;

  if (tableName.length <= available) {
    return `${PREFIX}${tableName}${SUFFIX}`;
  }

  const hash = createHash('sha256').update(tableName).digest('hex').slice(0, HASH_LENGTH);
  const truncated = tableName.slice(0, available - HASH_LENGTH - 1);
  return `${PREFIX}${truncated}_${hash}${SUFFIX}`;
}

export class PgVectorStorageAdapter implements VectorStorageAdapter {
  private readonly client: PgClient;
  private readonly tableName: string;
  private readonly tableIdent: string;
  private readonly dimensions: number;
  private readonly distanceType: 'cosine' | 'l2' | 'inner_product';
  private readonly autoMigrate: boolean;
  private readonly createIndex: boolean;
  private readonly hnswOptions: { m: number; efConstruction: number };
  private initialized = false;

  constructor(config: PgVectorConfig) {
    this.client = config.client;
    this.tableName = config.tableName ?? 'vector_entries';
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(this.tableName)) {
      throw new Error(
        `Invalid tableName '${this.tableName}': must match ^[a-zA-Z_][a-zA-Z0-9_]{0,62}$ to be safely used as a SQL identifier`
      );
    }
    // Same reasoning as tableName above: these are interpolated directly
    // into DDL in initialize() (vector(${dimensions}), WITH (m = ...,
    // ef_construction = ...)) via the simple query protocol, which allows
    // multiple ';'-separated statements per call — an unvalidated numeric
    // config value from an untrusted source (this constructor is a public
    // export) is exactly as exploitable as the unvalidated tableName this
    // class already hardens against.
    if (!Number.isInteger(config.dimensions) || config.dimensions < 1 || config.dimensions > 4096) {
      throw new Error(`Invalid dimensions '${config.dimensions}': must be an integer between 1 and 4096`);
    }
    const m = config.hnswOptions?.m ?? 16;
    const efConstruction = config.hnswOptions?.efConstruction ?? 64;
    if (!Number.isInteger(m) || m < 1) {
      throw new Error(`Invalid hnswOptions.m '${m}': must be a positive integer`);
    }
    if (!Number.isInteger(efConstruction) || efConstruction < 1) {
      throw new Error(`Invalid hnswOptions.efConstruction '${efConstruction}': must be a positive integer`);
    }
    this.dimensions = config.dimensions;
    this.distanceType = config.distanceType ?? 'cosine';
    this.autoMigrate = config.autoMigrate ?? true;
    this.createIndex = config.createIndex ?? true;
    this.hnswOptions = { m, efConstruction };
    // Validated above against a strict identifier regex; double-quoted for reserved-word safety.
    this.tableIdent = `"${this.tableName}"`;
  }

  /** Inicializa el adapter: crea extension, tabla e indices si autoMigrate=true. */
  async initialize(): Promise<void> {
    if (!this.autoMigrate) {
      this.initialized = true;
      return;
    }

    await this.client.query('CREATE EXTENSION IF NOT EXISTS vector');

    await this.client.query(`
      CREATE TABLE IF NOT EXISTS ${this.tableIdent} (
        id TEXT PRIMARY KEY,
        embedding vector(${this.dimensions}),
        metadata JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    if (this.createIndex) {
      const opClass = this.getOpClass();
      const indexName = buildIndexName(this.tableName);
      await this.client.query(`
        CREATE INDEX IF NOT EXISTS ${indexName}
        ON ${this.tableIdent}
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
      `INSERT INTO ${this.tableIdent} (id, embedding, metadata, updated_at)
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
      `DELETE FROM ${this.tableIdent} WHERE id = $1`,
      [id]
    );
  }

  async deleteBatch(ids: string[]): Promise<BatchStorageResult> {
    this.ensureInitialized();
    if (ids.length === 0) return { success: 0, failed: 0 };

    const result = await this.client.query(
      `DELETE FROM ${this.tableIdent} WHERE id = ANY($1)`,
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
      FROM ${this.tableIdent}
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
      `SELECT id FROM ${this.tableIdent} ORDER BY id`
    );
    return result.rows.map(r => r.id);
  }

  async count(): Promise<number> {
    this.ensureInitialized();
    const result = await this.client.query(
      `SELECT COUNT(*) AS cnt FROM ${this.tableIdent}`
    );
    return parseInt(result.rows[0].cnt);
  }

  async clear(): Promise<void> {
    this.ensureInitialized();
    await this.client.query(`TRUNCATE ${this.tableIdent}`);
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

  /**
   * Convierte distancia a score de similaridad, acotado a [0, 1] — mismo
   * contrato (y mismo bug, encontrado independientemente) que
   * minimemory/vector-storage.ts ya corrige con un clamp en JS. Sin el
   * clamp: 'cosine' puede dar negativo (pgvector's <=> devuelve distancia
   * coseno en [0,2], asi que 1-distancia cae en [-1,1]), e 'inner_product'
   * no tiene cota superior en absoluto (es un dot product crudo, no
   * normalizado). 'l2' ya caia naturalmente en (0,1] sin necesitar esto,
   * pero envolverlo igual no cambia su resultado.
   *
   * Se aplica en SQL (no en JS despues del map de filas) porque
   * similarityExpr tambien se usa en el WHERE del filtro de threshold —
   * un clamp solo-en-JS habria dejado ese filtro comparando contra el
   * valor crudo sin acotar, inconsistente con el score que el caller
   * termina viendo.
   */
  private getSimilarityExpression(distanceExpr: string): string {
    let raw: string;
    switch (this.distanceType) {
      case 'cosine':
        raw = `1 - (${distanceExpr})`;
        break;
      case 'l2':
        raw = `1 / (1 + (${distanceExpr}))`;
        break;
      case 'inner_product':
        raw = `-(${distanceExpr})`;
        break;
    }
    return `GREATEST(0, LEAST(1, ${raw}))`;
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('PgVectorStorageAdapter not initialized. Call initialize() first.');
    }
  }
}
