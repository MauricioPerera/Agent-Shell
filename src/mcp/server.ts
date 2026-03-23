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

/** Definiciones de las 2 tools expuestas por Agent Shell. */
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
export class McpServer {
  private readonly transport: StdioTransport;
  private readonly core: McpCore;
  private readonly name: string;
  private readonly version: string;
  private initialized = false;

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
  async handleMessage(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    // Notifications (no id) don't get responses
    if (request.id === undefined) {
      return null;
    }

    switch (request.method) {
      case 'initialize':
        return this.handleInitialize(request);
      case 'notifications/initialized':
        // Client acknowledgement after initialize - no response needed for notifications
        return null;
      case 'ping':
        return this.handlePing(request);
      case 'tools/list':
      case 'tools/call': {
        // Reject requests before initialization per MCP spec
        if (!this.initialized) {
          return {
            jsonrpc: '2.0',
            id: request.id!,
            error: { code: INVALID_REQUEST, message: 'Server not initialized. Send "initialize" first.' },
          };
        }
        return request.method === 'tools/list'
          ? this.handleToolsList(request)
          : this.handleToolsCall(request);
      }
      default:
        return {
          jsonrpc: '2.0',
          id: request.id,
          error: { code: METHOD_NOT_FOUND, message: `Method not found: ${request.method}` },
        };
    }
  }

  private handleInitialize(request: JsonRpcRequest): JsonRpcResponse {
    this.initialized = true;
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

  private async handleToolsCall(request: JsonRpcRequest): Promise<JsonRpcResponse> {
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
          toolResult = await this.execCommand(params.arguments);
          break;
        default:
          return {
            jsonrpc: '2.0',
            id: request.id!,
            error: { code: INVALID_PARAMS, message: `Unknown tool: ${params.name}` },
          };
      }
    } catch (err: any) {
      toolResult = {
        content: [{ type: 'text', text: `Internal error: ${err.message || 'unknown'}` }],
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

  private async execCommand(args?: Record<string, any>): Promise<McpToolResult> {
    if (!args || typeof args.command !== 'string') {
      return {
        content: [{ type: 'text', text: 'Error: "command" argument is required and must be a string' }],
        isError: true,
      };
    }

    const response = await this.core.exec(args.command);
    const text = JSON.stringify(response, null, 2);

    return {
      content: [{ type: 'text', text }],
      isError: response.code !== 0,
    };
  }
}
