/**
 * @module mcp/server
 * @description Servidor MCP de Agent Shell.
 *
 * Expone exactamente 2 tools al agente LLM:
 *   - cli_help: Retorna el protocolo de interaccion
 *   - cli_exec: Ejecuta un comando y retorna respuesta estructurada
 *
 * Protocolo: JSON-RPC 2.0 sobre stdio (compatible con MCP spec).
 * Dependencias externas: Ninguna.
 */

import { StdioTransport } from './transport.js';
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  McpServerConfig,
  McpCore,
  McpToolDefinition,
  McpToolCallParams,
  McpToolResult,
  McpInitializeResult,
} from './types.js';
import {
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  INVALID_REQUEST,
  INTERNAL_ERROR,
} from './types.js';

/**
 * Definiciones de las 2 tools expuestas por Agent Shell.
 *
 * No describe comandos individuales del registry (esos se descubren en
 * runtime via `cli_exec("search ...")`/`describe ...`) — son texto libre a
 * mano sobre la gramatica FIJA que Core.exec() acepta. Si cambia esa
 * gramatica (flags globales en src/parser/types.ts's GlobalFlags, o la
 * sintaxis de comandos que search/describe ilustran en su descripcion),
 * actualizar el texto de estas 2 descripciones tambien — no hay ninguna
 * fuente unica de la que esto se auto-genere.
 */
const TOOLS: McpToolDefinition[] = [
  {
    name: 'cli_help',
    description: 'Returns the Agent Shell interaction protocol. Call this first to learn how to discover and execute commands.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'cli_exec',
    description: 'Execute a command in Agent Shell. Use "search <query>" to discover commands, then execute them with optional flags like --dry-run, --validate, or --confirm.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The command to execute (e.g., "search create user", "users:create --name John", "describe users:create")',
        },
      },
      required: ['command'],
    },
  },
];

/**
 * Servidor MCP para Agent Shell.
 *
 * Implementa el protocolo MCP sobre stdio, exponiendo cli_help y cli_exec
 * como las unicas 2 tools disponibles para el agente.
 */
// Regresion (ronda 75 del audit, MEDIUM): mismo cap FIFO que
// WorkspaceSessionStore (skills/workspace.ts) — sin tope, un caller HTTP que
// no manda X-Session-Id agrega una entrada nueva a initializedSessions en
// CADA `initialize` (cada request sin ese header recibe un sessionId
// aleatorio nuevo, ver http-transport.ts), creciendo sin limite.
const MAX_INITIALIZED_SESSIONS = 200;

export class McpServer {
  private readonly transport: StdioTransport;
  private readonly core: McpCore;
  private readonly name: string;
  private readonly version: string;
  // Regresion (ronda 75 del audit, MEDIUM): era un solo boolean compartido
  // por TODAS las sesiones — en modo HTTP, apenas UNA sesion llamaba
  // `initialize`, el gate "rechazar antes de initialize" quedaba
  // permanentemente satisfecho para cualquier otra sesion concurrente o
  // futura que comparta el bearer token del deployment, sin importar si esa
  // sesion en particular hizo el handshake.
  //
  // Fix: el gate se trackea por sessionId SOLO cuando el caller mando un
  // X-Session-Id explicito (hasExplicitSessionId) — ese es el unico caso
  // donde una sesion real y reusable existe, y donde el bleed original era
  // posible. Un caller stdio (sessionId siempre undefined, una sola
  // conexion) o HTTP sin X-Session-Id (HttpSseTransport le asigna un id
  // ALEATORIO nuevo en CADA request — ver http-transport.ts — asi que jamas
  // podria reusar el mismo id entre `initialize` y una llamada posterior)
  // cae al flag global, igual que el comportamiento original: no hay
  // continuidad de sesion real que proteger ahi, y exigir el handshake por
  // request rompería a cualquier cliente HTTP simple que no adopto el
  // header.
  private globalInitialized = false;
  private readonly initializedSessions = new Set<string>();

  constructor(config: McpServerConfig) {
    this.core = config.core;
    this.name = config.name || 'agent-shell';
    this.version = config.version || '0.1.0';
    this.transport = new StdioTransport();
    this.transport.onMessage((msg) => this.handleMessage(msg));
  }

  /** Inicia el servidor MCP (escucha en stdio). */
  start(): void {
    this.transport.start();
  }

  /** Detiene el servidor. */
  stop(): void {
    this.transport.stop();
  }

