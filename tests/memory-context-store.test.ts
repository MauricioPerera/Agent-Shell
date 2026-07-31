/**
 * Tests for InMemoryStorageAdapter and SessionScopedContextStore — the
 * dependency-free ContextStore backend and the per-session wrapper that
 * makes it safe to plug into Core.contextStore for both stdio (single
 * caller) and HTTP (concurrent callers).
 *
 * Regression this covers: Core.executeContext() never threaded sessionId
 * through, so plugging one shared ContextStore instance into Core would
 * have leaked one HTTP caller's context into every other caller's
 * context:get. SessionScopedContextStore fixes this by keeping one
 * ContextStore per session_id (mirroring WorkspaceSessionStore in
 * src/skills/workspace.ts). CoreContextStore's interface was also
 * synchronous while the real ContextStore is fully async — Core now awaits
 * every call.
 */

import { describe, it, expect } from 'vitest';
import { InMemoryStorageAdapter } from '../src/context-store/memory-storage-adapter.js';
import { SessionScopedContextStore } from '../src/context-store/session-scoped-context-store.js';
import { ContextStore } from '../src/context-store/index.js';
import { Core } from '../src/core/index.js';
import type { SessionStore } from '../src/context-store/types.js';

function createSampleStore(): SessionStore {
  return {
    context: {
      entries: {
        theme: { key: 'theme', value: 'dark', type: 'string', set_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', version: 1 },
      },
    },
    history: [],
    undo_snapshots: [],
  };
}

// ===========================================================================
// InMemoryStorageAdapter
// ===========================================================================

describe('InMemoryStorageAdapter', () => {
  it('IM01: load retorna null para sesion inexistente', async () => {
    const adapter = new InMemoryStorageAdapter();
    expect(await adapter.load('nope')).toBeNull();
  });

  it('IM02: initialize crea una sesion vacia, no duplica en llamadas repetidas', async () => {
    const adapter = new InMemoryStorageAdapter();
    await adapter.initialize('sess-1');
    const first = await adapter.load('sess-1');
    expect(first).not.toBeNull();
    expect(first!.context.entries).toEqual({});

    await adapter.initialize('sess-1');
    const second = await adapter.load('sess-1');
    expect(second!.createdAt).toBe(first!.createdAt);
  });

  it('IM03: save y load roundtrip', async () => {
    const adapter = new InMemoryStorageAdapter();
    const store = createSampleStore();
    await adapter.save('sess-1', store);
    const loaded = await adapter.load('sess-1');
    expect(loaded!.context.entries.theme.value).toBe('dark');
  });

  it('IM04: multiples sesiones son independientes', async () => {
    const adapter = new InMemoryStorageAdapter();
    await adapter.save('sess-A', createSampleStore());
    expect(await adapter.load('sess-B')).toBeNull();
    expect((await adapter.load('sess-A'))!.context.entries.theme.value).toBe('dark');
  });

  it('IM05: destroy elimina la sesion', async () => {
    const adapter = new InMemoryStorageAdapter();
    await adapter.save('sess-1', createSampleStore());
    await adapter.destroy('sess-1');
    expect(await adapter.load('sess-1')).toBeNull();
  });

  it('IM06: healthCheck siempre retorna true', async () => {
    const adapter = new InMemoryStorageAdapter();
    expect(await adapter.healthCheck()).toBe(true);
  });

  it('IM07: dispose limpia todas las sesiones', async () => {
    const adapter = new InMemoryStorageAdapter();
    await adapter.save('sess-1', createSampleStore());
    await adapter.dispose();
    expect(await adapter.load('sess-1')).toBeNull();
  });

  it('IM08: funciona como StorageAdapter real de ContextStore (set/get/delete)', async () => {
    const adapter = new InMemoryStorageAdapter();
    const store = new ContextStore(adapter, 'sess-1');

    const setRes = await store.set('project', '"my-app"');
    expect(setRes.status).toBe(0);

    const getRes = await store.get('project');
    expect(getRes.data.value).toBe('my-app');

    const delRes = await store.delete('project');
    expect(delRes.status).toBe(0);

    const afterDelete = await store.get('project');
    expect(afterDelete.error?.code).toBe('KEY_NOT_FOUND');
  });

  /**
   * Regresion: sin bound, un caller cycleando session ids podia crecer el
   * Map sin limite — mismo razonamiento que MAX_SESSIONS en
   * WorkspaceSessionStore (src/skills/workspace.ts).
   */
  it('IM09: acota la cantidad de sesiones en memoria (evict LRU-ish)', async () => {
    const adapter = new InMemoryStorageAdapter();
    for (let i = 0; i < 205; i++) {
      await adapter.initialize(`sess-${i}`);
    }
    // The earliest sessions should have been evicted.
    expect(await adapter.load('sess-0')).toBeNull();
    // The most recent ones should still be present.
    expect(await adapter.load('sess-204')).not.toBeNull();
  });
});

// ===========================================================================
// SessionScopedContextStore
// ===========================================================================

describe('SessionScopedContextStore', () => {
  it('SC01: set + get roundtrip para una sesion', async () => {
    const scoped = new SessionScopedContextStore(new InMemoryStorageAdapter());
    await scoped.set('key', '"value"', 'sess-1');
    const result = await scoped.get('key', 'sess-1');
    expect(result.data.value).toBe('value');
  });

  it('SC02: dos sessionId distintos no ven el contexto del otro', async () => {
    const scoped = new SessionScopedContextStore(new InMemoryStorageAdapter());
    await scoped.set('secret', '"from-A"', 'sess-A');
    await scoped.set('secret', '"from-B"', 'sess-B');

    const resultA = await scoped.get('secret', 'sess-A');
    const resultB = await scoped.get('secret', 'sess-B');

    expect(resultA.data.value).toBe('from-A');
    expect(resultB.data.value).toBe('from-B');
  });

  it('SC03: delete en una sesion no afecta a otra', async () => {
    const scoped = new SessionScopedContextStore(new InMemoryStorageAdapter());
    await scoped.set('key', '"val"', 'sess-A');
    await scoped.set('key', '"val"', 'sess-B');

    await scoped.delete('key', 'sess-A');

    const resultA = await scoped.get('key', 'sess-A');
    const resultB = await scoped.get('key', 'sess-B');
    expect(resultA.error?.code).toBe('KEY_NOT_FOUND');
    expect(resultB.data.value).toBe('val');
  });

  it('SC04: getAll refleja solo las entradas de la sesion pedida', async () => {
    const scoped = new SessionScopedContextStore(new InMemoryStorageAdapter());
    await scoped.set('a', '1', 'sess-A');
    await scoped.set('b', '2', 'sess-B');

    const allA = await scoped.getAll('sess-A');
    const allB = await scoped.getAll('sess-B');
    expect(allA.data).toEqual({ a: 1 });
    expect(allB.data).toEqual({ b: 2 });
  });

  it('SC05: sessionId undefined usa una sesion default compartida (stdio)', async () => {
    const scoped = new SessionScopedContextStore(new InMemoryStorageAdapter());
    await scoped.set('key', '"stdio-value"');
    const result = await scoped.get('key');
    expect(result.data.value).toBe('stdio-value');
  });
});

// ===========================================================================
// Integracion end-to-end via Core
// ===========================================================================

function createMockRegistry() {
  return { get: () => ({ ok: false, error: { code: 'NOT_FOUND', message: 'not found' } }) };
}

describe('Core + SessionScopedContextStore (integracion end-to-end)', () => {
  it('CT01: context:set + context:get persisten via Core con sessionId', async () => {
    const core = new Core({
      registry: createMockRegistry() as any,
      contextStore: new SessionScopedContextStore(new InMemoryStorageAdapter()),
    });

    const setRes = await core.exec('context:set project my-app', 'session-1');
    expect(setRes.code).toBe(0);

    const getRes = await core.exec('context:get project', 'session-1');
    expect(getRes.code).toBe(0);
    expect(getRes.data.value).toBe('my-app');
  });

  it('CT02: context:delete elimina el valor', async () => {
    const core = new Core({
      registry: createMockRegistry() as any,
      contextStore: new SessionScopedContextStore(new InMemoryStorageAdapter()),
    });

    await core.exec('context:set temp value', 'session-1');
    const delRes = await core.exec('context:delete temp', 'session-1');
    expect(delRes.code).toBe(0);

    const getRes = await core.exec('context:get temp', 'session-1');
    expect(getRes.code).toBe(2);
  });

  /**
   * Regresion central: dos sessionId distintos pasados a core.exec() no
   * deben ver el contexto del otro — antes de este fix, executeContext()
   * ignoraba sessionId por completo y todo caller compartia una unica
   * instancia de ContextStore.
   */
  it('CT03: dos sessionId distintos estan aislados via Core.exec()', async () => {
    const core = new Core({
      registry: createMockRegistry() as any,
      contextStore: new SessionScopedContextStore(new InMemoryStorageAdapter()),
    });

    await core.exec('context:set secret from-session-A', 'session-A');
    await core.exec('context:set secret from-session-B', 'session-B');

    const resA = await core.exec('context:get secret', 'session-A');
    const resB = await core.exec('context:get secret', 'session-B');

    expect(resA.data.value).toBe('from-session-A');
    expect(resB.data.value).toBe('from-session-B');
  });

  it('CT04: el builtin "context" (bare) refleja solo la sesion del caller', async () => {
    const core = new Core({
      registry: createMockRegistry() as any,
      contextStore: new SessionScopedContextStore(new InMemoryStorageAdapter()),
    });

    await core.exec('context:set onlyA valueA', 'session-A');
    await core.exec('context:set onlyB valueB', 'session-B');

    const contextA = await core.exec('context', 'session-A');
    const contextB = await core.exec('context', 'session-B');

    expect(contextA.data).toEqual({ onlyA: 'valueA' });
    expect(contextB.data).toEqual({ onlyB: 'valueB' });
  });

  it('CT05: sin contextStore configurado, context:get retorna error claro', async () => {
    const core = new Core({ registry: createMockRegistry() as any });
    const res = await core.exec('context:get anything');
    expect(res.code).toBe(1);
    expect(res.error).toContain('Context store not available');
  });
});
