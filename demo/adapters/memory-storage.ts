/**
 * StorageAdapter in-memory para ContextStore.
 */

import type { StorageAdapter, SessionStore } from '../../src/context-store/types.js';

export class MemoryStorageAdapter implements StorageAdapter {
  readonly name = 'memory';
  private stores: Map<string, SessionStore> = new Map();

  async initialize(_sessionId: string): Promise<void> {}

  async load(sessionId: string): Promise<SessionStore | null> {
    return this.stores.get(sessionId) || null;
  }

  async save(sessionId: string, store: SessionStore): Promise<void> {
    this.stores.set(sessionId, structuredClone(store));
  }

  async destroy(sessionId: string): Promise<void> {
    this.stores.delete(sessionId);
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  async dispose(): Promise<void> {
    this.stores.clear();
  }
}
