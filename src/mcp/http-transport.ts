/**
 * @module mcp/http-transport
 * @description Transporte HTTP/SSE para el protocolo MCP.
 *
 * Expone el McpServer como servicio HTTP:
 *   - POST /rpc: JSON-RPC 2.0 requests
 *   - GET /sse: Server-Sent Events stream
 *   - GET /health: Health check endpoint
 *
 * Dependencias externas: Ninguna (usa node:http y node:crypto).
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { JsonRpcRequest, JsonRpcResponse, HttpTransportConfig, SseClient, HealthResponse } from './types.js';
import { PARSE_ERROR, INVALID_REQUEST } from './types.js';
import type { MessageHandler } from './transport.js';

/**
 * Transporte HTTP/SSE para JSON-RPC 2.0.
 *
 * Recibe requests via HTTP POST y entrega notificaciones via SSE.
 * Implementa la misma interfaz MessageHandler que StdioTransport.
 */
export class HttpSseTransport {
  private handler: MessageHandler | null = null;
  private server: Server | null = null;
  private readonly clients: Set<SseClient> = new Set();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private startedAt: number = 0;
  private _port: number;
  private readonly host: string;
  private readonly corsOrigin: string | string[] | undefined;
  private readonly heartbeatInterval: number;
  private readonly requestTimeout: number;
  private readonly maxBodySize: number;

  constructor(config?: HttpTransportConfig) {
    this._port = config?.port ?? 3000;
    this.host = config?.host ?? '127.0.0.1';
    this.corsOrigin = config?.corsOrigin;
    this.heartbeatInterval = config?.heartbeatInterval ?? 30_000;
    this.requestTimeout = config?.requestTimeout ?? 30_000;
    this.maxBodySize = config?.maxBodySize ?? 65_536;
  }

