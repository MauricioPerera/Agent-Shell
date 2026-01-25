/**
 * minimemory Integration Commands for Agent Shell.
 *
 * Exposes minimemory operations as Agent Shell commands, providing AI agents
 * with embedded vector search, hybrid search (vector + BM25 + filters),
 * and persistent agent memory (learn/recall tasks, code, errors).
 *
 * Strategy: minimemory's VectorDB and AgentMemory become first-class
 * commands in Agent Shell's namespace system. An AI agent can say
 * "remember this code pattern" and Agent Shell's vector index will
 * find the matching minimemory operation.
 *
 * Requirements:
 *   - minimemory Node.js binding: npm install minimemory
 *
 * Usage: bun demo/minimemory-integration.ts
 *
 * @see https://github.com/MauricioPerera/minimemory
 */

import { MiniMemoryApiAdapter } from './adapters/minimemory-api.js';

/**
 * Creates minimemory command definitions for Agent Shell.
 * Each command wraps a minimemory binding operation.
 */
export function createMiniMemoryCommands(api: MiniMemoryApiAdapter) {
  return [
    // === mm:stats - Database statistics ===
    {
      namespace: 'mm',
      name: 'stats',
      version: '1.0.0',
      description: 'Muestra estadisticas de la base de datos vectorial: documentos, dimensiones, tipo de indice y quantizacion',
      params: [],
      tags: ['minimemory', 'stats', 'status', 'info', 'database', 'vectors', 'count'],
      example: 'mm:stats',
      handler: async () => {
        try {
          const stats = api.stats();
          return { success: true, data: stats };
        } catch (error: any) {
          return { success: false, data: null, error: `Error obteniendo stats: ${error.message}` };
        }
      },
      undoable: false,
    },

    // === mm:insert - Insert document with vector and/or metadata ===
    {
      namespace: 'mm',
      name: 'insert',
      version: '1.0.0',
      description: 'Inserta un documento en la base de datos con vector de embedding y metadata opcional',
      params: [
        { name: 'id', type: 'string', required: true, description: 'ID unico del documento' },
        { name: 'vector', type: 'json', required: false, description: 'Vector de embedding (array de floats). Si se omite, se inserta solo metadata' },
        { name: 'metadata', type: 'json', required: false, description: 'Metadata del documento (objeto JSON)' },
        { name: 'content', type: 'string', required: false, description: 'Contenido textual para full-text search' },
      ],
      tags: ['minimemory', 'insert', 'add', 'store', 'document', 'vector', 'embedding', 'create'],
      example: 'mm:insert --id "doc-1" --metadata \'{"title": "Example", "category": "tech"}\'',
      handler: async (args: any) => {
        try {
          const vector = args.vector ? (typeof args.vector === 'string' ? JSON.parse(args.vector) : args.vector) : undefined;
          const metadata = args.metadata ? (typeof args.metadata === 'string' ? JSON.parse(args.metadata) : args.metadata) : undefined;

          if (metadata && args.content) {
            metadata.content = args.content;
          }

          api.insert({ id: args.id, vector, metadata });
          return {
            success: true,
            data: { id: args.id, hasVector: !!vector, metadataKeys: metadata ? Object.keys(metadata) : [] },
          };
        } catch (error: any) {
          return { success: false, data: null, error: `Error insertando: ${error.message}` };
        }
      },
      undoable: true,
    },

    // === mm:delete - Delete document ===
    {
      namespace: 'mm',
      name: 'delete',
      version: '1.0.0',
      description: 'Elimina un documento de la base de datos por su ID',
      params: [
        { name: 'id', type: 'string', required: true, description: 'ID del documento a eliminar' },
      ],
      tags: ['minimemory', 'delete', 'remove', 'document'],
      example: 'mm:delete --id "doc-1"',
      handler: async (args: any) => {
        try {
          api.delete(args.id);
          return { success: true, data: { deleted: args.id } };
        } catch (error: any) {
          return { success: false, data: null, error: `Error eliminando: ${error.message}` };
        }
      },
      confirm: true,
      undoable: false,
    },

    // === mm:get - Get document by ID ===
    {
      namespace: 'mm',
      name: 'get',
      version: '1.0.0',
      description: 'Obtiene un documento por su ID incluyendo vector y metadata',
      params: [
        { name: 'id', type: 'string', required: true, description: 'ID del documento' },
      ],
      tags: ['minimemory', 'get', 'fetch', 'retrieve', 'document', 'read'],
      example: 'mm:get --id "doc-1"',
      handler: async (args: any) => {
        try {
          const doc = api.get(args.id);
          if (!doc) {
            return { success: false, data: null, error: `Documento "${args.id}" no encontrado` };
          }
          return { success: true, data: { id: args.id, ...doc } };
        } catch (error: any) {
          return { success: false, data: null, error: `Error obteniendo documento: ${error.message}` };
        }
      },
      undoable: false,
    },

    // === mm:search - Vector similarity search ===
    {
      namespace: 'mm',
      name: 'search',
      version: '1.0.0',
      description: 'Busqueda semantica por similitud vectorial usando HNSW. Encuentra documentos similares a un vector de consulta',
      params: [
        { name: 'vector', type: 'json', required: true, description: 'Vector de consulta (array de floats)' },
        { name: 'top_k', type: 'int', required: false, description: 'Cantidad de resultados (default: 5)' },
      ],
      tags: ['minimemory', 'search', 'vector', 'semantic', 'similarity', 'find', 'nearest', 'hnsw'],
      example: 'mm:search --vector "[0.1, 0.2, ...]" --top_k 10',
      handler: async (args: any) => {
        try {
          const vector = typeof args.vector === 'string' ? JSON.parse(args.vector) : args.vector;
          const topK = args.top_k ? Number(args.top_k) : 5;
          const results = api.search(vector, topK);
          return {
            success: true,
            data: { count: results.length, results },
          };
        } catch (error: any) {
          return { success: false, data: null, error: `Error en busqueda vectorial: ${error.message}` };
        }
      },
      undoable: false,
    },

    // === mm:keywords - BM25 keyword search ===
    {
      namespace: 'mm',
      name: 'keywords',
      version: '1.0.0',
      description: 'Busqueda por palabras clave usando BM25 full-text search sobre los campos indexados',
      params: [
        { name: 'query', type: 'string', required: true, description: 'Terminos de busqueda' },
        { name: 'top_k', type: 'int', required: false, description: 'Cantidad de resultados (default: 10)' },
      ],
      tags: ['minimemory', 'keywords', 'bm25', 'fulltext', 'text', 'search', 'find'],
      example: 'mm:keywords --query "rust programming async" --top_k 5',
      handler: async (args: any) => {
        try {
          const topK = args.top_k ? Number(args.top_k) : 10;
          const results = api.keywordSearch(args.query, topK);
          return {
            success: true,
            data: { query: args.query, count: results.length, results },
          };
        } catch (error: any) {
          return { success: false, data: null, error: `Error en busqueda BM25: ${error.message}` };
        }
      },
      undoable: false,
    },

    // === mm:hybrid - Hybrid search (vector + keywords + filters) ===
    {
      namespace: 'mm',
      name: 'hybrid',
      version: '1.0.0',
      description: 'Busqueda hibrida combinando similitud vectorial, keywords BM25 y filtros de metadata con fusion RRF',
      params: [
        { name: 'vector', type: 'json', required: false, description: 'Vector de consulta (array de floats)' },
        { name: 'keywords', type: 'string', required: false, description: 'Terminos de busqueda para BM25' },
        { name: 'filter', type: 'json', required: false, description: 'Filtro de metadata (ej: {"category": "tech"})' },
        { name: 'top_k', type: 'int', required: false, description: 'Cantidad de resultados (default: 10)' },
        { name: 'vector_weight', type: 'float', required: false, description: 'Peso del vector vs keywords (0.0-1.0, default: 0.7)' },
      ],
      tags: ['minimemory', 'hybrid', 'search', 'vector', 'keywords', 'filter', 'combined', 'rrf', 'fusion'],
      example: 'mm:hybrid --keywords "authentication JWT" --filter \'{"category": "security"}\' --top_k 5',
      handler: async (args: any) => {
        try {
          const vector = args.vector ? (typeof args.vector === 'string' ? JSON.parse(args.vector) : args.vector) : undefined;
          const filter = args.filter ? (typeof args.filter === 'string' ? JSON.parse(args.filter) : args.filter) : undefined;
          const topK = args.top_k ? Number(args.top_k) : 10;
          const vectorWeight = args.vector_weight ? Number(args.vector_weight) : undefined;

          const results = api.hybridSearch({
            vector,
            keywords: args.keywords,
            filter,
            topK,
            vectorWeight,
          });

          return {
            success: true,
            data: {
              keywords: args.keywords || null,
              hasVector: !!vector,
              hasFilter: !!filter,
              count: results.length,
              results,
            },
          };
        } catch (error: any) {
          return { success: false, data: null, error: `Error en busqueda hibrida: ${error.message}` };
        }
      },
      undoable: false,
    },

    // === mm:filter - Metadata filter search ===
    {
      namespace: 'mm',
      name: 'filter',
      version: '1.0.0',
      description: 'Busqueda por filtros de metadata usando operadores (eq, gt, lt, contains, etc)',
      params: [
        { name: 'field', type: 'string', required: true, description: 'Campo de metadata a filtrar' },
        { name: 'operator', type: 'string', required: true, description: 'Operador: eq, ne, gt, gte, lt, lte, contains, starts_with' },
        { name: 'value', type: 'string', required: true, description: 'Valor a comparar' },
        { name: 'top_k', type: 'int', required: false, description: 'Cantidad de resultados (default: 20)' },
      ],
      tags: ['minimemory', 'filter', 'metadata', 'query', 'where', 'condition', 'operator'],
      example: 'mm:filter --field "category" --operator "eq" --value "tech" --top_k 10',
      handler: async (args: any) => {
        try {
          const topK = args.top_k ? Number(args.top_k) : 20;
          let value: any = args.value;
          // Try to parse numbers/booleans
          if (value === 'true') value = true;
          else if (value === 'false') value = false;
          else if (!isNaN(Number(value))) value = Number(value);

          const results = api.filterSearch(
            [{ field: args.field, operator: args.operator, value }],
            topK,
          );
          return {
            success: true,
            data: { filter: { field: args.field, operator: args.operator, value }, count: results.length, results },
          };
        } catch (error: any) {
          return { success: false, data: null, error: `Error en busqueda por filtros: ${error.message}` };
        }
      },
      undoable: false,
    },

    // === mm:save - Persist to disk ===
    {
      namespace: 'mm',
      name: 'save',
      version: '1.0.0',
      description: 'Guarda la base de datos a disco en formato .mmdb para persistencia entre sesiones',
      params: [
        { name: 'path', type: 'string', required: false, description: 'Ruta del archivo .mmdb (usa la ruta configurada si se omite)' },
      ],
      tags: ['minimemory', 'save', 'persist', 'disk', 'file', 'export', 'backup'],
      example: 'mm:save --path "./my-data.mmdb"',
      handler: async (args: any) => {
        try {
          api.save(args.path);
          return { success: true, data: { saved: args.path || 'default path' } };
        } catch (error: any) {
          return { success: false, data: null, error: `Error guardando: ${error.message}` };
        }
      },
      undoable: false,
    },

    // === mm:load - Load from disk ===
    {
      namespace: 'mm',
      name: 'load',
      version: '1.0.0',
      description: 'Carga la base de datos desde un archivo .mmdb en disco',
      params: [
        { name: 'path', type: 'string', required: false, description: 'Ruta del archivo .mmdb a cargar' },
      ],
      tags: ['minimemory', 'load', 'restore', 'import', 'open', 'read'],
      example: 'mm:load --path "./my-data.mmdb"',
      handler: async (args: any) => {
        try {
          api.load(args.path);
          const stats = api.stats();
          return { success: true, data: { loaded: args.path || 'default path', count: stats.count } };
        } catch (error: any) {
          return { success: false, data: null, error: `Error cargando: ${error.message}` };
        }
      },
      undoable: false,
    },

    // === Agent Memory Commands ===

    // === mm:learn - Learn from a task ===
    {
      namespace: 'mm',
      name: 'learn',
      version: '1.0.0',
      description: 'Aprende de una tarea completada, almacenando la experiencia (episodio) para referencia futura',
      params: [
        { name: 'task', type: 'string', required: true, description: 'Descripcion de la tarea realizada' },
        { name: 'solution', type: 'string', required: true, description: 'Solucion aplicada o codigo implementado' },
        { name: 'outcome', type: 'string', required: true, description: 'Resultado: success, failure, o partial' },
        { name: 'learnings', type: 'json', required: false, description: 'Array de lecciones aprendidas' },
      ],
      tags: ['minimemory', 'learn', 'task', 'experience', 'episode', 'remember', 'store', 'memory', 'agent'],
      example: 'mm:learn --task "Implementar auth JWT" --solution "Usar jsonwebtoken crate" --outcome "success" --learnings \'["Validar expiration"]\'',
      handler: async (args: any) => {
        try {
          const learnings = args.learnings
            ? (typeof args.learnings === 'string' ? JSON.parse(args.learnings) : args.learnings)
            : [];

          api.learnTask({
            task: args.task,
            solution: args.solution,
            outcome: args.outcome,
            learnings,
          });
          return {
            success: true,
            data: { task: args.task, outcome: args.outcome, learnings: learnings.length },
          };
        } catch (error: any) {
          return { success: false, data: null, error: `Error aprendiendo tarea: ${error.message}` };
        }
      },
      undoable: false,
    },

    // === mm:recall - Recall similar experiences ===
    {
      namespace: 'mm',
      name: 'recall',
      version: '1.0.0',
      description: 'Recuerda experiencias similares a una consulta, buscando en la memoria episodica del agente',
      params: [
        { name: 'query', type: 'string', required: true, description: 'Descripcion de lo que se busca recordar' },
        { name: 'top_k', type: 'int', required: false, description: 'Cantidad de resultados (default: 5)' },
      ],
      tags: ['minimemory', 'recall', 'remember', 'search', 'experience', 'similar', 'memory', 'agent', 'history'],
      example: 'mm:recall --query "autenticacion de usuarios" --top_k 3',
      handler: async (args: any) => {
        try {
          const topK = args.top_k ? Number(args.top_k) : 5;
          const results = api.recallSimilar(args.query, topK);
          return {
            success: true,
            data: { query: args.query, count: results.length, results },
          };
        } catch (error: any) {
          return { success: false, data: null, error: `Error recordando: ${error.message}` };
        }
      },
      undoable: false,
    },

    // === mm:learn-code - Learn a code snippet ===
    {
      namespace: 'mm',
      name: 'learn-code',
      version: '1.0.0',
      description: 'Almacena un snippet de codigo aprendido con su contexto, lenguaje y caso de uso',
      params: [
        { name: 'code', type: 'string', required: true, description: 'Codigo fuente del snippet' },
        { name: 'description', type: 'string', required: true, description: 'Descripcion de lo que hace' },
        { name: 'language', type: 'string', required: true, description: 'Lenguaje de programacion (rust, typescript, python, etc)' },
        { name: 'use_case', type: 'string', required: true, description: 'Caso de uso tipico' },
        { name: 'dependencies', type: 'json', required: false, description: 'Array de dependencias necesarias' },
        { name: 'tags', type: 'json', required: false, description: 'Array de tags para clasificacion' },
        { name: 'quality', type: 'float', required: false, description: 'Score de calidad 0.0-1.0 (default: 0.8)' },
      ],
      tags: ['minimemory', 'learn', 'code', 'snippet', 'store', 'remember', 'pattern', 'programming'],
      example: 'mm:learn-code --code "async fn fetch() { ... }" --description "HTTP fetch con retry" --language "rust" --use_case "API calls"',
      handler: async (args: any) => {
        try {
          const dependencies = args.dependencies
            ? (typeof args.dependencies === 'string' ? JSON.parse(args.dependencies) : args.dependencies)
            : [];
          const tags = args.tags
            ? (typeof args.tags === 'string' ? JSON.parse(args.tags) : args.tags)
            : [];

          api.learnCode({
            code: args.code,
            description: args.description,
            language: args.language,
            useCase: args.use_case,
            dependencies,
            tags,
            qualityScore: args.quality ? Number(args.quality) : 0.8,
          });
          return {
            success: true,
            data: { description: args.description, language: args.language, useCase: args.use_case },
          };
        } catch (error: any) {
          return { success: false, data: null, error: `Error almacenando codigo: ${error.message}` };
        }
      },
      undoable: false,
    },

    // === mm:recall-code - Recall code snippets ===
    {
      namespace: 'mm',
      name: 'recall-code',
      version: '1.0.0',
      description: 'Busca snippets de codigo similares a una consulta en la memoria del agente',
      params: [
        { name: 'query', type: 'string', required: true, description: 'Descripcion del tipo de codigo buscado' },
        { name: 'top_k', type: 'int', required: false, description: 'Cantidad de resultados (default: 5)' },
      ],
      tags: ['minimemory', 'recall', 'code', 'snippet', 'search', 'find', 'pattern', 'programming'],
      example: 'mm:recall-code --query "HTTP client async con reintentos" --top_k 3',
      handler: async (args: any) => {
        try {
          const topK = args.top_k ? Number(args.top_k) : 5;
          const results = api.recallCode(args.query, topK);
          return {
            success: true,
            data: { query: args.query, count: results.length, results },
          };
        } catch (error: any) {
          return { success: false, data: null, error: `Error buscando codigo: ${error.message}` };
        }
      },
      undoable: false,
    },

    // === mm:learn-error - Learn an error solution ===
    {
      namespace: 'mm',
      name: 'learn-error',
      version: '1.0.0',
      description: 'Registra la solucion a un error encontrado para referencia futura cuando ocurra de nuevo',
      params: [
        { name: 'error_message', type: 'string', required: true, description: 'Mensaje de error original' },
        { name: 'error_type', type: 'string', required: true, description: 'Tipo o codigo del error (ej: E0596, TypeError)' },
        { name: 'root_cause', type: 'string', required: true, description: 'Causa raiz del error' },
        { name: 'solution', type: 'string', required: true, description: 'Descripcion de la solucion aplicada' },
        { name: 'fixed_code', type: 'string', required: false, description: 'Codigo corregido (si aplica)' },
        { name: 'language', type: 'string', required: true, description: 'Lenguaje de programacion' },
      ],
      tags: ['minimemory', 'learn', 'error', 'solution', 'fix', 'debug', 'troubleshoot', 'bug'],
      example: 'mm:learn-error --error_message "cannot borrow as mutable" --error_type "E0596" --root_cause "Missing mut" --solution "Add mut keyword" --language "rust"',
      handler: async (args: any) => {
        try {
          api.learnError({
            errorMessage: args.error_message,
            errorType: args.error_type,
            rootCause: args.root_cause,
            solution: args.solution,
            fixedCode: args.fixed_code,
            language: args.language,
          });
          return {
            success: true,
            data: { errorType: args.error_type, language: args.language, hasFix: !!args.fixed_code },
          };
        } catch (error: any) {
          return { success: false, data: null, error: `Error registrando solucion: ${error.message}` };
        }
      },
      undoable: false,
    },

    // === mm:recall-errors - Recall error solutions ===
    {
      namespace: 'mm',
      name: 'recall-errors',
      version: '1.0.0',
      description: 'Busca soluciones a errores similares en la memoria del agente',
      params: [
        { name: 'query', type: 'string', required: true, description: 'Mensaje de error o descripcion del problema' },
        { name: 'top_k', type: 'int', required: false, description: 'Cantidad de resultados (default: 3)' },
      ],
      tags: ['minimemory', 'recall', 'error', 'solution', 'debug', 'troubleshoot', 'fix', 'help'],
      example: 'mm:recall-errors --query "borrow checker mutable reference" --top_k 3',
      handler: async (args: any) => {
        try {
          const topK = args.top_k ? Number(args.top_k) : 3;
          const results = api.recallErrors(args.query, topK);
          return {
            success: true,
            data: { query: args.query, count: results.length, results },
          };
        } catch (error: any) {
          return { success: false, data: null, error: `Error buscando soluciones: ${error.message}` };
        }
      },
      undoable: false,
    },

    // === mm:context - Set/get working context ===
    {
      namespace: 'mm',
      name: 'context',
      version: '1.0.0',
      description: 'Establece o muestra el contexto de trabajo actual (proyecto, tarea, goals)',
      params: [
        { name: 'project', type: 'string', required: false, description: 'Nombre del proyecto actual' },
        { name: 'task', type: 'string', required: false, description: 'Tarea actual en progreso' },
        { name: 'goals', type: 'json', required: false, description: 'Array de goals activos' },
      ],
      tags: ['minimemory', 'context', 'working', 'project', 'task', 'goals', 'current', 'state'],
      example: 'mm:context --project "agent-shell" --task "Integrar minimemory" --goals \'["Crear adapter", "Tests"]\'',
      handler: async (args: any) => {
        try {
          if (args.project || args.task || args.goals) {
            const goals = args.goals
              ? (typeof args.goals === 'string' ? JSON.parse(args.goals) : args.goals)
              : undefined;
            api.setWorkingContext(args.project || 'default', args.task, goals);
            return {
              success: true,
              data: { action: 'set', project: args.project, task: args.task, goals },
            };
          } else {
            const ctx = api.getWorkingContext();
            return { success: true, data: { action: 'get', context: ctx } };
          }
        } catch (error: any) {
          return { success: false, data: null, error: `Error con contexto: ${error.message}` };
        }
      },
      undoable: false,
    },

    // === mm:focus - Focus on a project (partial index) ===
    {
      namespace: 'mm',
      name: 'focus',
      version: '1.0.0',
      description: 'Enfoca la memoria en un proyecto especifico usando indice parcial para busquedas mas rapidas',
      params: [
        { name: 'project', type: 'string', required: true, description: 'Nombre del proyecto en el que enfocar' },
      ],
      tags: ['minimemory', 'focus', 'project', 'scope', 'partial', 'index', 'filter'],
      example: 'mm:focus --project "my-app"',
      handler: async (args: any) => {
        try {
          api.focusProject(args.project);
          return { success: true, data: { focused: args.project } };
        } catch (error: any) {
          return { success: false, data: null, error: `Error enfocando proyecto: ${error.message}` };
        }
      },
      undoable: false,
    },

    // === mm:memory-stats - Agent memory statistics ===
    {
      namespace: 'mm',
      name: 'memory-stats',
      version: '1.0.0',
      description: 'Muestra estadisticas de la memoria del agente: episodios, snippets, soluciones almacenadas',
      params: [],
      tags: ['minimemory', 'memory', 'stats', 'agent', 'episodes', 'snippets', 'count'],
      example: 'mm:memory-stats',
      handler: async () => {
        try {
          const dbStats = api.stats();
          let memoryStats = null;
          try {
            memoryStats = api.agentMemoryStats();
          } catch {
            // AgentMemory not available
          }
          return {
            success: true,
            data: { vectorDb: dbStats, agentMemory: memoryStats },
          };
        } catch (error: any) {
          return { success: false, data: null, error: `Error obteniendo stats: ${error.message}` };
        }
      },
      undoable: false,
    },

    // === mm:save-memory - Save agent memory ===
    {
      namespace: 'mm',
      name: 'save-memory',
      version: '1.0.0',
      description: 'Guarda la memoria del agente a disco para persistencia entre sesiones',
      params: [
        { name: 'path', type: 'string', required: true, description: 'Ruta del archivo .mmdb para la memoria' },
      ],
      tags: ['minimemory', 'save', 'memory', 'persist', 'export', 'backup', 'agent'],
      example: 'mm:save-memory --path "./agent-memory.mmdb"',
      handler: async (args: any) => {
        try {
          api.saveMemory(args.path);
          return { success: true, data: { saved: args.path } };
        } catch (error: any) {
          return { success: false, data: null, error: `Error guardando memoria: ${error.message}` };
        }
      },
      undoable: false,
    },

    // === mm:load-memory - Load agent memory ===
    {
      namespace: 'mm',
      name: 'load-memory',
      version: '1.0.0',
      description: 'Carga la memoria del agente desde un archivo .mmdb en disco',
      params: [
        { name: 'path', type: 'string', required: true, description: 'Ruta del archivo .mmdb a cargar' },
      ],
      tags: ['minimemory', 'load', 'memory', 'restore', 'import', 'agent'],
      example: 'mm:load-memory --path "./agent-memory.mmdb"',
      handler: async (args: any) => {
        try {
          api.loadMemory(args.path);
          return { success: true, data: { loaded: args.path } };
        } catch (error: any) {
          return { success: false, data: null, error: `Error cargando memoria: ${error.message}` };
        }
      },
      undoable: false,
    },
  ];
}
