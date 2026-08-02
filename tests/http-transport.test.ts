/**
 * Tests del modulo HttpSseTransport.
 *
 * Valida endpoints HTTP (POST /rpc, GET /sse, GET /health),
 * SSE streaming, CORS, error handling, y session management.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HttpSseTransport } from '../src/mcp/http-transport.js';
import { McpServer } from '../src/mcp/server.js';
import { Core } from '../src/core/index.js';
import { CommandRegistry } from '../src/command-registry/index.js';
import { registerShellSkills } from '../src/skills/index.js';
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

function rpcRequest(port: number, body: any, extraHeaders?: Record<string, string>): Promise<{ status: number; body: any }> {
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
          ...extraHeaders,
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

    /**
     * Regresion (ronda 41 del audit, HIGH): stop() solo cerraba las
     * conexiones SSE trackeadas; server.close() por si solo espera a que
     * las conexiones EXISTENTES se cierren solas, sin importar si son
     * SSE o keep-alive de /rpc. Una conexion keep-alive de /rpc en idle
     * (sin request en vuelo, pero sin cerrar) no se cierra por si sola
     * hasta su propio keepAliveTimeout (Node default ~5s) o hasta que el
     * peer la cierre — reproducido antes del fix: stop() tardaba ~7s con
     * una sola conexion idle abierta. closeIdleConnections()/
     * closeAllConnections() deben acotar esto a un margen chico.
     */
    it('T02b: stop() resuelve rapido aunque haya una conexion keep-alive de /rpc abierta e idle', async () => {
      transport = new HttpSseTransport({ port: 0 });
      transport.onMessage(createMockHandler());
      await transport.start();
      const port = transport.port;

      const { Agent } = await import('node:http');
      const keepAliveAgent = new Agent({ keepAlive: true, maxSockets: 1 });
      try {
        await new Promise<void>((resolve, reject) => {
          const req = httpRequest(
            {
              hostname: '127.0.0.1',
              port,
              path: '/rpc',
              method: 'POST',
              agent: keepAliveAgent,
              headers: { 'Content-Type': 'application/json' },
            },
            (res) => {
              res.on('data', () => {});
              res.on('end', () => resolve());
            }
          );
          req.on('error', reject);
          req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }));
        });

        // The socket is now idle but the agent keeps it open (keep-alive).
        const start = Date.now();
        await transport.stop();
        const elapsed = Date.now() - start;

        expect(elapsed).toBeLessThan(2000);
      } finally {
        keepAliveAgent.destroy();
      }
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

    /**
     * Regresion: el contrato exige verificar Content-Type antes de parsear
     * (paso 2 del flujo), pero handleRpc nunca lo chequeaba. Una pagina
     * cross-origin puede mandar un POST "simple" (sin preflight CORS) con
     * Content-Type text/plain o application/x-www-form-urlencoded — esos
     * SI puede emitirlos un <form> HTML real, a diferencia de application/json.
     */
    it('T08b: retorna 400 si Content-Type no es application/json (CSRF via form POST)', async () => {
      const { status, body } = await new Promise<{ status: number; body: any }>((resolve, reject) => {
        const data = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
        const req = httpRequest(
          {
            hostname: '127.0.0.1',
            port: transport.port,
            path: '/rpc',
            method: 'POST',
            headers: { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(data) },
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
      expect(body.error.code).toBe(-32600);
      expect(body.error.message).toContain('Content-Type');
    });

    it('T08c: acepta application/json con charset (application/json; charset=utf-8)', async () => {
      const { status, body } = await new Promise<{ status: number; body: any }>((resolve, reject) => {
        const data = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
        const req = httpRequest(
          {
            hostname: '127.0.0.1',
            port: transport.port,
            path: '/rpc',
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) },
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

      expect(status).toBe(200);
      expect(body.result).toEqual({ echo: 'ping' });
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

    /**
     * Regresion: `null` es JSON valido (JSON.parse('null') no lanza), asi
     * que `request` podia terminar siendo `null` aca dentro — el chequeo de
     * estructura JSON-RPC accedia `request.jsonrpc`/`request.id` sin
     * resguardo, lo que tiraba un TypeError sincronico dentro de un
     * callback async (`req.on('end', async () => {...})`) que nadie espera
     * ni atrapa. Sin un process.on('unhandledRejection') en todo el repo,
     * un solo request con body literal `null` tumbaba el proceso entero.
     */
    it('T09b: body JSON "null" retorna 400 en vez de tumbar el servidor', async () => {
      const { status, body } = await rpcRequest(transport.port, null);

      expect(status).toBe(400);
      expect(body.error.code).toBe(-32600);
    });

    it('T09c: body JSON no-objeto (numero/string/array) retorna 400, no crashea', async () => {
      for (const primitive of [42, 'just-a-string', true, []]) {
        const { status, body } = await rpcRequest(transport.port, primitive as any);
        expect(status).toBe(400);
        expect(body.error.code).toBe(-32600);
      }
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

    it('T12: retorna 500 si handler lanza error, sin filtrar el mensaje interno al caller', async () => {
      await transport.stop();
      transport = new HttpSseTransport({ port: 0 });
      transport.onMessage(createMockHandler({ throws: true }));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await transport.start();

      const { status, body } = await rpcRequest(transport.port, {
        jsonrpc: '2.0',
        id: 1,
        method: 'test',
      });

      expect(status).toBe(500);
      expect(body.error.code).toBe(-32603);
      expect(body.error.message).toBe('Internal error');
      expect(body.error.message).not.toContain('handler exploded');
      // Logged server-side instead, so an operator can still diagnose it.
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Internal error'), expect.any(Error));
      errorSpy.mockRestore();
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

    /**
     * Regresion: GET /sse no tenia limite de conexiones concurrentes — un
     * cliente (o atacante) podia abrir conexiones SSE sin cota y agotar
     * file descriptors/memoria del proceso, DoS trivial sin necesitar
     * preflight CORS (GET simple).
     */
    it('T17b: rechaza con 503 al superar maxSseClients', async () => {
      await transport.stop();
      transport = new HttpSseTransport({ port: 0, maxSseClients: 2 });
      transport.onMessage(createMockHandler());
      await transport.start();

      const c1 = await connectSse(transport.port);
      const c2 = await connectSse(transport.port);
      expect(transport.connectedClients).toBe(2);

      const c3 = await connectSse(transport.port);
      expect(c3.response.statusCode).toBe(503);
      // El tercero no cuenta como cliente SSE conectado.
      expect(transport.connectedClients).toBe(2);

      c1.close();
      c2.close();
      c3.close();
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

    /**
     * Regresion: con corsOrigin array, el preflight (OPTIONS) siempre
     * respondia con corsOrigin[0] sin importar el Origin real de la
     * request — a diferencia de applyCorsHeaders (usado en requests no-
     * preflight), que si comparaba contra el header Origin real. Rompia
     * el segundo/tercer origen de una config multi-origen legitima: el
     * navegador rechaza la respuesta porque el Origin devuelto no coincide
     * con el que mando.
     */
    it('T28b: OPTIONS con corsOrigin array responde con el Origin real de la request, no siempre el primero', async () => {
      transport = new HttpSseTransport({ port: 0, corsOrigin: ['http://localhost:5173', 'http://example.com'] });
      transport.onMessage(createMockHandler());
      await transport.start();

      // El SEGUNDO origen configurado hace el preflight — antes del fix
      // habria recibido 'http://localhost:5173' (el primero) en la respuesta.
      const { status, headers } = await httpOptions(transport.port, '/rpc', 'http://example.com');
      expect(status).toBe(204);
      expect(headers['access-control-allow-origin']).toBe('http://example.com');
    });

    it('T28c: OPTIONS con corsOrigin array y Origin no permitido no incluye el header', async () => {
      transport = new HttpSseTransport({ port: 0, corsOrigin: ['http://localhost:5173', 'http://example.com'] });
      transport.onMessage(createMockHandler());
      await transport.start();

      const { status, headers } = await httpOptions(transport.port, '/rpc', 'http://evil.example');
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

    /**
     * Regresion: un solo Core/registry compartido servia TODOS los requests
     * HTTP concurrentes a traves de la MISMA WorkspaceState — el cwd/env de
     * un caller se filtraba al siguiente request de cualquier OTRO caller.
     * Extremo a extremo real: dos "sesiones" (X-Session-Id distintos)
     * inicializan workspace:* en directorios DIFERENTES; cada una debe ver
     * solo el suyo. Sin el header, cada request es su propia sesion
     * aislada (nunca ve el estado de la otra ni persiste entre requests).
     */
    it('T30b: workspace:* aisla el cwd por X-Session-Id entre requests HTTP concurrentes', async () => {
      const registry = new CommandRegistry();
      registerShellSkills(registry);
      const core = new Core({ registry });
      const mcpServer = new McpServer({ core });

      transport = new HttpSseTransport({ port: 0 });
      transport.onMessage((msg, sessionId) => mcpServer.handleMessage(msg, sessionId));
      await transport.start();

      await rpcRequest(transport.port, { jsonrpc: '2.0', id: 0, method: 'initialize', params: {} });

      const dirA = mkdtempSync(join(tmpdir(), 'http-session-a-'));
      const dirB = mkdtempSync(join(tmpdir(), 'http-session-b-'));

      try {
        const cliExec = (command: string, sessionId?: string) =>
          rpcRequest(
            transport.port,
            { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cli_exec', arguments: { command } } },
            sessionId ? { 'X-Session-Id': sessionId } : undefined,
          );

        await cliExec(`workspace:init --path "${dirA}"`, 'session-A');
        await cliExec(`workspace:init --path "${dirB}"`, 'session-B');

        const statusA = await cliExec('workspace:status', 'session-A');
        const dataA = JSON.parse(statusA.body.result.content[0].text);
        expect(dataA.data.cwd).toBe(dirA);

        const statusB = await cliExec('workspace:status', 'session-B');
        const dataB = JSON.parse(statusB.body.result.content[0].text);
        expect(dataB.data.cwd).toBe(dirB);

        // No X-Session-Id at all: each request gets its own fresh, isolated
        // session — must NOT see either session-A's or session-B's cwd.
        const statusNoHeader = await cliExec('workspace:status');
        const dataNoHeader = JSON.parse(statusNoHeader.body.result.content[0].text);
        expect(dataNoHeader.data.cwd).not.toBe(dirA);
        expect(dataNoHeader.data.cwd).not.toBe(dirB);
      } finally {
        rmSync(dirA, { recursive: true, force: true });
        rmSync(dirB, { recursive: true, force: true });
      }
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

  describe('Fail-closed: bind no-loopback sin auth', () => {
    it('SEC01: start() rechaza con host 0.0.0.0 y sin auth', async () => {
      transport = new HttpSseTransport({ port: 0, host: '0.0.0.0' });
      await expect(transport.start()).rejects.toThrow(/Refusing to start/);
      // No se levanto ningun servidor
      expect(transport.port).toBe(0);
    });

    it('SEC02: start() funciona con host 0.0.0.0 y auth configurada', async () => {
      transport = new HttpSseTransport({ port: 0, host: '0.0.0.0', auth: { bearerToken: 'x' } });
      await transport.start();
      expect(transport.port).toBeGreaterThan(0);
      await transport.stop();
    });

    it('SEC03: start() funciona con host 0.0.0.0 e insecureAllowNoAuth explicito', async () => {
      transport = new HttpSseTransport({ port: 0, host: '0.0.0.0', insecureAllowNoAuth: true });
      await transport.start();
      expect(transport.port).toBeGreaterThan(0);
      await transport.stop();
    });

    it('SEC04: start() sigue funcionando con host loopback sin auth (backward compat)', async () => {
      transport = new HttpSseTransport({ port: 0, host: '127.0.0.1' });
      await transport.start();
      expect(transport.port).toBeGreaterThan(0);
      await transport.stop();
    });
  });
});
