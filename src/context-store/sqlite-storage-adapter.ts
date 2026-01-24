/**
 * @module context-store/sqlite-storage-adapter
 * @description SQLite-backed StorageAdapter for the ContextStore.
 *
 * Uses a relational schema (session_context, command_history, undo_snapshots, sessions)
 * instead of serializing the full SessionStore as a blob. This enables SQL queries
 * against session data and efficient partial updates.
 *
 * Accepts any database object satisfying the minimal SQLiteDatabase interface,
 * compatible with both `bun:sqlite` and `better-sqlite3` (zero external deps).
 */

import type { StorageAdapter, SessionStore, ContextEntry, HistoryEntry, UndoSnapshot } from './types.js';
import type { SQLiteDatabase, SQLiteStorageConfig } from './sqlite-types.js';

const MIGRATIONS = `
CREATE TABLE IF NOT EXISTS sessions (
    session_id      TEXT PRIMARY KEY,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    last_access_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    status          TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS session_context (
    session_id      TEXT NOT NULL,
    key             TEXT NOT NULL,
    value           TEXT NOT NULL,
    value_type      TEXT NOT NULL DEFAULT 'string',
    version         INTEGER NOT NULL DEFAULT 1,
    set_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    PRIMARY KEY (session_id, key)
);

CREATE TABLE IF NOT EXISTS command_history (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL,
    command_id      TEXT NOT NULL,
    command_raw     TEXT NOT NULL,
    namespace       TEXT NOT NULL DEFAULT '',
    args            TEXT NOT NULL DEFAULT '{}',
    exit_code       INTEGER NOT NULL DEFAULT 0,
    duration_ms     INTEGER NOT NULL DEFAULT 0,
    result_summary  TEXT NOT NULL DEFAULT '',
    undoable        INTEGER NOT NULL DEFAULT 0,
    undo_status     TEXT DEFAULT NULL,
    snapshot_id     TEXT DEFAULT NULL,
    executed_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    UNIQUE (session_id, command_id)
);

CREATE TABLE IF NOT EXISTS undo_snapshots (
    id              TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL,
    command_id      TEXT NOT NULL,
    state_before    TEXT NOT NULL DEFAULT '{}',
    rollback_command TEXT DEFAULT NULL,
    metadata        TEXT NOT NULL DEFAULT '{}',
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_context_session ON session_context(session_id);
CREATE INDEX IF NOT EXISTS idx_history_session ON command_history(session_id, executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_snapshots_session ON undo_snapshots(session_id);
`;

export class SQLiteStorageAdapter implements StorageAdapter {
  readonly name = 'sqlite';
  private readonly db: SQLiteDatabase;
  private readonly autoMigrate: boolean;
  private migrated = false;

  constructor(config: SQLiteStorageConfig) {
    this.db = config.db;
    this.autoMigrate = config.autoMigrate ?? true;
  }

  async initialize(session_id: string): Promise<void> {
    if (!this.migrated && this.autoMigrate) {
      this.runMigrations();
      this.migrated = true;
    }

    const existing = this.db.prepare(
      'SELECT session_id FROM sessions WHERE session_id = ?'
    ).get(session_id);

    if (!existing) {
      const now = new Date().toISOString();
      this.db.prepare(
        'INSERT INTO sessions (session_id, created_at, last_access_at, status) VALUES (?, ?, ?, ?)'
      ).run(session_id, now, now, 'active');
    }
  }

