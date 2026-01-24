/**
 * @module mcp
 * @description Modulo MCP de Agent Shell.
 *
 * Expone el servidor MCP que implementa el protocolo
 * JSON-RPC 2.0 sobre stdio con exactamente 2 tools:
 * cli_help y cli_exec.
 */

export { McpServer } from './server.js';
export { StdioTransport } from './transport.js';
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
} from './types.js';
