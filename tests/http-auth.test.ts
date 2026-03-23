/**
 * Tests for Bearer token authentication on HTTP/SSE transport.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { HttpSseTransport } from '../src/mcp/http-transport.js';
import type { JsonRpcRequest, JsonRpcResponse } from '../src/mcp/types.js';

const TEST_TOKEN = 'test-secret-token-12345';
const TEST_PORT = 0; // Let OS assign a free port

async function httpRequest(port: number, path: string, opts: { method?: string; body?: any; headers?: Record<string, string> } = {}): Promise<{ status: number; body: any }> {
  const method = opts.method || 'GET';
  const url = `http://127.0.0.1:${port}${path}`;

  const fetchOpts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json', ...opts.headers },
  };
  if (opts.body) fetchOpts.body = JSON.stringify(opts.body);

  const res = await fetch(url, fetchOpts);
  const text = await res.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

// ===========================================================================
// With Auth Enabled
// ===========================================================================

describe('HTTP Auth: Bearer Token', () => {
  let transport: HttpSseTransport;
  let port: number;

  beforeAll(async () => {
    transport = new HttpSseTransport({
      port: TEST_PORT,
      host: '127.0.0.1',
      auth: { bearerToken: TEST_TOKEN },
    });

    transport.onMessage(async (msg: JsonRpcRequest): Promise<JsonRpcResponse | null> => {
      if (msg.method === 'initialize') {
        return { jsonrpc: '2.0', id: msg.id!, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'test', version: '0.1.0' } } };
      }
      if (msg.method === 'tools/list') {
        return { jsonrpc: '2.0', id: msg.id!, result: { tools: [] } };
      }
      return { jsonrpc: '2.0', id: msg.id!, result: {} };
    });

    await transport.start();
    port = transport.port;
  });

  afterAll(async () => {
    await transport.stop();
  });

  it('AUTH01: rejects /rpc without Authorization header', async () => {
    const res = await httpRequest(port, '/rpc', {
      method: 'POST',
      body: { jsonrpc: '2.0', id: 1, method: 'initialize' },
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  it('AUTH02: rejects /rpc with wrong token', async () => {
    const res = await httpRequest(port, '/rpc', {
      method: 'POST',
      body: { jsonrpc: '2.0', id: 1, method: 'initialize' },
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  it('AUTH03: accepts /rpc with correct token', async () => {
    const res = await httpRequest(port, '/rpc', {
      method: 'POST',
      body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(res.body.result).toBeDefined();
  });

  it('AUTH04: /health is accessible without auth', async () => {
    const res = await httpRequest(port, '/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('AUTH05: rejects /sse without auth', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/sse`);
    expect(res.status).toBe(401);
  });

  it('AUTH06: rejects Bearer with extra spaces', async () => {
    const res = await httpRequest(port, '/rpc', {
      method: 'POST',
      body: { jsonrpc: '2.0', id: 1, method: 'ping' },
      headers: { Authorization: `Bearer  ${TEST_TOKEN}` }, // double space
    });
    expect(res.status).toBe(401);
  });

  it('AUTH07: rejects non-Bearer auth scheme', async () => {
    const res = await httpRequest(port, '/rpc', {
      method: 'POST',
      body: { jsonrpc: '2.0', id: 1, method: 'ping' },
      headers: { Authorization: `Basic ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(401);
  });

  it('AUTH08: multiple authenticated requests work', async () => {
    const headers = { Authorization: `Bearer ${TEST_TOKEN}` };

    const r1 = await httpRequest(port, '/rpc', {
      method: 'POST', headers,
      body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    });
    expect(r1.status).toBe(200);

    const r2 = await httpRequest(port, '/rpc', {
      method: 'POST', headers,
      body: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    });
    expect(r2.status).toBe(200);
  });
});

// ===========================================================================
// Without Auth (backward compatible)
// ===========================================================================

describe('HTTP Auth: No Auth Configured', () => {
  let transport: HttpSseTransport;
  let port: number;

  beforeAll(async () => {
    transport = new HttpSseTransport({
      port: TEST_PORT,
      host: '127.0.0.1',
      // No auth config
    });

    transport.onMessage(async (msg: JsonRpcRequest): Promise<JsonRpcResponse | null> => {
      return { jsonrpc: '2.0', id: msg.id!, result: { ok: true } };
    });

    await transport.start();
    port = transport.port;
  });

  afterAll(async () => {
    await transport.stop();
  });

  it('AUTH09: /rpc works without auth when not configured', async () => {
    const res = await httpRequest(port, '/rpc', {
      method: 'POST',
      body: { jsonrpc: '2.0', id: 1, method: 'ping' },
    });
    expect(res.status).toBe(200);
  });

  it('AUTH10: /health works without auth', async () => {
    const res = await httpRequest(port, '/health');
    expect(res.status).toBe(200);
  });
});
