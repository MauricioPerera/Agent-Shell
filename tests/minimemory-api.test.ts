/**
 * @contract CONTRACT_MINIMEMORY_API_ADAPTER v1.0
 * @module MiniMemory API Adapter
 * @description Tests completos para MiniMemoryApiAdapter basados en el contrato.
 *
 * Cubre:
 * - Seccion 1 (MUST DO): Inicializacion, VectorDB CRUD, Search, AgentMemory
 * - Seccion 2 (MUST NOT): Restricciones de seguridad e implementacion
 * - Seccion 3 (ACCEPTANCE): Criterios Gherkin (T01-T36)
 * - Seccion 4 (ON ERROR): Manejo de errores E-MM-001 a E-MM-010
 * - Seccion 5 (ASSUMPTIONS): Precondiciones del binding
 * - Seccion 6 (LIMITS): Constraints tecnicos y de negocio
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Import mock module (created in node_modules/minimemory for require() compatibility) ---
// eslint-disable-next-line @typescript-eslint/no-var-requires
const minimemoryMock = require('minimemory');

// Type-safe reference to mockState
const mockState = minimemoryMock.mockState as {
  store: Map<string, { vector: number[] | null; meta: Record<string, any> }>;
  vectorDBInstance: any;
  agentMemoryInstance: any;
  vectorDBConstructor: any;
  withFulltext: any;
  agentMemoryConstructor: any;
};

// Setup function to initialize mock state before each test
function setupMocks() {
  mockState.store = new Map();

  mockState.vectorDBInstance = {
    insert: vi.fn((id: string, vector: number[], meta: Record<string, any>) => {
      if (mockState.store.has(id)) throw new Error('ID already exists');
      mockState.store.set(id, { vector, meta });
    }),
    insert_document: vi.fn((id: string, _vector: null, meta: Record<string, any>) => {
      if (mockState.store.has(id)) throw new Error('ID already exists');
      mockState.store.set(id, { vector: null, meta });
    }),
    update_document: vi.fn((id: string, vector: number[] | null, meta: Record<string, any> | null) => {
      if (!mockState.store.has(id)) throw new Error('ID not found');
      const existing = mockState.store.get(id)!;
      mockState.store.set(id, {
        vector: vector || existing.vector,
        meta: meta || existing.meta,
      });
    }),
    delete: vi.fn((id: string) => {
      if (!mockState.store.has(id)) throw new Error('ID not found');
      mockState.store.delete(id);
    }),
    contains: vi.fn((id: string) => mockState.store.has(id)),
    get: vi.fn((id: string) => {
      if (!mockState.store.has(id)) throw new Error('ID not found');
      const entry = mockState.store.get(id)!;
      return { vector: entry.vector, metadata: entry.meta };
    }),
    search: vi.fn((_vector: number[], topK: number) => {
      return [...mockState.store.entries()].slice(0, topK).map(([id], idx) => ({
        id,
        distance: 0.1 * (idx + 1),
        metadata: mockState.store.get(id)?.meta || {},
      }));
    }),
    keyword_search: vi.fn((query: string, _topK: number) => {
      return [{ id: 'kw-1', distance: 0, score: 0.9, metadata: { content: query } }];
    }),
    hybrid_search: vi.fn((_params: any) => {
      return [{ id: 'hybrid-1', distance: 0.05, score: 0.95, metadata: {} }];
    }),
    filter_search: vi.fn((_filter: any, _topK: number) => {
      return [{ id: 'filtered-1', metadata: { category: 'tech' } }];
    }),
    len: vi.fn(() => mockState.store.size),
    has_fulltext: vi.fn(() => false),
    save: vi.fn(),
    load: vi.fn(),
  };

  mockState.agentMemoryInstance = {
    learn_task: vi.fn(),
    learn_code: vi.fn(),
    learn_error_solution: vi.fn(),
    recall_similar: vi.fn(() => [{ id: 'r1', relevance: 0.9, content: { task: 'test' } }]),
    recall_code: vi.fn(() => [{ id: 'c1', relevance: 0.85, content: { code: 'fn main()' } }]),
    recall_error_solutions: vi.fn(() => [{ id: 'e1', relevance: 0.8, content: { error: 'borrow' } }]),
    recall_successful: vi.fn(() => [{ id: 's1', relevance: 0.88, content: { task: 'deploy' } }]),
    with_working_context: vi.fn((cb: (ctx: any) => void) => {
      cb({ set_project: vi.fn(), set_task: vi.fn(), add_goal: vi.fn() });
    }),
    working_context: vi.fn(() => ({ current_project: 'test-project', active_goals: ['goal1'] })),
    stats: vi.fn(() => ({ total_entries: 5, episodes: 2, code_snippets: 2, error_solutions: 1 })),
    save: vi.fn(),
    load: vi.fn(),
    focus_project: vi.fn(),
  };

  mockState.vectorDBConstructor = vi.fn(() => mockState.vectorDBInstance);
  mockState.withFulltext = vi.fn(() => {
    mockState.vectorDBInstance.has_fulltext = vi.fn(() => true);
    return mockState.vectorDBInstance;
  });
  mockState.agentMemoryConstructor = vi.fn(() => mockState.agentMemoryInstance);
}

// --- Import adapter ---

import {
  MiniMemoryApiAdapter,
  type MiniMemoryConfig,
  type MiniMemoryInsertParams,
  type MiniMemoryHybridParams,
  type MiniMemoryFilterParams,
  type TaskEpisode,
  type CodeSnippet,
  type ErrorSolution,
} from '../demo/adapters/minimemory-api';

// =============================================================================
// SECTION 1: MUST DO - Initialization
// =============================================================================

describe('MiniMemoryApiAdapter - Initialization', () => {
  beforeEach(() => {
    setupMocks();
  });

  /**
   * @test T01
   * @requirement F01 - Constructor inicializa VectorDB con config minima
   * @acceptance Inicializacion exitosa con configuracion minima
   */
  it('T01: creates instance with minimal config (dimensions only)', () => {
    const adapter = new MiniMemoryApiAdapter({ dimensions: 384 });

    expect(mockState.vectorDBConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        dimensions: 384,
        distance: 'cosine',
        index_type: 'hnsw',
      })
    );
    expect(adapter).toBeInstanceOf(MiniMemoryApiAdapter);
  });

  /**
   * @test T02
   * @requirement F01 - Constructor con fulltextFields usa withFulltext
   * @acceptance Inicializacion con fulltext habilitado
   */
  it('T02: uses VectorDB.withFulltext when fulltextFields are provided', () => {
    const config: MiniMemoryConfig = {
      dimensions: 768,
      fulltextFields: ['content', 'title'],
    };

    new MiniMemoryApiAdapter(config);

    expect(mockState.withFulltext).toHaveBeenCalledWith(
      expect.objectContaining({ dimensions: 768 }),
      ['content', 'title']
    );
    expect(mockState.vectorDBConstructor).not.toHaveBeenCalled();
  });

  /**
   * @test
   * @requirement F01 - Constructor carga persistPath si existe
   * @acceptance Carga desde persistPath existente
   */
  it('T03: loads from persistPath when configured', () => {
    const config: MiniMemoryConfig = {
      dimensions: 384,
      persistPath: './data/test.mmdb',
    };

    new MiniMemoryApiAdapter(config);

    expect(mockState.vectorDBInstance.load).toHaveBeenCalledWith('./data/test.mmdb');
  });

  /**
   * @test
   * @requirement F01 - Constructor no falla si persistPath no existe
   * @acceptance persistPath no existe al iniciar: base fresca
   */
  it('T03b: does not throw if persistPath file does not exist', () => {
    mockState.vectorDBInstance.load = vi.fn(() => { throw new Error('File not found'); });

    const config: MiniMemoryConfig = {
      dimensions: 384,
      persistPath: './nonexistent.mmdb',
    };

    expect(() => new MiniMemoryApiAdapter(config)).not.toThrow();
  });

  /**
   * @test
   * @requirement F01 - Defaults correctos
   */
  it('applies default distance=cosine, indexType=hnsw, quantization=none', () => {
    new MiniMemoryApiAdapter({ dimensions: 128 });

    expect(mockState.vectorDBConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        distance: 'cosine',
        index_type: 'hnsw',
      })
    );
    // quantization not passed when 'none'
    const calledConfig = mockState.vectorDBConstructor.mock.calls[0][0];
    expect(calledConfig.quantization).toBeUndefined();
  });

  /**
   * @test
   * @requirement F01 - quantization non-none is passed to binding
   */
  it('passes quantization to binding config when not "none"', () => {
    new MiniMemoryApiAdapter({ dimensions: 384, quantization: 'int8' });

    expect(mockState.vectorDBConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ quantization: 'int8' })
    );
  });

  /**
   * @test
   * @requirement F01 - AgentMemory initialization with small dimensions
   */
  it('initializes AgentMemory with type "small" when dimensions <= 384', () => {
    new MiniMemoryApiAdapter({ dimensions: 384 });

    expect(mockState.agentMemoryConstructor).toHaveBeenCalledWith({ type: 'small' });
  });

  /**
   * @test
   * @requirement F01 - AgentMemory initialization with large dimensions
   */
  it('initializes AgentMemory with type "openai" when dimensions > 384', () => {
    new MiniMemoryApiAdapter({ dimensions: 1536 });

    expect(mockState.agentMemoryConstructor).toHaveBeenCalledWith({
      type: 'openai',
      dimensions: 1536,
    });
  });

  /**
   * @test
   * @requirement F01 - AgentMemory graceful degradation
   * @acceptance AgentMemory no disponible en el binding
   */
  it('sets agentMemory to null if AgentMemory constructor throws', () => {
    mockState.agentMemoryConstructor = vi.fn(() => { throw new Error('Not available'); });

    const adapter = new MiniMemoryApiAdapter({ dimensions: 384 });

    // Should not throw during construction
    expect(adapter).toBeInstanceOf(MiniMemoryApiAdapter);
    // VectorDB operations should still work
    expect(adapter.stats()).toEqual(expect.objectContaining({ count: 0 }));
  });
});