  /** Procesa un mensaje JSON-RPC. Util para custom transports y testing. */
  async handleMessage(request: JsonRpcRequest, sessionId?: string, hasExplicitSessionId?: boolean): Promise<JsonRpcResponse | null> {
    // Notifications (no id) don't get responses
    if (request.id === undefined) {
      return null;
    }

    switch (request.method) {
      case 'initialize':
        return this.handleInitialize(request, sessionId, hasExplicitSessionId);
      case 'notifications/initialized':
        // Client acknowledgement after initialize - no response needed for notifications
        return null;
      case 'ping':
        return this.handlePing(request);
      case 'tools/list':
      case 'tools/call': {
        // Reject requests before initialization per MCP spec
        const isInitialized = hasExplicitSessionId && sessionId !== undefined
          ? this.initializedSessions.has(sessionId)
          : this.globalInitialized;
        if (!isInitialized) {
          return {
            jsonrpc: '2.0',
            id: request.id!,
            error: { code: INVALID_REQUEST, message: 'Server not initialized. Send "initialize" first.' },
          };
        }
        return request.method === 'tools/list'
          ? this.handleToolsList(request)
          : this.handleToolsCall(request, sessionId);
      }
      default:
        return {
          jsonrpc: '2.0',
          id: request.id,
          error: { code: METHOD_NOT_FOUND, message: `Method not found: ${request.method}` },
        };
    }
  }

  private handleInitialize(request: JsonRpcRequest, sessionId?: string, hasExplicitSessionId?: boolean): JsonRpcResponse {
    if (hasExplicitSessionId && sessionId !== undefined) {
      if (!this.initializedSessions.has(sessionId) && this.initializedSessions.size >= MAX_INITIALIZED_SESSIONS) {
        const oldest = this.initializedSessions.values().next().value;
        if (oldest !== undefined) this.initializedSessions.delete(oldest);
      }
      this.initializedSessions.add(sessionId);
    } else {
      this.globalInitialized = true;
    }
    const result: McpInitializeResult = {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: this.name, version: this.version },
    };
    return { jsonrpc: '2.0', id: request.id!, result };
  }

  private handlePing(request: JsonRpcRequest): JsonRpcResponse {
    return { jsonrpc: '2.0', id: request.id!, result: {} };
  }

  private handleToolsList(request: JsonRpcRequest): JsonRpcResponse {
    return { jsonrpc: '2.0', id: request.id!, result: { tools: TOOLS } };
  }

  private async handleToolsCall(request: JsonRpcRequest, sessionId?: string): Promise<JsonRpcResponse> {
    const params = request.params as McpToolCallParams | undefined;

    if (!params || !params.name) {
      return {
        jsonrpc: '2.0',
        id: request.id!,
        error: { code: INVALID_PARAMS, message: 'Missing tool name' },
      };
    }

    let toolResult: McpToolResult;

    try {
      switch (params.name) {
        case 'cli_help':
          toolResult = await this.execHelp();
          break;
        case 'cli_exec':
          toolResult = await this.execCommand(params.arguments, sessionId);
          break;
        default:
          return {
            jsonrpc: '2.0',
            id: request.id!,
            error: { code: INVALID_PARAMS, message: `Unknown tool: ${params.name}` },
          };
      }
    } catch (err: any) {
      // This is the catch-all for unexpected exceptions (bugs), not the
      // structured command-failure path Core.exec() already returns as
      // data — err.message here can be an arbitrary Node error (e.g. an fs
      // error naming an absolute path), so it's logged server-side instead
      // of echoed to the remote caller.
      console.error('[agent-shell] Internal error in cli_exec:', err);
      toolResult = {
        content: [{ type: 'text', text: 'Internal error' }],
        isError: true,
      };
    }

    return { jsonrpc: '2.0', id: request.id!, result: toolResult };
  }

  private async execHelp(): Promise<McpToolResult> {
    const helpText = this.core.help();
    return {
      content: [{ type: 'text', text: helpText }],
    };
  }

  private async execCommand(args?: Record<string, any>, sessionId?: string): Promise<McpToolResult> {
    if (!args || typeof args.command !== 'string') {
      return {
        content: [{ type: 'text', text: 'Error: "command" argument is required and must be a string' }],
        isError: true,
      };
    }

    const response = await this.core.exec(args.command, sessionId);
    const text = JSON.stringify(response, null, 2);

    return {
      content: [{ type: 'text', text }],
      isError: response.code !== 0,
    };
  }
}
