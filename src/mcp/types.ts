/**
 * @module mcp/types
 * @description Tipos del protocolo MCP (Model Context Protocol).
 *
 * Implementacion minima de JSON-RPC 2.0 y tipos MCP necesarios
 * para exponer cli_help() y cli_exec() como tools.
 */

// --- JSON-RPC 2.0 ---

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, any>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: any;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: any;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, any>;
}

// --- MCP Protocol ---

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

export interface McpToolCallParams {
  name: string;
  arguments?: Record<string, any>;
}

export interface McpToolResult {
  content: McpContent[];
  isError?: boolean;
}

export interface McpContent {
  type: 'text';
  text: string;
}

export interface McpServerInfo {
  name: string;
  version: string;
}

export interface McpCapabilities {
  tools?: {};
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: McpCapabilities;
  serverInfo: McpServerInfo;
}

/** Configuracion del MCP Server de Agent Shell. */
export interface McpServerConfig {
  /** Nombre del servidor MCP. */
  name?: string;
  /** Version del servidor. */
  version?: string;
  /** Instancia de Core ya configurada. */
  core: any;
}

// --- JSON-RPC Error Codes ---

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