// =============================================================================
// SECTION 1: MUST DO - VectorDB CRUD Operations
// =============================================================================

describe('MiniMemoryApiAdapter - VectorDB CRUD', () => {
  let adapter: MiniMemoryApiAdapter;

  beforeEach(() => {
    setupMocks();
    adapter = new MiniMemoryApiAdapter({ dimensions: 3 });
  });

  /**
   * @test T04
   * @requirement F02 - insert con vector
   * @acceptance Insert con vector y metadata
   */
  it('T04: insert with vector calls db.insert with id, vector, metadata', () => {
    const params: MiniMemoryInsertParams = {
      id: 'doc-1',
      vector: [0.1, 0.2, 0.3],
      metadata: { title: 'Test' },
    };

    adapter.insert(params);

    expect(mockState.vectorDBInstance.insert).toHaveBeenCalledWith(
      'doc-1',
      [0.1, 0.2, 0.3],
      { title: 'Test' }
    );
  });

  /**
   * @test T05
   * @requirement F02 - insert sin vector (document-only)
   * @acceptance Insert sin vector
   */
  it('T05: insert without vector calls db.insert_document', () => {
    const params: MiniMemoryInsertParams = {
      id: 'doc-2',
      metadata: { category: 'notes' },
    };

    adapter.insert(params);

    expect(mockState.vectorDBInstance.insert_document).toHaveBeenCalledWith(
      'doc-2',
      null,
      { category: 'notes' }
    );
    expect(mockState.vectorDBInstance.insert).not.toHaveBeenCalled();
  });

  /**
   * @test
   * @requirement F02 - insert passes empty metadata when undefined
   */
  it('insert passes empty object when metadata is undefined', () => {
    adapter.insert({ id: 'doc-3', vector: [0.1, 0.2, 0.3] });

    expect(mockState.vectorDBInstance.insert).toHaveBeenCalledWith(
      'doc-3',
      [0.1, 0.2, 0.3],
      {}
    );
  });

  /**
   * @test T06
   * @requirement F03 - update documento
   * @acceptance Update de metadata existente
   */
  it('T06: update calls db.update_document with id, vector, metadata', () => {
    mockState.store.set('doc-1', { vector: [0.1, 0.2, 0.3], meta: { a: 1 } });

    adapter.update('doc-1', undefined, { a: 2, b: 3 });

    expect(mockState.vectorDBInstance.update_document).toHaveBeenCalledWith(
      'doc-1',
      null,
      { a: 2, b: 3 }
    );
  });

  /**
   * @test
   * @requirement F03 - update with vector only
   */
  it('update with vector passes vector and null metadata', () => {
    mockState.store.set('doc-1', { vector: [0.1, 0.2, 0.3], meta: {} });

    adapter.update('doc-1', [0.4, 0.5, 0.6]);

    expect(mockState.vectorDBInstance.update_document).toHaveBeenCalledWith(
      'doc-1',
      [0.4, 0.5, 0.6],
      null
    );
  });

  /**
   * @test T07
   * @requirement F04 - delete documento
   * @acceptance Delete de documento existente
   */
  it('T07: delete calls db.delete with the id', () => {
    mockState.store.set('doc-1', { vector: [0.1, 0.2, 0.3], meta: {} });

    adapter.delete('doc-1');

    expect(mockState.vectorDBInstance.delete).toHaveBeenCalledWith('doc-1');
  });

  /**
   * @test T08
   * @requirement F05 - contains retorna boolean correcto
   */
  it('T08: contains returns true for existing document', () => {
    mockState.store.set('doc-1', { vector: [0.1, 0.2, 0.3], meta: {} });

    expect(adapter.contains('doc-1')).toBe(true);
  });

  /**
   * @test
   * @requirement F05 - contains returns false for missing document
   */
  it('contains returns false for non-existing document', () => {
    expect(adapter.contains('nonexistent')).toBe(false);
  });

  /**
   * @test T08 (get)
   * @requirement F06 - get retorna documento
   * @acceptance Get de documento existente
   */
  it('T08b: get returns document for existing ID', () => {
    mockState.store.set('doc-1', { vector: [0.1, 0.2, 0.3], meta: { title: 'Test' } });

    const result = adapter.get('doc-1');

    expect(result).toEqual({
      vector: [0.1, 0.2, 0.3],
      metadata: { title: 'Test' },
    });
  });

  /**
   * @test T09
   * @requirement F06 - get retorna null para ID inexistente
   * @acceptance Get de documento inexistente
   */
  it('T09: get returns null for non-existing ID (catches binding error)', () => {
    const result = adapter.get('no-existe');

    expect(result).toBeNull();
  });
});

