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
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import type { JsonRpcRequest, JsonRpcResponse, HttpTransportConfig, SseClient, HealthResponse } from './types.js';
import { PARSE_ERROR, INVALID_REQUEST } from './types.js';
import type { MessageHandler } from './transport.js';

/**
 * Retorna true SOLO para hosts de loopback conocidos: '127.0.0.1',
 * 'localhost', '::1'. Cualquier otro valor (incluyendo '0.0.0.0', '::',
 * IPs de LAN, hostnames) retorna false. Usado para decidir si start()
 * debe rechazar cuando no hay auth configurada (fail-closed).
 */
function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/**
 * Compara dos strings en tiempo constante (protege contra timing attacks).
 * Hashea ambos valores primero para que timingSafeEqual siempre reciba
 * buffers del MISMO largo (32 bytes, SHA-256) sin importar el largo real
 * de los strings de entrada -- evita el caso borde de timingSafeEqual
 * lanzando una excepcion cuando los buffers tienen largos distintos, y
 * de paso evita filtrar el largo real del token por timing.
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = createHash('sha256').update(a, 'utf-8').digest();
  const bufB = createHash('sha256').update(b, 'utf-8').digest();
  return timingSafeEqual(bufA, bufB);
}

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
  private readonly maxSseClients: number;
  private readonly authToken: string | null;
  private readonly authExcludePaths: Set<string>;
  private readonly insecureAllowNoAuth: boolean;

  constructor(config?: HttpTransportConfig) {
    this._port = config?.port ?? 3000;
    this.host = config?.host ?? '127.0.0.1';
    this.corsOrigin = config?.corsOrigin;
    this.heartbeatInterval = config?.heartbeatInterval ?? 30_000;
    this.requestTimeout = config?.requestTimeout ?? 30_000;
    this.maxBodySize = config?.maxBodySize ?? 65_536;
    this.maxSseClients = config?.maxSseClients ?? 100;
    this.authToken = config?.auth?.bearerToken ?? null;
    this.authExcludePaths = new Set(config?.auth?.excludePaths ?? ['/health']);
    this.insecureAllowNoAuth = config?.insecureAllowNoAuth ?? false;
  }

  /** Registra el handler de mensajes (misma interfaz que StdioTransport). */
  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  /** Inicia el servidor HTTP. Retorna Promise que resuelve cuando esta escuchando. */
  start(): Promise<void> {
    if (this.server) return Promise.resolve();

    // Fail-closed: rechazar antes de crear/levantar el servidor si se va a
    // bindear a una interfaz no-loopback sin auth configurada y sin opt-in
    // explicito. Evita arrancar expuesto a la red por accidente.
    if (!this.authToken && !isLoopbackHost(this.host) && !this.insecureAllowNoAuth) {
      return Promise.reject(
        new Error(
          `Refusing to start HttpSseTransport bound to '${this.host}' without authentication configured. ` +
            "Set auth.bearerToken, bind to 127.0.0.1/localhost, or pass insecureAllowNoAuth: true to explicitly opt out (not recommended)."
        )
      );
    }

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
      this.handleCorsPreFlight(req, res);
      return;
    }

    // Apply CORS headers
    this.applyCorsHeaders(req, res);

    // Bearer token authentication
    if (this.authToken && !this.authExcludePaths.has(url)) {
      const authHeader = req.headers.authorization;
      if (!authHeader || !timingSafeStringEqual(authHeader, `Bearer ${this.authToken}`)) {
        this.sendJson(res, 401, { error: 'Unauthorized', message: 'Valid Bearer token required in Authorization header' });
        return;
      }
    }

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

      // Verify Content-Type is application/json (contract step 2). A cross-site
      // HTML form can only ever submit application/x-www-form-urlencoded,
      // multipart/form-data, or text/plain — none of those satisfy this check,
      // and application/json isn't CORS-safelisted, so a genuine cross-origin
      // JSON request would trigger a preflight the browser enforces. Without
      // this check, a "simple" form POST (no preflight at all) reaches the
      // handler on any deployment that isn't already gated by another layer —
      // most concretely, one bound to loopback with no auth token configured.
      const contentType = req.headers['content-type'] || '';
      if (!contentType.toLowerCase().startsWith('application/json')) {
        clearTimeout(timeout);
        this.sendJson(res, 400, {
          jsonrpc: '2.0',
          id: null,
          error: { code: INVALID_REQUEST, message: `Invalid Request: Content-Type must be application/json (got '${contentType || 'none'}')` },
        });
        return;
      }

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

      // Session-scoped state (workspace:* cwd/env/history) is looked up by
      // this id — a caller that wants persistence across requests must send
      // the SAME X-Session-Id on each one. Without it, every request gets a
      // fresh, isolated id: safer than the old implicit-shared-state default
      // (one Core serving concurrent callers previously mixed everyone's
      // cwd/env together), at the cost of no persistence for callers that
      // haven't adopted the header yet.
      //
      // KNOWN LIMITATION (documented, not fixed): this value is entirely
      // client-chosen and has no relationship to authentication. This
      // server authenticates with one bearer token shared by the whole
      // deployment, not per-principal identity — any caller who knows that
      // token can supply ANOTHER caller's X-Session-Id (guessed, observed,
      // or just reused) and read/mutate that caller's workspace:* state
      // (stashed env vars, cwd, history), or force its eviction by cycling
      // through enough fresh ids (WorkspaceSessionStore's 200-entry FIFO
      // cap). This only prevents ACCIDENTAL cross-talk between concurrent
      // legitimate callers sharing one token — it is not a security
      // boundary between mutually-untrusting principals on the same
      // deployment. See contracts/http-transport.md §1.6 for the full
      // writeup. A real fix needs either per-principal tokens or a
      // server-issued, client-unspoofable session id; neither is
      // implemented.
      const sessionId = (req.headers['x-session-id'] as string | undefined) || randomUUID();

      try {
        const response = await this.handler(request, sessionId);
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
    // No limit meant any client (or a single attacker) could open unbounded
    // SSE connections and exhaust the process's file descriptors/memory —
    // a trivial DoS since GET /sse doesn't require a CORS preflight to open,
    // only to have its response read cross-origin.
    if (this.clients.size >= this.maxSseClients) {
      this.sendJson(res, 503, { error: 'Too many concurrent SSE connections' });
      return;
    }

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

  /**
   * With an array corsOrigin, resolves which origin (if any) to echo back
   * for THIS request — matching applyCorsHeaders' logic. Used to fix
   * handleCorsPreFlight always answering with corsOrigin[0] regardless of
   * the requester's actual Origin, which broke legitimate multi-origin
   * configs (an allowed 2nd/3rd origin's preflight got the 1st origin's
   * value back, which browsers then reject as a mismatch).
   */
  private resolveAllowedOrigin(req: IncomingMessage): string | null {
    if (!this.corsOrigin) return null;
    if (!Array.isArray(this.corsOrigin)) return this.corsOrigin;
    const requestOrigin = req.headers['origin'] || '';
    return this.corsOrigin.includes(requestOrigin) ? requestOrigin : null;
  }

  private handleCorsPreFlight(req: IncomingMessage, res: ServerResponse): void {
    const origin = this.resolveAllowedOrigin(req);
    if (!origin) {
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(204, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Session-Id',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
  }

  private applyCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
    const origin = this.resolveAllowedOrigin(req);
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
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
