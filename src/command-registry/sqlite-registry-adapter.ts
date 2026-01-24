/**
 * @module command-registry/sqlite-registry-adapter
 * @description SQLite persistence layer for CommandRegistry.
 *
 * Provides persistent storage of CommandDefinitions in SQLite, enabling
 * fast cold-start by loading definitions from disk instead of re-registering.
 * Handlers are NOT persisted (they must be re-attached programmatically).
 *
 * Accepts any database object satisfying the minimal SQLiteDatabase interface,
 * compatible with both `bun:sqlite` and `better-sqlite3` (zero external deps).
 */

import type { CommandDefinition } from './types.js';
import type { SQLiteDatabase } from '../context-store/sqlite-types.js';

const MIGRATIONS = `
CREATE TABLE IF NOT EXISTS commands (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    namespace       TEXT NOT NULL,
    name            TEXT NOT NULL,
    version         TEXT NOT NULL,
    description     TEXT NOT NULL,
    long_description TEXT,
    params          TEXT NOT NULL DEFAULT '[]',
    output_shape    TEXT NOT NULL DEFAULT '{}',
    example         TEXT NOT NULL DEFAULT '',
    tags            TEXT NOT NULL DEFAULT '[]',
    reversible      INTEGER NOT NULL DEFAULT 0,
    requires_confirmation INTEGER NOT NULL DEFAULT 0,
    deprecated      INTEGER NOT NULL DEFAULT 0,
    deprecated_message TEXT,
    required_permissions TEXT NOT NULL DEFAULT '[]',
    metadata        TEXT NOT NULL DEFAULT '{}',
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    UNIQUE (namespace, name, version)
);

CREATE INDEX IF NOT EXISTS idx_commands_ns_name ON commands(namespace, name);
CREATE INDEX IF NOT EXISTS idx_commands_namespace ON commands(namespace);
`;

/** Configuration for SQLiteRegistryAdapter. */
export interface SQLiteRegistryConfig {
  /** Database instance (bun:sqlite or better-sqlite3). */
  db: SQLiteDatabase;
  /** Whether to run migrations on initialize. Default: true. */
  autoMigrate?: boolean;
}

export class SQLiteRegistryAdapter {
  private readonly db: SQLiteDatabase;
  private migrated = false;
  private readonly autoMigrate: boolean;

  constructor(config: SQLiteRegistryConfig) {
    this.db = config.db;
    this.autoMigrate = config.autoMigrate ?? true;
  }

  /** Initialize the adapter (creates tables if needed). */
  initialize(): void {
    if (!this.migrated && this.autoMigrate) {
      this.db.exec(MIGRATIONS);
      this.migrated = true;
    }
  }

  /** Save a command definition to the database. Upserts on conflict. */
  save(definition: CommandDefinition): void {
    this.ensureMigrated();

    this.db.prepare(`
      INSERT INTO commands
        (namespace, name, version, description, long_description, params, output_shape, example, tags, reversible, requires_confirmation, deprecated, deprecated_message, required_permissions)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(namespace, name, version) DO UPDATE SET
        description = excluded.description,
        long_description = excluded.long_description,
        params = excluded.params,
        output_shape = excluded.output_shape,
        example = excluded.example,
        tags = excluded.tags,
        reversible = excluded.reversible,
        requires_confirmation = excluded.requires_confirmation,
        deprecated = excluded.deprecated,
        deprecated_message = excluded.deprecated_message,
        required_permissions = excluded.required_permissions,
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    `).run(
      definition.namespace,
      definition.name,
      definition.version,
      definition.description,
      definition.longDescription ?? null,
      JSON.stringify(definition.params),
      JSON.stringify(definition.output),
      definition.example,
      JSON.stringify(definition.tags),
      definition.reversible ? 1 : 0,
      definition.requiresConfirmation ? 1 : 0,
      definition.deprecated ? 1 : 0,
      definition.deprecatedMessage ?? null,
      JSON.stringify(definition.requiredPermissions ?? []),
    );
  }

  /** Save multiple command definitions in a single transaction. */
  saveBatch(definitions: CommandDefinition[]): void {
    this.ensureMigrated();
    const batchSave = this.db.transaction(() => {
      for (const def of definitions) {
        this.save(def);
      }
    });
    batchSave();
  }

  /** Load all command definitions from the database. */
  loadAll(): CommandDefinition[] {
    this.ensureMigrated();
    const rows = this.db.prepare('SELECT * FROM commands ORDER BY namespace, name, version').all() as any[];
    return rows.map(this.rowToDefinition);
  }

  /** Load command definitions by namespace. */
  loadByNamespace(namespace: string): CommandDefinition[] {
    this.ensureMigrated();
    const rows = this.db.prepare(
      'SELECT * FROM commands WHERE namespace = ? ORDER BY name, version'
    ).all(namespace) as any[];
    return rows.map(this.rowToDefinition);
  }

  /** Load a specific command definition. Returns null if not found. */
  loadOne(namespace: string, name: string, version?: string): CommandDefinition | null {
    this.ensureMigrated();
    let row: any;
    if (version) {
      row = this.db.prepare(
        'SELECT * FROM commands WHERE namespace = ? AND name = ? AND version = ?'
      ).get(namespace, name, version);
    } else {
      // Get latest version (by rowid desc, which correlates with insertion order)
      row = this.db.prepare(
        'SELECT * FROM commands WHERE namespace = ? AND name = ? ORDER BY id DESC LIMIT 1'
      ).get(namespace, name);
    }
    return row ? this.rowToDefinition(row) : null;
  }

  /** Delete a command definition from the database. */
  delete(namespace: string, name: string, version: string): boolean {
    this.ensureMigrated();
    const result = this.db.prepare(
      'DELETE FROM commands WHERE namespace = ? AND name = ? AND version = ?'
    ).run(namespace, name, version);
    return (result as any)?.changes > 0;
  }

  /** Get all unique namespaces. */
  getNamespaces(): string[] {
    this.ensureMigrated();
    const rows = this.db.prepare(
      'SELECT DISTINCT namespace FROM commands ORDER BY namespace'
    ).all() as any[];
    return rows.map((r: any) => r.namespace);
  }

  /** Get total count of commands. */
  count(): number {
    this.ensureMigrated();
    const row = this.db.prepare('SELECT COUNT(*) AS cnt FROM commands').get() as any;
    return row?.cnt ?? 0;
  }

  private ensureMigrated(): void {
    if (!this.migrated && this.autoMigrate) {
      this.db.exec(MIGRATIONS);
      this.migrated = true;
    }
  }

  private rowToDefinition(row: any): CommandDefinition {
    return {
      namespace: row.namespace,
      name: row.name,
      version: row.version,
      description: row.description,
      longDescription: row.long_description ?? undefined,
      params: JSON.parse(row.params),
      output: JSON.parse(row.output_shape),
      example: row.example,
      tags: JSON.parse(row.tags),
      reversible: row.reversible === 1,
      requiresConfirmation: row.requires_confirmation === 1,
      deprecated: row.deprecated === 1,
      deprecatedMessage: row.deprecated_message ?? undefined,
      requiredPermissions: JSON.parse(row.required_permissions),
    };
  }
}