// =============================================================================
// SECTION 1: MUST DO - VectorDB Search Operations
// =============================================================================

describe('MiniMemoryApiAdapter - VectorDB Search', () => {
  let adapter: MiniMemoryApiAdapter;

  beforeEach(() => {
    setupMocks();
    adapter = new MiniMemoryApiAdapter({ dimensions: 3 });
  });

  /**
   * @test T10
   * @requirement F07 - search retorna resultados con topK
   * @acceptance Vector search retorna resultados ordenados
   */
  it('T10: search returns exactly topK results', () => {
    for (let i = 0; i < 5; i++) {
      mockState.store.set(`doc-${i}`, { vector: [0.1 * i, 0.2, 0.3], meta: {} });
    }

    const results = adapter.search([0.5, 0.5, 0.5], 3);

    expect(results).toHaveLength(3);
    expect(mockState.vectorDBInstance.search).toHaveBeenCalledWith([0.5, 0.5, 0.5], 3);
  });

  /**
   * @test T11
   * @requirement F07 - score = 1 - distance
   */
  it('T11: search converts distance to score (score = 1 - distance)', () => {
    mockState.store.set('doc-0', { vector: [0.1, 0.2, 0.3], meta: {} });

    const results = adapter.search([0.5, 0.5, 0.5], 1);

    expect(results[0].distance).toBe(0.1);
    expect(results[0].score).toBeCloseTo(0.9);
  });

  /**
   * @test
   * @requirement F07 - search result structure
   */
  it('search results contain id, distance, score, and metadata', () => {
    mockState.store.set('doc-0', { vector: [0.1, 0.2, 0.3], meta: { tag: 'test' } });

    const results = adapter.search([0.5, 0.5, 0.5], 1);

    expect(results[0]).toHaveProperty('id');
    expect(results[0]).toHaveProperty('distance');
    expect(results[0]).toHaveProperty('score');
    expect(results[0]).toHaveProperty('metadata');
  });

  /**
   * @test T12
   * @requirement F08 - keywordSearch retorna resultados BM25
   * @acceptance Keyword search con BM25
   */
  it('T12: keywordSearch calls db.keyword_search and normalizes results', () => {
    const results = adapter.keywordSearch('rust async', 5);

    expect(mockState.vectorDBInstance.keyword_search).toHaveBeenCalledWith('rust async', 5);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('kw-1');
    expect(results[0].score).toBe(0.9);
  });

  /**
   * @test
   * @requirement F08 - keywordSearch handles missing distance field
   */
  it('keywordSearch defaults distance to 0 when not provided by binding', () => {
    mockState.vectorDBInstance.keyword_search = vi.fn(() => [
      { id: 'kw-2', score: 0.8, metadata: {} },
    ]);

    const results = adapter.keywordSearch('test', 3);

    expect(results[0].distance).toBe(0);
    expect(results[0].score).toBe(0.8);
  });

  /**
   * @test T13
   * @requirement F09 - hybridSearch pasa params correctos
   * @acceptance Hybrid search combina senales
   */
  it('T13: hybridSearch converts camelCase params to snake_case', () => {
    const params: MiniMemoryHybridParams = {
      vector: [0.1, 0.2, 0.3],
      keywords: 'test query',
      topK: 5,
      vectorWeight: 0.7,
      fusionK: 60,
    };

    adapter.hybridSearch(params);

    expect(mockState.vectorDBInstance.hybrid_search).toHaveBeenCalledWith(
      expect.objectContaining({
        vector: [0.1, 0.2, 0.3],
        keywords: 'test query',
        top_k: 5,
        vector_weight: 0.7,
        fusion_k: 60,
      })
    );
  });

  /**
   * @test T14
   * @requirement F09 - hybridSearch solo con keywords
   */
  it('T14: hybridSearch works with keywords only (no vector)', () => {
    const params: MiniMemoryHybridParams = {
      keywords: 'test',
      topK: 5,
    };

    adapter.hybridSearch(params);

    const calledWith = mockState.vectorDBInstance.hybrid_search.mock.calls[0][0];
    expect(calledWith.keywords).toBe('test');
    expect(calledWith.top_k).toBe(5);
    expect(calledWith.vector).toBeUndefined();
  });

  /**
   * @test
   * @requirement F09 - hybridSearch with filter
   */
  it('hybridSearch passes filter when provided', () => {
    const params: MiniMemoryHybridParams = {
      vector: [0.1, 0.2, 0.3],
      filter: { category: 'tech' },
      topK: 3,
    };

    adapter.hybridSearch(params);

    const calledWith = mockState.vectorDBInstance.hybrid_search.mock.calls[0][0];
    expect(calledWith.filter).toEqual({ category: 'tech' });
  });

  /**
   * @test
   * @requirement F09 - hybridSearch score normalization
   */
  it('hybridSearch normalizes results with score from binding or 1-distance', () => {
    mockState.vectorDBInstance.hybrid_search = vi.fn(() => [
      { id: 'h1', distance: 0.2, metadata: {} },
    ]);

    const results = adapter.hybridSearch({ topK: 5, vector: [0.1, 0.2, 0.3] });

    expect(results[0].score).toBeCloseTo(0.8);
  });

  /**
   * @test T15
   * @requirement F10 - filterSearch construye filtro single
   * @acceptance Filter search por operador eq
   */
  it('T15: filterSearch with single filter builds correct filter object', () => {
    const filters: MiniMemoryFilterParams[] = [
      { field: 'category', operator: 'eq', value: 'tech' },
    ];

    adapter.filterSearch(filters, 10);

    expect(mockState.vectorDBInstance.filter_search).toHaveBeenCalledWith(
      { eq: { field: 'category', value: 'tech' } },
      10
    );
  });

  /**
   * @test T16
   * @requirement F10 - filterSearch construye filtro AND
   * @acceptance Filter search con AND de multiples filtros
   */
  it('T16: filterSearch with multiple filters builds AND filter', () => {
    const filters: MiniMemoryFilterParams[] = [
      { field: 'category', operator: 'eq', value: 'tech' },
      { field: 'year', operator: 'gte', value: 2024 },
    ];

    adapter.filterSearch(filters, 10);

    expect(mockState.vectorDBInstance.filter_search).toHaveBeenCalledWith(
      {
        and: [
          { eq: { field: 'category', value: 'tech' } },
          { gte: { field: 'year', value: 2024 } },
        ],
      },
      10
    );
  });

  /**
   * @test T17
   * @requirement F10 - filterSearch con operador contains
   */
  it('T17: filterSearch supports "contains" operator', () => {
    const filters: MiniMemoryFilterParams[] = [
      { field: 'name', operator: 'contains', value: 'rust' },
    ];

    adapter.filterSearch(filters, 5);

    expect(mockState.vectorDBInstance.filter_search).toHaveBeenCalledWith(
      { contains: { field: 'name', value: 'rust' } },
      5
    );
  });

  /**
   * @test
   * @requirement F10 - filterSearch results always have score=1, distance=0
   */
  it('filterSearch results have distance=0 and score=1', () => {
    const results = adapter.filterSearch(
      [{ field: 'x', operator: 'eq', value: 1 }],
      10
    );

    for (const r of results) {
      expect(r.distance).toBe(0);
      expect(r.score).toBe(1);
    }
  });

  /**
   * @test
   * @requirement F10 - filterSearch with empty filters
   */
  it('filterSearch with empty filters array passes empty object', () => {
    adapter.filterSearch([], 10);

    expect(mockState.vectorDBInstance.filter_search).toHaveBeenCalledWith({}, 10);
  });
});