  async load(session_id: string): Promise<SessionStore | null> {
    if (!this.migrated && this.autoMigrate) {
      this.runMigrations();
      this.migrated = true;
    }

    const session = this.db.prepare(
      'SELECT * FROM sessions WHERE session_id = ?'
    ).get(session_id) as any;

    if (!session) return null;

    // Update last_access_at
    this.db.prepare(
      'UPDATE sessions SET last_access_at = ? WHERE session_id = ?'
    ).run(new Date().toISOString(), session_id);

    // Load context entries
    const contextRows = this.db.prepare(
      'SELECT * FROM session_context WHERE session_id = ?'
    ).all(session_id) as any[];

    const entries: Record<string, ContextEntry> = {};
    for (const row of contextRows) {
      entries[row.key] = {
        key: row.key,
        value: JSON.parse(row.value),
        type: row.value_type,
        set_at: row.set_at,
        updated_at: row.updated_at,
        version: row.version,
      };
    }

    // Load history
    const historyRows = this.db.prepare(
      'SELECT * FROM command_history WHERE session_id = ? ORDER BY executed_at ASC'
    ).all(session_id) as any[];

    const history: HistoryEntry[] = historyRows.map((row: any) => ({
      id: row.command_id,
      command: row.command_raw,
      namespace: row.namespace,
      args: JSON.parse(row.args),
      executed_at: row.executed_at,
      duration_ms: row.duration_ms,
      exit_code: row.exit_code,
      result_summary: row.result_summary,
      undoable: row.undoable === 1,
      undo_status: row.undo_status,
      snapshot_id: row.snapshot_id,
    }));

    // Load undo snapshots
    const snapshotRows = this.db.prepare(
      'SELECT * FROM undo_snapshots WHERE session_id = ? ORDER BY created_at ASC'
    ).all(session_id) as any[];

    const undo_snapshots: UndoSnapshot[] = snapshotRows.map((row: any) => ({
      id: row.id,
      command_id: row.command_id,
      created_at: row.created_at,
      state_before: JSON.parse(row.state_before),
      rollback_command: row.rollback_command,
      metadata: JSON.parse(row.metadata),
    }));

    return {
      context: { entries },
      history,
      undo_snapshots,
      createdAt: session.created_at,
      lastAccessAt: session.last_access_at,
    };
  }

  async save(session_id: string, store: SessionStore): Promise<void> {
    if (!this.migrated && this.autoMigrate) {
      this.runMigrations();
      this.migrated = true;
    }

    const saveTransaction = this.db.transaction(() => {
      // Upsert session
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO sessions (session_id, created_at, last_access_at, status)
        VALUES (?, ?, ?, 'active')
        ON CONFLICT(session_id) DO UPDATE SET last_access_at = ?
      `).run(session_id, store.createdAt ?? now, now, now);

      // Replace context entries
      this.db.prepare('DELETE FROM session_context WHERE session_id = ?').run(session_id);
      const insertContext = this.db.prepare(`
        INSERT INTO session_context (session_id, key, value, value_type, version, set_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const [key, entry] of Object.entries(store.context.entries)) {
        insertContext.run(
          session_id,
          key,
          JSON.stringify(entry.value),
          entry.type,
          entry.version,
          entry.set_at ?? now,
          entry.updated_at ?? now,
        );
      }

      // Replace history
      this.db.prepare('DELETE FROM command_history WHERE session_id = ?').run(session_id);
      const insertHistory = this.db.prepare(`
        INSERT INTO command_history
          (session_id, command_id, command_raw, namespace, args, exit_code, duration_ms, result_summary, undoable, undo_status, snapshot_id, executed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const entry of store.history) {
        insertHistory.run(
          session_id,
          entry.id,
          entry.command,
          entry.namespace,
          JSON.stringify(entry.args),
          entry.exit_code,
          entry.duration_ms,
          entry.result_summary,
          entry.undoable ? 1 : 0,
          entry.undo_status,
          entry.snapshot_id,
          entry.executed_at,
        );
      }

      // Replace snapshots
      this.db.prepare('DELETE FROM undo_snapshots WHERE session_id = ?').run(session_id);
      const insertSnapshot = this.db.prepare(`
        INSERT INTO undo_snapshots (id, session_id, command_id, state_before, rollback_command, metadata, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const snap of store.undo_snapshots) {
        insertSnapshot.run(
          snap.id,
          session_id,
          snap.command_id,
          JSON.stringify(snap.state_before),
          snap.rollback_command,
          JSON.stringify(snap.metadata),
          snap.created_at,
        );
      }
    });

    saveTransaction();
  }

  async destroy(session_id: string): Promise<void> {
    const destroyTransaction = this.db.transaction(() => {
      this.db.prepare('DELETE FROM undo_snapshots WHERE session_id = ?').run(session_id);
      this.db.prepare('DELETE FROM command_history WHERE session_id = ?').run(session_id);
      this.db.prepare('DELETE FROM session_context WHERE session_id = ?').run(session_id);
      this.db.prepare('DELETE FROM sessions WHERE session_id = ?').run(session_id);
    });
    destroyTransaction();
  }

  async healthCheck(): Promise<boolean> {
    try {
      const result = this.db.prepare('SELECT 1 AS ok').get() as any;
      return result?.ok === 1;
    } catch {
      return false;
    }
  }

  async dispose(): Promise<void> {
    // No-op: the caller owns the database instance lifecycle
  }

  private runMigrations(): void {
    this.db.exec(MIGRATIONS);
  }
}
