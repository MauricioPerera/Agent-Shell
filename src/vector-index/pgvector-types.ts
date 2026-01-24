/**
 * @module vector-index/pgvector-types
 * @description Tipos para el adapter pgvector de Agent Shell.
 *
 * Define una interfaz minima de PostgreSQL que es compatible con
 * `pg` (node-postgres) y otras librerias Postgres.
 * El adapter no tiene dependencias runtime - acepta cualquier
 * cliente que satisfaga esta interfaz.
 */

/** Resultado de un query PostgreSQL. */
export interface PgQueryResult {
  rows: any[];
  rowCount: number | null;
}

/** Interfaz minima del cliente PostgreSQL. Compatible con `pg.Pool` y `pg.Client`. */
export interface PgClient {
  query(text: string, values?: any[]): Promise<PgQueryResult>;
}

/** Configuracion del adapter pgvector. */
export interface PgVectorConfig {
  /** Cliente PostgreSQL (Pool o Client de `pg`). */
  client: PgClient;
  /** Nombre de la tabla para almacenar vectores. Default: 'vector_entries'. */
  tableName?: string;
  /** Dimension de los vectores. Requerido para CREATE TABLE. */
  dimensions: number;
  /** Crear tabla automaticamente en initialize(). Default: true. */
  autoMigrate?: boolean;
  /** Tipo de distancia para busquedas. Default: 'cosine'. */
  distanceType?: 'cosine' | 'l2' | 'inner_product';
  /** Crear indice HNSW automaticamente. Default: true. */
  createIndex?: boolean;
  /** Parametros del indice HNSW. */
  hnswOptions?: {
    m?: number;
    efConstruction?: number;
  };
}
