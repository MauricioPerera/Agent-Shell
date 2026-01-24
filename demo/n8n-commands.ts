/**
 * n8n Integration Commands for Agent Shell.
 *
 * Exposes n8n workflows as Agent Shell commands, allowing AI agents
 * to discover and trigger n8n automations via semantic search.
 *
 * Strategy: n8n workflows become first-class commands in Agent Shell's
 * namespace system. An AI agent can say "send an email notification"
 * and Agent Shell's vector index will find the matching n8n workflow.
 *
 * Requirements:
 *   - n8n instance running with API enabled
 *   - Environment variables: N8N_BASE_URL, N8N_API_KEY
 *
 * Usage: bun demo/n8n-integration.ts
 */

import { N8nApiAdapter } from './adapters/n8n-api.js';

/**
 * Creates n8n command definitions for Agent Shell.
 * Each command wraps an n8n API operation.
 */
export function createN8nCommands(api: N8nApiAdapter) {
  return [
    // === n8n:workflows - List available workflows ===
    {
      namespace: 'n8n',
      name: 'workflows',
      version: '1.0.0',
      description: 'Lista todos los workflows disponibles en n8n con su estado de activacion',
      params: [
        { name: 'active', type: 'bool', required: false, description: 'Filtrar solo workflows activos o inactivos' },
        { name: 'tags', type: 'string', required: false, description: 'Filtrar por tag (nombre del tag)' },
      ],
      tags: ['n8n', 'workflows', 'automation', 'listing'],
      example: 'n8n:workflows --active true',
      handler: async (args: any) => {
        try {
          const workflows = await api.listWorkflows({
            active: args.active !== undefined ? args.active === 'true' || args.active === true : undefined,
            tags: args.tags,
          });
          return {
            success: true,
            data: {
              count: workflows.length,
              workflows: workflows.map(w => ({
                id: w.id,
                name: w.name,
                active: w.active,
                tags: w.tags?.map(t => t.name) || [],
                updatedAt: w.updatedAt,
              })),
            },
          };
        } catch (error: any) {
          return { success: false, data: null, error: `Error listando workflows: ${error.message}` };
        }
      },
      undoable: false,
    },

    // === n8n:describe - Get workflow details ===
    {
      namespace: 'n8n',
      name: 'describe',
      version: '1.0.0',
      description: 'Muestra los detalles completos de un workflow: nodos, conexiones y configuracion',
      params: [
        { name: 'id', type: 'string', required: true, description: 'ID del workflow en n8n' },
      ],
      tags: ['n8n', 'workflow', 'detail', 'inspect'],
      example: 'n8n:describe --id "1234"',
      handler: async (args: any) => {
        try {
          const workflow = await api.getWorkflow(args.id);
          return {
            success: true,
            data: {
              id: workflow.id,
              name: workflow.name,
              active: workflow.active,
              nodes: workflow.nodes.map(n => ({ type: n.type, name: n.name })),
              connections: Object.keys(workflow.connections),
              tags: workflow.tags?.map(t => t.name) || [],
              createdAt: workflow.createdAt,
              updatedAt: workflow.updatedAt,
            },
          };
        } catch (error: any) {
          return { success: false, data: null, error: `Error obteniendo workflow: ${error.message}` };
        }
      },
      undoable: false,
    },

    // === n8n:trigger - Execute a workflow ===
    {
      namespace: 'n8n',
      name: 'trigger',
      version: '1.0.0',
      description: 'Ejecuta un workflow de n8n por su ID, opcionalmente pasando datos de entrada como payload JSON',
      params: [
        { name: 'id', type: 'string', required: true, description: 'ID del workflow a ejecutar' },
        { name: 'payload', type: 'json', required: false, description: 'Datos JSON a enviar al workflow como input' },
      ],
      tags: ['n8n', 'workflow', 'execute', 'trigger', 'automation', 'run'],
      example: 'n8n:trigger --id "1234" --payload \'{"email": "user@test.com", "subject": "Hola"}\'',
      handler: async (args: any) => {
        try {
          let payload: Record<string, any> | undefined;
          if (args.payload) {
            payload = typeof args.payload === 'string' ? JSON.parse(args.payload) : args.payload;
          }
          const execution = await api.executeWorkflow(args.id, payload);
          return {
            success: true,
            data: {
              executionId: execution.id,
              status: execution.status,
              workflowId: execution.workflowId,
              startedAt: execution.startedAt,
              finished: execution.finished,
              result: execution.data || null,
            },
          };
        } catch (error: any) {
          return { success: false, data: null, error: `Error ejecutando workflow: ${error.message}` };
        }
      },
      confirm: true,
      undoable: false,
    },

    // === n8n:activate - Activate a workflow ===
    {
      namespace: 'n8n',
      name: 'activate',
      version: '1.0.0',
      description: 'Activa un workflow para que responda a sus triggers automaticamente',
      params: [
        { name: 'id', type: 'string', required: true, description: 'ID del workflow a activar' },
      ],
      tags: ['n8n', 'workflow', 'activate', 'enable', 'trigger'],
      example: 'n8n:activate --id "1234"',
      handler: async (args: any) => {
        try {
          const workflow = await api.activateWorkflow(args.id);
          return {
            success: true,
            data: { id: workflow.id, name: workflow.name, active: workflow.active },
          };
        } catch (error: any) {
          return { success: false, data: null, error: `Error activando workflow: ${error.message}` };
        }
      },
      undoable: true,
    },

    // === n8n:deactivate - Deactivate a workflow ===
    {
      namespace: 'n8n',
      name: 'deactivate',
      version: '1.0.0',
      description: 'Desactiva un workflow para detener sus triggers automaticos',
      params: [
        { name: 'id', type: 'string', required: true, description: 'ID del workflow a desactivar' },
      ],
      tags: ['n8n', 'workflow', 'deactivate', 'disable', 'stop'],
      example: 'n8n:deactivate --id "1234"',
      handler: async (args: any) => {
        try {
          const workflow = await api.deactivateWorkflow(args.id);
          return {
            success: true,
            data: { id: workflow.id, name: workflow.name, active: workflow.active },
          };
        } catch (error: any) {
          return { success: false, data: null, error: `Error desactivando workflow: ${error.message}` };
        }
      },
      undoable: true,
    },

    // === n8n:executions - List recent executions ===
    {
      namespace: 'n8n',
      name: 'executions',
      version: '1.0.0',
      description: 'Lista las ejecuciones recientes de workflows con su estado y resultado',
      params: [
        { name: 'workflow_id', type: 'string', required: false, description: 'Filtrar ejecuciones de un workflow especifico' },
        { name: 'status', type: 'enum', enumValues: ['success', 'error', 'waiting'], required: false, description: 'Filtrar por estado de ejecucion' },
        { name: 'limit', type: 'int', required: false, description: 'Cantidad maxima de resultados (default: 10)' },
      ],
      tags: ['n8n', 'executions', 'history', 'monitoring', 'logs'],
      example: 'n8n:executions --workflow_id "1234" --status error --limit 5',
      handler: async (args: any) => {
        try {
          const executions = await api.getExecutions(args.workflow_id, {
            limit: args.limit ? Number(args.limit) : 10,
            status: args.status,
          });
          return {
            success: true,
            data: {
              count: executions.length,
              executions: executions.map(e => ({
                id: e.id,
                workflowId: e.workflowId,
                status: e.status,
                mode: e.mode,
                startedAt: e.startedAt,
                stoppedAt: e.stoppedAt,
                finished: e.finished,
              })),
            },
          };
        } catch (error: any) {
          return { success: false, data: null, error: `Error listando ejecuciones: ${error.message}` };
        }
      },
      undoable: false,
    },

    // === n8n:health - Check n8n status ===
    {
      namespace: 'n8n',
      name: 'health',
      version: '1.0.0',
      description: 'Verifica el estado de conexion con la instancia de n8n',
      params: [],
      tags: ['n8n', 'health', 'status', 'monitoring', 'connectivity'],
      example: 'n8n:health',
      handler: async () => {
        try {
          const health = await api.healthCheck();
          return { success: true, data: health };
        } catch (error: any) {
          return { success: false, data: null, error: `n8n no disponible: ${error.message}` };
        }
      },
      undoable: false,
    },
  ];
}
