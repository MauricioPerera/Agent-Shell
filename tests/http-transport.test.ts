/**
 * Tests del modulo HttpSseTransport.
 *
 * Valida endpoints HTTP (POST /rpc, GET /sse, GET /health),
 * SSE streaming, CORS, error handling, y session management.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { request as httpRequest } from 'node:http';
import { HttpSseTransport } from '../src/mcp/http-transport.js';
import type { JsonRpcRequest, JsonRpcResponse } from '../src/mcp/types.js';

// --- Helpers ---

function createMockHandler(overrides?: Partial<{ response: any; delay: number; throws: boolean }>) {
  return async (req: JsonRpcRequest): Promise<JsonRpcResponse | null> => {
    if (overrides?.throws) throw new Error('handler exploded');
    if (overrides?.delay) await new Promise((r) => setTimeout(r, overrides.delay));
    if (req.id === undefined) return null; // notification

    const result = overrides?.response ?? { echo: req.method };
    return { jsonrpc: '2.0', id: req.id!, result };
  };
}

function rpcRequest(port: number, body: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: '/rpc',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          let parsed: any;
          try { parsed = JSON.parse(text); } catch { parsed = text; }
          resolve({ status: res.statusCode!, body: parsed });
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpGet(port: number, path: string, headers?: Record<string, string>): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode!,
            headers: res.headers as Record<string, string>,
            body: Buffer.concat(chunks).toString('utf-8'),
          });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function connectSse(port: number): Promise<{ events: Array<{ event: string; data: string }>; close: () => void; response: any }> {
  return new Promise((resolve, reject) => {
    const events: Array<{ event: string; data: string }> = [];

    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: '/sse',
        method: 'GET',
        headers: { Accept: 'text/event-stream' },
      },
      (res) => {
        let buffer = '';
        let currentEvent = 'message';

        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf-8');
          const parts = buffer.split('\n\n');
          buffer = parts.pop() || '';

          for (const part of parts) {
            const lines = part.split('\n');
            let event = 'message';
            let data = '';
            for (const line of lines) {
              if (line.startsWith('event: ')) event = line.slice(7);
              if (line.startsWith('data: ')) data = line.slice(6);
            }
            events.push({ event, data });
          }
        });

        const close = () => {
          res.destroy();
          req.destroy();
        };

        // Wait a tick for the connected event
        setTimeout(() => resolve({ events, close, response: res }), 50);
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function httpOptions(port: number, path: string, origin?: string): Promise<{ status: number; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'OPTIONS',
        headers: origin ? { Origin: origin } : {},
      },
      (res) => {
        res.on('data', () => {});
        res.on('end', () => {
          resolve({ status: res.statusCode!, headers: res.headers as Record<string, string> });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// --- Tests ---

describe('HttpSseTransport', () => {
  let transport: HttpSseTransport;

  afterEach(async () => {
    if (transport) {
      await transport.stop();
    }
  });

  describe('Lifecycle', () => {
    it('T01: start() resuelve cuando el servidor esta escuchando', async () => {
      transport = new HttpSseTransport({ port: 0 });
      transport.onMessage(createMockHandler());
      await transport.start();
      expect(transport.port).toBeGreaterThan(0);
    });

    it('T02: stop() cierra el servidor y resuelve', async () => {
      transport = new HttpSseTransport({ port: 0 });
      transport.onMessage(createMockHandler());
      await transport.start();
      const port = transport.port;
      await transport.stop();

      // Server should be down
      await expect(rpcRequest(port, { jsonrpc: '2.0', id: 1, method: 'ping' })).rejects.toThrow();
    });

    it('T03: double start() es no-op', async () => {
      transport = new HttpSseTransport({ port: 0 });
      transport.onMessage(createMockHandler());
      await transport.start();
      const port = transport.port;
      await transport.start(); // no-op
      expect(transport.port).toBe(port);
    });

    it('T04: stop() sin start() es no-op', async () => {
      transport = new HttpSseTransport({ port: 0 });
      await transport.stop(); // should not throw
    });

    it('T05: port 0 asigna puerto aleatorio', async () => {
      transport = new HttpSseTransport({ port: 0 });
      transport.onMessage(createMockHandler());
      await transport.start();
      expect(transport.port).toBeGreaterThan(0);
      expect(transport.port).not.toBe(0);
    });
  });

  describe('POST /rpc', () => {
    beforeEach(async () => {
      transport = new HttpSseTransport({ port: 0 });
      transport.onMessage(createMockHandler());
      await transport.start();
    });

    it('T06: procesa JSON-RPC request y retorna response', async () => {
      const { status, body } = await rpcRequest(transport.port, {
        jsonrpc: '2.0',
        id: 1,
        method: 'ping',
      });

      expect(status).toBe(200);
      expect(body.jsonrpc).toBe('2.0');
      expect(body.id).toBe(1);
      expect(body.result).toEqual({ echo: 'ping' });
    });

    it('T07: retorna 400 para JSON invalido', async () => {
      const { status, body } = await new Promise<{ status: number; body: any }>((resolve, reject) => {
        const data = 'not json at all {{{';
        const req = httpRequest(
          {
            hostname: '127.0.0.1',
            port: transport.port,
            path: '/rpc',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
              resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) });
            });
          }
        );
        req.on('error', reject);
        req.write(data);
        req.end();
      });

      expect(status).toBe(400);
      expect(body.error.code).toBe(-32700);
    });

    it('T08: retorna 400 si falta jsonrpc o method', async () => {
      const { status, body } = await rpcRequest(transport.port, {
        id: 1,
        method: 'ping',
        // missing jsonrpc: '2.0'
      });

      expect(status).toBe(400);
      expect(body.error.code).toBe(-32600);
    });

    it('T09: retorna 400 si falta method', async () => {
      const { status, body } = await rpcRequest(transport.port, {
        jsonrpc: '2.0',
        id: 1,
        // missing method
      });

      expect(status).toBe(400);
      expect(body.error.code).toBe(-32600);
    });

    it('T10: retorna 413 si body excede maxBodySize', async () => {
      await transport.stop();
      transport = new HttpSseTransport({ port: 0, maxBodySize: 50 });
      transport.onMessage(createMockHandler());
      await transport.start();

      const { status } = await rpcRequest(transport.port, {
        jsonrpc: '2.0',
        id: 1,
        method: 'test',
        params: { data: 'x'.repeat(100) },
      });

      expect(status).toBe(413);
    });

    it('T11: retorna 204 para notifications (sin id)', async () => {
      const { status } = await rpcRequest(transport.port, {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      });

      expect(status).toBe(204);
    });

    it('T12: retorna 500 si handler lanza error', async () => {
      await transport.stop();
      transport = new HttpSseTransport({ port: 0 });
      transport.onMessage(createMockHandler({ throws: true }));
      await transport.start();

      const { status, body } = await rpcRequest(transport.port, {
        jsonrpc: '2.0',
        id: 1,
        method: 'test',
      });

      expect(status).toBe(500);
      expect(body.error.code).toBe(-32603);
      expect(body.error.message).toContain('handler exploded');
    });

    it('T13: retorna 500 si no hay handler registrado', async () => {
      await transport.stop();
      transport = new HttpSseTransport({ port: 0 });
      // No handler registered
      await transport.start();

      const { status, body } = await rpcRequest(transport.port, {
        jsonrpc: '2.0',
        id: 1,
        method: 'test',
      });

      expect(status).toBe(500);
      expect(body.error.message).toContain('No handler registered');
    });
  });

  describe('GET /sse', () => {
    beforeEach(async () => {
      transport = new HttpSseTransport({ port: 0, heartbeatInterval: 100 });
      transport.onMessage(createMockHandler());
      await transport.start();
    });

    it('T14: establece conexion SSE con headers correctos', async () => {
      const { events, close, response } = await connectSse(transport.port);
      expect(response.headers['content-type']).toBe('text/event-stream');
      expect(response.headers['cache-control']).toBe('no-cache');
      expect(response.headers['connection']).toBe('keep-alive');
      close();
    });

    it('T15: envia evento connected con sessionId', async () => {
      const { events, close } = await connectSse(transport.port);

      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].event).toBe('connected');
      const data = JSON.parse(events[0].data);
      expect(data.sessionId).toBeDefined();
      expect(typeof data.sessionId).toBe('string');
      close();
    });

    it('T16: incrementa connectedClients al conectarse', async () => {
      expect(transport.connectedClients).toBe(0);
      const { close } = await connectSse(transport.port);
      expect(transport.connectedClients).toBe(1);
      close();
      // Wait for close to propagate
      await new Promise((r) => setTimeout(r, 50));
      expect(transport.connectedClients).toBe(0);
    });

    it('T17: multiples clientes SSE simultaneos', async () => {
      const c1 = await connectSse(transport.port);
      const c2 = await connectSse(transport.port);
      const c3 = await connectSse(transport.port);

      expect(transport.connectedClients).toBe(3);

      c1.close();
      c2.close();
      c3.close();
    });

    it('T18: envia heartbeat periodicamente', async () => {
      const { events, close } = await connectSse(transport.port);

      // Wait for at least one heartbeat (interval is 100ms)
      await new Promise((r) => setTimeout(r, 200));

      const heartbeats = events.filter((e) => e.event === 'heartbeat');
      expect(heartbeats.length).toBeGreaterThanOrEqual(1);

      const data = JSON.parse(heartbeats[0].data);
      expect(data.time).toBeDefined();
      expect(typeof data.time).toBe('number');
      close();
    });

    it('T19: notify() envia evento a todos los clientes conectados', async () => {
      const c1 = await connectSse(transport.port);
      const c2 = await connectSse(transport.port);

      transport.notify('test/event', { value: 42 });

      // Wait for event to propagate
      await new Promise((r) => setTimeout(r, 50));

      const msgs1 = c1.events.filter((e) => e.event === 'message');
      const msgs2 = c2.events.filter((e) => e.event === 'message');

      expect(msgs1.length).toBe(1);
      expect(msgs2.length).toBe(1);

      const parsed = JSON.parse(msgs1[0].data);
      expect(parsed.jsonrpc).toBe('2.0');
      expect(parsed.method).toBe('test/event');
      expect(parsed.params).toEqual({ value: 42 });

      c1.close();
      c2.close();
    });
  });

  describe('GET /health', () => {
    beforeEach(async () => {
      transport = new HttpSseTransport({ port: 0 });
      transport.onMessage(createMockHandler());
      await transport.start();
    });

    it('T20: retorna status ok con uptime y clients', async () => {
      const { status, body } = await httpGet(transport.port, '/health');
      const health = JSON.parse(body);

      expect(status).toBe(200);
      expect(health.status).toBe('ok');
      expect(health.transport).toBe('http-sse');
      expect(typeof health.uptime).toBe('number');
      expect(health.connectedClients).toBe(0);
    });

    it('T21: refleja clients conectados en health', async () => {
      const { close } = await connectSse(transport.port);

      const { body } = await httpGet(transport.port, '/health');
      const health = JSON.parse(body);
      expect(health.connectedClients).toBe(1);

      close();
    });
  });

  describe('Routing & HTTP Methods', () => {
    beforeEach(async () => {
      transport = new HttpSseTransport({ port: 0 });
      transport.onMessage(createMockHandler());
      await transport.start();
    });

    it('T22: retorna 404 para rutas desconocidas', async () => {
      const { status } = await httpGet(transport.port, '/unknown');
      expect(status).toBe(404);
    });

    it('T23: retorna 405 para GET /rpc', async () => {
      const { status } = await httpGet(transport.port, '/rpc');
      expect(status).toBe(405);
    });
  });

  describe('CORS', () => {
    it('T24: sin corsOrigin no agrega headers CORS', async () => {
      transport = new HttpSseTransport({ port: 0 });
      transport.onMessage(createMockHandler());
      await transport.start();

      const { status, body } = await rpcRequest(transport.port, {
        jsonrpc: '2.0',
        id: 1,
        method: 'ping',
      });

      expect(status).toBe(200);
      // No CORS headers in response (checked via health which returns headers)
      const health = await httpGet(transport.port, '/health');
      expect(health.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('T25: con corsOrigin string agrega header CORS', async () => {
      transport = new HttpSseTransport({ port: 0, corsOrigin: 'http://localhost:5173' });
      transport.onMessage(createMockHandler());
      await transport.start();

      const { headers } = await httpGet(transport.port, '/health');
      expect(headers['access-control-allow-origin']).toBe('http://localhost:5173');
    });

    it('T26: con corsOrigin array solo agrega si origin coincide', async () => {
      transport = new HttpSseTransport({ port: 0, corsOrigin: ['http://localhost:5173', 'http://example.com'] });
      transport.onMessage(createMockHandler());
      await transport.start();

      // Matching origin
      const { headers } = await httpGet(transport.port, '/health', { Origin: 'http://example.com' });
      expect(headers['access-control-allow-origin']).toBe('http://example.com');
    });

    it('T27: OPTIONS preflight retorna 204 con headers CORS', async () => {
      transport = new HttpSseTransport({ port: 0, corsOrigin: 'http://localhost:5173' });
      transport.onMessage(createMockHandler());
      await transport.start();

      const { status, headers } = await httpOptions(transport.port, '/rpc', 'http://localhost:5173');
      expect(status).toBe(204);
      expect(headers['access-control-allow-methods']).toContain('POST');
      expect(headers['access-control-allow-headers']).toContain('Content-Type');
      expect(headers['access-control-max-age']).toBe('86400');
    });

    it('T28: OPTIONS sin corsOrigin retorna 204 sin headers CORS', async () => {
      transport = new HttpSseTransport({ port: 0 });
      transport.onMessage(createMockHandler());
      await transport.start();

      const { status, headers } = await httpOptions(transport.port, '/rpc');
      expect(status).toBe(204);
      expect(headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('Integration with McpServer', () => {
    it('T29: funciona con McpServer.handleMessage como handler', async () => {
      // Simula el patron de uso real
      const mockMcpServer = {
        handleMessage: async (req: JsonRpcRequest): Promise<JsonRpcResponse | null> => {
          if (req.method === 'initialize') {
            return {
              jsonrpc: '2.0',
              id: req.id!,
              result: {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'test', version: '0.1.0' },
              },
            };
          }
          if (req.method === 'tools/list') {
            return {
              jsonrpc: '2.0',
              id: req.id!,
              result: { tools: [{ name: 'cli_help' }, { name: 'cli_exec' }] },
            };
          }
          return { jsonrpc: '2.0', id: req.id!, result: {} };
        },
      };

      transport = new HttpSseTransport({ port: 0 });
      transport.onMessage((req) => mockMcpServer.handleMessage(req));
      await transport.start();

      // Initialize
      const init = await rpcRequest(transport.port, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {},
      });
      expect(init.body.result.protocolVersion).toBe('2024-11-05');
      expect(init.body.result.serverInfo.name).toBe('test');

      // Tools list
      const tools = await rpcRequest(transport.port, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      });
      expect(tools.body.result.tools).toHaveLength(2);
    });

    it('T30: stop() cierra todas las conexiones SSE activas', async () => {
      transport = new HttpSseTransport({ port: 0 });
      transport.onMessage(createMockHandler());
      await transport.start();

      const c1 = await connectSse(transport.port);
      const c2 = await connectSse(transport.port);
      expect(transport.connectedClients).toBe(2);

      await transport.stop();
      expect(transport.connectedClients).toBe(0);

      // Clients should be disconnected (response ended)
      c1.close();
      c2.close();
    });
  });

  describe('Config Defaults', () => {
    it('T31: usa defaults correctos', async () => {
      transport = new HttpSseTransport();
      // Port default is 3000, but we can't easily test that without binding
      // Just verify it was created without error
      expect(transport.connectedClients).toBe(0);
    });
  });

  describe('Request Timeout', () => {
    it('T32: timeout genera respuesta 504', async () => {
      transport = new HttpSseTransport({ port: 0, requestTimeout: 50 });
      transport.onMessage(createMockHandler({ delay: 200 }));
      await transport.start();

      const { status, body } = await rpcRequest(transport.port, {
        jsonrpc: '2.0',
        id: 1,
        method: 'slow',
      });

      expect(status).toBe(504);
      expect(body.error.message).toContain('timeout');
    });
  });
});
