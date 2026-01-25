/**
 * @module tests/minimemory-native
 * @description Tests for the native minimemory integration in src/minimemory/
 *
 * Tests the factory function, availability detection, and fallback behavior.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MiniMemoryBinding } from '../src/minimemory/types.js';

// Mock the minimemory binding
function createMockBinding(): MiniMemoryBinding {
  const store = new Map<string, { vector: number[]; meta: Record<string, unknown> }>();

  return {
    VectorDB: vi.fn().mockImplementation(() => ({
      insert: vi.fn((id: string, vector: number[], meta: Record<string, unknown>) => {
        store.set(id, { vector, meta });
      }),
      update: vi.fn((id: string, vector: number[], meta: Record<string, unknown>) => {
        store.set(id, { vector, meta });
      }),
      delete: vi.fn((id: string) => {
        store.delete(id);
      }),
      contains: vi.fn((id: string) => store.has(id)),
      get: vi.fn((id: string) => store.get(id) || null),
      search: vi.fn((vector: number[], topK: number) => {
        const results = Array.from(store.entries()).slice(0, topK).map(([id, data]) => ({
          id,
          distance: 0.1,
          metadata: data.meta,
        }));
        return results;
      }),
      list_ids: vi.fn(() => Array.from(store.keys())),
      len: vi.fn(() => store.size),
      has_fulltext: vi.fn(() => false),
      save: vi.fn(),
      load: vi.fn(),
    })),
  };
}

describe('minimemory native integration', () => {
  describe('MiniMemoryVectorStorage', () => {
    it('T01: creates instance with provided binding', async () => {
      const { MiniMemoryVectorStorage } = await import('../src/minimemory/vector-storage.js');
      const binding = createMockBinding();

      const storage = new MiniMemoryVectorStorage(
        { dimensions: 768, distance: 'cosine', indexType: 'hnsw' },
        binding
      );

      expect(storage).toBeDefined();
      expect(binding.VectorDB).toHaveBeenCalledWith({
        dimensions: 768,
        distance: 'cosine',
        index_type: 'hnsw',
        hnsw_m: 16,
        hnsw_ef_construction: 200,
      });
    });

    it('T02: upsert stores entry correctly', async () => {
      const { MiniMemoryVectorStorage } = await import('../src/minimemory/vector-storage.js');
      const binding = createMockBinding();

      const storage = new MiniMemoryVectorStorage({ dimensions: 3 }, binding);

      await storage.upsert({
        id: 'test-1',
        vector: [0.1, 0.2, 0.3],
        metadata: { namespace: 'test', command: 'cmd', description: 'desc', signature: '', parameters: [], tags: [], indexedAt: '', version: '1.0.0' },
      });

      const count = await storage.count();
      expect(count).toBe(1);
    });

    it('T03: search returns results with score', async () => {
      const { MiniMemoryVectorStorage } = await import('../src/minimemory/vector-storage.js');
      const binding = createMockBinding();

      const storage = new MiniMemoryVectorStorage({ dimensions: 3 }, binding);

      await storage.upsert({
        id: 'test-1',
        vector: [0.1, 0.2, 0.3],
        metadata: { namespace: 'test', command: 'cmd', description: 'desc', signature: '', parameters: [], tags: [], indexedAt: '', version: '1.0.0' },
      });

      const results = await storage.search({
        vector: [0.1, 0.2, 0.3],
        topK: 5,
      });

      expect(results.length).toBe(1);
      expect(results[0].id).toBe('test-1');
      expect(results[0].score).toBe(0.9); // 1 - 0.1 distance
    });

    it('T04: healthCheck returns healthy status', async () => {
      const { MiniMemoryVectorStorage } = await import('../src/minimemory/vector-storage.js');
      const binding = createMockBinding();

      const storage = new MiniMemoryVectorStorage({ dimensions: 768 }, binding);
      const health = await storage.healthCheck();

      expect(health.status).toBe('healthy');
      expect(health.details).toContain('minimemory HNSW');
    });

    it('T05: delete removes entry', async () => {
      const { MiniMemoryVectorStorage } = await import('../src/minimemory/vector-storage.js');
      const binding = createMockBinding();

      const storage = new MiniMemoryVectorStorage({ dimensions: 3 }, binding);

      await storage.upsert({
        id: 'test-1',
        vector: [0.1, 0.2, 0.3],
        metadata: { namespace: 'test', command: 'cmd', description: 'desc', signature: '', parameters: [], tags: [], indexedAt: '', version: '1.0.0' },
      });

      expect(await storage.count()).toBe(1);

      await storage.delete('test-1');

      expect(await storage.count()).toBe(0);
    });

    it('T06: clear removes all entries', async () => {
      const { MiniMemoryVectorStorage } = await import('../src/minimemory/vector-storage.js');
      const binding = createMockBinding();

      const storage = new MiniMemoryVectorStorage({ dimensions: 3 }, binding);

      await storage.upsert({
        id: 'test-1',
        vector: [0.1, 0.2, 0.3],
        metadata: { namespace: 'test', command: 'cmd', description: 'desc', signature: '', parameters: [], tags: [], indexedAt: '', version: '1.0.0' },
      });
      await storage.upsert({
        id: 'test-2',
        vector: [0.4, 0.5, 0.6],
        metadata: { namespace: 'test', command: 'cmd2', description: 'desc2', signature: '', parameters: [], tags: [], indexedAt: '', version: '1.0.0' },
      });

      expect(await storage.count()).toBe(2);

      await storage.clear();

      expect(await storage.count()).toBe(0);
    });

    it('T07: listIds returns all stored IDs', async () => {
      const { MiniMemoryVectorStorage } = await import('../src/minimemory/vector-storage.js');
      const binding = createMockBinding();

      const storage = new MiniMemoryVectorStorage({ dimensions: 3 }, binding);

      await storage.upsert({
        id: 'test-1',
        vector: [0.1, 0.2, 0.3],
        metadata: { namespace: 'test', command: 'cmd', description: 'desc', signature: '', parameters: [], tags: [], indexedAt: '', version: '1.0.0' },
      });
      await storage.upsert({
        id: 'test-2',
        vector: [0.4, 0.5, 0.6],
        metadata: { namespace: 'test', command: 'cmd2', description: 'desc2', signature: '', parameters: [], tags: [], indexedAt: '', version: '1.0.0' },
      });

      const ids = await storage.listIds();

      expect(ids).toContain('test-1');
      expect(ids).toContain('test-2');
      expect(ids.length).toBe(2);
    });

    it('T08: search applies namespace filter', async () => {
      const { MiniMemoryVectorStorage } = await import('../src/minimemory/vector-storage.js');
      const binding = createMockBinding();

      const storage = new MiniMemoryVectorStorage({ dimensions: 3 }, binding);

      await storage.upsert({
        id: 'test-1',
        vector: [0.1, 0.2, 0.3],
        metadata: { namespace: 'users', command: 'cmd', description: 'desc', signature: '', parameters: [], tags: [], indexedAt: '', version: '1.0.0' },
      });
      await storage.upsert({
        id: 'test-2',
        vector: [0.4, 0.5, 0.6],
        metadata: { namespace: 'notes', command: 'cmd2', description: 'desc2', signature: '', parameters: [], tags: [], indexedAt: '', version: '1.0.0' },
      });

      const results = await storage.search({
        vector: [0.1, 0.2, 0.3],
        topK: 10,
        filters: { namespace: 'users' },
      });

      expect(results.length).toBe(1);
      expect(results[0].metadata.namespace).toBe('users');
    });
  });

  describe('Factory function', () => {
    it('T09: createVectorStorage with prefer=memory returns in-memory storage', async () => {
      const { createVectorStorage } = await import('../src/minimemory/factory.js');

      const result = await createVectorStorage({
        dimensions: 768,
        prefer: 'memory',
      });

      expect(result.backend).toBe('memory');
      expect(result.storage).toBeDefined();
    });

    it('T10: in-memory fallback implements VectorStorageAdapter interface', async () => {
      const { createVectorStorage } = await import('../src/minimemory/factory.js');

      const { storage } = await createVectorStorage({
        dimensions: 3,
        prefer: 'memory',
      });

      // Test interface methods
      await storage.upsert({
        id: 'test-1',
        vector: [0.1, 0.2, 0.3],
        metadata: { namespace: 'test', command: 'cmd', description: 'desc', signature: '', parameters: [], tags: [], indexedAt: '', version: '1.0.0' },
      });

      expect(await storage.count()).toBe(1);

      const results = await storage.search({
        vector: [0.1, 0.2, 0.3],
        topK: 5,
      });

      expect(results.length).toBe(1);

      await storage.delete('test-1');
      expect(await storage.count()).toBe(0);

      const health = await storage.healthCheck();
      expect(health.status).toBe('healthy');
    });

    it('T11: in-memory storage applies filters correctly', async () => {
      const { createVectorStorage } = await import('../src/minimemory/factory.js');

      const { storage } = await createVectorStorage({
        dimensions: 3,
        prefer: 'memory',
      });

      await storage.upsert({
        id: 'users-1',
        vector: [0.1, 0.2, 0.3],
        metadata: { namespace: 'users', command: 'create', description: 'Create user', signature: '', parameters: [], tags: ['crud'], indexedAt: '', version: '1.0.0' },
      });
      await storage.upsert({
        id: 'notes-1',
        vector: [0.1, 0.2, 0.3],
        metadata: { namespace: 'notes', command: 'create', description: 'Create note', signature: '', parameters: [], tags: ['crud'], indexedAt: '', version: '1.0.0' },
      });

      // Filter by namespace
      const nsResults = await storage.search({
        vector: [0.1, 0.2, 0.3],
        topK: 10,
        filters: { namespace: 'users' },
      });
      expect(nsResults.length).toBe(1);
      expect(nsResults[0].id).toBe('users-1');

      // Filter by excludeIds
      const exResults = await storage.search({
        vector: [0.1, 0.2, 0.3],
        topK: 10,
        filters: { excludeIds: ['users-1'] },
      });
      expect(exResults.length).toBe(1);
      expect(exResults[0].id).toBe('notes-1');
    });

    it('T12: in-memory storage respects threshold', async () => {
      const { createVectorStorage } = await import('../src/minimemory/factory.js');

      const { storage } = await createVectorStorage({
        dimensions: 3,
        prefer: 'memory',
      });

      await storage.upsert({
        id: 'test-1',
        vector: [1, 0, 0],
        metadata: { namespace: 'test', command: 'cmd', description: 'desc', signature: '', parameters: [], tags: [], indexedAt: '', version: '1.0.0' },
      });

      // Very different vector - low similarity
      const results = await storage.search({
        vector: [0, 1, 0],
        topK: 10,
        threshold: 0.9,
      });

      // Should be filtered out due to low similarity
      expect(results.length).toBe(0);
    });
  });

  describe('isMinimemoryAvailable', () => {
    it('T13: returns boolean', async () => {
      const { isMinimemoryAvailable } = await import('../src/minimemory/factory.js');

      const result = isMinimemoryAvailable();

      expect(typeof result).toBe('boolean');
    });
  });
});
