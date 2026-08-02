/**
 * @module context-store/session-scoped-context-store
 * @description Adapts ContextStore (session_id fixed at construction time)
 * to Core's CoreContextStore interface (session_id passed per call).
 *
 * Regression this fixes: Core.executeContext() never threaded the caller's
 * sessionId through to contextStore.get/set/delete — plugging one shared
 * ContextStore instance into Core would have let one HTTP caller's context
 * leak into every other concurrent caller's context:get (the same
 * cross-tenant bug already fixed for workspace:* — see
 * src/skills/workspace.ts's WorkspaceSessionStore). This class keeps one
 * lazily-created ContextStore per session_id instead, all sharing the same
 * underlying StorageAdapter (which is itself already session_id-keyed, so
 * sharing it across sessions is safe and avoids allocating a redundant
 * per-session backend).
 */

import { ContextStore } from './index.js';
import type { StorageAdapter, ContextStoreConfig } from './types.js';

const MAX_SESSIONS = 200;
const DEFAULT_SESSION = '__default__';

/** Result shape matching Core's CoreContextStore interface. */
interface ContextStoreResult {
  data?: any;
  error?: { code: string; message: string };
}

export class SessionScopedContextStore {
  private readonly stores = new Map<string, Promise<ContextStore>>();

  constructor(
    private readonly adapter: StorageAdapter,
    private readonly config?: ContextStoreConfig,
    /**
     * Called the first time a genuinely new, caller-supplied sessionId is
     * seen at this layer (i.e. a per-session ContextStore is actually
     * allocated) — never for the shared DEFAULT_SESSION bucket stdio/
     * library callers fall back to, since that bucket isn't a real
     * per-tenant session. Previously nothing observed this: AGENT_PROFILES-
     * documented session:created had zero emit sites anywhere in src/.
     */
    private readonly onSessionCreated?: (sessionId: string) => void,
  ) {}

  async get(key: string, sessionId?: string): Promise<ContextStoreResult> {
    const store = await this.getStore(sessionId);
    const result = await store.get(key);
    return { data: result.data, error: result.error };
  }

  async set(key: string, value: any, sessionId?: string): Promise<ContextStoreResult> {
    const store = await this.getStore(sessionId);
    const result = await store.set(key, value);
    return { data: result.data, error: result.error };
  }

  async delete(key: string, sessionId?: string): Promise<ContextStoreResult> {
    const store = await this.getStore(sessionId);
    const result = await store.delete(key);
    return { data: result.data, error: result.error };
  }

  async getAll(sessionId?: string): Promise<ContextStoreResult> {
    const store = await this.getStore(sessionId);
    const result = await store.getAll();
    return { data: result.data, error: result.error };
  }

  /**
   * Undefined/no sessionId maps to one shared DEFAULT_SESSION bucket —
   * correct for stdio (one agent per process, no cross-tenant risk) and any
   * direct/library caller that predates session scoping. A real sessionId
   * (HttpSseTransport always supplies one) gets its own isolated instance.
   */
  private getStore(sessionId?: string): Promise<ContextStore> {
    const key = sessionId || DEFAULT_SESSION;
    let storePromise = this.stores.get(key);
    if (!storePromise) {
      // Bound the map BEFORE inserting — same reasoning as
      // WorkspaceSessionStore in src/skills/workspace.ts.
      if (this.stores.size >= MAX_SESSIONS) {
        const oldestKey = this.stores.keys().next().value;
        if (oldestKey !== undefined) this.stores.delete(oldestKey);
      }
      // Regresion (ronda 41 del audit, MEDIUM-HIGH): la version anterior
      // era un check-then-act async ("let store = map.get(key); if (!store)
      // { await adapter.initialize(key); store = new ContextStore(...);
      // map.set(key, store); }") — dos llamadas concurrentes para el MISMO
      // sessionId nuevo ven ambas store===undefined, ambas construyen su
      // propio ContextStore, y la segunda pisa a la primera en el map
      // (lost update; con InMemoryStorageAdapter el bug queda mudo porque
      // el objeto subyacente es compartido, pero con SQLite/Encrypted -que
      // hacen un round-trip JSON completo sin referencia compartida- es un
      // lost-update real). Fix: cachear la PROMESA en el map de forma
      // sincrona ANTES de cualquier await, para que la segunda llamada
      // concurrente encuentre la promesa ya en curso en vez de arrancar
      // su propia construccion.
      storePromise = (async () => {
        await this.adapter.initialize(key);
        return new ContextStore(this.adapter, key, this.config);
      })();
      // Si initialize()/construccion falla, no dejar la promesa rechazada
      // envenenando el map para siempre — permitir que una llamada futura
      // reintente en vez de heredar el mismo rechazo indefinidamente.
      storePromise.catch(() => {
        if (this.stores.get(key) === storePromise) this.stores.delete(key);
      });
      this.stores.set(key, storePromise);
      if (sessionId !== undefined) this.onSessionCreated?.(sessionId);
    }
    return storePromise;
  }
}