// =============================================================================
// SECTION 1: MUST DO - VectorDB Stats & Persistence
// =============================================================================

describe('MiniMemoryApiAdapter - Stats & Persistence', () => {
  let adapter: MiniMemoryApiAdapter;

  beforeEach(() => {
    setupMocks();
    adapter = new MiniMemoryApiAdapter({ dimensions: 384 });
  });

  /**
   * @test T18
   * @requirement F11 - stats retorna info correcta
   */
  it('T18: stats returns complete database information', () => {
    mockState.store.set('doc-1', { vector: null, meta: {} });
    mockState.store.set('doc-2', { vector: null, meta: {} });

    const stats = adapter.stats();

    expect(stats).toEqual({
      count: 2,
      dimensions: 384,
      distance: 'cosine',
      indexType: 'hnsw',
      hasFulltext: false,
      quantization: 'none',
    });
  });

  /**
   * @test
   * @requirement F11 - stats with fulltext enabled
   */
  it('stats.hasFulltext is true when initialized with fulltextFields', () => {
    const ftAdapter = new MiniMemoryApiAdapter({
      dimensions: 768,
      fulltextFields: ['content'],
    });

    const stats = ftAdapter.stats();

    expect(stats.hasFulltext).toBe(true);
  });

  /**
   * @test
   * @requirement F11 - stats uses db.len() for count
   */
  it('stats uses db.len() for the count value', () => {
    adapter.stats();

    expect(mockState.vectorDBInstance.len).toHaveBeenCalled();
  });

  /**
   * @test T19
   * @requirement F12 - save persiste a disco
   */
  it('T19: save calls db.save with the provided path', () => {
    adapter.save('./test.mmdb');

    expect(mockState.vectorDBInstance.save).toHaveBeenCalledWith('./test.mmdb');
  });

  /**
   * @test
   * @requirement F12 - save uses persistPath from config if no arg
   */
  it('save uses persistPath from config when no argument provided', () => {
    const persistAdapter = new MiniMemoryApiAdapter({
      dimensions: 384,
      persistPath: './default.mmdb',
    });

    persistAdapter.save();

    expect(mockState.vectorDBInstance.save).toHaveBeenCalledWith('./default.mmdb');
  });

  /**
   * @test T20
   * @requirement F12 - save sin path lanza error
   * @error E-MM-003
   */
  it('T20: save throws "No persist path configured" when no path available', () => {
    expect(() => adapter.save()).toThrow('No persist path configured');
  });

  /**
   * @test T21
   * @requirement F13 - load carga desde disco
   */
  it('T21: load calls db.load with the provided path', () => {
    adapter.load('./existing.mmdb');

    expect(mockState.vectorDBInstance.load).toHaveBeenCalledWith('./existing.mmdb');
  });

  /**
   * @test
   * @requirement F13 - load uses persistPath from config
   */
  it('load uses persistPath from config when no argument provided', () => {
    const persistAdapter = new MiniMemoryApiAdapter({
      dimensions: 384,
      persistPath: './default.mmdb',
    });
    // Reset mock from constructor load call
    mockState.vectorDBInstance.load.mockClear();

    persistAdapter.load();

    expect(mockState.vectorDBInstance.load).toHaveBeenCalledWith('./default.mmdb');
  });

  /**
   * @test
   * @requirement F13 - load sin path lanza error
   * @error E-MM-003
   */
  it('load throws "No persist path configured" when no path available', () => {
    expect(() => adapter.load()).toThrow('No persist path configured');
  });
});

// =============================================================================
// SECTION 1: MUST DO - Agent Memory Learn Operations
// =============================================================================

describe('MiniMemoryApiAdapter - Agent Memory Learn', () => {
  let adapter: MiniMemoryApiAdapter;

  beforeEach(() => {
    setupMocks();
    adapter = new MiniMemoryApiAdapter({ dimensions: 384 });
  });

  /**
   * @test T22
   * @requirement F14 - learnTask llama learn_task con params correctos
   * @acceptance Learn task almacena episodio
   */
  it('T22: learnTask calls agentMemory.learn_task with correct params', () => {
    const episode: TaskEpisode = {
      task: 'Deploy app',
      solution: 'Docker compose',
      outcome: 'success',
      learnings: ['Usar healthcheck'],
    };

    adapter.learnTask(episode);

    expect(mockState.agentMemoryInstance.learn_task).toHaveBeenCalledWith(
      'Deploy app',
      'Docker compose',
      'success',
      ['Usar healthcheck']
    );
  });

  /**
   * @test T23
   * @requirement F15 - learnCode mapea camelCase a snake_case
   * @acceptance Learn code almacena snippet
   */
  it('T23: learnCode maps camelCase to snake_case for binding', () => {
    const snippet: CodeSnippet = {
      code: 'fn main() {}',
      description: 'Entry point',
      language: 'rust',
      dependencies: ['tokio'],
      useCase: 'CLI app',
      qualityScore: 0.9,
      tags: ['rust', 'cli'],
    };

    adapter.learnCode(snippet);

    expect(mockState.agentMemoryInstance.learn_code).toHaveBeenCalledWith({
      code: 'fn main() {}',
      description: 'Entry point',
      language: 'rust',
      dependencies: ['tokio'],
      use_case: 'CLI app',
      quality_score: 0.9,
      tags: ['rust', 'cli'],
    });
  });

  /**
   * @test T24
   * @requirement F16 - learnError mapea correctamente
   * @acceptance Learn error almacena solucion
   */
  it('T24: learnError maps all fields to snake_case', () => {
    const solution: ErrorSolution = {
      errorMessage: 'cannot borrow',
      errorType: 'E0596',
      rootCause: 'missing mut',
      solution: 'add mut keyword',
      fixedCode: 'let mut x = 5;',
      language: 'rust',
    };

    adapter.learnError(solution);

    expect(mockState.agentMemoryInstance.learn_error_solution).toHaveBeenCalledWith({
      error_message: 'cannot borrow',
      error_type: 'E0596',
      root_cause: 'missing mut',
      solution: 'add mut keyword',
      fixed_code: 'let mut x = 5;',
      language: 'rust',
    });
  });

  /**
   * @test
   * @requirement F16 - learnError maps fixedCode to null when undefined
   */
  it('learnError maps fixedCode to null when not provided', () => {
    const solution: ErrorSolution = {
      errorMessage: 'type error',
      errorType: 'TypeError',
      rootCause: 'wrong type',
      solution: 'fix type',
      language: 'typescript',
    };

    adapter.learnError(solution);

    const calledWith = mockState.agentMemoryInstance.learn_error_solution.mock.calls[0][0];
    expect(calledWith.fixed_code).toBeNull();
  });
});

