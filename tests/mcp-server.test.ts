/**
 * Tests del modulo MCP Server.
 *
 * Valida el protocolo JSON-RPC 2.0, las 2 tools expuestas
 * (cli_help, cli_exec), y el manejo de errores.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '../src/mcp/server.js';
import type { JsonRpcRequest, JsonRpcResponse } from '../src/mcp/types.js';

// --- Mock Core ---
function createMockCore(overrides: Partial<{ help: Function; exec: Function }> = {}) {
  return {
    help: overrides.help || (() => 'Agent Shell - Protocolo de Interaccion\n...'),
    exec: overrides.exec || (async (cmd: string) => ({
      code: 0,
      data: { result: 'ok' },
      error: null,
      meta: { duration_ms: 5, command: cmd, mode: 'normal', timestamp: new Date().toISOString() },
    })),
  };
}

// Helper: simulates sending a JSON-RPC message and getting the response
// by calling the internal handler directly (bypasses stdio transport)
async function sendMessage(server: any, request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  return server.handleMessage(request);
}

/** Sends an initialize request to put the server into initialized state. */
async function initializeServer(server: any): Promise<void> {
  await sendMessage(server, {
    jsonrpc: '2.0',
    id: 'init',
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {} },
  });
}

describe('McpServer', () => {
  let core: ReturnType<typeof createMockCore>;
  let server: McpServer;

  beforeEach(async () => {
    core = createMockCore();
    server = new McpServer({ core, name: 'test-shell', version: '0.0.1' });
    await initializeServer(server);
  });

  describe('initialize', () => {
    it('T01: responde con protocolVersion, capabilities y serverInfo', async () => {
      const response = await sendMessage(server, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {} },
      });

      expect(response).not.toBeNull();
      expect(response!.jsonrpc).toBe('2.0');
      expect(response!.id).toBe(1);
      expect(response!.result.protocolVersion).toBe('2024-11-05');
      expect(response!.result.capabilities).toEqual({ tools: {} });
      expect(response!.result.serverInfo.name).toBe('test-shell');
      expect(response!.result.serverInfo.version).toBe('0.0.1');
    });
  });

  describe('tools/list', () => {
    it('T02: retorna exactamente 2 tools (cli_help y cli_exec)', async () => {
      const response = await sendMessage(server, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      });

      expect(response!.result.tools).toHaveLength(2);
      const names = response!.result.tools.map((t: any) => t.name);
      expect(names).toContain('cli_help');
      expect(names).toContain('cli_exec');
    });

    it('T03: cli_help no tiene parametros requeridos', async () => {
      const response = await sendMessage(server, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/list',
      });

      const helpTool = response!.result.tools.find((t: any) => t.name === 'cli_help');
      expect(helpTool.inputSchema.properties).toEqual({});
      expect(helpTool.inputSchema.required).toBeUndefined();
    });

    it('T04: cli_exec requiere parametro "command" de tipo string', async () => {
      const response = await sendMessage(server, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/list',
      });

      const execTool = response!.result.tools.find((t: any) => t.name === 'cli_exec');
      expect(execTool.inputSchema.properties.command.type).toBe('string');
      expect(execTool.inputSchema.required).toContain('command');
    });
  });

  describe('tools/call - cli_help', () => {
    it('T05: retorna el texto del protocolo de interaccion', async () => {
      const response = await sendMessage(server, {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'cli_help' },
      });

      expect(response!.result.content).toHaveLength(1);
      expect(response!.result.content[0].type).toBe('text');
      expect(response!.result.content[0].text).toContain('Agent Shell');
      expect(response!.result.isError).toBeUndefined();
    });

    it('T06: invoca core.help() internamente', async () => {
      const helpSpy = vi.fn(() => 'protocol text');
      const spyCore = createMockCore({ help: helpSpy });
      const spyServer = new McpServer({ core: spyCore });
      await initializeServer(spyServer);

      await sendMessage(spyServer, {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'cli_help' },
      });

      expect(helpSpy).toHaveBeenCalledOnce();
    });
  });

  describe('tools/call - cli_exec', () => {
    it('T07: ejecuta un comando y retorna resultado JSON', async () => {
      const response = await sendMessage(server, {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'cli_exec', arguments: { command: 'users:list' } },
      });

      expect(response!.result.content).toHaveLength(1);
      expect(response!.result.content[0].type).toBe('text');
      const parsed = JSON.parse(response!.result.content[0].text);
      expect(parsed.code).toBe(0);
      expect(parsed.data).toEqual({ result: 'ok' });
    });

    it('T08: pasa el comando a core.exec()', async () => {
      const execSpy = vi.fn(async () => ({ code: 0, data: null, error: null, meta: {} }));
      const spyCore = createMockCore({ exec: execSpy });
      const spyServer = new McpServer({ core: spyCore });
      await initializeServer(spyServer);

      await sendMessage(spyServer, {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: { name: 'cli_exec', arguments: { command: 'search crear usuario' } },
      });

      expect(execSpy).toHaveBeenCalledWith('search crear usuario');
    });

    it('T09: retorna isError=true cuando core responde con code != 0', async () => {
      const failCore = createMockCore({
        exec: async () => ({ code: 2, data: null, error: 'Not found', meta: {} }),
      });
      const failServer = new McpServer({ core: failCore });
      await initializeServer(failServer);

      const response = await sendMessage(failServer, {
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'cli_exec', arguments: { command: 'unknown:cmd' } },
      });

      expect(response!.result.isError).toBe(true);
    });

    it('T10: retorna error si falta el argumento "command"', async () => {
      const response = await sendMessage(server, {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'cli_exec', arguments: {} },
      });

      expect(response!.result.isError).toBe(true);
      expect(response!.result.content[0].text).toContain('command');
    });

    it('T11: retorna error si "command" no es string', async () => {
      const response = await sendMessage(server, {
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: { name: 'cli_exec', arguments: { command: 123 } },
      });

      expect(response!.result.isError).toBe(true);
    });

    it('T12: maneja excepciones del handler sin crashear', async () => {
      const throwCore = createMockCore({
        exec: async () => { throw new Error('unexpected failure'); },
      });
      const throwServer = new McpServer({ core: throwCore });
      await initializeServer(throwServer);

      const response = await sendMessage(throwServer, {
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: { name: 'cli_exec', arguments: { command: 'crash' } },
      });

      expect(response!.result.isError).toBe(true);
      expect(response!.result.content[0].text).toContain('unexpected failure');
    });
  });

  describe('Error handling', () => {
    it('T13: retorna METHOD_NOT_FOUND para metodos desconocidos', async () => {
      const response = await sendMessage(server, {
        jsonrpc: '2.0',
        id: 13,
        method: 'unknown/method',
      });

      expect(response!.error).toBeDefined();
      expect(response!.error!.code).toBe(-32601);
    });

    it('T14: retorna INVALID_PARAMS para tool desconocida', async () => {
      const response = await sendMessage(server, {
        jsonrpc: '2.0',
        id: 14,
        method: 'tools/call',
        params: { name: 'unknown_tool' },
      });

      expect(response!.error).toBeDefined();
      expect(response!.error!.code).toBe(-32602);
    });

    it('T15: retorna INVALID_PARAMS si falta el nombre del tool', async () => {
      const response = await sendMessage(server, {
        jsonrpc: '2.0',
        id: 15,
        method: 'tools/call',
        params: {},
      });

      expect(response!.error).toBeDefined();
      expect(response!.error!.code).toBe(-32602);
    });

    it('T15b: retorna INVALID_REQUEST si no se ha inicializado', async () => {
      const uninitServer = new McpServer({ core, name: 'test-shell', version: '0.0.1' });
      const response = await sendMessage(uninitServer, {
        jsonrpc: '2.0',
        id: 'uninit',
        method: 'tools/call',
        params: { name: 'cli_help' },
      });

      expect(response!.error).toBeDefined();
      expect(response!.error!.code).toBe(-32600);
    });

    it('T16: no retorna respuesta para notificaciones (sin id)', async () => {
      const response = await sendMessage(server, {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      });

      expect(response).toBeNull();
    });
  });

  describe('ping', () => {
    it('T17: responde a ping con objeto vacio', async () => {
      const response = await sendMessage(server, {
        jsonrpc: '2.0',
        id: 17,
        method: 'ping',
      });

      expect(response!.result).toEqual({});
    });
  });

  describe('StdioTransport protocol', () => {
    it('T18: respuestas siempre incluyen jsonrpc: "2.0"', async () => {
      const response = await sendMessage(server, {
        jsonrpc: '2.0',
        id: 18,
        method: 'initialize',
      });

      expect(response!.jsonrpc).toBe('2.0');
    });

    it('T19: respuestas preservan el id del request', async () => {
      const response = await sendMessage(server, {
        jsonrpc: '2.0',
        id: 'custom-id-abc',
        method: 'tools/list',
      });

      expect(response!.id).toBe('custom-id-abc');
    });

    it('T20: ids numericos se preservan como numeros', async () => {
      const response = await sendMessage(server, {
        jsonrpc: '2.0',
        id: 42,
        method: 'ping',
      });

      expect(response!.id).toBe(42);
    });
  });
});
