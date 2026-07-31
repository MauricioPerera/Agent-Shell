/**
 * @module context-store/memory-storage-adapter
 * @description In-memory StorageAdapter for ContextStore — the
 * dependency-free default backend (no real database required).
 *
 * Data does not survive process restarts. For persistence, use
 * SQLiteStorageAdapter instead.
 */

import type { StorageAdapter, SessionStore } from './types.js';

/**
 * Bounds how many distinct sessions this adapter holds in memory. Without a
 * cap, a caller cycling through session ids (accidentally or maliciously)
 * could grow this without limit — same reasoning as WorkspaceSessionStore's
 * MAX_SESSIONS in src/skills/workspace.ts.
 */
const MAX_SESSIONS = 200;

export class InMemoryStorageAdapter implements StorageAdapter {
  readonly name = 'memory';
  private readonly stores = new Map<string, SessionStore>();

  async initialize(session_id: string): Promise<void> {
    if (!this.stores.has(session_id)) {
      this.evictIfFull();
      const now = new Date().toISOString();
      this.stores.set(session_id, {
        context: { entries: {} },
        history: [],
        undo_snapshots: [],
        createdAt: now,
        lastAccessAt: now,
      });
    }
  }

  async load(session_id: string): Promise<SessionStore | null> {
    return this.stores.get(session_id) ?? null;
  }

  async save(session_id: string, store: SessionStore): Promise<void> {
    if (!this.stores.has(session_id)) this.evictIfFull();
    this.stores.set(session_id, store);
  }

  async destroy(session_id: string): Promise<void> {
    this.stores.delete(session_id);
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  async dispose(): Promise<void> {
    this.stores.clear();
  }

  // Evicts the oldest entry — Map iteration order is insertion order.
  private evictIfFull(): void {
    if (this.stores.size >= MAX_SESSIONS) {
      const oldestKey = this.stores.keys().next().value;
      if (oldestKey !== undefined) this.stores.delete(oldestKey);
    }
  }
}
