/**
 * @module mcp
 * @description Modulo MCP de Agent Shell.
 *
 * Expone el servidor MCP que implementa el protocolo
 * JSON-RPC 2.0 con transportes pluggables:
 *   - StdioTransport: stdin/stdout (local, MCP clients)
 *   - HttpSseTransport: HTTP POST + SSE (remoto, web, multi-agente)
 */

export { McpServer } from './server.js';
export { StdioTransport } from './transport.js';
export { HttpSseTransport } from './http-transport.js';
export type {
  McpServerConfig,
  McpToolDefinition,
  McpToolResult,
  McpContent,
  McpServerInfo,
  McpCapabilities,
  McpInitializeResult,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,
  HttpTransportConfig,
  SseClient,
  HealthResponse,
} from './types.js';
