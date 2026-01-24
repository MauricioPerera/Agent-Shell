/**
 * VoltAgent Integration Commands for Agent Shell.
 *
 * Exposes VoltAgent server operations as Agent Shell commands, allowing
 * AI agents to discover and orchestrate multi-agent workflows, conversations,
 * and structured outputs via semantic search.
 *
 * Strategy: VoltAgent agents, workflows, and conversations become first-class
 * commands in Agent Shell's namespace system. An AI agent can say
 * "send a message to the support agent" and Agent Shell's vector index
 * will find the matching VoltAgent operation.
 *
 * Requirements:
 *   - VoltAgent server running (default: http://localhost:3141)
 *   - Environment variables: VOLTAGENT_BASE_URL, VOLTAGENT_API_KEY (optional)
 *
 * Usage: bun demo/voltagent-integration.ts
 */

import { VoltAgentApiAdapter } from './adapters/voltagent-api.js';

/**
 * Creates VoltAgent command definitions for Agent Shell.
 * Each command wraps a VoltAgent API operation.
 */
export function createVoltAgentCommands(api: VoltAgentApiAdapter) {
  return [
    // === voltagent:health - Check server connectivity ===
    {
      namespace: 'voltagent',
      name: 'health',
      version: '1.0.0',
      description: 'Verifica el estado de conexion con el servidor VoltAgent',
      params: [],
      tags: ['voltagent', 'health', 'status', 'monitoring', 'connectivity'],
      example: 'voltagent:health',
      handler: async () => {
        try {
          const health = await api.healthCheck();
          return { success: true, data: health };
        } catch (error: any) {
          return { success: false, data: null, error: `VoltAgent no disponible: ${error.message}` };
        }
      },
      undoable: false,
    },

    // === voltagent:agents - List available agents ===
    {
      namespace: 'voltagent',
      name: 'agents',
      version: '1.0.0',
      description: 'Lista los agentes IA disponibles en VoltAgent con sus herramientas y configuracion',
      params: [],
      tags: ['voltagent', 'agents', 'list', 'available', 'ai', 'assistants'],
      example: 'voltagent:agents',
      handler: async () => {
        try {
          const agents = await api.listAgents();
          return {
            success: true,
            data: {
              count: agents.length,
              agents: agents.map(a => ({
                id: a.id,
                name: a.name,
                description: a.description,
                model: a.model,
                tools: a.tools?.map(t => t.name) || [],
                subAgents: a.subAgents || [],
              })),
            },
          };
        } catch (error: any) {
          return { success: false, data: null, error: `Error listando agentes: ${error.message}` };
        }
      },
      undoable: false,
    },

    // === voltagent:send - Send message to an agent ===
    {
      namespace: 'voltagent',
      name: 'send',
      version: '1.0.0',
      description: 'Envia un mensaje a un agente IA y recibe la respuesta completa de texto',
      params: [
        { name: 'agent_id', type: 'string', required: true, description: 'ID del agente al que enviar el mensaje' },
        { name: 'input', type: 'string', required: true, description: 'Mensaje o prompt a enviar al agente' },
        { name: 'conversation_id', type: 'string', required: false, description: 'ID de conversacion existente para continuar contexto' },
        { name: 'user_id', type: 'string', required: false, description: 'ID del usuario que envia el mensaje' },
      ],
      tags: ['voltagent', 'send', 'message', 'agent', 'generate', 'text', 'invoke', 'ask'],
      example: 'voltagent:send --agent_id "support-agent" --input "Help me with billing"',
      handler: async (args: any) => {
        try {
          const result = await api.generateText(args.agent_id, {
            input: args.input,
            conversationId: args.conversation_id,
            userId: args.user_id,
          });
          return {
            success: true,
            data: {
              agent_id: args.agent_id,
              response: result.text,
              conversationId: result.conversationId,
            },
          };
        } catch (error: any) {
          return { success: false, data: null, error: `Error enviando mensaje: ${error.message}` };
        }
      },
      confirm: true,
      undoable: false,
    },

    // === voltagent:chat - Chat with streaming ===
    {
      namespace: 'voltagent',
      name: 'chat',
      version: '1.0.0',
      description: 'Inicia o continua una conversacion con un agente usando streaming SSE para respuestas incrementales',
      params: [
        { name: 'agent_id', type: 'string', required: true, description: 'ID del agente con el que conversar' },
        { name: 'input', type: 'string', required: true, description: 'Mensaje a enviar en la conversacion' },
        { name: 'conversation_id', type: 'string', required: false, description: 'ID de conversacion para continuarla' },
        { name: 'user_id', type: 'string', required: false, description: 'ID del usuario' },
      ],
      tags: ['voltagent', 'chat', 'conversation', 'stream', 'sse', 'realtime', 'interactive'],
      example: 'voltagent:chat --agent_id "my-agent" --input "What can you help me with?"',
      handler: async (args: any) => {
        try {
          const events: Array<{ event: string; data: any }> = [];
          const result = await api.chat(
            args.agent_id,
            {
              input: args.input,
              conversationId: args.conversation_id,
              userId: args.user_id,
            },
            (event) => { events.push(event); }
          );
          return {
            success: true,
            data: {
              agent_id: args.agent_id,
              response: result.final_text,
              conversationId: result.conversationId,
              events_count: result.events_count,
            },
          };
        } catch (error: any) {
          return { success: false, data: null, error: `Error en chat: ${error.message}` };
        }
      },
      confirm: true,
      undoable: false,
    },

    // === voltagent:object - Generate structured object ===
    {
      namespace: 'voltagent',
      name: 'object',
      version: '1.0.0',
      description: 'Genera un objeto JSON estructurado usando un agente, util para extraccion de datos o respuestas tipadas',
      params: [
        { name: 'agent_id', type: 'string', required: true, description: 'ID del agente generador' },
        { name: 'input', type: 'string', required: true, description: 'Prompt o instruccion para generar el objeto' },
        { name: 'schema', type: 'json', required: false, description: 'Schema JSON del objeto esperado (Zod-compatible)' },
      ],
      tags: ['voltagent', 'object', 'structured', 'json', 'generate', 'extract', 'typed'],
      example: 'voltagent:object --agent_id "extractor" --input "Extract name and email from: John at john@example.com"',
      handler: async (args: any) => {
        try {
          const schema = args.schema ? (typeof args.schema === 'string' ? JSON.parse(args.schema) : args.schema) : undefined;
          const result = await api.generateObject(args.agent_id, {
            input: args.input,
            schema,
          });
          return {
            success: true,
            data: {
              agent_id: args.agent_id,
              object: result,
            },
          };
        } catch (error: any) {
          return { success: false, data: null, error: `Error generando objeto: ${error.message}` };
        }
      },
      confirm: true,
      undoable: false,
    },

    // === voltagent:workflows - List available workflows ===
    {
      namespace: 'voltagent',
      name: 'workflows',
      version: '1.0.0',
      description: 'Lista los workflows disponibles en VoltAgent con sus pasos y configuracion',
      params: [],
      tags: ['voltagent', 'workflows', 'list', 'automation', 'pipeline', 'chain'],
      example: 'voltagent:workflows',
      handler: async () => {
        try {
          const workflows = await api.listWorkflows();
          return {
            success: true,
            data: {
              count: workflows.length,
              workflows: workflows.map(w => ({
                id: w.id,
                name: w.name,
                description: w.description,
                steps: w.steps,
              })),
            },
          };
        } catch (error: any) {
          return { success: false, data: null, error: `Error listando workflows: ${error.message}` };
        }
      },
      undoable: false,
    },

    // === voltagent:run-workflow - Execute a workflow ===
    {
      namespace: 'voltagent',
      name: 'run-workflow',
      version: '1.0.0',
      description: 'Ejecuta un workflow multi-paso y espera el resultado completo de la ejecucion',
      params: [
        { name: 'workflow_id', type: 'string', required: true, description: 'ID del workflow a ejecutar' },
        { name: 'input', type: 'json', required: true, description: 'Input JSON para el workflow (ej: {"amount": 5000, "department": "engineering"})' },
      ],
      tags: ['voltagent', 'workflow', 'execute', 'run', 'automation', 'pipeline', 'chain', 'multi-step'],
      example: 'voltagent:run-workflow --workflow_id "expense-approval" --input \'{"amount": 5000}\'',
      handler: async (args: any) => {
        try {
          const input = typeof args.input === 'string' ? JSON.parse(args.input) : args.input;
          const result = await api.executeWorkflow(args.workflow_id, input);
          return {
            success: true,
            data: {
              workflow_id: args.workflow_id,
              execution_id: result.executionId,
              status: result.status,
              result: result.result,
            },
          };
        } catch (error: any) {
          return { success: false, data: null, error: `Error ejecutando workflow: ${error.message}` };
        }
      },
      confirm: true,
      undoable: false,
    },

    // === voltagent:stream-workflow - Execute workflow with streaming ===
    {
      namespace: 'voltagent',
      name: 'stream-workflow',
      version: '1.0.0',
      description: 'Ejecuta un workflow con streaming SSE para monitorear el progreso paso a paso en tiempo real',
      params: [
        { name: 'workflow_id', type: 'string', required: true, description: 'ID del workflow a ejecutar' },
        { name: 'input', type: 'json', required: true, description: 'Input JSON para el workflow' },
      ],
      tags: ['voltagent', 'workflow', 'stream', 'sse', 'realtime', 'progress', 'monitor'],
      example: 'voltagent:stream-workflow --workflow_id "data-pipeline" --input \'{"source": "db"}\'',
      handler: async (args: any) => {
        try {
          const input = typeof args.input === 'string' ? JSON.parse(args.input) : args.input;
          const events: Array<{ event: string; data: any }> = [];
          const result = await api.streamWorkflow(args.workflow_id, input, (event) => {
            events.push(event);
          });
          return {
            success: true,
            data: {
              workflow_id: args.workflow_id,
              events_count: result.events_count,
              events,
              final_result: result.final_result,
            },
          };
        } catch (error: any) {
          return { success: false, data: null, error: `Error en streaming de workflow: ${error.message}` };
        }
      },
      confirm: true,
      undoable: false,
    },

    // === voltagent:resume-workflow - Resume suspended workflow ===
    {
      namespace: 'voltagent',
      name: 'resume-workflow',
      version: '1.0.0',
      description: 'Reanuda un workflow suspendido (human-in-the-loop) con input de aprobacion o datos adicionales',
      params: [
        { name: 'workflow_id', type: 'string', required: true, description: 'ID del workflow' },
        { name: 'execution_id', type: 'string', required: true, description: 'ID de la ejecucion suspendida' },
        { name: 'input', type: 'json', required: false, description: 'Input adicional para la reanudacion (ej: {"approved": true})' },
      ],
      tags: ['voltagent', 'workflow', 'resume', 'continue', 'approval', 'human-in-the-loop'],
      example: 'voltagent:resume-workflow --workflow_id "approval-flow" --execution_id "exec-123" --input \'{"approved": true}\'',
      handler: async (args: any) => {
        try {
          const input = args.input ? (typeof args.input === 'string' ? JSON.parse(args.input) : args.input) : undefined;
          const result = await api.resumeWorkflow(args.workflow_id, args.execution_id, input);
          return {
            success: true,
            data: {
              workflow_id: args.workflow_id,
              execution_id: result.executionId,
              status: result.status,
              result: result.result,
            },
          };
        } catch (error: any) {
          return { success: false, data: null, error: `Error reanudando workflow: ${error.message}` };
        }
      },
      confirm: true,
      undoable: false,
    },

    // === voltagent:cancel-workflow - Cancel a running workflow ===
    {
      namespace: 'voltagent',
      name: 'cancel-workflow',
      version: '1.0.0',
      description: 'Cancela un workflow en ejecucion o suspendido, deteniendo todos los pasos pendientes',
      params: [
        { name: 'workflow_id', type: 'string', required: true, description: 'ID del workflow' },
        { name: 'execution_id', type: 'string', required: true, description: 'ID de la ejecucion a cancelar' },
        { name: 'reason', type: 'string', required: false, description: 'Razon de la cancelacion' },
      ],
      tags: ['voltagent', 'workflow', 'cancel', 'stop', 'abort', 'terminate'],
      example: 'voltagent:cancel-workflow --workflow_id "pipeline" --execution_id "exec-456" --reason "timeout"',
      handler: async (args: any) => {
        try {
          const result = await api.cancelWorkflow(args.workflow_id, args.execution_id, args.reason);
          return {
            success: true,
            data: {
              workflow_id: args.workflow_id,
              execution_id: result.executionId,
              status: result.status,
            },
          };
        } catch (error: any) {
          return { success: false, data: null, error: `Error cancelando workflow: ${error.message}` };
        }
      },
      confirm: true,
      undoable: false,
    },

    // === voltagent:conversations - List agent conversations ===
    {
      namespace: 'voltagent',
      name: 'conversations',
      version: '1.0.0',
      description: 'Lista las conversaciones de un agente con su historial y metadata',
      params: [
        { name: 'agent_id', type: 'string', required: true, description: 'ID del agente' },
        { name: 'limit', type: 'int', required: false, description: 'Cantidad maxima de resultados (default: 10)' },
      ],
      tags: ['voltagent', 'conversations', 'history', 'memory', 'sessions', 'chat'],
      example: 'voltagent:conversations --agent_id "support-agent" --limit 5',
      handler: async (args: any) => {
        try {
          const conversations = await api.listConversations(args.agent_id, {
            limit: args.limit ? Number(args.limit) : 10,
          });
          return {
            success: true,
            data: {
              agent_id: args.agent_id,
              count: conversations.length,
              conversations: conversations.map(c => ({
                id: c.id,
                title: c.title,
                metadata: c.metadata,
                createdAt: c.createdAt,
                updatedAt: c.updatedAt,
              })),
            },
          };
        } catch (error: any) {
          return { success: false, data: null, error: `Error listando conversaciones: ${error.message}` };
        }
      },
      undoable: false,
    },

    // === voltagent:messages - Get conversation messages ===
    {
      namespace: 'voltagent',
      name: 'messages',
      version: '1.0.0',
      description: 'Obtiene los mensajes de una conversacion especifica para ver el historial de interacciones',
      params: [
        { name: 'conversation_id', type: 'string', required: true, description: 'ID de la conversacion' },
        { name: 'agent_id', type: 'string', required: true, description: 'ID del agente' },
        { name: 'limit', type: 'int', required: false, description: 'Cantidad maxima de mensajes (default: 20)' },
      ],
      tags: ['voltagent', 'messages', 'history', 'conversation', 'transcript', 'log'],
      example: 'voltagent:messages --conversation_id "conv-123" --agent_id "my-agent" --limit 10',
      handler: async (args: any) => {
        try {
          const messages = await api.listMessages(args.conversation_id, args.agent_id, {
            limit: args.limit ? Number(args.limit) : 20,
          });
          return {
            success: true,
            data: {
              conversation_id: args.conversation_id,
              count: messages.length,
              messages: messages.map(m => ({
                id: m.id,
                role: m.role,
                content: m.content,
                createdAt: m.createdAt,
              })),
            },
          };
        } catch (error: any) {
          return { success: false, data: null, error: `Error obteniendo mensajes: ${error.message}` };
        }
      },
      undoable: false,
    },
  ];
}
