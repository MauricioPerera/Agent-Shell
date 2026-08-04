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

  // Regresion (ronda 78 del audit, MEDIUM): load()/save() pasaban la
  // MISMA referencia de objeto que este adapter guarda internamente — a
  // diferencia de SQLiteStorageAdapter/EncryptedStorageAdapter (que hacen
  // un round-trip de (de)serializacion en cada load()/save(), rompiendo
  // cualquier aliasing por construccion), este adapter es puro JS en
  // memoria: sin clonar, un caller que muta el objeto devuelto por get()/
  // getAll() (o cualquier consumidor externo de la libreria que use este
  // adapter directamente) corrompe el estado "persistido" de la sesion
  // sin pasar nunca por set()/save(). structuredClone() corta esa
  // referencia compartida en ambas direcciones, igualando el
  // comportamiento observable al de los otros dos adapters.
  async load(session_id: string): Promise<SessionStore | null> {
    const stored = this.stores.get(session_id);
    return stored ? structuredClone(stored) : null;
  }

  async save(session_id: string, store: SessionStore): Promise<void> {
    if (!this.stores.has(session_id)) this.evictIfFull();
    this.stores.set(session_id, structuredClone(store));
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
