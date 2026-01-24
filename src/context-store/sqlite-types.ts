/**
 * @module context-store/sqlite-types
 * @description Minimal database interface for SQLite adapters.
 *
 * Compatible with both `bun:sqlite` (Database) and `better-sqlite3`.
 * The adapter accepts any object satisfying this interface, maintaining
 * zero external dependencies.
 */

/** Minimal prepared statement interface. */
export interface SQLiteStatement {
  run(...params: any[]): any;
  get(...params: any[]): any;
  all(...params: any[]): any[];
}

/** Minimal database interface satisfied by bun:sqlite and better-sqlite3. */
export interface SQLiteDatabase {
  prepare(sql: string): SQLiteStatement;
  exec(sql: string): void;
  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T;
}

/** Configuration for SQLiteStorageAdapter. */
export interface SQLiteStorageConfig {
  /** Database instance (bun:sqlite or better-sqlite3). */
  db: SQLiteDatabase;
  /** Whether to run migrations on initialize. Default: true. */
  autoMigrate?: boolean;
}
