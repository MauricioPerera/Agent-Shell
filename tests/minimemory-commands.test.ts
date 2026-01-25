/**
 * @contract CONTRACT_MINIMEMORY_COMMANDS v1.0
 * @module minimemory-commands (namespace mm:)
 * @description Tests para los 21 comandos minimemory basados en el contrato.
 *
 * Cubre: Estructura de comandos, VectorDB operations, AgentMemory operations,
 * parseo de JSON, conversion de tipos, manejo de errores, flags confirm/undoable.
 *
 * Casos de prueba del contrato: T01-T42
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMiniMemoryCommands } from '../demo/minimemory-commands.js';

// --- Mock del MiniMemoryApiAdapter ---

function createMockApi() {
  return {
    stats: vi.fn(() => ({
      count: 10,
      dimensions: 768,
      distance: 'cosine',
      indexType: 'hnsw',
      hasFulltext: true,
      quantization: 'none',
    })),
    insert: vi.fn(),
    delete: vi.fn(),
    get: vi.fn((id: string) => ({ vector: [0.1], metadata: { title: 'test' } })),
    contains: vi.fn(() => true),
    search: vi.fn(() => [{ id: 'r1', distance: 0.1, score: 0.9, metadata: {} }]),
    keywordSearch: vi.fn(() => [{ id: 'kw1', distance: 0, score: 0.85, metadata: {} }]),
    hybridSearch: vi.fn(() => [{ id: 'h1', distance: 0.05, score: 0.95, metadata: {} }]),
    filterSearch: vi.fn(() => [{ id: 'f1', distance: 0, score: 1, metadata: {} }]),
    save: vi.fn(),
    load: vi.fn(),
    learnTask: vi.fn(),
    learnCode: vi.fn(),
    learnError: vi.fn(),
    recallSimilar: vi.fn(() => [{ id: 'r1', relevance: 0.9, content: {} }]),
    recallCode: vi.fn(() => [{ id: 'c1', relevance: 0.85, content: {} }]),
    recallErrors: vi.fn(() => [{ id: 'e1', relevance: 0.8, content: {} }]),
    recallSuccessful: vi.fn(() => []),
    setWorkingContext: vi.fn(),
    getWorkingContext: vi.fn(() => ({ current_project: 'test' })),
    agentMemoryStats: vi.fn(() => ({
      totalEntries: 5,
      episodes: 2,
      codeSnippets: 2,
      errorSolutions: 1,
    })),
    saveMemory: vi.fn(),
    loadMemory: vi.fn(),
    focusProject: vi.fn(),
  };
}

// --- Helper: buscar comando por nombre ---

function findCommand(commands: any[], name: string) {
  return commands.find((cmd: any) => cmd.name === name);
}

// --- Tests ---

describe('createMiniMemoryCommands', () => {
  let api: ReturnType<typeof createMockApi>;
  let commands: any[];

  beforeEach(() => {
    api = createMockApi();
    commands = createMiniMemoryCommands(api as any);
  });

  // =========================================================================
  // SECTION 1: Estructura de Comandos (T01-T04, T41, T42)
  // =========================================================================

  describe('Estructura de comandos', () => {
    /**
     * @test
     * @requirement T01 - Factory retorna 21 comandos
     * @acceptance Scenario: Factory retorna 21 comandos
     */
    it('retorna un array de exactamente 21 comandos', () => {
      expect(commands).toHaveLength(21);
    });

    /**
     * @test
     * @requirement T02 - Todos namespace "mm"
     * @acceptance Scenario: Todos tienen namespace "mm"
     */
    it('todos los comandos tienen namespace "mm"', () => {
      for (const cmd of commands) {
        expect(cmd.namespace).toBe('mm');
      }
    });

    /**
     * @test
     * @requirement T03 - Todos tienen version "1.0.0"
     */
    it('todos los comandos tienen version "1.0.0"', () => {
      for (const cmd of commands) {
        expect(cmd.version).toBe('1.0.0');
      }
    });

    /**
     * @test
     * @requirement T04 - Todos tienen tags no vacio
     * @acceptance Scenario: Todos los comandos tienen tags
     */
    it('todos los comandos tienen tags como array no vacio', () => {
      for (const cmd of commands) {
        expect(Array.isArray(cmd.tags)).toBe(true);
        expect(cmd.tags.length).toBeGreaterThan(0);
      }
    });

    /**
     * @test
     * @requirement T03 - Todos tienen handler async
     */
    it('todos los comandos tienen handler como funcion', () => {
      for (const cmd of commands) {
        expect(typeof cmd.handler).toBe('function');
      }
    });

    /**
     * @test
     * @requirement T41 - Confirm flag en delete
     * @mustnot Ejecutar operaciones destructivas sin confirm: true
     */
    it('mm:delete tiene confirm: true', () => {
      const deleteCmd = findCommand(commands, 'delete');
      expect(deleteCmd.confirm).toBe(true);
    });

    /**
     * @test
     * @requirement T42 - Undoable en insert
     */
    it('mm:insert tiene undoable: true', () => {
      const insertCmd = findCommand(commands, 'insert');
      expect(insertCmd.undoable).toBe(true);
    });

    /**
     * @test
     * Todos los tags empiezan con "minimemory" como primer tag
     */
    it('todos los comandos incluyen "minimemory" como primer tag', () => {
      for (const cmd of commands) {
        expect(cmd.tags[0]).toBe('minimemory');
      }
    });
  });

  // =========================================================================
  // SECTION 2: VectorDB Commands
  // =========================================================================

  describe('VectorDB Commands', () => {
    // --- mm:stats ---

    describe('mm:stats', () => {
      /**
       * @test
       * @requirement T40 - Stats DB
       * @acceptance Scenario: Stats de DB
       */
      it('retorna success con stats de la DB', async () => {
        const cmd = findCommand(commands, 'stats');
        const result = await cmd.handler({});

        expect(result.success).toBe(true);
        expect(result.data).toEqual({
          count: 10,
          dimensions: 768,
          distance: 'cosine',
          indexType: 'hnsw',
          hasFulltext: true,
          quantization: 'none',
        });
        expect(api.stats).toHaveBeenCalled();
      });
    });

    // --- mm:insert ---

    describe('mm:insert', () => {
      /**
       * @test
       * @requirement T05 - Insert con vector
       * @acceptance Scenario: Insert con vector y metadata
       */
      it('llama api.insert con params correctos incluyendo vector', async () => {
        const cmd = findCommand(commands, 'insert');
        const result = await cmd.handler({
          id: 'doc-1',
          vector: '[0.1, 0.2, 0.3]',
          metadata: '{"title": "Test"}',
        });

        expect(result.success).toBe(true);
        expect(result.data.id).toBe('doc-1');
        expect(result.data.hasVector).toBe(true);
        expect(result.data.metadataKeys).toContain('title');
        expect(api.insert).toHaveBeenCalledWith({
          id: 'doc-1',
          vector: [0.1, 0.2, 0.3],
          metadata: { title: 'Test' },
        });
      });

      /**
       * @test
       * @requirement T06 - Insert sin vector
       * @acceptance Scenario: Insert sin vector (solo metadata)
       */
      it('insert sin vector retorna hasVector false', async () => {
        const cmd = findCommand(commands, 'insert');
        const result = await cmd.handler({
          id: 'doc-2',
          metadata: '{"category": "tech"}',
        });

        expect(result.success).toBe(true);
        expect(result.data.hasVector).toBe(false);
        expect(result.data.metadataKeys).toContain('category');
        expect(api.insert).toHaveBeenCalledWith({
          id: 'doc-2',
          vector: undefined,
          metadata: { category: 'tech' },
        });
      });

      /**
       * @test
       * @requirement T07 - Insert con content agrega a metadata
       * @acceptance Scenario: Insert con content agrega a metadata
       */
      it('parsea metadata JSON string y agrega content', async () => {
        const cmd = findCommand(commands, 'insert');
        const result = await cmd.handler({
          id: 'doc-3',
          metadata: '{"title": "X"}',
          content: 'texto completo',
        });

        expect(result.success).toBe(true);
        expect(api.insert).toHaveBeenCalledWith({
          id: 'doc-3',
          vector: undefined,
          metadata: { title: 'X', content: 'texto completo' },
        });
        expect(result.data.metadataKeys).toContain('content');
      });

      /**
       * @test
       * Parsea metadata cuando ya es objeto (no string)
       */
      it('acepta metadata como objeto directo', async () => {
        const cmd = findCommand(commands, 'insert');
        const result = await cmd.handler({
          id: 'doc-4',
          metadata: { title: 'Direct' },
        });

        expect(result.success).toBe(true);
        expect(api.insert).toHaveBeenCalledWith({
          id: 'doc-4',
          vector: undefined,
          metadata: { title: 'Direct' },
        });
      });
    });

    // --- mm:delete ---

    describe('mm:delete', () => {
      /**
       * @test
       * @requirement T08 - Delete exitoso
       * @acceptance Scenario: Delete con confirm
       */
      it('llama api.delete con el id correcto', async () => {
        const cmd = findCommand(commands, 'delete');
        const result = await cmd.handler({ id: 'doc-1' });

        expect(result.success).toBe(true);
        expect(result.data.deleted).toBe('doc-1');
        expect(api.delete).toHaveBeenCalledWith('doc-1');
      });
    });

    // --- mm:get ---

    describe('mm:get', () => {
      /**
       * @test
       * @requirement T09 - Get existente
       * @acceptance Scenario: Get documento existente
       */
      it('retorna documento existente con vector y metadata', async () => {
        const cmd = findCommand(commands, 'get');
        const result = await cmd.handler({ id: 'doc-1' });

        expect(result.success).toBe(true);
        expect(result.data.id).toBe('doc-1');
        expect(result.data.vector).toEqual([0.1]);
        expect(result.data.metadata).toEqual({ title: 'test' });
        expect(api.get).toHaveBeenCalledWith('doc-1');
      });

      /**
       * @test
       * @requirement T10 - Get inexistente
       * @acceptance Scenario: Get documento inexistente
       * @error E002 - Documento no encontrado
       */
      it('retorna error si documento no existe', async () => {
        api.get.mockReturnValue(null);
        const cmd = findCommand(commands, 'get');
        const result = await cmd.handler({ id: 'ghost' });

        expect(result.success).toBe(false);
        expect(result.error).toContain('ghost');
        expect(result.error).toContain('no encontrado');
      });
    });

    // --- mm:search ---

    describe('mm:search', () => {
      /**
       * @test
       * @requirement T11 - Search con vector
       * @acceptance Scenario: Busqueda vectorial
       */
      it('parsea vector JSON y llama api.search con topK', async () => {
        const cmd = findCommand(commands, 'search');
        const result = await cmd.handler({
          vector: '[0.1, 0.2, 0.3]',
          top_k: '3',
        });

        expect(result.success).toBe(true);
        expect(result.data.count).toBe(1);
        expect(result.data.results).toHaveLength(1);
        expect(api.search).toHaveBeenCalledWith([0.1, 0.2, 0.3], 3);
      });

      /**
       * @test
       * @requirement T12 - Search top_k default
       */
      it('usa top_k default de 5 si no se especifica', async () => {
        const cmd = findCommand(commands, 'search');
        await cmd.handler({ vector: '[0.1]' });

        expect(api.search).toHaveBeenCalledWith([0.1], 5);
      });
    });

    // --- mm:keywords ---

    describe('mm:keywords', () => {
      /**
       * @test
       * @requirement T13 - Keywords search
       * @acceptance Scenario: Busqueda BM25
       */
      it('llama keywordSearch con query y topK', async () => {
        const cmd = findCommand(commands, 'keywords');
        const result = await cmd.handler({ query: 'rust async', top_k: '5' });

        expect(result.success).toBe(true);
        expect(result.data.query).toBe('rust async');
        expect(result.data.count).toBe(1);
        expect(api.keywordSearch).toHaveBeenCalledWith('rust async', 5);
      });

      /**
       * @test
       * top_k default de 10 para keywords
       */
      it('usa top_k default de 10', async () => {
        const cmd = findCommand(commands, 'keywords');
        await cmd.handler({ query: 'test' });

        expect(api.keywordSearch).toHaveBeenCalledWith('test', 10);
      });
    });

    // --- mm:hybrid ---

    describe('mm:hybrid', () => {
      /**
       * @test
       * @requirement T14 - Hybrid solo keywords
       * @acceptance Scenario: Busqueda hibrida
       */
      it('funciona solo con keywords (sin vector)', async () => {
        const cmd = findCommand(commands, 'hybrid');
        const result = await cmd.handler({ keywords: 'auth JWT' });

        expect(result.success).toBe(true);
        expect(result.data.hasVector).toBe(false);
        expect(result.data.keywords).toBe('auth JWT');
        expect(api.hybridSearch).toHaveBeenCalledWith({
          vector: undefined,
          keywords: 'auth JWT',
          filter: undefined,
          topK: 10,
          vectorWeight: undefined,
        });
      });

      /**
       * @test
       * @requirement T15 - Hybrid con vector + keywords + filter
       */
      it('combina vector + keywords + filter correctamente', async () => {
        const cmd = findCommand(commands, 'hybrid');
        const result = await cmd.handler({
          vector: '[0.5, 0.6]',
          keywords: 'security',
          filter: '{"category": "auth"}',
          top_k: '5',
          vector_weight: '0.8',
        });

        expect(result.success).toBe(true);
        expect(result.data.hasVector).toBe(true);
        expect(result.data.hasFilter).toBe(true);
        expect(result.data.keywords).toBe('security');
        expect(api.hybridSearch).toHaveBeenCalledWith({
          vector: [0.5, 0.6],
          keywords: 'security',
          filter: { category: 'auth' },
          topK: 5,
          vectorWeight: 0.8,
        });
      });

      /**
       * @test
       * Hybrid sin ningun parametro de busqueda
       */
      it('funciona sin vector ni filter (solo topK default)', async () => {
        const cmd = findCommand(commands, 'hybrid');
        const result = await cmd.handler({});

        expect(result.success).toBe(true);
        expect(result.data.hasVector).toBe(false);
        expect(result.data.hasFilter).toBe(false);
        expect(result.data.keywords).toBeNull();
      });
    });

    // --- mm:filter ---

    describe('mm:filter', () => {
      /**
       * @test
       * @requirement T16 - Filter eq
       * @acceptance Scenario: Busqueda por filtro metadata
       */
      it('construye params y llama filterSearch', async () => {
        const cmd = findCommand(commands, 'filter');
        const result = await cmd.handler({
          field: 'category',
          operator: 'eq',
          value: 'tech',
          top_k: '10',
        });

        expect(result.success).toBe(true);
        expect(result.data.filter).toEqual({
          field: 'category',
          operator: 'eq',
          value: 'tech',
        });
        expect(result.data.count).toBe(1);
        expect(api.filterSearch).toHaveBeenCalledWith(
          [{ field: 'category', operator: 'eq', value: 'tech' }],
          10,
        );
      });

      /**
       * @test
       * @requirement T17 - Filter coercion numerica
       * @acceptance Scenario: Coercion automatica de value en filter
       */
      it('parsea valores numericos automaticamente', async () => {
        const cmd = findCommand(commands, 'filter');
        await cmd.handler({
          field: 'score',
          operator: 'gt',
          value: '42',
        });

        expect(api.filterSearch).toHaveBeenCalledWith(
          [{ field: 'score', operator: 'gt', value: 42 }],
          20,
        );
      });

      /**
       * @test
       * @requirement T18 - Filter coercion booleana
       */
      it('parsea "true" como boolean true', async () => {
        const cmd = findCommand(commands, 'filter');
        await cmd.handler({
          field: 'active',
          operator: 'eq',
          value: 'true',
        });

        expect(api.filterSearch).toHaveBeenCalledWith(
          [{ field: 'active', operator: 'eq', value: true }],
          20,
        );
      });

      /**
       * @test
       * Filter coercion booleana false
       */
      it('parsea "false" como boolean false', async () => {
        const cmd = findCommand(commands, 'filter');
        await cmd.handler({
          field: 'deprecated',
          operator: 'eq',
          value: 'false',
        });

        expect(api.filterSearch).toHaveBeenCalledWith(
          [{ field: 'deprecated', operator: 'eq', value: false }],
          20,
        );
      });

      /**
       * @test
       * Filter usa top_k default de 20
       */
      it('usa top_k default de 20', async () => {
        const cmd = findCommand(commands, 'filter');
        await cmd.handler({
          field: 'type',
          operator: 'eq',
          value: 'doc',
        });

        expect(api.filterSearch).toHaveBeenCalledWith(
          expect.any(Array),
          20,
        );
      });
    });

    // --- mm:save ---

    describe('mm:save', () => {
      /**
       * @test
       * @requirement T19 - Save con path
       * @acceptance Scenario: Save y Load
       */
      it('llama api.save con path especificado', async () => {
        const cmd = findCommand(commands, 'save');
        const result = await cmd.handler({ path: './test.mmdb' });

        expect(result.success).toBe(true);
        expect(result.data.saved).toBe('./test.mmdb');
        expect(api.save).toHaveBeenCalledWith('./test.mmdb');
      });

      /**
       * @test
       * @requirement T20 - Save sin path (default)
       */
      it('llama api.save sin path cuando no se proporciona', async () => {
        const cmd = findCommand(commands, 'save');
        const result = await cmd.handler({});

        expect(result.success).toBe(true);
        expect(result.data.saved).toBe('default path');
        expect(api.save).toHaveBeenCalledWith(undefined);
      });
    });

    // --- mm:load ---

    describe('mm:load', () => {
      /**
       * @test
       * @requirement T21 - Load con path
       * @acceptance Scenario: Load exitoso
       */
      it('llama api.load y muestra count de documentos', async () => {
        const cmd = findCommand(commands, 'load');
        const result = await cmd.handler({ path: './data.mmdb' });

        expect(result.success).toBe(true);
        expect(result.data.loaded).toBe('./data.mmdb');
        expect(result.data.count).toBe(10);
        expect(api.load).toHaveBeenCalledWith('./data.mmdb');
        expect(api.stats).toHaveBeenCalled();
      });
    });
  });

  // =========================================================================
  // SECTION 3: AgentMemory Commands
  // =========================================================================

  describe('AgentMemory Commands', () => {
    // --- mm:learn ---

    describe('mm:learn', () => {
      /**
       * @test
       * @requirement T22 - Learn tarea
       * @acceptance Scenario: Aprender tarea exitosa
       */
      it('llama learnTask con params correctos', async () => {
        const cmd = findCommand(commands, 'learn');
        const result = await cmd.handler({
          task: 'Implementar auth',
          solution: 'JWT con refresh tokens',
          outcome: 'success',
        });

        expect(result.success).toBe(true);
        expect(result.data.task).toBe('Implementar auth');
        expect(result.data.outcome).toBe('success');
        expect(result.data.learnings).toBe(0);
        expect(api.learnTask).toHaveBeenCalledWith({
          task: 'Implementar auth',
          solution: 'JWT con refresh tokens',
          outcome: 'success',
          learnings: [],
        });
      });

      /**
       * @test
       * @requirement T23 - Learn con learnings JSON
       * @acceptance Scenario: Learn con learnings como string JSON
       */
      it('parsea learnings JSON string', async () => {
        const cmd = findCommand(commands, 'learn');
        const result = await cmd.handler({
          task: 'Setup CI',
          solution: 'GitHub Actions',
          outcome: 'success',
          learnings: '["Usar cache", "Pin versions"]',
        });

        expect(result.success).toBe(true);
        expect(result.data.learnings).toBe(2);
        expect(api.learnTask).toHaveBeenCalledWith({
          task: 'Setup CI',
          solution: 'GitHub Actions',
          outcome: 'success',
          learnings: ['Usar cache', 'Pin versions'],
        });
      });

      /**
       * @test
       * Learn acepta learnings como array directo
       */
      it('acepta learnings como array directo (no string)', async () => {
        const cmd = findCommand(commands, 'learn');
        const result = await cmd.handler({
          task: 'Refactor',
          solution: 'Extract method',
          outcome: 'partial',
          learnings: ['Lesson 1'],
        });

        expect(result.success).toBe(true);
        expect(result.data.learnings).toBe(1);
        expect(api.learnTask).toHaveBeenCalledWith(
          expect.objectContaining({ learnings: ['Lesson 1'] }),
        );
      });
    });

    // --- mm:recall ---

    describe('mm:recall', () => {
      /**
       * @test
       * @requirement T24 - Recall experiencias
       * @acceptance Scenario: Recordar experiencia similar
       */
      it('llama recallSimilar con query y topK', async () => {
        const cmd = findCommand(commands, 'recall');
        const result = await cmd.handler({ query: 'autenticacion', top_k: '3' });

        expect(result.success).toBe(true);
        expect(result.data.query).toBe('autenticacion');
        expect(result.data.count).toBe(1);
        expect(result.data.results).toHaveLength(1);
        expect(api.recallSimilar).toHaveBeenCalledWith('autenticacion', 3);
      });

      /**
       * @test
       * Recall usa top_k default de 5
       */
      it('usa top_k default de 5', async () => {
        const cmd = findCommand(commands, 'recall');
        await cmd.handler({ query: 'test' });

        expect(api.recallSimilar).toHaveBeenCalledWith('test', 5);
      });
    });

    // --- mm:learn-code ---

    describe('mm:learn-code', () => {
      /**
       * @test
       * @requirement T25 - Learn-code completo
       * @acceptance Scenario: Almacenar snippet de codigo
       */
      it('llama learnCode con todos los params', async () => {
        const cmd = findCommand(commands, 'learn-code');
        const result = await cmd.handler({
          code: 'async fn fetch() { }',
          description: 'HTTP fetch con retry',
          language: 'rust',
          use_case: 'API calls',
          dependencies: '["reqwest", "tokio"]',
          tags: '["http", "async"]',
          quality: '0.9',
        });

        expect(result.success).toBe(true);
        expect(result.data.description).toBe('HTTP fetch con retry');
        expect(result.data.language).toBe('rust');
        expect(result.data.useCase).toBe('API calls');
        expect(api.learnCode).toHaveBeenCalledWith({
          code: 'async fn fetch() { }',
          description: 'HTTP fetch con retry',
          language: 'rust',
          useCase: 'API calls',
          dependencies: ['reqwest', 'tokio'],
          tags: ['http', 'async'],
          qualityScore: 0.9,
        });
      });

      /**
       * @test
       * Learn-code con defaults (sin opcionales)
       */
      it('usa defaults para dependencies, tags y quality', async () => {
        const cmd = findCommand(commands, 'learn-code');
        await cmd.handler({
          code: 'console.log("hi")',
          description: 'Simple log',
          language: 'typescript',
          use_case: 'debugging',
        });

        expect(api.learnCode).toHaveBeenCalledWith({
          code: 'console.log("hi")',
          description: 'Simple log',
          language: 'typescript',
          useCase: 'debugging',
          dependencies: [],
          tags: [],
          qualityScore: 0.8,
        });
      });
    });

    // --- mm:recall-code ---

    describe('mm:recall-code', () => {
      /**
       * @test
       * @requirement T26 - Recall-code
       * @acceptance Scenario: Buscar snippet por descripcion
       */
      it('llama recallCode con query y topK', async () => {
        const cmd = findCommand(commands, 'recall-code');
        const result = await cmd.handler({ query: 'HTTP client async', top_k: '3' });

        expect(result.success).toBe(true);
        expect(result.data.query).toBe('HTTP client async');
        expect(result.data.count).toBe(1);
        expect(api.recallCode).toHaveBeenCalledWith('HTTP client async', 3);
      });

      /**
       * @test
       * Recall-code usa top_k default de 5
       */
      it('usa top_k default de 5', async () => {
        const cmd = findCommand(commands, 'recall-code');
        await cmd.handler({ query: 'test' });

        expect(api.recallCode).toHaveBeenCalledWith('test', 5);
      });
    });

    // --- mm:learn-error ---

    describe('mm:learn-error', () => {
      /**
       * @test
       * @requirement T27 - Learn-error completo
       * @acceptance Scenario: Registrar solucion a error
       */
      it('llama learnError con todos los params requeridos', async () => {
        const cmd = findCommand(commands, 'learn-error');
        const result = await cmd.handler({
          error_message: 'cannot borrow as mutable',
          error_type: 'E0596',
          root_cause: 'Missing mut keyword',
          solution: 'Add mut to binding',
          language: 'rust',
        });

        expect(result.success).toBe(true);
        expect(result.data.errorType).toBe('E0596');
        expect(result.data.language).toBe('rust');
        expect(result.data.hasFix).toBe(false);
        expect(api.learnError).toHaveBeenCalledWith({
          errorMessage: 'cannot borrow as mutable',
          errorType: 'E0596',
          rootCause: 'Missing mut keyword',
          solution: 'Add mut to binding',
          fixedCode: undefined,
          language: 'rust',
        });
      });

      /**
       * @test
       * @requirement T28 - Learn-error con fixed_code
       * @acceptance Scenario: Registrar solucion con codigo corregido
       */
      it('retorna hasFix true cuando incluye fixed_code', async () => {
        const cmd = findCommand(commands, 'learn-error');
        const result = await cmd.handler({
          error_message: 'type error',
          error_type: 'TypeError',
          root_cause: 'Wrong type',
          solution: 'Cast to number',
          fixed_code: 'const x: number = Number(val);',
          language: 'typescript',
        });

        expect(result.success).toBe(true);
        expect(result.data.hasFix).toBe(true);
        expect(api.learnError).toHaveBeenCalledWith(
          expect.objectContaining({
            fixedCode: 'const x: number = Number(val);',
          }),
        );
      });
    });

    // --- mm:recall-errors ---

    describe('mm:recall-errors', () => {
      /**
       * @test
       * @requirement T29 - Recall-errors
       * @acceptance Scenario: Buscar solucion a error
       */
      it('llama recallErrors con query y topK', async () => {
        const cmd = findCommand(commands, 'recall-errors');
        const result = await cmd.handler({
          query: 'borrow checker mutable',
          top_k: '2',
        });

        expect(result.success).toBe(true);
        expect(result.data.query).toBe('borrow checker mutable');
        expect(result.data.count).toBe(1);
        expect(api.recallErrors).toHaveBeenCalledWith('borrow checker mutable', 2);
      });

      /**
       * @test
       * Recall-errors usa top_k default de 3
       */
      it('usa top_k default de 3', async () => {
        const cmd = findCommand(commands, 'recall-errors');
        await cmd.handler({ query: 'error' });

        expect(api.recallErrors).toHaveBeenCalledWith('error', 3);
      });
    });

    // --- mm:context ---

    describe('mm:context', () => {
      /**
       * @test
       * @requirement T30 - Context set
       * @acceptance Scenario: Establecer contexto de trabajo
       */
      it('SET - llama setWorkingContext con project, task y goals', async () => {
        const cmd = findCommand(commands, 'context');
        const result = await cmd.handler({
          project: 'agent-shell',
          task: 'Tests',
          goals: '["Cobertura 90%", "Sin bugs"]',
        });

        expect(result.success).toBe(true);
        expect(result.data.action).toBe('set');
        expect(result.data.project).toBe('agent-shell');
        expect(result.data.task).toBe('Tests');
        expect(result.data.goals).toEqual(['Cobertura 90%', 'Sin bugs']);
        expect(api.setWorkingContext).toHaveBeenCalledWith(
          'agent-shell',
          'Tests',
          ['Cobertura 90%', 'Sin bugs'],
        );
      });

      /**
       * @test
       * @requirement T31 - Context get
       * @acceptance Scenario: Obtener contexto actual (get)
       */
      it('GET - retorna working context cuando no hay params', async () => {
        const cmd = findCommand(commands, 'context');
        const result = await cmd.handler({});

        expect(result.success).toBe(true);
        expect(result.data.action).toBe('get');
        expect(result.data.context).toEqual({ current_project: 'test' });
        expect(api.getWorkingContext).toHaveBeenCalled();
      });

      /**
       * @test
       * Context SET solo con project (sin task ni goals)
       */
      it('SET - funciona solo con project', async () => {
        const cmd = findCommand(commands, 'context');
        const result = await cmd.handler({ project: 'my-app' });

        expect(result.success).toBe(true);
        expect(result.data.action).toBe('set');
        expect(api.setWorkingContext).toHaveBeenCalledWith('my-app', undefined, undefined);
      });
    });

    // --- mm:focus ---

    describe('mm:focus', () => {
      /**
       * @test
       * @requirement T32 - Focus proyecto
       * @acceptance Scenario: Enfocar en proyecto
       */
      it('llama focusProject con el nombre del proyecto', async () => {
        const cmd = findCommand(commands, 'focus');
        const result = await cmd.handler({ project: 'my-app' });

        expect(result.success).toBe(true);
        expect(result.data.focused).toBe('my-app');
        expect(api.focusProject).toHaveBeenCalledWith('my-app');
      });
    });

    // --- mm:memory-stats ---

    describe('mm:memory-stats', () => {
      /**
       * @test
       * @requirement T33 - Memory-stats completo
       * @acceptance Scenario: Memory stats con AgentMemory disponible
       */
      it('retorna stats combinados de vectorDb y agentMemory', async () => {
        const cmd = findCommand(commands, 'memory-stats');
        const result = await cmd.handler({});

        expect(result.success).toBe(true);
        expect(result.data.vectorDb).toEqual({
          count: 10,
          dimensions: 768,
          distance: 'cosine',
          indexType: 'hnsw',
          hasFulltext: true,
          quantization: 'none',
        });
        expect(result.data.agentMemory).toEqual({
          totalEntries: 5,
          episodes: 2,
          codeSnippets: 2,
          errorSolutions: 1,
        });
      });

      /**
       * @test
       * @requirement T34 - Memory-stats sin AgentMemory
       * @acceptance Scenario: Memory stats sin AgentMemory
       */
      it('retorna agentMemory null si no esta disponible (sin error)', async () => {
        api.agentMemoryStats.mockImplementation(() => {
          throw new Error('AgentMemory not available');
        });

        const cmd = findCommand(commands, 'memory-stats');
        const result = await cmd.handler({});

        expect(result.success).toBe(true);
        expect(result.data.vectorDb).toBeDefined();
        expect(result.data.agentMemory).toBeNull();
      });
    });

    // --- mm:save-memory ---

    describe('mm:save-memory', () => {
      /**
       * @test
       * @requirement T35 - Save-memory
       * @acceptance Scenario: Save memory
       */
      it('llama saveMemory con el path', async () => {
        const cmd = findCommand(commands, 'save-memory');
        const result = await cmd.handler({ path: './agent.mmdb' });

        expect(result.success).toBe(true);
        expect(result.data.saved).toBe('./agent.mmdb');
        expect(api.saveMemory).toHaveBeenCalledWith('./agent.mmdb');
      });
    });

    // --- mm:load-memory ---

    describe('mm:load-memory', () => {
      /**
       * @test
       * @requirement T36 - Load-memory
       * @acceptance Scenario: Load memory
       */
      it('llama loadMemory con el path', async () => {
        const cmd = findCommand(commands, 'load-memory');
        const result = await cmd.handler({ path: './agent.mmdb' });

        expect(result.success).toBe(true);
        expect(result.data.loaded).toBe('./agent.mmdb');
        expect(api.loadMemory).toHaveBeenCalledWith('./agent.mmdb');
      });
    });
  });

  // =========================================================================
  // SECTION 4: Error Handling (T37-T39)
  // =========================================================================

  describe('Error Handling', () => {
    /**
     * @test
     * @requirement T37 - Error en handler capturado
     * @acceptance Scenario: Error en operacion del adapter
     * @mustnot Lanzar excepciones sin capturar
     */
    it('handler retorna success:false cuando api lanza error (insert)', async () => {
      api.insert.mockImplementation(() => {
        throw new Error('dimension mismatch: expected 768, got 3');
      });

      const cmd = findCommand(commands, 'insert');
      const result = await cmd.handler({
        id: 'doc-1',
        vector: '[0.1, 0.2, 0.3]',
      });

      expect(result.success).toBe(false);
      expect(result.data).toBeNull();
      expect(result.error).toContain('dimension mismatch');
    });

    /**
     * @test
     * @requirement T38 - JSON invalido en vector
     * @acceptance Scenario: JSON malformado en parametro tipo json
     * @error E001 - JSON.parse falla
     */
    it('retorna error cuando JSON es invalido en vector', async () => {
      const cmd = findCommand(commands, 'search');
      const result = await cmd.handler({ vector: 'not valid json' });

      expect(result.success).toBe(false);
      expect(result.data).toBeNull();
      expect(result.error).toBeDefined();
    });

    /**
     * @test
     * JSON invalido en metadata de insert
     */
    it('retorna error cuando JSON es invalido en metadata', async () => {
      const cmd = findCommand(commands, 'insert');
      const result = await cmd.handler({
        id: 'doc-x',
        metadata: '{invalid json}',
      });

      expect(result.success).toBe(false);
      expect(result.data).toBeNull();
      expect(result.error).toBeDefined();
    });

    /**
     * @test
     * JSON invalido en filter de hybrid
     */
    it('retorna error cuando JSON es invalido en filter de hybrid', async () => {
      const cmd = findCommand(commands, 'hybrid');
      const result = await cmd.handler({
        keywords: 'test',
        filter: 'not{json',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    /**
     * @test
     * JSON invalido en learnings de learn
     */
    it('retorna error cuando JSON es invalido en learnings', async () => {
      const cmd = findCommand(commands, 'learn');
      const result = await cmd.handler({
        task: 'test',
        solution: 'test',
        outcome: 'success',
        learnings: '[invalid',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    /**
     * @test
     * @requirement T39 - AgentMemory no disponible
     * @acceptance Scenario: AgentMemory no disponible
     * @error E004 - AgentMemory not available
     */
    it('retorna error cuando learnTask lanza (AgentMemory no disponible)', async () => {
      api.learnTask.mockImplementation(() => {
        throw new Error('AgentMemory not available in this binding version');
      });

      const cmd = findCommand(commands, 'learn');
      const result = await cmd.handler({
        task: 'test',
        solution: 'test',
        outcome: 'success',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('AgentMemory not available');
    });

    /**
     * @test
     * Error capturado en recallSimilar
     */
    it('retorna error cuando recallSimilar lanza', async () => {
      api.recallSimilar.mockImplementation(() => {
        throw new Error('Index corrupted');
      });

      const cmd = findCommand(commands, 'recall');
      const result = await cmd.handler({ query: 'test' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Index corrupted');
    });

    /**
     * @test
     * Error capturado en delete
     */
    it('retorna error cuando delete lanza', async () => {
      api.delete.mockImplementation(() => {
        throw new Error('Document not found');
      });

      const cmd = findCommand(commands, 'delete');
      const result = await cmd.handler({ id: 'ghost' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Document not found');
    });

    /**
     * @test
     * Error capturado en save
     * @error E003 - Path no configurado
     */
    it('retorna error cuando save falla (no persist path)', async () => {
      api.save.mockImplementation(() => {
        throw new Error('No persist path configured');
      });

      const cmd = findCommand(commands, 'save');
      const result = await cmd.handler({});

      expect(result.success).toBe(false);
      expect(result.error).toContain('No persist path configured');
    });

    /**
     * @test
     * Error capturado en load
     * @error E006 - Archivo no encontrado
     */
    it('retorna error cuando load falla (archivo no encontrado)', async () => {
      api.load.mockImplementation(() => {
        throw new Error('ENOENT: no such file');
      });

      const cmd = findCommand(commands, 'load');
      const result = await cmd.handler({ path: './nonexistent.mmdb' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('ENOENT');
    });

    /**
     * @test
     * Error capturado en keywordSearch
     */
    it('retorna error cuando keywordSearch lanza', async () => {
      api.keywordSearch.mockImplementation(() => {
        throw new Error('BM25 index not initialized');
      });

      const cmd = findCommand(commands, 'keywords');
      const result = await cmd.handler({ query: 'test' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('BM25 index not initialized');
    });

    /**
     * @test
     * Error capturado en filterSearch
     * @error E008 - Operador invalido
     */
    it('retorna error cuando filterSearch lanza (operador invalido)', async () => {
      api.filterSearch.mockImplementation(() => {
        throw new Error('Invalid operator: regex');
      });

      const cmd = findCommand(commands, 'filter');
      const result = await cmd.handler({
        field: 'x',
        operator: 'regex',
        value: '.*',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid operator');
    });

    /**
     * @test
     * Error capturado en learnCode
     */
    it('retorna error cuando learnCode lanza', async () => {
      api.learnCode.mockImplementation(() => {
        throw new Error('Storage full');
      });

      const cmd = findCommand(commands, 'learn-code');
      const result = await cmd.handler({
        code: 'x',
        description: 'y',
        language: 'ts',
        use_case: 'z',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Storage full');
    });

    /**
     * @test
     * Error capturado en learnError
     */
    it('retorna error cuando learnError lanza', async () => {
      api.learnError.mockImplementation(() => {
        throw new Error('Failed to index');
      });

      const cmd = findCommand(commands, 'learn-error');
      const result = await cmd.handler({
        error_message: 'e',
        error_type: 'E',
        root_cause: 'r',
        solution: 's',
        language: 'ts',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to index');
    });

    /**
     * @test
     * Error capturado en recallCode
     */
    it('retorna error cuando recallCode lanza', async () => {
      api.recallCode.mockImplementation(() => {
        throw new Error('Query failed');
      });

      const cmd = findCommand(commands, 'recall-code');
      const result = await cmd.handler({ query: 'test' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Query failed');
    });

    /**
     * @test
     * Error capturado en recallErrors
     */
    it('retorna error cuando recallErrors lanza', async () => {
      api.recallErrors.mockImplementation(() => {
        throw new Error('Unexpected');
      });

      const cmd = findCommand(commands, 'recall-errors');
      const result = await cmd.handler({ query: 'test' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unexpected');
    });

    /**
     * @test
     * Error capturado en focusProject
     */
    it('retorna error cuando focusProject lanza', async () => {
      api.focusProject.mockImplementation(() => {
        throw new Error('Project not found');
      });

      const cmd = findCommand(commands, 'focus');
      const result = await cmd.handler({ project: 'ghost' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Project not found');
    });

    /**
     * @test
     * Error capturado en setWorkingContext
     */
    it('retorna error cuando setWorkingContext lanza', async () => {
      api.setWorkingContext.mockImplementation(() => {
        throw new Error('Context limit exceeded');
      });

      const cmd = findCommand(commands, 'context');
      const result = await cmd.handler({ project: 'x' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Context limit exceeded');
    });

    /**
     * @test
     * Error capturado en getWorkingContext
     */
    it('retorna error cuando getWorkingContext lanza', async () => {
      api.getWorkingContext.mockImplementation(() => {
        throw new Error('State corrupted');
      });

      const cmd = findCommand(commands, 'context');
      const result = await cmd.handler({});

      expect(result.success).toBe(false);
      expect(result.error).toContain('State corrupted');
    });

    /**
     * @test
     * Error capturado en saveMemory
     */
    it('retorna error cuando saveMemory lanza', async () => {
      api.saveMemory.mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });

      const cmd = findCommand(commands, 'save-memory');
      const result = await cmd.handler({ path: '/root/protected.mmdb' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('EACCES');
    });

    /**
     * @test
     * Error capturado en loadMemory
     */
    it('retorna error cuando loadMemory lanza', async () => {
      api.loadMemory.mockImplementation(() => {
        throw new Error('File corrupted');
      });

      const cmd = findCommand(commands, 'load-memory');
      const result = await cmd.handler({ path: './bad.mmdb' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('File corrupted');
    });

    /**
     * @test
     * Error capturado en stats (memory-stats outer catch)
     */
    it('retorna error cuando stats lanza en memory-stats', async () => {
      api.stats.mockImplementation(() => {
        throw new Error('DB not initialized');
      });

      const cmd = findCommand(commands, 'memory-stats');
      const result = await cmd.handler({});

      expect(result.success).toBe(false);
      expect(result.error).toContain('DB not initialized');
    });

    /**
     * @test
     * Todos los handlers nunca lanzan excepciones al exterior
     * @mustnot Lanzar excepciones sin capturar
     */
    it('ningun handler lanza excepcion al exterior (todos retornan resultado)', async () => {
      // Hacer que todas las APIs fallen
      const failApi = createMockApi();
      for (const key of Object.keys(failApi)) {
        (failApi as any)[key] = vi.fn(() => {
          throw new Error('Catastrophic failure');
        });
      }

      const failCommands = createMiniMemoryCommands(failApi as any);

      for (const cmd of failCommands) {
        const result = await cmd.handler({
          id: 'x',
          vector: '[1]',
          query: 'x',
          field: 'x',
          operator: 'eq',
          value: 'x',
          task: 'x',
          solution: 'x',
          outcome: 'x',
          code: 'x',
          description: 'x',
          language: 'x',
          use_case: 'x',
          error_message: 'x',
          error_type: 'x',
          root_cause: 'x',
          project: 'x',
          path: 'x',
        });

        // Ninguno debe lanzar: todos retornan un objeto con success
        expect(result).toHaveProperty('success');
        expect(typeof result.success).toBe('boolean');
      }
    });
  });

  // =========================================================================
  // SECTION 5: MUST NOT - Negative Tests
  // =========================================================================

  describe('MUST NOT (Restricciones)', () => {
    /**
     * @test
     * @mustnot Almacenar estado mutable en el modulo
     */
    it('llamar createMiniMemoryCommands multiples veces produce arrays independientes', () => {
      const commands1 = createMiniMemoryCommands(api as any);
      const commands2 = createMiniMemoryCommands(api as any);

      expect(commands1).not.toBe(commands2);
      expect(commands1).toHaveLength(commands2.length);
    });

    /**
     * @test
     * @mustnot Retornar valores raw sin envolver en { success, data, error }
     */
    it('todos los handlers retornan formato { success, data } o { success, data, error }', async () => {
      const cmd = findCommand(commands, 'stats');
      const result = await cmd.handler({});

      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('data');
    });

    /**
     * @test
     * Los comandos no destructivos NO tienen confirm: true
     */
    it('comandos no destructivos no tienen confirm true', () => {
      const nonDestructive = commands.filter((c: any) => c.name !== 'delete');
      for (const cmd of nonDestructive) {
        expect(cmd.confirm).not.toBe(true);
      }
    });

    /**
     * @test
     * Solo insert tiene undoable: true
     */
    it('solo insert tiene undoable true', () => {
      const undoableCommands = commands.filter((c: any) => c.undoable === true);
      expect(undoableCommands).toHaveLength(1);
      expect(undoableCommands[0].name).toBe('insert');
    });
  });

  // =========================================================================
  // SECTION 6: Completeness - Verificacion del catalogo
  // =========================================================================

  describe('Catalogo completo de comandos', () => {
    const expectedNames = [
      'stats',
      'insert',
      'delete',
      'get',
      'search',
      'keywords',
      'hybrid',
      'filter',
      'save',
      'load',
      'learn',
      'recall',
      'learn-code',
      'recall-code',
      'learn-error',
      'recall-errors',
      'context',
      'focus',
      'memory-stats',
      'save-memory',
      'load-memory',
    ];

    it('contiene los 21 comandos esperados por nombre', () => {
      const names = commands.map((c: any) => c.name).sort();
      expect(names).toEqual(expectedNames.sort());
    });

    it('todos tienen description no vacia', () => {
      for (const cmd of commands) {
        expect(cmd.description).toBeDefined();
        expect(cmd.description.length).toBeGreaterThan(0);
      }
    });

    it('todos tienen example no vacio', () => {
      for (const cmd of commands) {
        expect(cmd.example).toBeDefined();
        expect(cmd.example.length).toBeGreaterThan(0);
      }
    });
  });
});