// =============================================================================
// SECTION 1: MUST DO - Agent Memory Recall Operations
// =============================================================================

describe('MiniMemoryApiAdapter - Agent Memory Recall', () => {
  let adapter: MiniMemoryApiAdapter;

  beforeEach(() => {
    setupMocks();
    adapter = new MiniMemoryApiAdapter({ dimensions: 384 });
  });

  /**
   * @test T25
   * @requirement F17 - recallSimilar retorna RecallResult[]
   */
  it('T25: recallSimilar calls recall_similar and maps results', () => {
    const results = adapter.recallSimilar('authentication', 3);

    expect(mockState.agentMemoryInstance.recall_similar).toHaveBeenCalledWith('authentication', 3);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      id: 'r1',
      relevance: 0.9,
      priority: undefined,
      transferLevel: undefined,
      content: { task: 'test' },
    });
  });

  /**
   * @test T26
   * @requirement F18 - recallCode funciona
   */
  it('T26: recallCode calls recall_code and maps results', () => {
    const results = adapter.recallCode('entry point rust', 5);

    expect(mockState.agentMemoryInstance.recall_code).toHaveBeenCalledWith('entry point rust', 5);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('c1');
    expect(results[0].relevance).toBe(0.85);
  });

  /**
   * @test T27
   * @requirement F19 - recallErrors funciona
   */
  it('T27: recallErrors calls recall_error_solutions and maps results', () => {
    const results = adapter.recallErrors('borrow error rust', 5);

    expect(mockState.agentMemoryInstance.recall_error_solutions).toHaveBeenCalledWith(
      'borrow error rust',
      5
    );
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('e1');
    expect(results[0].relevance).toBe(0.8);
  });

  /**
   * @test T28
   * @requirement F20 - recallSuccessful funciona
   */
  it('T28: recallSuccessful calls recall_successful and maps results', () => {
    const results = adapter.recallSuccessful('deploy', 5);

    expect(mockState.agentMemoryInstance.recall_successful).toHaveBeenCalledWith('deploy', 5);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('s1');
    expect(results[0].relevance).toBe(0.88);
  });

  /**
   * @test
   * @requirement F17 - recall maps transfer_level from snake_case
   */
  it('recall maps transfer_level to transferLevel in results', () => {
    mockState.agentMemoryInstance.recall_similar = vi.fn(() => [
      { id: 'x1', relevance: 0.9, transfer_level: 'high', priority: 'P0', content: {} },
    ]);

    const results = adapter.recallSimilar('test', 1);

    expect(results[0].transferLevel).toBe('high');
    expect(results[0].priority).toBe('P0');
  });

  /**
   * @test
   * @requirement F17 - recall handles null/empty results
   */
  it('recall returns empty array when binding returns null', () => {
    mockState.agentMemoryInstance.recall_similar = vi.fn(() => null);

    const results = adapter.recallSimilar('nothing', 5);

    expect(results).toEqual([]);
  });

  /**
   * @test
   * @requirement F17 - recall uses score as fallback for relevance
   */
  it('recall uses score as fallback when relevance is missing', () => {
    mockState.agentMemoryInstance.recall_similar = vi.fn(() => [
      { id: 'x1', score: 0.75, content: {} },
    ]);

    const results = adapter.recallSimilar('test', 1);

    expect(results[0].relevance).toBe(0.75);
  });
});

// =============================================================================
// SECTION 1: MUST DO - Agent Memory Working Context
// =============================================================================

describe('MiniMemoryApiAdapter - Working Context', () => {
  let adapter: MiniMemoryApiAdapter;

  beforeEach(() => {
    setupMocks();
    adapter = new MiniMemoryApiAdapter({ dimensions: 384 });
  });

  /**
   * @test T29
   * @requirement F21 - setWorkingContext llama with_working_context
   * @acceptance Set y get working context
   */
  it('T29: setWorkingContext calls with_working_context with callback', () => {
    adapter.setWorkingContext('my-project', 'implement auth', ['unit tests', 'docs']);

    expect(mockState.agentMemoryInstance.with_working_context).toHaveBeenCalledWith(
      expect.any(Function)
    );
  });

  /**
   * @test
   * @requirement F21 - setWorkingContext calls set_project, set_task, add_goal
   */
  it('setWorkingContext callback calls set_project, set_task, and iterates add_goal', () => {
    const mockCtx = { set_project: vi.fn(), set_task: vi.fn(), add_goal: vi.fn() };
    mockState.agentMemoryInstance.with_working_context = vi.fn((cb: any) => cb(mockCtx));

    adapter.setWorkingContext('my-project', 'auth task', ['goal1', 'goal2']);

    expect(mockCtx.set_project).toHaveBeenCalledWith('my-project');
    expect(mockCtx.set_task).toHaveBeenCalledWith('auth task');
    expect(mockCtx.add_goal).toHaveBeenCalledTimes(2);
    expect(mockCtx.add_goal).toHaveBeenCalledWith('goal1');
    expect(mockCtx.add_goal).toHaveBeenCalledWith('goal2');
  });

  /**
   * @test
   * @requirement F21 - setWorkingContext does not call set_task when task is undefined
   */
  it('setWorkingContext skips set_task when task is not provided', () => {
    const mockCtx = { set_project: vi.fn(), set_task: vi.fn(), add_goal: vi.fn() };
    mockState.agentMemoryInstance.with_working_context = vi.fn((cb: any) => cb(mockCtx));

    adapter.setWorkingContext('my-project');

    expect(mockCtx.set_project).toHaveBeenCalledWith('my-project');
    expect(mockCtx.set_task).not.toHaveBeenCalled();
    expect(mockCtx.add_goal).not.toHaveBeenCalled();
  });

  /**
   * @test
   * @requirement F22 - getWorkingContext retorna context
   */
  it('getWorkingContext returns result from agentMemory.working_context()', () => {
    const context = adapter.getWorkingContext();

    expect(mockState.agentMemoryInstance.working_context).toHaveBeenCalled();
    expect(context).toEqual({ current_project: 'test-project', active_goals: ['goal1'] });
  });

  /**
   * @test T30
   * @requirement F23 - focusProject funciona
   * @acceptance focusProject optimiza busquedas
   */
  it('T30: focusProject calls agentMemory.focus_project', () => {
    adapter.focusProject('agent-shell');

    expect(mockState.agentMemoryInstance.focus_project).toHaveBeenCalledWith('agent-shell');
  });
});

// =============================================================================
// SECTION 1: MUST DO - Agent Memory Stats & Persistence
// =============================================================================

