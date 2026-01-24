/**
 * @module mcp/transport
 * @description Transporte stdio para el protocolo MCP.
 *
 * Lee mensajes JSON-RPC delimitados por newline desde stdin
 * y escribe respuestas a stdout.
 */

import type { JsonRpcRequest, JsonRpcResponse } from './types.js';

export type MessageHandler = (message: JsonRpcRequest) => Promise<JsonRpcResponse | null>;

/**
 * Transporte stdio para JSON-RPC 2.0.
 * Lee lineas de stdin, parsea como JSON-RPC, delega al handler,
 * y escribe respuestas a stdout.
 */
export class StdioTransport {
  private handler: MessageHandler | null = null;
  private buffer = '';
  private running = false;

  /** Registra el handler de mensajes. */
  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  /** Inicia la lectura de stdin. */
  start(): void {
    if (this.running) return;
    this.running = true;

    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => this.onData(chunk));
    process.stdin.on('end', () => this.stop());
    process.stdin.resume();
  }

  /** Detiene el transporte. */
  stop(): void {
    this.running = false;
    process.stdin.pause();
  }

  /** Envia una respuesta JSON-RPC por stdout. */
  send(response: JsonRpcResponse): void {
    const json = JSON.stringify(response);
    process.stdout.write(json + '\n');
  }

  /** Envia una notificacion JSON-RPC por stdout. */
  notify(method: string, params?: Record<string, any>): void {
    const notification = { jsonrpc: '2.0' as const, method, params };
    process.stdout.write(JSON.stringify(notification) + '\n');
  }

  private async onData(chunk: string): Promise<void> {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      await this.processLine(trimmed);
    }
  }

  private async processLine(line: string): Promise<void> {
    if (!this.handler) return;

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line);
    } catch {
      this.send({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error: invalid JSON' },
      });
      return;
    }

    if (request.jsonrpc !== '2.0' || !request.method) {
      this.send({
        jsonrpc: '2.0',
        id: request.id ?? null,
        error: { code: -32600, message: 'Invalid Request: missing jsonrpc or method' },
      });
      return;
    }

    const response = await this.handler(request);
    if (response) {
      this.send(response);
    }
  }
}
