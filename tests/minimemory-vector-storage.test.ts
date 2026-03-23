/**
 * @contract MINIMEMORY_VECTOR_STORAGE v1.0
 * @module MiniMemory Vector Storage (VectorStorageAdapter impl)
 * @description Tests para MiniMemoryVectorStorage basados en el contrato de especificacion.
 *
 * Valida que el adapter delegue correctamente al binding nativo de minimemory (mockeado),
 * manejando serializacion de metadata, post-filtering, conversion distance->score,
 * y persistencia automatica.
 *
 * El mock de minimemory se resuelve via alias en vitest.config.ts -> __mocks__/minimemory.ts
 *
 * Tests cubiertos (25 del contrato):
 * - T01-T02: Constructor e inicializacion
 * - T03-T04: Upsert individual
 * - T05-T06: Upsert batch
 * - T07-T09: Delete individual y batch
 * - T10-T16: Search con filtros
 * - T17-T18: ListIds y Count
 * - T19: Clear
 * - T20-T21: Health check
 * - T22-T25: Auto-persist y serialization
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Create mock state
let _currentInstance: any = null;
let _currentStore: Map<string, { vector: number[]; meta: Record<string, any> }> = new Map();

function createMockInstance(config: any) {
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

const MockVectorDB = vi.fn((config: any) => createMockInstance(config));

function _getMockInstance(): any {
  return _currentInstance;
}

function _getMockStore(): Map<string, { vector: number[]; meta: Record<string, any> }> {
  return _currentStore;
}

function _resetMock(): void {
  _currentInstance = null;
  _currentStore = new Map();
  MockVectorDB.mockClear();
}

// Use the mock binding directly — the src/ MiniMemoryVectorStorage accepts
// an optional `binding` parameter, avoiding the need to mock require('minimemory').
const mockBinding = {
  VectorDB: MockVectorDB,
};

// Use the mock VectorDB for assertions
const VectorDB = MockVectorDB;

import { MiniMemoryVectorStorage as _MiniMemoryVectorStorage } from '../src/minimemory/vector-storage.js';
import type { MiniMemoryVectorStorageConfig } from '../src/minimemory/types.js';
import type { VectorEntry, VectorSearchQuery } from '../src/vector-index/types.js';

// Wrap constructor to always inject mock binding
class MiniMemoryVectorStorage extends _MiniMemoryVectorStorage {
  constructor(config: MiniMemoryVectorStorageConfig) {
    super(config, mockBinding as any);
  }
}

// --- Helpers ---

function createVector(dimensions: number, seed: number = 0.5): number[] {
  return Array.from({ length: dimensions }, (_, i) => Math.sin(seed + i) * 0.5 + 0.5);
}

function createSampleEntry(id: string, overrides: Partial<VectorEntry> = {}): VectorEntry {
  return {
    id,
    vector: createVector(768),
    metadata: {
      namespace: 'users',
      command: id.split(':')[1] ?? 'cmd',
      description: `Command ${id}`,
      signature: `${id} --arg value`,
      parameters: ['--name', '--email'],
      tags: ['test', 'users'],
      indexedAt: '2026-01-24T00:00:00Z',
      version: '1.0.0',
    },
    ...overrides,
  };
}

function createDefaultConfig(overrides: Partial<MiniMemoryVectorStorageConfig> = {}): MiniMemoryVectorStorageConfig {
  return {
    dimensions: 768,
    ...overrides,
  };
}

// Access the mock's VectorDB instance for assertions
function getDb() {
  return _getMockInstance();
}

// =====================================================================
// TEST SUITE: MiniMemoryVectorStorage
// =====================================================================

describe('MiniMemoryVectorStorage', () => {
  let storage: MiniMemoryVectorStorage;

  beforeEach(() => {
    _resetMock();
    storage = new MiniMemoryVectorStorage(createDefaultConfig());
  });

  // ----------------------------------------------------------
  // Seccion 1: Constructor / Inicializacion
  // ----------------------------------------------------------
  describe('Constructor e Inicializacion', () => {

    /**
     * @test T01 - Constructor con binding disponible
     * @requirement F01 - Inicializacion del backend nativo
     * @priority Alta
     */
    it('T01: inicializa VectorDB con config de dimensiones y defaults', () => {
      expect(VectorDB).toHaveBeenCalledWith(
        expect.objectContaining({
          dimensions: 768,
          distance: 'cosine',
          index_type: 'hnsw',
          hnsw_m: 16,
          hnsw_ef_construction: 200,
        })
      );
    });

    /**
     * @test T02 - Constructor con HNSW params custom
     * @requirement F01 - Configurar VectorDB con parametros HNSW
     * @priority Alta
     */
    it('T02: pasa parametros HNSW custom al VectorDB', () => {
      _resetMock();

      new MiniMemoryVectorStorage(createDefaultConfig({
        hnswM: 32,
        hnswEfConstruction: 400,
      }));

      expect(VectorDB).toHaveBeenCalledWith(
        expect.objectContaining({
          hnsw_m: 32,
          hnsw_ef_construction: 400,
        })
      );
    });

    /**
     * @test T25 - Constructor con quantization int8
     * @requirement F01 - Configurar quantizacion
     * @priority Media
     */
    it('T25: pasa quantization al VectorDB cuando no es "none"', () => {
      _resetMock();

      new MiniMemoryVectorStorage(createDefaultConfig({
        quantization: 'int8',
      }));

      expect(VectorDB).toHaveBeenCalledWith(
        expect.objectContaining({
          quantization: 'int8',
        })
      );
    });

    /**
     * @test Constructor sin quantization no incluye el campo
     * @requirement F01 - Quantization por defecto es 'none'
     */
    it('no incluye quantization en config cuando es "none"', () => {
      _resetMock();

      new MiniMemoryVectorStorage(createDefaultConfig({
        quantization: 'none',
      }));

      const callArgs = VectorDB.mock.calls[0][0];
      expect(callArgs.quantization).toBeUndefined();
    });

    /**
     * @test T23 - Constructor intenta load si persistPath existe
     * @requirement F01 - Cargar datos persistidos desde disco
     * @priority Alta
     */
    it('T23: intenta cargar desde disco cuando persistPath esta configurado', () => {
      _resetMock();

      new MiniMemoryVectorStorage(createDefaultConfig({
        persistPath: '/tmp/test.mmdb',
      }));

      expect(getDb().load).toHaveBeenCalledWith('/tmp/test.mmdb');
    });

    /**
     * @test Constructor con persistPath inexistente no falla
     * @acceptance Inicializacion con persistPath inexistente -> database fresco
     */
    it('no lanza error si load falla (archivo inexistente)', () => {
      _resetMock();

      // Configure the mock BEFORE the instance is created
      // The createMockInstance will be called by VectorDB constructor,
      // so we need to override what MockVectorDB returns
      const originalImpl = MockVectorDB.getMockImplementation();
      MockVectorDB.mockImplementation((config: any) => {
        const instance = createMockInstance(config);
        instance.load.mockImplementation(() => {
          throw new Error('File not found');
        });
        return instance;
      });

      expect(() => {
        new MiniMemoryVectorStorage(createDefaultConfig({
          persistPath: '/tmp/nonexistent.mmdb',
        }));
      }).not.toThrow();

      // Restore the original implementation
      if (originalImpl) {
        MockVectorDB.mockImplementation(originalImpl);
      } else {
        MockVectorDB.mockImplementation((config: any) => createMockInstance(config));
      }
    });

    /**
     * @test Constructor con distance euclidean
     * @priority Baja
     */
    it('T27: soporta distance euclidean en config', () => {
      _resetMock();

      new MiniMemoryVectorStorage(createDefaultConfig({
        distance: 'euclidean',
      }));

      expect(VectorDB).toHaveBeenCalledWith(
        expect.objectContaining({
          distance: 'euclidean',
        })
      );
    });

    /**
     * @test Constructor con indexType flat no incluye HNSW params
     * @priority Baja
     */
    it('T29: no incluye hnsw params cuando indexType es flat', () => {
      _resetMock();

      new MiniMemoryVectorStorage(createDefaultConfig({
        indexType: 'flat',
      }));

      const callArgs = VectorDB.mock.calls[0][0];
      expect(callArgs.index_type).toBe('flat');
      expect(callArgs.hnsw_m).toBeUndefined();
      expect(callArgs.hnsw_ef_construction).toBeUndefined();
    });
  });

  // ----------------------------------------------------------
  // Seccion 2: Upsert
  // ----------------------------------------------------------
  describe('Upsert', () => {

    /**
     * @test T03 - Upsert agrega entrada nueva
     * @requirement F02 - Upsert individual
     * @acceptance Insertar vector nuevo -> count=1
     * @priority Alta
     */
    it('T03: inserta nueva entrada cuando ID no existe', async () => {
      const entry = createSampleEntry('cmd:test');

      await storage.upsert(entry);

      expect(getDb().insert).toHaveBeenCalledWith(
        'cmd:test',
        entry.vector,
        expect.any(Object)
      );
      expect(await storage.count()).toBe(1);
      expect(await storage.listIds()).toContain('cmd:test');
    });

    /**
     * @test T04 - Upsert actualiza entrada existente
     * @requirement F02 - Si existe: llamar db.update
     * @acceptance Actualizar vector existente -> count=1 (no duplica)
     * @priority Alta
     */
    it('T04: actualiza entrada existente cuando ID ya existe', async () => {
      // First insert succeeds
      await storage.upsert(createSampleEntry('cmd:test', { vector: createVector(768, 1.0) }));

      // Second upsert should call update_document (since insert throws "ID already exists")
      await storage.upsert(createSampleEntry('cmd:test', { vector: createVector(768, 2.0) }));

      expect(await storage.count()).toBe(1);
    });

    /**
     * @test Upsert auto-persiste cuando persistPath esta configurado
     * @requirement F02 - Actualizar idSet y auto-persistir
     * @priority Alta
     */
    it('T22: auto-persiste despues de upsert con persistPath', async () => {
      _resetMock();
      const s = new MiniMemoryVectorStorage(createDefaultConfig({
        persistPath: '/tmp/test.mmdb',
      }));
      getDb().save.mockClear();

      await s.upsert(createSampleEntry('cmd:test'));

      expect(getDb().save).toHaveBeenCalledWith('/tmp/test.mmdb');
    });

    /**
     * @test Upsert no persiste cuando persistPath no esta configurado
     * @mustnot No hacer auto-persist en operaciones sin persistPath
     */
    it('no persiste cuando persistPath no esta configurado', async () => {
      await storage.upsert(createSampleEntry('cmd:test'));

      expect(getDb().save).not.toHaveBeenCalled();
    });

    /**
     * @test Upsert silencia errores de persistencia
     * @error MM004 - Error de I/O en persistencia
     */
    it('silencia errores de auto-persist sin afectar el upsert', async () => {
      _resetMock();
      const s = new MiniMemoryVectorStorage(createDefaultConfig({
        persistPath: '/tmp/readonly.mmdb',
      }));
      getDb().save.mockImplementation(() => {
        throw new Error('Permission denied');
      });

      await expect(s.upsert(createSampleEntry('cmd:test'))).resolves.not.toThrow();
      expect(await s.count()).toBe(1);
    });
  });

  // ----------------------------------------------------------
  // Seccion 3: Upsert Batch
  // ----------------------------------------------------------
  describe('Upsert Batch', () => {

    /**
     * @test T05 - UpsertBatch procesa multiples entradas
     * @requirement F03 - Upsert batch
     * @acceptance Batch completamente exitoso -> {success: N, failed: 0}
     * @priority Alta
     */
    it('T05: procesa multiples entradas exitosamente', async () => {
      const entries = Array.from({ length: 10 }, (_, i) =>
        createSampleEntry(`cmd:${i}`)
      );

      const result = await storage.upsertBatch(entries);

      expect(result.success).toBe(10);
      expect(result.failed).toBe(0);
      expect(await storage.count()).toBe(10);
    });

    /**
     * @test UpsertBatch auto-persiste una sola vez al final
     * @requirement F03 - Auto-persistir una sola vez al final del batch
     */
    it('auto-persiste una sola vez al final del batch', async () => {
      _resetMock();
      const s = new MiniMemoryVectorStorage(createDefaultConfig({
        persistPath: '/tmp/test.mmdb',
      }));
      getDb().save.mockClear();

      const entries = Array.from({ length: 5 }, (_, i) =>
        createSampleEntry(`cmd:${i}`)
      );

      await s.upsertBatch(entries);

      expect(getDb().save).toHaveBeenCalledTimes(1);
    });
  });

  // ----------------------------------------------------------
  // Seccion 4: Delete
  // ----------------------------------------------------------
  describe('Delete', () => {

    /**
     * @test T07 - Delete elimina entrada existente
     * @requirement F04 - Delete individual
     * @acceptance Eliminar vector existente -> count decrementado
     * @priority Alta
     */
    it('T07: elimina entrada existente y actualiza idSet', async () => {
      await storage.upsert(createSampleEntry('cmd:test'));
      expect(await storage.count()).toBe(1);

      await storage.delete('cmd:test');

      expect(await storage.count()).toBe(0);
      expect(await storage.listIds()).not.toContain('cmd:test');
    });

    /**
     * @test T08 - Delete no falla para ID inexistente
     * @requirement F04 - Operacion silenciosa (no-op) si el ID no existe
     * @error MM003 - ID no encontrado en delete
     * @priority Media
     */
    it('T08: no falla para ID inexistente', async () => {
      await expect(storage.delete('cmd:ghost')).resolves.not.toThrow();
      expect(await storage.count()).toBe(0);
    });

    /**
     * @test Delete auto-persiste despues de eliminar
     * @requirement F04 - Actualizar idSet y auto-persistir
     */
    it('auto-persiste despues de delete exitoso', async () => {
      _resetMock();
      const s = new MiniMemoryVectorStorage(createDefaultConfig({
        persistPath: '/tmp/test.mmdb',
      }));
      await s.upsert(createSampleEntry('cmd:test'));
      getDb().save.mockClear();

      await s.delete('cmd:test');

      expect(getDb().save).toHaveBeenCalledWith('/tmp/test.mmdb');
    });
  });

  // ----------------------------------------------------------
  // Seccion 5: Delete Batch
  // ----------------------------------------------------------
  describe('Delete Batch', () => {

    /**
     * @test T09 - DeleteBatch elimina multiples IDs
     * @requirement F05 - Delete batch
     * @acceptance Batch delete -> {success: N, failed: M}
     * @priority Media
     */
    it('T09: procesa multiples IDs correctamente', async () => {
      await storage.upsert(createSampleEntry('cmd:a'));
      await storage.upsert(createSampleEntry('cmd:b'));
      await storage.upsert(createSampleEntry('cmd:c'));

      const result = await storage.deleteBatch(['cmd:a', 'cmd:b']);

      expect(result.success).toBeGreaterThanOrEqual(1);
      expect(await storage.count()).toBeLessThanOrEqual(1);
    });

    /**
     * @test DeleteBatch auto-persiste una sola vez al final
     */
    it('auto-persiste una sola vez al final del batch', async () => {
      _resetMock();
      const s = new MiniMemoryVectorStorage(createDefaultConfig({
        persistPath: '/tmp/test.mmdb',
      }));
      await s.upsert(createSampleEntry('cmd:a'));
      await s.upsert(createSampleEntry('cmd:b'));
      getDb().save.mockClear();

      await s.deleteBatch(['cmd:a', 'cmd:b']);

      expect(getDb().save).toHaveBeenCalledTimes(1);
    });
  });

  // ----------------------------------------------------------
  // Seccion 6: Search
  // ----------------------------------------------------------
  describe('Search', () => {

    beforeEach(async () => {
      // Insertar datos de prueba con diferentes namespaces y tags
      const entries: VectorEntry[] = [
        createSampleEntry('users:create', {
          metadata: {
            namespace: 'users', command: 'create',
            description: 'Create user', signature: 'users:create',
            parameters: ['--name'], tags: ['admin', 'users'],
            indexedAt: '2026-01-24T00:00:00Z', version: '1.0.0',
          },
        }),
        createSampleEntry('users:list', {
          metadata: {
            namespace: 'users', command: 'list',
            description: 'List users', signature: 'users:list',
            parameters: [], tags: ['users'],
            indexedAt: '2026-01-24T00:00:00Z', version: '1.0.0',
          },
        }),
        createSampleEntry('billing:charge', {
          metadata: {
            namespace: 'billing', command: 'charge',
            description: 'Charge customer', signature: 'billing:charge',
            parameters: ['--amount'], tags: ['billing', 'payments'],
            indexedAt: '2026-01-24T00:00:00Z', version: '1.0.0',
          },
        }),
      ];

      for (const entry of entries) {
        await storage.upsert(entry);
      }
    });

    /**
     * @test T10 - Search retorna resultados con score
     * @requirement F06 - Busqueda vectorial
     * @acceptance Resultados con id, score, metadata
     * @priority Alta
     */
    it('T10: retorna resultados con score y respeta topK', async () => {
      const query: VectorSearchQuery = {
        vector: createVector(768),
        topK: 3,
      };

      const results = await storage.search(query);

      expect(results.length).toBeLessThanOrEqual(3);
      results.forEach(r => {
        expect(r.id).toBeDefined();
        expect(typeof r.score).toBe('number');
        expect(r.metadata).toBeDefined();
      });
    });

    /**
     * @test T11 - Search convierte distance a score (1 - distance)
     * @requirement F06 - Convertir distancia a score: score = 1 - distance
     * @acceptance distance=0.0 -> score=1.0
     * @priority Alta
     */
    it('T11: convierte distance a score como 1 - distance', async () => {
      getDb().search.mockReturnValueOnce([
        { id: 'cmd:exact', distance: 0.0, metadata: { namespace: 'test', tags: '[]', parameters: '[]' } },
        { id: 'cmd:close', distance: 0.2, metadata: { namespace: 'test', tags: '[]', parameters: '[]' } },
      ]);

      const results = await storage.search({
        vector: createVector(768),
        topK: 10,
      });

      expect(results[0].score).toBe(1.0);
      expect(results[1].score).toBeCloseTo(0.8);
    });

    /**
     * @test T12 - Search aplica threshold
     * @requirement F06 - Aplicar filtro de threshold
     * @acceptance Solo resultados con score >= threshold
     * @priority Alta
     */
    it('T12: descarta resultados con score menor a threshold', async () => {
      getDb().search.mockReturnValueOnce([
        { id: 'cmd:high', distance: 0.05, metadata: { namespace: 'test', tags: '[]', parameters: '[]' } },
        { id: 'cmd:low', distance: 0.9, metadata: { namespace: 'test', tags: '[]', parameters: '[]' } },
      ]);

      const results = await storage.search({
        vector: createVector(768),
        topK: 10,
        threshold: 0.8,
      });

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('cmd:high');
    });

    /**
     * @test T13 - Search aplica namespace filter
     * @requirement F06 - Aplicar filtro de namespace
     * @acceptance Solo retorna vectores con metadata.namespace coincidente
     * @priority Alta
     */
    it('T13: filtra resultados por namespace', async () => {
      getDb().search.mockReturnValueOnce([
        { id: 'users:create', distance: 0.1, metadata: { namespace: 'users', tags: '["users"]', parameters: '[]' } },
        { id: 'billing:charge', distance: 0.15, metadata: { namespace: 'billing', tags: '[]', parameters: '[]' } },
        { id: 'users:list', distance: 0.2, metadata: { namespace: 'users', tags: '["users"]', parameters: '[]' } },
      ]);

      const results = await storage.search({
        vector: createVector(768),
        topK: 10,
        filters: { namespace: 'users' },
      });

      expect(results.every(r => r.metadata.namespace === 'users')).toBe(true);
    });

    /**
     * @test T14 - Search aplica excludeIds filter
     * @requirement F06 - Aplicar filtro de excludeIds
     * @acceptance Resultados no incluyen IDs excluidos
     * @priority Media
     */
    it('T14: excluye resultados con IDs en excludeIds', async () => {
      getDb().search.mockReturnValueOnce([
        { id: 'cmd:a', distance: 0.1, metadata: { namespace: 'test', tags: '[]', parameters: '[]' } },
        { id: 'cmd:b', distance: 0.2, metadata: { namespace: 'test', tags: '[]', parameters: '[]' } },
        { id: 'cmd:c', distance: 0.3, metadata: { namespace: 'test', tags: '[]', parameters: '[]' } },
      ]);

      const results = await storage.search({
        vector: createVector(768),
        topK: 10,
        filters: { excludeIds: ['cmd:b'] },
      });

      const ids = results.map(r => r.id);
      expect(ids).not.toContain('cmd:b');
    });

    /**
     * @test T15 - Search aplica tags filter
     * @requirement F06 - Aplicar filtro de tags
     * @acceptance Solo resultados con al menos un tag coincidente
     * @priority Media
     */
    it('T15: filtra resultados por tags', async () => {
      getDb().search.mockReturnValueOnce([
        { id: 'cmd:admin', distance: 0.1, metadata: { namespace: 'test', tags: '["admin","users"]', parameters: '[]' } },
        { id: 'cmd:billing', distance: 0.2, metadata: { namespace: 'test', tags: '["billing"]', parameters: '[]' } },
      ]);

      const results = await storage.search({
        vector: createVector(768),
        topK: 10,
        filters: { tags: ['admin'] },
      });

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('cmd:admin');
    });

    /**
     * @test T16 - Search respeta topK limit
     * @requirement F06 - Cortar resultados al alcanzar topK
     * @priority Alta
     */
    it('T16: corta resultados al alcanzar topK', async () => {
      getDb().search.mockReturnValueOnce(
        Array.from({ length: 20 }, (_, i) => ({
          id: `cmd:${i}`,
          distance: i * 0.02,
          metadata: { namespace: 'test', tags: '[]', parameters: '[]' },
        }))
      );

      const results = await storage.search({
        vector: createVector(768),
        topK: 5,
      });

      expect(results).toHaveLength(5);
    });

    /**
     * @test Search over-fetch solicita topK*2 al binding
     * @requirement F06 - Sobre-fetchear: solicitar topK * 2
     * @priority Alta
     */
    it('solicita topK*2 resultados al binding para compensar post-filtering', async () => {
      await storage.search({
        vector: createVector(768),
        topK: 5,
      });

      expect(getDb().search).toHaveBeenCalledWith(
        expect.any(Array),
        10 // topK * 2 = 5 * 2
      );
    });
  });

  // ----------------------------------------------------------
  // Seccion 7: Serializacion de Metadata
  // ----------------------------------------------------------
  describe('Serializacion de Metadata', () => {

    /**
     * @test T24a - Serializacion de metadata (arrays a JSON strings)
     * @requirement F12 - Serializacion de metadata
     * @acceptance Arrays se convierten a JSON strings
     * @priority Alta
     */
    it('T24a: serializa arrays de metadata a JSON strings al insertar', async () => {
      const entry = createSampleEntry('cmd:test', {
        metadata: {
          namespace: 'users',
          command: 'test',
          description: 'Test',
          signature: 'test',
          parameters: ['--name', '--email'],
          tags: ['users', 'admin'],
          indexedAt: '2026-01-24T00:00:00Z',
          version: '1.0.0',
        },
      });

      await storage.upsert(entry);

      const insertCall = getDb().insert.mock.calls[0];
      const serializedMeta = insertCall[2];
      expect(serializedMeta.parameters).toBe('["--name","--email"]');
      expect(serializedMeta.tags).toBe('["users","admin"]');
    });

    /**
     * @test T24b - Deserializacion de metadata
     * @requirement F12 - Convertir JSON strings de vuelta a arrays
     * @acceptance Arrays se restauran correctamente
     * @priority Alta
     */
    it('T24b: deserializa JSON strings a arrays en resultados de search', async () => {
      getDb().search.mockReturnValueOnce([
        {
          id: 'cmd:test',
          distance: 0.1,
          metadata: {
            namespace: 'users',
            parameters: '["--name","--email"]',
            tags: '["users","admin"]',
          },
        },
      ]);

      const results = await storage.search({
        vector: createVector(768),
        topK: 5,
      });

      expect(results[0].metadata.parameters).toEqual(['--name', '--email']);
      expect(results[0].metadata.tags).toEqual(['users', 'admin']);
    });
  });

  // ----------------------------------------------------------
  // Seccion 8: ListIds y Count
  // ----------------------------------------------------------
  describe('ListIds y Count', () => {

    /**
     * @test T17 - listIds retorna todos los IDs
     * @requirement F07 - Listado de IDs
     * @priority Media
     */
    it('T17: listIds retorna array con todos los IDs insertados', async () => {
      await storage.upsert(createSampleEntry('cmd:a'));
      await storage.upsert(createSampleEntry('cmd:b'));

      const ids = await storage.listIds();

      expect(ids).toHaveLength(2);
      expect(ids).toContain('cmd:a');
      expect(ids).toContain('cmd:b');
    });

    /**
     * @test T18 - count retorna cantidad correcta
     * @requirement F08 - Conteo
     * @priority Media
     */
    it('T18: count retorna la cantidad correcta de entradas', async () => {
      expect(await storage.count()).toBe(0);

      await storage.upsert(createSampleEntry('cmd:1'));
      expect(await storage.count()).toBe(1);

      await storage.upsert(createSampleEntry('cmd:2'));
      expect(await storage.count()).toBe(2);
    });

    /**
     * @test listIds retorna array vacio cuando no hay entradas
     */
    it('listIds retorna array vacio para instancia vacia', async () => {
      const ids = await storage.listIds();
      expect(ids).toEqual([]);
    });
  });

  // ----------------------------------------------------------
  // Seccion 9: Clear
  // ----------------------------------------------------------
  describe('Clear', () => {

    /**
     * @test T19 - Clear elimina todas las entradas
     * @requirement F09 - Limpieza total
     * @acceptance count=0, listIds=[]
     * @priority Alta
     */
    it('T19: elimina todas las entradas del indice', async () => {
      await storage.upsert(createSampleEntry('cmd:a'));
      await storage.upsert(createSampleEntry('cmd:b'));
      expect(await storage.count()).toBe(2);

      await storage.clear();

      expect(await storage.count()).toBe(0);
      expect(await storage.listIds()).toEqual([]);
    });

    /**
     * @test Clear auto-persiste el estado limpio
     * @requirement F09 - Auto-persistir el estado limpio
     */
    it('auto-persiste despues de clear', async () => {
      _resetMock();
      const s = new MiniMemoryVectorStorage(createDefaultConfig({
        persistPath: '/tmp/test.mmdb',
      }));
      await s.upsert(createSampleEntry('cmd:a'));
      getDb().save.mockClear();

      await s.clear();

      expect(getDb().save).toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------
  // Seccion 10: Health Check
  // ----------------------------------------------------------
  describe('Health Check', () => {

    /**
     * @test T20 - HealthCheck retorna healthy
     * @requirement F10 - Health check
     * @acceptance {status: 'healthy', details: ...}
     * @priority Media
     */
    it('T20: retorna healthy con detalles del indice', async () => {
      await storage.upsert(createSampleEntry('cmd:a'));
      await storage.upsert(createSampleEntry('cmd:b'));

      const health = await storage.healthCheck();

      expect(health.status).toBe('healthy');
      expect(health.details).toContain('minimemory');
      expect(health.details).toContain('2 vectors');
    });

    /**
     * @test T21 - HealthCheck con quantization configurada
     */
    it('T21: reporta quantization configurada en los detalles', async () => {
      _resetMock();
      const s = new MiniMemoryVectorStorage(createDefaultConfig({
        quantization: 'int8',
      }));

      const health = await s.healthCheck();

      expect(health.status).toBe('healthy');
      expect(health.details).toContain('int8');
    });
  });

  // ----------------------------------------------------------
  // Seccion 11: Save y GetDb
  // ----------------------------------------------------------
  describe('Save y GetDb', () => {

    /**
     * @test Save persiste a disco manualmente
     */
    it('save llama db.save con el persistPath', () => {
      _resetMock();
      const s = new MiniMemoryVectorStorage(createDefaultConfig({
        persistPath: '/tmp/manual.mmdb',
      }));
      getDb().save.mockClear();

      s.save();

      expect(getDb().save).toHaveBeenCalledWith('/tmp/manual.mmdb');
    });

    /**
     * @test getDb retorna la instancia del VectorDB nativo
     */
    it('getDb retorna la instancia del binding nativo', () => {
      const db = storage.getDb();
      expect(db).toBeDefined();
    });
  });

  // ----------------------------------------------------------
  // Seccion 12: MUST NOT - Restricciones
  // ----------------------------------------------------------
  describe('MUST NOT - Restricciones', () => {

    /**
     * @mustnot No retornar distancias raw al consumidor
     * @requirement Siempre convertir a score (1 - distance)
     */
    it('nunca expone distancias raw, solo scores convertidos', async () => {
      getDb().search.mockReturnValueOnce([
        { id: 'cmd:test', distance: 0.35, metadata: { namespace: 'test', tags: '[]', parameters: '[]' } },
      ]);

      const results = await storage.search({
        vector: createVector(768),
        topK: 5,
      });

      expect(results[0].score).toBe(0.65); // 1 - 0.35
      expect((results[0] as any).distance).toBeUndefined();
    });

    /**
     * @mustnot No hacer auto-persist en operaciones de solo lectura
     */
    it('no persiste en operaciones de lectura', async () => {
      _resetMock();
      const s = new MiniMemoryVectorStorage(createDefaultConfig({
        persistPath: '/tmp/test.mmdb',
      }));
      await s.upsert(createSampleEntry('cmd:test'));
      getDb().save.mockClear();

      await s.search({ vector: createVector(768), topK: 5 });
      await s.listIds();
      await s.count();
      await s.healthCheck();

      expect(getDb().save).not.toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------
  // Seccion 13: Concurrencia
  // ----------------------------------------------------------
  describe('Concurrencia', () => {

    /**
     * @test T30 - Concurrencia 10 upserts simultaneos
     * @acceptance Todos exitosos, count=10
     * @priority Media
     */
    it('T30: soporta 10 upserts concurrentes sin errores', async () => {
      const promises = Array.from({ length: 10 }, (_, i) =>
        storage.upsert(createSampleEntry(`cmd:concurrent-${i}`))
      );

      await expect(Promise.all(promises)).resolves.not.toThrow();
      expect(await storage.count()).toBe(10);
    });
  });

  // ----------------------------------------------------------
  // Seccion 14: Error Handling
  // ----------------------------------------------------------
  describe('Error Handling', () => {

    /**
     * @test Search con binding que retorna resultados vacios
     */
    it('search retorna array vacio cuando el binding no tiene resultados', async () => {
      getDb().search.mockReturnValueOnce([]);

      const results = await storage.search({
        vector: createVector(768),
        topK: 5,
      });

      expect(results).toEqual([]);
    });

    /**
     * @test Search maneja distance undefined como 0
     */
    it('search trata distance undefined como 0 (score = 1)', async () => {
      getDb().search.mockReturnValueOnce([
        { id: 'cmd:test', metadata: { namespace: 'test', tags: '[]', parameters: '[]' } },
      ]);

      const results = await storage.search({
        vector: createVector(768),
        topK: 5,
      });

      expect(results[0].score).toBe(1.0);
    });
  });
});