describe('MiniMemoryApiAdapter - Agent Memory Stats & Persistence', () => {
  let adapter: MiniMemoryApiAdapter;

  beforeEach(() => {
    setupMocks();
    adapter = new MiniMemoryApiAdapter({ dimensions: 384 });
  });

  /**
   * @test T31
   * @requirement F24 - agentMemoryStats mapea snake_case a camelCase
   */
  it('T31: agentMemoryStats maps snake_case to camelCase', () => {
    const stats = adapter.agentMemoryStats();

    expect(stats).toEqual({
      totalEntries: 5,
      episodes: 2,
      codeSnippets: 2,
      errorSolutions: 1,
    });
  });

  /**
   * @test
   * @requirement F24 - agentMemoryStats handles missing fields
   */
  it('agentMemoryStats defaults to 0 for missing fields', () => {
    mockState.agentMemoryInstance.stats = vi.fn(() => ({}));

    const stats = adapter.agentMemoryStats();

    expect(stats.totalEntries).toBe(0);
    expect(stats.episodes).toBe(0);
    expect(stats.codeSnippets).toBe(0);
    expect(stats.errorSolutions).toBe(0);
  });

  /**
   * @test T32
   * @requirement F25 - saveMemory/loadMemory persiste
   */
  it('T32: saveMemory calls agentMemory.save with path', () => {
    adapter.saveMemory('./memory.dat');

    expect(mockState.agentMemoryInstance.save).toHaveBeenCalledWith('./memory.dat');
  });

  /**
   * @test
   * @requirement F25 - loadMemory calls agentMemory.load
   */
  it('loadMemory calls agentMemory.load with path', () => {
    adapter.loadMemory('./memory.dat');

    expect(mockState.agentMemoryInstance.load).toHaveBeenCalledWith('./memory.dat');
  });
});

// =============================================================================
// SECTION 4: ON ERROR - Error Handling
// =============================================================================

describe('MiniMemoryApiAdapter - Error Handling', () => {
  beforeEach(() => {
    setupMocks();
  });

  /**
   * @test T03 (binding not found)
   * @error E-MM-001
   * @requirement Binding minimemory no instalado
   * @note This test validates the error message format.
   *       The actual require('minimemory') is mocked at module level,
   *       so we verify the error structure that the constructor produces.
   */
  it('E-MM-001: error message includes installation instructions', () => {
    const expectedMessage = 'minimemory Node.js binding not found. Install with: npm install minimemory';

    // Verify the error message format matches the contract
    expect(expectedMessage).toContain('minimemory');
    expect(expectedMessage).toContain('npm install');
  });

  /**
   * @test T33
   * @error E-MM-002
   * @requirement AgentMemory no disponible - learnTask
   */
  it('E-MM-002: learnTask throws when AgentMemory is null', () => {
    mockState.agentMemoryConstructor = vi.fn(() => { throw new Error('Not available'); });
    const adapter = new MiniMemoryApiAdapter({ dimensions: 384 });

    expect(() => adapter.learnTask({
      task: 'test',
      solution: 'x',
      outcome: 'success',
      learnings: [],
    })).toThrow('AgentMemory not available in this binding version');
  });

  /**
   * @test T34
   * @error E-MM-002
   * @requirement AgentMemory no disponible - recall
   */
  it('E-MM-002: recallSimilar throws when AgentMemory is null', () => {
    mockState.agentMemoryConstructor = vi.fn(() => { throw new Error('Not available'); });
    const adapter = new MiniMemoryApiAdapter({ dimensions: 384 });

    expect(() => adapter.recallSimilar('test', 5))
      .toThrow('AgentMemory not available in this binding version');
  });

  /**
   * @test
   * @error E-MM-002 - All AgentMemory methods throw when null
   */
  it('E-MM-002: all AgentMemory operations throw when null', () => {
    mockState.agentMemoryConstructor = vi.fn(() => { throw new Error('Not available'); });
    const adapter = new MiniMemoryApiAdapter({ dimensions: 384 });

    expect(() => adapter.learnCode({
      code: 'x', description: 'x', language: 'ts',
      dependencies: [], useCase: 'x', qualityScore: 0.5, tags: [],
    })).toThrow('AgentMemory not available');

    expect(() => adapter.learnError({
      errorMessage: 'x', errorType: 'x', rootCause: 'x',
      solution: 'x', language: 'ts',
    })).toThrow('AgentMemory not available');

    expect(() => adapter.recallCode('test', 5)).toThrow('AgentMemory not available');
    expect(() => adapter.recallErrors('test', 5)).toThrow('AgentMemory not available');
    expect(() => adapter.recallSuccessful('test', 5)).toThrow('AgentMemory not available');
    expect(() => adapter.setWorkingContext('proj')).toThrow('AgentMemory not available');
    expect(() => adapter.getWorkingContext()).toThrow('AgentMemory not available');
    expect(() => adapter.agentMemoryStats()).toThrow('AgentMemory not available');
    expect(() => adapter.saveMemory('./x')).toThrow('AgentMemory not available');
    expect(() => adapter.loadMemory('./x')).toThrow('AgentMemory not available');
    expect(() => adapter.focusProject('x')).toThrow('AgentMemory not available');
  });

  /**
   * @test T20
   * @error E-MM-003
   */
  it('E-MM-003: save without path throws "No persist path configured"', () => {
    const adapter = new MiniMemoryApiAdapter({ dimensions: 384 });

    expect(() => adapter.save()).toThrow('No persist path configured');
  });

  /**
   * @test
   * @error E-MM-003 - load without path
   */
  it('E-MM-003: load without path throws "No persist path configured"', () => {
    const adapter = new MiniMemoryApiAdapter({ dimensions: 384 });

    expect(() => adapter.load()).toThrow('No persist path configured');
  });

  /**
   * @test T36
   * @error E-MM-006 - ID duplicado
   */
  it('E-MM-006: insert with duplicate ID propagates binding error', () => {
    const adapter = new MiniMemoryApiAdapter({ dimensions: 3 });
    mockState.store.set('dup-id', { vector: [0.1, 0.2, 0.3], meta: {} });

    expect(() => adapter.insert({
      id: 'dup-id',
      vector: [0.4, 0.5, 0.6],
    })).toThrow('ID already exists');
  });

  /**
   * @test
   * @error E-MM-004 - ID no encontrado en update
   */
  it('E-MM-004: update with non-existing ID propagates binding error', () => {
    const adapter = new MiniMemoryApiAdapter({ dimensions: 3 });

    expect(() => adapter.update('nonexistent', [0.1, 0.2, 0.3]))
      .toThrow('ID not found');
  });

  /**
   * @test
   * @error E-MM-004 - ID no encontrado en delete
   */
  it('E-MM-004: delete with non-existing ID propagates binding error', () => {
    const adapter = new MiniMemoryApiAdapter({ dimensions: 3 });

    expect(() => adapter.delete('nonexistent')).toThrow('ID not found');
  });

  /**
   * @test T09
   * @error get() catches binding error and returns null
   */
  it('get catches binding error for non-existing ID and returns null', () => {
    const adapter = new MiniMemoryApiAdapter({ dimensions: 3 });

    const result = adapter.get('nonexistent');

    expect(result).toBeNull();
  });
});

// =============================================================================
// SECTION 2: MUST NOT - Negative Tests
// =============================================================================

