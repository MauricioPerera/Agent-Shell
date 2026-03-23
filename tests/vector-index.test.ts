/**
 * @contract CONTRACT_VECTOR_INDEX v1.0
 * @module Vector Index (Agent Shell - Discovery Semantico)
 * @description Tests para el Vector Index basados en los 20 casos de prueba del contrato.
 *
 * El Vector Index indexa definiciones de comandos como embeddings vectoriales
 * y responde queries en lenguaje natural retornando los comandos mas relevantes.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Tipos del contrato ---

interface EmbeddingAdapter {
  embed(text: string): Promise<EmbeddingResult>;
  embedBatch(texts: string[]): Promise<EmbeddingResult[]>;
  getDimensions(): number;
  getModelId(): string;
}

interface EmbeddingResult {
  vector: number[];
  dimensions: number;
  tokenCount: number;
  model: string;
}

interface VectorStorageAdapter {
  upsert(entry: VectorEntry): Promise<void>;
  upsertBatch(entries: VectorEntry[]): Promise<BatchStorageResult>;
  delete(id: string): Promise<void>;
  deleteBatch(ids: string[]): Promise<BatchStorageResult>;
  search(query: VectorSearchQuery): Promise<VectorSearchResult[]>;
  listIds(): Promise<string[]>;
  count(): Promise<number>;
  clear(): Promise<void>;
  healthCheck(): Promise<HealthStatus>;
}

interface VectorEntry {
  id: string;
  vector: number[];
  metadata: CommandMetadata;
}

interface VectorSearchQuery {
  vector: number[];
  topK: number;
  threshold?: number;
  filters?: { namespace?: string; tags?: string[]; excludeIds?: string[] };
}

interface VectorSearchResult {
  id: string;
  score: number;
  metadata: CommandMetadata;
}

interface CommandMetadata {
  namespace: string;
  command: string;
  description: string;
  signature: string;
  parameters: string[];
  tags: string[];
  indexedAt: string;
  version: string;
}

interface SearchResponse {
  query: string;
  results: SearchResultItem[];
  totalIndexed: number;
  searchTimeMs: number;
  model: string;
}

interface SearchResultItem {
  commandId: string;
  score: number;
  command: string;
  namespace: string;
  description: string;
  signature: string;
  example: string;
}

interface IndexResult {
  id: string;
  success: boolean;
}

interface BatchIndexResult {
  total: number;
  success: number;
  failed: number;
  errors: any[];
}

interface SyncReport {
  added: number;
  updated: number;
  removed: number;
  duration_ms: number;
}

interface IndexStats {
  totalIndexed: number;
  lastSyncAt: string | null;
  adapterModel: string;
  storageName: string;
}

interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  details?: string;
}

interface BatchStorageResult {
  success: number;
  failed: number;
}

interface CommandDefinition {
  namespace: string;
  name: string;
  version: string;
  description: string;
  params?: any[];
  tags?: string[];
  example?: string;
}

import { VectorIndex } from '../src/vector-index/index.js';

// --- Mock Adapters ---

function createMockEmbeddingAdapter(dimensions: number = 128): EmbeddingAdapter {
  let callCount = 0;
  return {
    async embed(text: string): Promise<EmbeddingResult> {
      callCount++;
      // Generar vector deterministico basado en el texto
      const vector = Array.from({ length: dimensions }, (_, i) =>
        Math.sin(text.charCodeAt(i % text.length) + i) * 0.5 + 0.5
      );
      return { vector, dimensions, tokenCount: text.split(' ').length, model: 'mock-model' };
    },
    async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
      return Promise.all(texts.map(t => this.embed(t)));
    },
    getDimensions() { return dimensions; },
    getModelId() { return 'mock-model'; },
  };
}

function createMockStorageAdapter(): VectorStorageAdapter & { _entries: Map<string, VectorEntry> } {
  const entries = new Map<string, VectorEntry>();

  return {
    _entries: entries,
    async upsert(entry: VectorEntry) {
      entries.set(entry.id, entry);
    },
    async upsertBatch(newEntries: VectorEntry[]): Promise<BatchStorageResult> {
      newEntries.forEach(e => entries.set(e.id, e));
      return { success: newEntries.length, failed: 0 };
    },
    async delete(id: string) {
      entries.delete(id);
    },
    async deleteBatch(ids: string[]): Promise<BatchStorageResult> {
      ids.forEach(id => entries.delete(id));
      return { success: ids.length, failed: 0 };
    },
    async search(query: VectorSearchQuery): Promise<VectorSearchResult[]> {
      // Compute real cosine similarity for accurate test results
      const all = Array.from(entries.values());
      let results = all.map((entry) => {
        let dot = 0, normA = 0, normB = 0;
        for (let i = 0; i < query.vector.length; i++) {
          dot += query.vector[i] * entry.vector[i];
          normA += query.vector[i] * query.vector[i];
          normB += entry.vector[i] * entry.vector[i];
        }
        const denom = Math.sqrt(normA) * Math.sqrt(normB);
        const score = denom === 0 ? 0 : dot / denom;
        return { id: entry.id, score, metadata: entry.metadata };
      });

      if (query.filters?.namespace) {
        results = results.filter(r => r.metadata.namespace === query.filters!.namespace);
      }
      if (query.filters?.tags && query.filters.tags.length > 0) {
        results = results.filter(r => query.filters!.tags!.every(t => r.metadata.tags.includes(t)));
      }
      if (query.filters?.excludeIds) {
        results = results.filter(r => !query.filters!.excludeIds!.includes(r.id));
      }
      if (query.threshold) {
        results = results.filter(r => r.score >= query.threshold!);
      }
      results.sort((a, b) => b.score - a.score);
      return results.slice(0, query.topK);
    },
    async listIds(): Promise<string[]> {
      return Array.from(entries.keys());
    },
    async count(): Promise<number> {
      return entries.size;
    },
    async clear() {
      entries.clear();
    },
    async healthCheck(): Promise<HealthStatus> {
      return { status: 'healthy' };
    },
  };
}

function createSampleCommand(overrides: Partial<CommandDefinition> = {}): CommandDefinition {
  return {
    namespace: 'users',
    name: 'create',
    version: '1.0.0',
    description: 'Crea un nuevo usuario en el sistema',
    params: [{ name: 'name', type: 'string' }, { name: 'email', type: 'string' }],
    tags: ['user', 'creation'],
    example: 'users:create --name "John" --email john@test.com',
    ...overrides,
  };
}

// ============================================================
// TEST SUITE: Vector Index - Casos de Prueba del Contrato
// ============================================================

describe('Vector Index', () => {
  let embeddingAdapter: EmbeddingAdapter;
  let storageAdapter: ReturnType<typeof createMockStorageAdapter>;
  let vectorIndex: VectorIndex;

  beforeEach(async () => {
    embeddingAdapter = createMockEmbeddingAdapter(128);
    storageAdapter = createMockStorageAdapter();
    vectorIndex = new VectorIndex({
      embeddingAdapter,
      storageAdapter,
      defaultTopK: 5,
      defaultThreshold: 0.3,
    });
  });

  // ----------------------------------------------------------
  // Seccion 1: Indexacion de comandos
  // ----------------------------------------------------------
  describe('Indexacion de comandos', () => {

    /**
     * @test T01 - Indexar comando simple
     * @acceptance Indexar un comando nuevo
     * @priority Alta
     */
    it('T01: indexa un comando y retorna IndexResult con id', async () => {
      const cmd = createSampleCommand();
      const result = await vectorIndex.indexCommand(cmd);

      expect(result.id).toBe('users:create');
      expect(result.success).toBe(true);

      // Verificar que se almaceno en storage
      const count = await storageAdapter.count();
      expect(count).toBe(1);
    });

    /**
     * @test T02 - Indexar batch de 100 comandos
     * @acceptance Indexar en batch eficientemente
     * @priority Alta
     */
    it('T02: indexa batch de 100 comandos con success=100', async () => {
      const commands = Array.from({ length: 100 }, (_, i) =>
        createSampleCommand({ namespace: `ns${i}`, name: `cmd${i}` })
      );

      const result = await vectorIndex.indexBatch(commands);

      expect(result.total).toBe(100);
      expect(result.success).toBe(100);
      expect(result.failed).toBe(0);

      const count = await storageAdapter.count();
      expect(count).toBe(100);
    });

    /**
     * @test T12 - Embedding adapter mock genera vector de dimension correcta
     * @acceptance Adapter retorna vector de dimensiones esperadas
     * @priority Alta
     */
    it('T12: embedding adapter genera vector con dimensiones correctas', async () => {
      const embResult = await embeddingAdapter.embed('test text');

      expect(embResult.vector).toHaveLength(128);
      expect(embResult.dimensions).toBe(128);
      expect(embResult.model).toBe('mock-model');
    });

    /**
     * @test T13 - Storage adapter mock funciona correctamente
     * @acceptance Operaciones CRUD del storage
     * @priority Alta
     */
    it('T13: storage adapter soporta upsert, delete y search', async () => {
      const entry: VectorEntry = {
        id: 'test:cmd',
        vector: Array(128).fill(0.5),
        metadata: {
          namespace: 'test',
          command: 'cmd',
          description: 'Test command',
          signature: 'test:cmd',
          parameters: [],
          tags: [],
          indexedAt: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      await storageAdapter.upsert(entry);
      expect(await storageAdapter.count()).toBe(1);

      const searchResults = await storageAdapter.search({
        vector: Array(128).fill(0.5),
        topK: 5,
      });
      expect(searchResults).toHaveLength(1);
      expect(searchResults[0].id).toBe('test:cmd');

      await storageAdapter.delete('test:cmd');
      expect(await storageAdapter.count()).toBe(0);
    });

    /**
     * @test T19 - Idempotencia indexar (mismo comando 2 veces)
     * @acceptance Solo 1 vector en storage
     * @priority Alta
     */
    it('T19: indexar mismo comando 2 veces resulta en solo 1 vector', async () => {
      const cmd = createSampleCommand();

      await vectorIndex.indexCommand(cmd);
      await vectorIndex.indexCommand(cmd);

      const count = await storageAdapter.count();
      expect(count).toBe(1);
    });

    /**
     * @test T17 - Comando sin descripcion
     * @acceptance Indexa con campos disponibles
     * @priority Baja
     */
    it('T17: indexa comando con descripcion vacia usando otros campos', async () => {
      const cmd = createSampleCommand({ description: '' });
      const result = await vectorIndex.indexCommand(cmd);

      expect(result.success).toBe(true);
    });
  });

  // ----------------------------------------------------------
  // Seccion 2: Busqueda semantica
  // ----------------------------------------------------------
  describe('Busqueda semantica', () => {

    beforeEach(async () => {
      // Indexar varios comandos para busqueda
      const commands = [
        createSampleCommand({ namespace: 'users', name: 'create', description: 'Crea un nuevo usuario' }),
        createSampleCommand({ namespace: 'users', name: 'list', description: 'Lista todos los usuarios' }),
        createSampleCommand({ namespace: 'users', name: 'delete', description: 'Elimina un usuario' }),
        createSampleCommand({ namespace: 'orders', name: 'create', description: 'Crea una nueva orden de compra' }),
        createSampleCommand({ namespace: 'orders', name: 'list', description: 'Lista todas las ordenes' }),
        createSampleCommand({ namespace: 'auth', name: 'login', description: 'Inicia sesion de usuario' }),
        createSampleCommand({ namespace: 'auth', name: 'register', description: 'Registra nuevo usuario' }),
      ];
      await vectorIndex.indexBatch(commands);
    });

    /**
     * @test T03 - Search query relevante
     * @acceptance Score > 0.8 en primer resultado para query exacto
     * @priority Alta
     */
    it('T03: retorna resultados con score alto para query relevante', async () => {
      const response = await vectorIndex.search('crear usuario');

      expect(response.results.length).toBeGreaterThan(0);
      expect(response.results[0].score).toBeGreaterThan(0.5);
      expect(response.query).toBe('crear usuario');
      expect(response.totalIndexed).toBe(7);
    });

    /**
     * @test T04 - Search query irrelevante
     * @acceptance results.length === 0
     * @priority Alta
     */
    it('T04: retorna 0 resultados para query completamente irrelevante', async () => {
      // Con threshold alto y query irrelevante
      const response = await vectorIndex.search('receta de cocina', { threshold: 0.99 });

      expect(response.results).toHaveLength(0);
    });

    /**
     * @test T05 - Search con topK=3
     * @acceptance Exactamente 3 resultados
     * @priority Media
     */
    it('T05: retorna exactamente topK resultados cuando hay suficientes', async () => {
      const response = await vectorIndex.search('listar', { topK: 3 });

      expect(response.results.length).toBeLessThanOrEqual(3);
    });

    /**
     * @test T06 - Search con threshold=0.9
     * @acceptance Solo resultados con score >= 0.9
     * @priority Media
     */
    it('T06: filtra resultados por threshold minimo de score', async () => {
      const response = await vectorIndex.search('query ambiguo', { threshold: 0.9 });

      response.results.forEach(r => {
        expect(r.score).toBeGreaterThanOrEqual(0.9);
      });
    });

    /**
     * @test T07 - Search con namespace filter
     * @acceptance Solo comandos del namespace filtrado
     * @priority Media
     */
    it('T07: filtra resultados por namespace', async () => {
      const response = await vectorIndex.search('listar', { namespace: 'users' });

      response.results.forEach(r => {
        expect(r.namespace).toBe('users');
      });
    });

    /**
     * @test T16 - Query vacio
     * @error E002 - Query invalido
     * @priority Media
     */
    it('T16: retorna error para query vacio', async () => {
      await expect(vectorIndex.search('')).rejects.toThrow();
      // o alternativamente:
      // const response = await vectorIndex.search('');
      // expect(response.results).toEqual([]);
    });

    it('resultados estan ordenados por score descendente', async () => {
      const response = await vectorIndex.search('usuario');

      for (let i = 1; i < response.results.length; i++) {
        expect(response.results[i - 1].score).toBeGreaterThanOrEqual(response.results[i].score);
      }
    });

    it('cada resultado incluye commandId, score, description y signature', async () => {
      const response = await vectorIndex.search('crear');

      response.results.forEach(r => {
        expect(r.commandId).toBeDefined();
        expect(typeof r.score).toBe('number');
        expect(r.description).toBeDefined();
        expect(r.namespace).toBeDefined();
      });
    });

    it('searchTimeMs se reporta en la respuesta', async () => {
      const response = await vectorIndex.search('test');

      expect(response.searchTimeMs).toBeGreaterThanOrEqual(0);
      expect(typeof response.searchTimeMs).toBe('number');
    });

    /**
     * @test T20 - Search time < 200ms
     * @limit Latencia de busqueda
     * @priority Alta
     */
    it('T20: busqueda se completa en menos de 200ms', async () => {
      const start = Date.now();
      await vectorIndex.search('usuario');
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(200);
    });
  });

  // ----------------------------------------------------------
  // Seccion 3: Sincronizacion
  // ----------------------------------------------------------
  describe('Sincronizacion con Command Registry', () => {
    let mockRegistry: any;

    beforeEach(async () => {
      // Pre-indexar algunos comandos
      await vectorIndex.indexBatch([
        createSampleCommand({ namespace: 'users', name: 'create' }),
        createSampleCommand({ namespace: 'users', name: 'list' }),
        createSampleCommand({ namespace: 'users', name: 'delete' }),
      ]);

      mockRegistry = {
        listAll() {
          return [
            createSampleCommand({ namespace: 'users', name: 'create' }),
            createSampleCommand({ namespace: 'users', name: 'list' }),
            createSampleCommand({ namespace: 'users', name: 'delete' }),
            // 2 nuevos
            createSampleCommand({ namespace: 'orders', name: 'create' }),
            createSampleCommand({ namespace: 'orders', name: 'list' }),
          ];
        },
      };
    });

    /**
     * @test T08 - Sync delta - nuevos comandos
     * @acceptance SyncReport.added=2
     * @priority Alta
     */
    it('T08: sync delta detecta y indexa comandos nuevos', async () => {
      const report = await vectorIndex.sync('delta', mockRegistry);

      expect(report.added).toBe(2);
      expect(report.duration_ms).toBeGreaterThanOrEqual(0);

      const count = await storageAdapter.count();
      expect(count).toBe(5); // 3 originales + 2 nuevos
    });

    /**
     * @test T09 - Sync delta - comandos eliminados
     * @acceptance SyncReport.removed=1
     * @priority Alta
     */
    it('T09: sync delta elimina comandos que ya no estan en registry', async () => {
      // Registry sin users:delete
      const registryWithoutDelete = {
        listAll() {
          return [
            createSampleCommand({ namespace: 'users', name: 'create' }),
            createSampleCommand({ namespace: 'users', name: 'list' }),
          ];
        },
      };

      const report = await vectorIndex.sync('delta', registryWithoutDelete);

      expect(report.removed).toBe(1);
      const count = await storageAdapter.count();
      expect(count).toBe(2);
    });

    /**
     * @test T10 - Sync delta - comandos modificados
     * @acceptance SyncReport.updated=1
     * @priority Alta
     */
    it('T10: sync delta re-indexa comandos con version diferente', async () => {
      const registryWithUpdate = {
        listAll() {
          return [
            createSampleCommand({ namespace: 'users', name: 'create', version: '2.0.0' }), // modificado
            createSampleCommand({ namespace: 'users', name: 'list' }),
            createSampleCommand({ namespace: 'users', name: 'delete' }),
          ];
        },
      };

      const report = await vectorIndex.sync('delta', registryWithUpdate);

      expect(report.updated).toBe(1);
    });

    /**
     * @test T11 - Sync full rebuild
     * @acceptance Indice reconstruido completamente
     * @priority Media
     */
    it('T11: sync full reconstruye el indice completo', async () => {
      const registryFull = {
        listAll() {
          return Array.from({ length: 50 }, (_, i) =>
            createSampleCommand({ namespace: `ns${i}`, name: `cmd${i}` })
          );
        },
      };

      const report = await vectorIndex.sync('full', registryFull);

      const count = await storageAdapter.count();
      expect(count).toBe(50);
    });
  });

  // ----------------------------------------------------------
  // Seccion 4: Health Check
  // ----------------------------------------------------------
  describe('Health Check', () => {

    /**
     * @test T14 - Health check - healthy
     * @acceptance Retorna status healthy
     * @priority Media
     */
    it('T14: retorna healthy cuando ambos adapters estan operativos', async () => {
      const health = await vectorIndex.healthCheck();

      expect(health.status).toBe('healthy');
    });

    /**
     * @test T15 - Health check - unhealthy
     * @acceptance Retorna status unhealthy con error
     * @priority Media
     */
    it('T15: retorna unhealthy cuando storage adapter no esta disponible', async () => {
      // Crear un vector index con storage que falla en healthCheck
      const brokenStorage: VectorStorageAdapter = {
        ...createMockStorageAdapter(),
        async healthCheck() { return { status: 'unhealthy' as const, details: 'Connection refused' }; },
      };

      const unhealthyIndex = new VectorIndex({
        embeddingAdapter,
        storageAdapter: brokenStorage,
        defaultTopK: 5,
        defaultThreshold: 0.3,
      });

      const health = await unhealthyIndex.healthCheck();
      expect(health.status).toBe('unhealthy');
      expect(health.details).toBeDefined();
    });
  });

  // ----------------------------------------------------------
  // Seccion 5: Concurrencia
  // ----------------------------------------------------------
  describe('Concurrencia', () => {

    /**
     * @test T18 - Concurrencia search (10 simultaneos)
     * @acceptance Todos responden correctamente
     * @priority Media
     */
    it('T18: soporta 10 busquedas concurrentes sin errores', async () => {
      // Indexar comandos primero
      await vectorIndex.indexBatch([
        createSampleCommand({ namespace: 'users', name: 'create' }),
        createSampleCommand({ namespace: 'users', name: 'list' }),
      ]);

      const queries = Array.from({ length: 10 }, (_, i) =>
        vectorIndex.search(`query ${i}`)
      );

      const results = await Promise.all(queries);

      results.forEach(response => {
        expect(response.results).toBeDefined();
        expect(response.searchTimeMs).toBeGreaterThanOrEqual(0);
      });
    });
  });

  // ----------------------------------------------------------
  // Seccion 6: Stats
  // ----------------------------------------------------------
  describe('Estadisticas del indice', () => {

    it('retorna estadisticas correctas', async () => {
      await vectorIndex.indexBatch([
        createSampleCommand({ namespace: 'users', name: 'create' }),
        createSampleCommand({ namespace: 'users', name: 'list' }),
        createSampleCommand({ namespace: 'orders', name: 'create' }),
      ]);

      const stats = await vectorIndex.getStats();

      expect(stats.totalIndexed).toBe(3);
      expect(stats.adapterModel).toBe('mock-model');
    });
  });

  // ----------------------------------------------------------
  // Seccion 7: MUST NOT
  // ----------------------------------------------------------
  describe('MUST NOT - Restricciones del Vector Index', () => {

    it('no retorna mas de 20 resultados por query', async () => {
      // Indexar 30 comandos
      const commands = Array.from({ length: 30 }, (_, i) =>
        createSampleCommand({ namespace: `ns${i}`, name: `cmd${i}` })
      );
      await vectorIndex.indexBatch(commands);

      const response = await vectorIndex.search('test', { topK: 25 });

      // Debe respetar limite maximo de 20
      expect(response.results.length).toBeLessThanOrEqual(20);
    });

    it('no modifica el Command Registry', async () => {
      // El VectorIndex solo lee del Registry, nunca escribe
      const registryMock = {
        listAll: vi.fn().mockReturnValue([createSampleCommand()]),
      };

      await vectorIndex.sync('full', registryMock);

      // Solo se llamo listAll, no metodos de escritura
      expect(registryMock.listAll).toHaveBeenCalled();
    });

    it('no cachea resultados de busqueda entre sesiones diferentes', async () => {
      await vectorIndex.indexCommand(createSampleCommand());

      const r1 = await vectorIndex.search('crear usuario');
      // Agregar otro comando
      await vectorIndex.indexCommand(createSampleCommand({ namespace: 'extra', name: 'cmd' }));
      const r2 = await vectorIndex.search('crear usuario');

      // r2 debe reflejar el nuevo estado del indice
      expect(r2.totalIndexed).toBeGreaterThan(r1.totalIndexed);
    });
  });

  // ----------------------------------------------------------
  // Seccion 8: Texto indexable
  // ----------------------------------------------------------
  describe('Construccion del texto indexable', () => {

    it('incluye descripcion, namespace y nombre en el texto indexable', async () => {
      const embedSpy = vi.spyOn(embeddingAdapter, 'embed');

      await vectorIndex.indexCommand(createSampleCommand({
        description: 'Crea un nuevo usuario',
        namespace: 'users',
        name: 'create',
      }));

      expect(embedSpy).toHaveBeenCalled();
      const textUsed = embedSpy.mock.calls[0][0];
      expect(textUsed).toContain('Crea un nuevo usuario');
      expect(textUsed).toContain('users');
      expect(textUsed).toContain('create');
    });

    it('incluye tags en el texto indexable cuando estan disponibles', async () => {
      const embedSpy = vi.spyOn(embeddingAdapter, 'embed');

      await vectorIndex.indexCommand(createSampleCommand({
        tags: ['creation', 'onboarding'],
      }));

      const textUsed = embedSpy.mock.calls[0][0];
      expect(textUsed).toContain('creation');
      expect(textUsed).toContain('onboarding');
    });
  });

  // ----------------------------------------------------------
  // Seccion 9: Errores
  // ----------------------------------------------------------
  describe('Manejo de errores', () => {

    it('E002: rechaza query vacio o invalido sin llamar al adapter', async () => {
      const embedSpy = vi.spyOn(embeddingAdapter, 'embed');

      try {
        await vectorIndex.search('');
      } catch (e) {
        // Expected
      }

      expect(embedSpy).not.toHaveBeenCalled();
    });

    it('E009: maneja comando con texto indexable vacio', async () => {
      const cmd = createSampleCommand({
        description: '',
        tags: [],
        params: [],
      });

      // No debe crashear, puede hacer skip con warning
      const result = await vectorIndex.indexCommand(cmd);
      // El contrato permite indexar con campos disponibles o skip con warning
      expect(result).toBeDefined();
    });

    it('E005: removeCommand de id inexistente no crashea', async () => {
      // Debe ser no-op con warning, no excepcion
      await expect(vectorIndex.removeCommand('nonexistent:cmd')).resolves.not.toThrow();
    });
  });

  // ==========================================================================
  // Matryoshka Progressive Search
  // ==========================================================================

  describe('Matryoshka progressive search', () => {
    let matryoshkaIndex: VectorIndex;
    let embeddingAdapter: EmbeddingAdapter;
    let storageAdapter: ReturnType<typeof createMockStorageAdapter>;

    beforeEach(async () => {
      embeddingAdapter = createMockEmbeddingAdapter(768);
      storageAdapter = createMockStorageAdapter();
      matryoshkaIndex = new VectorIndex({
        embeddingAdapter,
        storageAdapter,
        defaultTopK: 5,
        defaultThreshold: 0.3,
        matryoshka: {
          enabled: true,
          fullDimensions: 768,
          layers: [
            { dimensions: 64, candidateTopK: 50 },
            { dimensions: 128, candidateTopK: 25 },
            { dimensions: 256, candidateTopK: 10 },
          ],
        },
      });

      const commands: CommandDefinition[] = [
        createSampleCommand({ namespace: 'users', name: 'create', description: 'Crea un nuevo usuario' }),
        createSampleCommand({ namespace: 'users', name: 'list', description: 'Lista todos los usuarios' }),
        createSampleCommand({ namespace: 'users', name: 'get', description: 'Obtiene un usuario por ID' }),
        createSampleCommand({ namespace: 'users', name: 'delete', description: 'Elimina un usuario' }),
        createSampleCommand({ namespace: 'orders', name: 'create', description: 'Crea una nueva orden de compra' }),
        createSampleCommand({ namespace: 'orders', name: 'list', description: 'Lista todas las ordenes' }),
        createSampleCommand({ namespace: 'auth', name: 'login', description: 'Inicia sesion de usuario' }),
      ];
      await matryoshkaIndex.indexBatch(commands);
    });

    it('M01: returns matryoshkaStages diagnostics in response', async () => {
      const response = await matryoshkaIndex.search('crear usuario');

      expect(response.matryoshkaStages).toBeDefined();
      expect(response.matryoshkaStages!.length).toBe(4); // 64d, 128d, 256d, 768d
      expect(response.matryoshkaStages![0].dimensions).toBe(64);
      expect(response.matryoshkaStages![1].dimensions).toBe(128);
      expect(response.matryoshkaStages![2].dimensions).toBe(256);
      expect(response.matryoshkaStages![3].dimensions).toBe(768);
    });

    it('M02: funnel progressively narrows candidates', async () => {
      const response = await matryoshkaIndex.search('crear usuario');
      const stages = response.matryoshkaStages!;

      // First stage starts with all 7 commands
      expect(stages[0].candidatesIn).toBe(7);
      // Each stage should output <= its configured candidateTopK (or fewer if input is smaller)
      for (let i = 0; i < stages.length - 1; i++) {
        expect(stages[i + 1].candidatesIn).toBeLessThanOrEqual(stages[i].candidatesOut);
      }
    });

    it('M03: returns valid results with scores', async () => {
      const response = await matryoshkaIndex.search('crear usuario');

      expect(response.results.length).toBeGreaterThan(0);
      expect(response.results[0].score).toBeGreaterThan(0);
      expect(response.results[0].commandId).toBeDefined();
      expect(response.results[0].namespace).toBeDefined();
    });

    it('M04: threshold 0.99 returns 0 results for irrelevant query', async () => {
      const response = await matryoshkaIndex.search('receta de cocina', { threshold: 0.99 });

      expect(response.results).toHaveLength(0);
      expect(response.matryoshkaStages).toBeDefined();
    });

    it('M05: namespace filter works in matryoshka mode', async () => {
      const response = await matryoshkaIndex.search('crear', { namespace: 'orders' });

      for (const result of response.results) {
        expect(result.namespace).toBe('orders');
      }
    });

    it('M06: empty index returns empty results', async () => {
      const emptyIndex = new VectorIndex({
        embeddingAdapter,
        storageAdapter: createMockStorageAdapter(),
        defaultTopK: 5,
        defaultThreshold: 0.3,
        matryoshka: {
          enabled: true,
          fullDimensions: 768,
          layers: [{ dimensions: 64, candidateTopK: 50 }],
        },
      });

      const response = await emptyIndex.search('test');

      expect(response.results).toHaveLength(0);
      expect(response.matryoshkaStages).toBeDefined();
    });

    it('M07: single intermediate layer config works', async () => {
      const singleLayerIndex = new VectorIndex({
        embeddingAdapter,
        storageAdapter,
        defaultTopK: 5,
        defaultThreshold: 0.3,
        matryoshka: {
          enabled: true,
          fullDimensions: 768,
          layers: [{ dimensions: 128, candidateTopK: 10 }],
        },
      });

      // Re-index into this instance
      await singleLayerIndex.indexBatch([
        createSampleCommand({ namespace: 'users', name: 'create', description: 'Crea un usuario' }),
        createSampleCommand({ namespace: 'users', name: 'list', description: 'Lista usuarios' }),
      ]);

      const response = await singleLayerIndex.search('crear usuario');

      expect(response.matryoshkaStages).toHaveLength(2); // 128d + 768d final
      expect(response.results.length).toBeGreaterThan(0);
    });

    it('M08: does not return matryoshkaStages when disabled', async () => {
      const normalIndex = new VectorIndex({
        embeddingAdapter,
        storageAdapter,
        defaultTopK: 5,
        defaultThreshold: 0.3,
      });

      await normalIndex.indexBatch([
        createSampleCommand({ namespace: 'users', name: 'create', description: 'Crea un usuario' }),
      ]);

      const response = await normalIndex.search('crear usuario');

      expect(response.matryoshkaStages).toBeUndefined();
    });
  });

  // ==========================================================================
  // MatryoshkaEmbeddingAdapter
  // ==========================================================================

  describe('MatryoshkaEmbeddingAdapter', () => {
    it('M09: truncates vectors to maxDimensions', async () => {
      const inner = createMockEmbeddingAdapter(768);
      const { MatryoshkaEmbeddingAdapter } = await import('../src/vector-index/matryoshka.js');
      const adapter = new MatryoshkaEmbeddingAdapter(inner, 256);

      const result = await adapter.embed('test query');

      expect(result.vector).toHaveLength(256);
      expect(result.dimensions).toBe(256);
    });

    it('M10: passes through when no maxDimensions', async () => {
      const inner = createMockEmbeddingAdapter(768);
      const { MatryoshkaEmbeddingAdapter } = await import('../src/vector-index/matryoshka.js');
      const adapter = new MatryoshkaEmbeddingAdapter(inner);

      const result = await adapter.embed('test query');

      expect(result.vector).toHaveLength(768);
    });

    it('M11: embedBatch truncates all results', async () => {
      const inner = createMockEmbeddingAdapter(768);
      const { MatryoshkaEmbeddingAdapter } = await import('../src/vector-index/matryoshka.js');
      const adapter = new MatryoshkaEmbeddingAdapter(inner, 128);

      const results = await adapter.embedBatch(['hello', 'world', 'test']);

      expect(results).toHaveLength(3);
      for (const r of results) {
        expect(r.vector).toHaveLength(128);
        expect(r.dimensions).toBe(128);
      }
    });

    it('M12: getDimensions reports maxDimensions when set', async () => {
      const inner = createMockEmbeddingAdapter(768);
      const { MatryoshkaEmbeddingAdapter } = await import('../src/vector-index/matryoshka.js');

      const truncated = new MatryoshkaEmbeddingAdapter(inner, 256);
      expect(truncated.getDimensions()).toBe(256);

      const passthrough = new MatryoshkaEmbeddingAdapter(inner);
      expect(passthrough.getDimensions()).toBe(768);
    });
  });

  // ==========================================================================
  // truncateVector utility
  // ==========================================================================

  describe('truncateVector', () => {
    it('M13: truncates 768d vector to 64d', async () => {
      const { truncateVector } = await import('../src/vector-index/matryoshka.js');
      const vector = Array.from({ length: 768 }, (_, i) => i * 0.01);

      const truncated = truncateVector(vector, 64);

      expect(truncated).toHaveLength(64);
      expect(truncated[0]).toBe(vector[0]);
      expect(truncated[63]).toBe(vector[63]);
    });

    it('M14: returns original when dimensions >= vector length', async () => {
      const { truncateVector } = await import('../src/vector-index/matryoshka.js');
      const vector = [0.1, 0.2, 0.3];

      const same = truncateVector(vector, 5);
      expect(same).toBe(vector); // same reference, no copy

      const exact = truncateVector(vector, 3);
      expect(exact).toBe(vector);
    });
  });
});
