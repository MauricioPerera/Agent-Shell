/**
 * LangGraph Integration Commands for Agent Shell.
 *
 * Exposes LangGraph server operations as Agent Shell commands, allowing
 * AI agents to discover and orchestrate stateful graph-based workflows
 * via semantic search.
 *
 * Strategy: LangGraph assistants, threads, and runs become first-class
 * commands in Agent Shell's namespace system. An AI agent can say
 * "run an agent graph" and Agent Shell's vector index will find the
 * matching LangGraph operation.
 *
 * Requirements:
 *   - LangGraph server running (default: http://localhost:8123)
 *   - Environment variables: LANGGRAPH_BASE_URL, LANGGRAPH_API_KEY (optional)
 *
 * Usage: bun demo/langgraph-integration.ts
 */

import { LangGraphApiAdapter } from './adapters/langgraph-api.js';

/**
 * Creates LangGraph command definitions for Agent Shell.
 * Each command wraps a LangGraph API operation.
 */
export function createLangGraphCommands(api: LangGraphApiAdapter) {
  return [
    // === langgraph:health - Check server connectivity ===
    {
      namespace: 'langgraph',
      name: 'health',
      version: '1.0.0',
      description: 'Verifica el estado de conexion con el servidor LangGraph',
      params: [],
      tags: ['langgraph', 'health', 'status', 'monitoring', 'connectivity'],
      example: 'langgraph:health',
      handler: async () => {
        try {
          const health = await api.healthCheck();
          return { success: true, data: health };
        } catch (error: any) {
          return { success: false, data: null, error: `LangGraph no disponible: ${error.message}` };
        }
      },
      undoable: false,
    },

    // === langgraph:assistants - List available graphs/assistants ===
    {
      namespace: 'langgraph',
      name: 'assistants',
      version: '1.0.0',
      description: 'Lista los asistentes (grafos) disponibles en LangGraph con su configuracion',
      params: [
        { name: 'graph_id', type: 'string', required: false, description: 'Filtrar por graph ID especifico' },
        { name: 'limit', type: 'int', required: false, description: 'Cantidad maxima de resultados (default: 10)' },
      ],
      tags: ['langgraph', 'assistants', 'agents', 'graphs', 'listing', 'available'],
      example: 'langgraph:assistants --graph_id "react-agent"',
      handler: async (args: any) => {
        try {
          const assistants = await api.listAssistants({
            graph_id: args.graph_id,
            limit: args.limit ? Number(args.limit) : 10,
          });
          return {
            success: true,
            data: {
              count: assistants.length,
              assistants: assistants.map(a => ({
                assistant_id: a.assistant_id,
                graph_id: a.graph_id,
                name: a.name,
                metadata: a.metadata,
                updated_at: a.updated_at,
              })),
            },
          };
        } catch (error: any) {
          return { success: false, data: null, error: `Error listando asistentes: ${error.message}` };
        }
      },
      undoable: false,
    },

    // === langgraph:describe - Get assistant details ===
    {
      namespace: 'langgraph',
      name: 'describe',
      version: '1.0.0',
      description: 'Muestra los detalles completos de un asistente: graph_id, config y metadata',
      params: [
        { name: 'assistant_id', type: 'string', required: true, description: 'ID del asistente a inspeccionar' },
      ],
      tags: ['langgraph', 'assistant', 'detail', 'inspect', 'config', 'graph'],
      example: 'langgraph:describe --assistant_id "asst-abc123"',
      handler: async (args: any) => {
        try {
          const assistant = await api.getAssistant(args.assistant_id);
          return {
            success: true,
            data: {
              assistant_id: assistant.assistant_id,
              graph_id: assistant.graph_id,
              name: assistant.name,
              config: assistant.config,
              metadata: assistant.metadata,
              created_at: assistant.created_at,
              updated_at: assistant.updated_at,
            },
          };
        } catch (error: any) {
          return { success: false, data: null, error: `Error obteniendo asistente: ${error.message}` };
        }
      },
      undoable: false,
    },

    // === langgraph:threads - Create a new conversation thread ===
    {
      namespace: 'langgraph',
      name: 'threads',
      version: '1.0.0',
      description: 'Crea un nuevo thread de conversacion para ejecutar grafos con estado persistente',
      params: [
        { name: 'metadata', type: 'json', required: false, description: 'Metadata JSON para el thread (ej: {"user": "agent-1"})' },
      ],
      tags: ['langgraph', 'thread', 'create', 'conversation', 'session', 'state'],
      example: 'langgraph:threads --metadata \'{"user": "agent-1", "purpose": "support"}\'',
      handler: async (args: any) => {
        try {
          let metadata: Record<string, any> | undefined;
          if (args.metadata) {
            metadata = typeof args.metadata === 'string' ? JSON.parse(args.metadata) : args.metadata;
          }
          const thread = await api.createThread(metadata);
          return {
            success: true,
            data: {
              thread_id: thread.thread_id,
              status: thread.status,
              metadata: thread.metadata,
              created_at: thread.created_at,
            },
          };
        } catch (error: any) {
          return { success: false, data: null, error: `Error creando thread: ${error.message}` };
        }
      },
      undoable: false,
    },

    // === langgraph:state - Get thread state ===
    {
      namespace: 'langgraph',
      name: 'state',
      version: '1.0.0',
      description: 'Obtiene el estado actual de un thread incluyendo valores, proximos nodos y checkpoint',
      params: [
        { name: 'thread_id', type: 'string', required: true, description: 'ID del thread a inspeccionar' },
      ],
      tags: ['langgraph', 'state', 'thread', 'inspect', 'values', 'checkpoint'],
      example: 'langgraph:state --thread_id "thread-abc123"',
      handler: async (args: any) => {
        try {
          const state = await api.getThreadState(args.thread_id);
          return {
            success: true,
            data: {
              values: state.values,
              next: state.next,
              checkpoint: state.checkpoint,
              metadata: state.metadata,
            },
          };
        } catch (error: any) {
          return { success: false, data: null, error: `Error obteniendo estado: ${error.message}` };
        }
      },
      undoable: false,
    },

    // === langgraph:run - Execute a graph (wait for result) ===
    {
      namespace: 'langgraph',
      name: 'run',
      version: '1.0.0',
      description: 'Ejecuta un grafo en un thread, enviando input y esperando el resultado completo',
      params: [
        { name: 'thread_id', type: 'string', required: true, description: 'ID del thread donde ejecutar' },
        { name: 'assistant_id', type: 'string', required: true, description: 'ID del asistente/grafo a ejecutar' },
        { name: 'input', type: 'json', required: true, description: 'Input JSON para el grafo (ej: {"messages": [{"role":"user","content":"hello"}]})' },
        { name: 'config', type: 'json', required: false, description: 'Configuracion opcional del run (recursion_limit, tags, etc)' },
      ],
      tags: ['langgraph', 'run', 'execute', 'graph', 'agent', 'invoke', 'workflow'],
      example: 'langgraph:run --thread_id "t-123" --assistant_id "a-456" --input \'{"messages": [{"role": "user", "content": "hello"}]}\'',
      handler: async (args: any) => {
        try {
          const input = typeof args.input === 'string' ? JSON.parse(args.input) : args.input;
          const config = args.config ? (typeof args.config === 'string' ? JSON.parse(args.config) : args.config) : undefined;

          const result = await api.createRun(args.thread_id, {
            input,
            config,
            metadata: { assistant_id: args.assistant_id },
          });

          return {
            success: true,
            data: {
              assistant_id: args.assistant_id,
              thread_id: args.thread_id,
              result,
            },
          };
        } catch (error: any) {
          return { success: false, data: null, error: `Error ejecutando grafo: ${error.message}` };
        }
      },
      confirm: true,
      undoable: false,
    },

    // === langgraph:stream - Execute with SSE streaming ===
    {
      namespace: 'langgraph',
      name: 'stream',
      version: '1.0.0',
      description: 'Ejecuta un grafo con streaming SSE, retornando eventos incrementales del procesamiento',
      params: [
        { name: 'thread_id', type: 'string', required: true, description: 'ID del thread donde ejecutar' },
        { name: 'assistant_id', type: 'string', required: true, description: 'ID del asistente/grafo a ejecutar' },
        { name: 'input', type: 'json', required: true, description: 'Input JSON para el grafo' },
        { name: 'stream_mode', type: 'enum', enumValues: ['values', 'updates', 'events'], required: false, description: 'Modo de streaming: values (estado completo), updates (deltas), events (todos los eventos)' },
      ],
      tags: ['langgraph', 'stream', 'sse', 'realtime', 'execute', 'graph', 'incremental'],
      example: 'langgraph:stream --thread_id "t-123" --assistant_id "a-456" --input \'{"messages": [...]}\'  --stream_mode updates',
      handler: async (args: any) => {
        try {
          const input = typeof args.input === 'string' ? JSON.parse(args.input) : args.input;
          const events: Array<{ event: string; data: any }> = [];

          const result = await api.streamRun(
            args.thread_id,
            {
              input,
              stream_mode: args.stream_mode || 'values',
              metadata: { assistant_id: args.assistant_id },
            },
            (event) => {
              events.push(event);
            }
          );

          return {
            success: true,
            data: {
              assistant_id: args.assistant_id,
              thread_id: args.thread_id,
              events_count: result.events_count,
              events,
              final_state: result.final_event,
            },
          };
        } catch (error: any) {
          return { success: false, data: null, error: `Error en streaming: ${error.message}` };
        }
      },
      confirm: true,
      undoable: false,
    },

    // === langgraph:runs - List run history ===
    {
      namespace: 'langgraph',
      name: 'runs',
      version: '1.0.0',
      description: 'Lista las ejecuciones (runs) de un thread con su estado y resultado',
      params: [
        { name: 'thread_id', type: 'string', required: true, description: 'ID del thread' },
        { name: 'status', type: 'enum', enumValues: ['pending', 'running', 'success', 'error', 'timeout', 'interrupted'], required: false, description: 'Filtrar por estado de ejecucion' },
        { name: 'limit', type: 'int', required: false, description: 'Cantidad maxima de resultados (default: 10)' },
      ],
      tags: ['langgraph', 'runs', 'history', 'executions', 'monitoring', 'status'],
      example: 'langgraph:runs --thread_id "t-123" --status error --limit 5',
      handler: async (args: any) => {
        try {
          const runs = await api.listRuns(args.thread_id, {
            limit: args.limit ? Number(args.limit) : 10,
            status: args.status,
          });
          return {
            success: true,
            data: {
              count: runs.length,
              runs: runs.map(r => ({
                run_id: r.run_id,
                assistant_id: r.assistant_id,
                status: r.status,
                created_at: r.created_at,
                updated_at: r.updated_at,
              })),
            },
          };
        } catch (error: any) {
          return { success: false, data: null, error: `Error listando ejecuciones: ${error.message}` };
        }
      },
      undoable: false,
    },
  ];
}