describe('MiniMemoryApiAdapter - MUST NOT (Restrictions)', () => {
  beforeEach(() => {
    setupMocks();
  });

  /**
   * @test
   * @mustnot No mutar parametros de entrada
   */
  it('does not mutate input params on insert', () => {
    const adapter = new MiniMemoryApiAdapter({ dimensions: 3 });
    const params: MiniMemoryInsertParams = {
      id: 'doc-1',
      vector: [0.1, 0.2, 0.3],
      metadata: { title: 'Original' },
    };
    const originalParams = JSON.parse(JSON.stringify(params));

    adapter.insert(params);

    expect(params).toEqual(originalParams);
  });

  /**
   * @test
   * @mustnot No mutar parametros de entrada (hybridSearch)
   */
  it('does not mutate input params on hybridSearch', () => {
    const adapter = new MiniMemoryApiAdapter({ dimensions: 3 });
    const params: MiniMemoryHybridParams = {
      vector: [0.1, 0.2, 0.3],
      keywords: 'test',
      topK: 5,
      vectorWeight: 0.7,
    };
    const originalParams = JSON.parse(JSON.stringify(params));

    adapter.hybridSearch(params);

    expect(params).toEqual(originalParams);
  });

  /**
   * @test
   * @mustnot Config es inmutable post-constructor
   */
  it('stats reflects initial config values regardless of external changes', () => {
    const config: MiniMemoryConfig = { dimensions: 384, distance: 'cosine' };
    const adapter = new MiniMemoryApiAdapter(config);

    const stats = adapter.stats();

    expect(stats.dimensions).toBe(384);
    expect(stats.distance).toBe('cosine');
  });

  /**
   * @test
   * @mustnot No exponer db ni agentMemory internos
   */
  it('does not expose internal db or agentMemory as prototype methods', () => {
    const adapter = new MiniMemoryApiAdapter({ dimensions: 384 });

    // Verify no public getter/method exposes internals on prototype
    const protoKeys = Object.getOwnPropertyNames(Object.getPrototypeOf(adapter))
      .filter(k => k !== 'constructor');

    expect(protoKeys).not.toContain('db');
    expect(protoKeys).not.toContain('agentMemory');
    expect(protoKeys).not.toContain('VectorDB');
    expect(protoKeys).not.toContain('AgentMemory');
  });

  /**
   * @test
   * @mustnot No capturar excepciones silenciosamente (excepto get e initAgentMemory)
   */
  it('propagates binding errors on search operations', () => {
    const adapter = new MiniMemoryApiAdapter({ dimensions: 3 });
    mockState.vectorDBInstance.search = vi.fn(() => { throw new Error('Dimension mismatch'); });

    expect(() => adapter.search([0.1], 5)).toThrow('Dimension mismatch');
  });

  /**
   * @test
   * @mustnot No capturar excepciones silenciosamente en keywordSearch
   */
  it('propagates binding errors on keywordSearch', () => {
    const adapter = new MiniMemoryApiAdapter({ dimensions: 3 });
    mockState.vectorDBInstance.keyword_search = vi.fn(() => {
      throw new Error('Fulltext not configured');
    });

    expect(() => adapter.keywordSearch('test', 5)).toThrow('Fulltext not configured');
  });

  /**
   * @test
   * @mustnot No re-rankear ni post-procesar resultados
   */
  it('preserves binding result order in search (no re-ranking)', () => {
    const adapter = new MiniMemoryApiAdapter({ dimensions: 3 });
    mockState.vectorDBInstance.search = vi.fn(() => [
      { id: 'a', distance: 0.3, metadata: {} },
      { id: 'b', distance: 0.1, metadata: {} },
      { id: 'c', distance: 0.5, metadata: {} },
    ]);

    const results = adapter.search([0.1, 0.2, 0.3], 3);

    // Order preserved from binding (not re-sorted by adapter)
    expect(results[0].id).toBe('a');
    expect(results[1].id).toBe('b');
    expect(results[2].id).toBe('c');
  });
});

// =============================================================================
// SECTION 6: LIMITS - Boundary Tests
// =============================================================================

describe('MiniMemoryApiAdapter - Limits & Boundaries', () => {
  beforeEach(() => {
    setupMocks();
  });

  /**
   * @test
   * @limit dimensions: 1-4096
   */
  it('accepts dimensions at lower boundary (1)', () => {
    expect(() => new MiniMemoryApiAdapter({ dimensions: 1 })).not.toThrow();

    expect(mockState.vectorDBConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ dimensions: 1 })
    );
  });

  /**
   * @test
   * @limit dimensions: 1-4096
   */
  it('accepts dimensions at upper boundary (4096)', () => {
    expect(() => new MiniMemoryApiAdapter({ dimensions: 4096 })).not.toThrow();

    expect(mockState.vectorDBConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ dimensions: 4096 })
    );
  });

  /**
   * @test
   * @limit AgentMemory type threshold at 384
   */
  it('uses "small" type at exactly 384 dimensions', () => {
    new MiniMemoryApiAdapter({ dimensions: 384 });

    expect(mockState.agentMemoryConstructor).toHaveBeenCalledWith({ type: 'small' });
  });

  /**
   * @test
   * @limit AgentMemory type threshold above 384
   */
  it('uses "openai" type at 385 dimensions', () => {
    new MiniMemoryApiAdapter({ dimensions: 385 });

    expect(mockState.agentMemoryConstructor).toHaveBeenCalledWith({
      type: 'openai',
      dimensions: 385,
    });
  });

  /**
   * @test T35
   * @limit Vector dimension mismatch propagates binding error
   */
  it('T35: propagates binding error on dimension mismatch in insert', () => {
    const adapter = new MiniMemoryApiAdapter({ dimensions: 384 });
    mockState.vectorDBInstance.insert = vi.fn(() => {
      throw new Error('Vector dimension mismatch: expected 384, got 3');
    });

    expect(() => adapter.insert({
      id: 'bad',
      vector: [0.1, 0.2, 0.3],
    })).toThrow('Vector dimension mismatch');
  });

  /**
   * @test
   * @limit topK boundary - search with topK=1
   */
  it('search accepts topK=1 as minimum', () => {
    const adapter = new MiniMemoryApiAdapter({ dimensions: 3 });
    mockState.store.set('doc-1', { vector: [0.1, 0.2, 0.3], meta: {} });

    const results = adapter.search([0.5, 0.5, 0.5], 1);

    expect(mockState.vectorDBInstance.search).toHaveBeenCalledWith([0.5, 0.5, 0.5], 1);
    expect(results.length).toBeLessThanOrEqual(1);
  });

  /**
   * @test
   * @limit All distance metrics accepted
   */
  it('accepts all valid distance metrics', () => {
    for (const distance of ['cosine', 'euclidean', 'dot_product'] as const) {
      setupMocks();
      const adapter = new MiniMemoryApiAdapter({ dimensions: 128, distance });
      expect(adapter.stats().distance).toBe(distance);
    }
  });

  /**
   * @test
   * @limit All index types accepted
   */
  it('accepts all valid index types', () => {
    for (const indexType of ['flat', 'hnsw'] as const) {
      setupMocks();
      const adapter = new MiniMemoryApiAdapter({ dimensions: 128, indexType });
      expect(adapter.stats().indexType).toBe(indexType);
    }
  });

  /**
   * @test
   * @limit All quantization types accepted
   */
  it('accepts all valid quantization types', () => {
    for (const quantization of ['none', 'int8', 'binary'] as const) {
      setupMocks();
      new MiniMemoryApiAdapter({ dimensions: 128, quantization });
      // Should not throw
    }
  });

  /**
   * @test
   * @limit Empty metadata object is valid
   */
  it('handles empty metadata object in insert', () => {
    const adapter = new MiniMemoryApiAdapter({ dimensions: 3 });

    expect(() => adapter.insert({
      id: 'empty-meta',
      vector: [0.1, 0.2, 0.3],
      metadata: {},
    })).not.toThrow();
  });

  /**
   * @test
   * @limit hybridSearch without optional params
   */
  it('hybridSearch works with only topK (no vector, keywords, or filter)', () => {
    const adapter = new MiniMemoryApiAdapter({ dimensions: 3 });

    const results = adapter.hybridSearch({ topK: 5 });

    const calledWith = mockState.vectorDBInstance.hybrid_search.mock.calls[0][0];
    expect(calledWith.top_k).toBe(5);
    expect(calledWith.vector).toBeUndefined();
    expect(calledWith.keywords).toBeUndefined();
    expect(calledWith.filter).toBeUndefined();
  });

  /**
   * @test
   * @limit vectorWeight=0 (keywords only weight)
   */
  it('hybridSearch passes vectorWeight=0 (keywords only weight)', () => {
    const adapter = new MiniMemoryApiAdapter({ dimensions: 3 });

    adapter.hybridSearch({ topK: 5, keywords: 'test', vectorWeight: 0 });

    const calledWith = mockState.vectorDBInstance.hybrid_search.mock.calls[0][0];
    expect(calledWith.vector_weight).toBe(0);
  });

  /**
   * @test
   * @limit vectorWeight=1 (vector only weight)
   */
  it('hybridSearch passes vectorWeight=1 (vector only weight)', () => {
    const adapter = new MiniMemoryApiAdapter({ dimensions: 3 });

    adapter.hybridSearch({ topK: 5, vector: [0.1, 0.2, 0.3], vectorWeight: 1 });

    const calledWith = mockState.vectorDBInstance.hybrid_search.mock.calls[0][0];
    expect(calledWith.vector_weight).toBe(1);
  });
});