  /** Registra el handler de mensajes (misma interfaz que StdioTransport). */
  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  /** Inicia el servidor HTTP. Retorna Promise que resuelve cuando esta escuchando. */
  start(): Promise<void> {
    if (this.server) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));

      this.server.on('error', (err) => {
        reject(err);
      });

      this.server.listen(this._port, this.host, () => {
        const addr = this.server!.address();
        if (addr && typeof addr === 'object') {
          this._port = addr.port;
        }
        this.startedAt = Date.now();
        this.startHeartbeat();
        resolve();
      });
    });
  }

  /** Detiene el servidor HTTP. Cierra todas las conexiones SSE. */
  stop(): Promise<void> {
    if (!this.server) return Promise.resolve();

    // Stop heartbeat
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Close all SSE connections
    for (const client of this.clients) {
      client.response.end();
    }
    this.clients.clear();

    // Close HTTP server
    return new Promise<void>((resolve) => {
      this.server!.close(() => {
        this.server = null;
        resolve();
      });
    });
  }

  /** Envia una notificacion a todos los clientes SSE conectados. */
  notify(method: string, params?: Record<string, any>): void {
    const notification = { jsonrpc: '2.0' as const, method, params };
    for (const client of this.clients) {
      this.sendSseEvent(client.response, 'message', notification);
    }
  }

  /** Numero de clientes SSE actualmente conectados. */
  get connectedClients(): number {
    return this.clients.size;
  }

  /** Puerto actual del servidor (util si port=0 para puerto aleatorio). */
  get port(): number {
    return this._port;
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url || '/';
    const method = req.method || 'GET';

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      this.handleCorsPreFlight(res);
      return;
    }

    // Apply CORS headers
    this.applyCorsHeaders(req, res);

    if (url === '/rpc' && method === 'POST') {
      this.handleRpc(req, res);
    } else if (url === '/sse' && method === 'GET') {
      this.handleSse(req, res);
    } else if (url === '/health' && method === 'GET') {
      this.handleHealth(res);
    } else if (url === '/rpc' && method !== 'POST') {
      this.sendJson(res, 405, { error: 'Method Not Allowed. Use POST for /rpc.' });
    } else {
      this.sendJson(res, 404, { error: 'Not Found' });
    }
  }

  private handleRpc(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    let aborted = false;

    // Request timeout
    const timeout = setTimeout(() => {
      if (!aborted) {
        aborted = true;
        this.sendJson(res, 504, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32000, message: 'Request timeout' },
        });
      }
    }, this.requestTimeout);

    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      totalSize += chunk.length;
      if (totalSize > this.maxBodySize) {
        aborted = true;
        clearTimeout(timeout);
        this.sendJson(res, 413, { error: 'Request body too large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', async () => {
      if (aborted) return;

      const body = Buffer.concat(chunks).toString('utf-8');

      // Parse JSON
      let request: JsonRpcRequest;
      try {
        request = JSON.parse(body);
      } catch {
        clearTimeout(timeout);
        this.sendJson(res, 400, {
          jsonrpc: '2.0',
          id: null,
          error: { code: PARSE_ERROR, message: 'Parse error: invalid JSON' },
        });
        return;
      }

      // Validate JSON-RPC structure
      if (request.jsonrpc !== '2.0' || !request.method) {
        clearTimeout(timeout);
        this.sendJson(res, 400, {
          jsonrpc: '2.0',
          id: request.id ?? null,
          error: { code: INVALID_REQUEST, message: 'Invalid Request: missing jsonrpc or method' },
        });
        return;
      }

      // Delegate to handler
      if (!this.handler) {
        clearTimeout(timeout);
        this.sendJson(res, 500, {
          jsonrpc: '2.0',
          id: request.id ?? null,
          error: { code: -32603, message: 'No handler registered' },
        });
        return;
      }

      try {
        const response = await this.handler(request);
        if (aborted) return; // timeout already fired
        clearTimeout(timeout);
        if (response) {
          this.sendJson(res, 200, response);
        } else {
          // Notification (no response expected)
          res.writeHead(204);
          res.end();
        }
      } catch (err: any) {
        if (aborted) return;
        clearTimeout(timeout);
        this.sendJson(res, 500, {
          jsonrpc: '2.0',
          id: request.id ?? null,
          error: { code: -32603, message: `Internal error: ${err.message || 'unknown'}` },
        });
      }
    });

    req.on('error', () => {
      if (!aborted) {
        aborted = true;
        clearTimeout(timeout);
      }
    });
  }

  private handleSse(req: IncomingMessage, res: ServerResponse): void {
    const clientId = randomUUID();

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const client: SseClient = {
      id: clientId,
      response: res,
      connectedAt: Date.now(),
    };

    this.clients.add(client);

    // Send connected event
    this.sendSseEvent(res, 'connected', { sessionId: clientId });

    // Handle disconnect
    req.on('close', () => {
      this.clients.delete(client);
    });

    res.on('close', () => {
      this.clients.delete(client);
    });
  }

  private handleHealth(res: ServerResponse): void {
    const health: HealthResponse = {
      status: 'ok',
      uptime: Math.floor((Date.now() - this.startedAt) / 1000),
      connectedClients: this.clients.size,
      transport: 'http-sse',
    };
    this.sendJson(res, 200, health);
  }

  private handleCorsPreFlight(res: ServerResponse): void {
    if (!this.corsOrigin) {
      res.writeHead(204);
      res.end();
      return;
    }

    const origin = Array.isArray(this.corsOrigin) ? this.corsOrigin[0] : this.corsOrigin;
    res.writeHead(204, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Session-Id',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
  }

  private applyCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
    if (!this.corsOrigin) return;

    const requestOrigin = req.headers['origin'] || '';

    if (Array.isArray(this.corsOrigin)) {
      if (this.corsOrigin.includes(requestOrigin)) {
        res.setHeader('Access-Control-Allow-Origin', requestOrigin);
      }
    } else {
      res.setHeader('Access-Control-Allow-Origin', this.corsOrigin);
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      for (const client of this.clients) {
        this.sendSseEvent(client.response, 'heartbeat', { time: Date.now() });
      }
    }, this.heartbeatInterval);

    // Allow process to exit even if heartbeat is running
    if (this.heartbeatTimer.unref) {
      this.heartbeatTimer.unref();
    }
  }

  private sendSseEvent(res: ServerResponse, event: string, data: any): void {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      // Client disconnected, ignore write errors
    }
  }

  private sendJson(res: ServerResponse, statusCode: number, data: any): void {
    const json = JSON.stringify(data);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(json),
    });
    res.end(json);
  }
}
