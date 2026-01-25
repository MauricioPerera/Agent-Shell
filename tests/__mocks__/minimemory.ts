/**
 * Mock del binding nativo minimemory (napi-rs).
 *
 * Este mock simula el VectorDB con un Map en memoria,
 * exponiendo la misma API que el binding real.
 *
 * Para usar en tests, importar y configurar:
 *   import { VectorDB, _getMockState } from 'minimemory';
 */

import { vi } from 'vitest';

// Estado global mutable - cada instancia de VectorDB comparte este mock state
let _currentInstance: any = null;
let _currentStore: Map<string, { vector: number[]; meta: Record<string, any> }> = new Map();

function createInstance(config: any) {
  const store = new Map<string, { vector: number[]; meta: Record<string, any> }>();
  _currentStore = store;

  const instance: any = {
    _config: config,
    insert: vi.fn((id: string, vector: number[], meta: any) => {
      store.set(id, { vector, meta });
    }),
    update: vi.fn((id: string, vector: number[], meta: any) => {
      store.set(id, { vector, meta });
    }),
    delete: vi.fn((id: string) => {
      store.delete(id);
    }),
    contains: vi.fn((id: string) => store.has(id)),
    get: vi.fn((id: string) => store.get(id)),
    search: vi.fn((vector: number[], topK: number) => {
      return [...store.entries()]
        .slice(0, topK)
        .map(([id, data]) => ({
          id,
          distance: 0.1,
          metadata: data.meta,
        }));
    }),
    list_ids: vi.fn(() => [...store.keys()]),
    len: vi.fn(() => store.size),
    save: vi.fn(),
    load: vi.fn(),
    has_fulltext: vi.fn(() => false),
  };

  _currentInstance = instance;
  return instance;
}

export const VectorDB = vi.fn((config: any) => createInstance(config));

/** Access the current mock instance for assertions in tests */
export function _getMockInstance(): any {
  return _currentInstance;
}

/** Access the current mock store for assertions in tests */
export function _getMockStore(): Map<string, { vector: number[]; meta: Record<string, any> }> {
  return _currentStore;
}

/** Reset the mock state (use in beforeEach) */
export function _resetMock(): void {
  _currentInstance = null;
  _currentStore = new Map();
  VectorDB.mockClear();
}