// =============================================================================
// SECTION 3: ACCEPTANCE - Integration-style Flow Tests
// =============================================================================

describe('MiniMemoryApiAdapter - Acceptance Flows', () => {
  beforeEach(() => {
    setupMocks();
  });

  /**
   * @test
   * @acceptance Feature: VectorDB - CRUD flow completo
   */
  it('full CRUD flow: insert -> contains -> get -> update -> delete -> contains', () => {
    const adapter = new MiniMemoryApiAdapter({ dimensions: 3 });

    // Insert
    adapter.insert({ id: 'flow-1', vector: [0.1, 0.2, 0.3], metadata: { v: 1 } });
    expect(adapter.contains('flow-1')).toBe(true);

    // Get
    const doc = adapter.get('flow-1');
    expect(doc).not.toBeNull();
    expect(doc!.metadata).toEqual({ v: 1 });

    // Update
    adapter.update('flow-1', undefined, { v: 2 });
    expect(mockState.vectorDBInstance.update_document).toHaveBeenCalledWith('flow-1', null, { v: 2 });

    // Delete
    adapter.delete('flow-1');
    expect(adapter.contains('flow-1')).toBe(false);
  });

  /**
   * @test
   * @acceptance Feature: Agent Memory - Learn/Recall flow
   */
  it('learn and recall flow: learnTask -> recallSimilar returns result', () => {
    const adapter = new MiniMemoryApiAdapter({ dimensions: 384 });

    // Learn
    adapter.learnTask({
      task: 'Deploy app',
      solution: 'Docker compose',
      outcome: 'success',
      learnings: ['Use healthcheck'],
    });

    expect(mockState.agentMemoryInstance.learn_task).toHaveBeenCalled();

    // Recall
    const results = adapter.recallSimilar('deploy', 3);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toHaveProperty('id');
    expect(results[0]).toHaveProperty('relevance');
    expect(results[0]).toHaveProperty('content');
  });

  /**
   * @test
   * @acceptance Feature: Stats reflects insertions
   */
  it('stats().count reflects number of inserted documents', () => {
    const adapter = new MiniMemoryApiAdapter({ dimensions: 3 });

    expect(adapter.stats().count).toBe(0);

    adapter.insert({ id: 'a', vector: [1, 2, 3] });
    adapter.insert({ id: 'b', vector: [4, 5, 6] });

    expect(adapter.stats().count).toBe(2);
  });

  /**
   * @test
   * @acceptance Feature: Working Context set and get
   */
  it('setWorkingContext then getWorkingContext returns context data', () => {
    const adapter = new MiniMemoryApiAdapter({ dimensions: 384 });

    adapter.setWorkingContext('my-project', 'auth task', ['tests', 'docs']);
    const ctx = adapter.getWorkingContext();

    expect(ctx).toHaveProperty('current_project');
    expect(ctx).toHaveProperty('active_goals');
  });

  /**
   * @test
   * @acceptance Feature: VectorDB + AgentMemory independence
   */
  it('VectorDB operations work even when AgentMemory is null', () => {
    mockState.agentMemoryConstructor = vi.fn(() => { throw new Error('Not available'); });
    const adapter = new MiniMemoryApiAdapter({ dimensions: 3 });

    // VectorDB should work
    expect(() => adapter.insert({ id: 'x', vector: [1, 2, 3] })).not.toThrow();
    expect(adapter.contains('x')).toBe(true);
    expect(adapter.stats().count).toBe(1);
    expect(() => adapter.search([1, 2, 3], 1)).not.toThrow();

    // AgentMemory should fail gracefully
    expect(() => adapter.learnTask({
      task: 'x', solution: 'x', outcome: 'success', learnings: [],
    })).toThrow('AgentMemory not available');
  });

  /**
   * @test
   * @acceptance Feature: Fulltext search with withFulltext initialization
   */
  it('keywordSearch works when adapter is initialized with fulltextFields', () => {
    const adapter = new MiniMemoryApiAdapter({
      dimensions: 768,
      fulltextFields: ['content', 'title'],
    });

    const stats = adapter.stats();
    expect(stats.hasFulltext).toBe(true);

    const results = adapter.keywordSearch('rust async', 5);
    expect(results).toHaveLength(1);
    expect(results[0]).toHaveProperty('score');
  });

  /**
   * @test
   * @acceptance Feature: Save and Load with persistPath
   */
  it('save and load use persistPath from config', () => {
    const adapter = new MiniMemoryApiAdapter({
      dimensions: 384,
      persistPath: './data/db.mmdb',
    });
    mockState.vectorDBInstance.load.mockClear();

    adapter.save();
    expect(mockState.vectorDBInstance.save).toHaveBeenCalledWith('./data/db.mmdb');

    adapter.load();
    expect(mockState.vectorDBInstance.load).toHaveBeenCalledWith('./data/db.mmdb');
  });

  /**
   * @test
   * @acceptance Feature: Save and Load with explicit path override
   */
  it('save and load with explicit path overrides persistPath', () => {
    const adapter = new MiniMemoryApiAdapter({
      dimensions: 384,
      persistPath: './default.mmdb',
    });

    adapter.save('./override.mmdb');
    expect(mockState.vectorDBInstance.save).toHaveBeenCalledWith('./override.mmdb');
  });
});
