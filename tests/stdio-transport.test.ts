/**
 * Tests for src/mcp/transport.ts's StdioTransport — the actual stdio
 * front door of the MCP protocol (what `agent-shell serve` uses by
 * default). Previously untested: tests/mcp-server.test.ts's
 * "StdioTransport protocol" block calls McpServer.handleMessage()
 * directly, bypassing this class entirely — none of its own logic
 * (JSON-RPC error codes, newline-delimited buffering across stdin
 * `data` chunks) had any coverage.
 *
 * process.stdin/process.stdout are spied rather than piped into, so
 * these tests never touch the real stream: the 'data'/'end' listeners
 * StdioTransport registers via stdin.on() are captured and invoked
 * directly, and stdout.write() calls are captured instead of printed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StdioTransport } from '../src/mcp/transport.js';
import type { JsonRpcRequest, JsonRpcResponse } from '../src/mcp/types.js';

describe('StdioTransport', () => {
  let transport: StdioTransport;
  let dataListener: (chunk: string) => Promise<void>;
  let endListener: () => void;
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let stdinOnSpy: ReturnType<typeof vi.spyOn>;
  let stdinResumeSpy: ReturnType<typeof vi.spyOn>;
  let stdinPauseSpy: ReturnType<typeof vi.spyOn>;
  let stdinSetEncodingSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    transport = new StdioTransport();
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stdinSetEncodingSpy = vi.spyOn(process.stdin, 'setEncoding').mockImplementation(() => process.stdin as any);
    stdinResumeSpy = vi.spyOn(process.stdin, 'resume').mockImplementation(() => process.stdin as any);
    stdinPauseSpy = vi.spyOn(process.stdin, 'pause').mockImplementation(() => process.stdin as any);
    stdinOnSpy = vi.spyOn(process.stdin, 'on').mockImplementation(((event: string, listener: any) => {
      if (event === 'data') dataListener = listener;
      if (event === 'end') endListener = listener;
      return process.stdin;
    }) as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function sentMessages(): any[] {
    return writeSpy.mock.calls.map(([arg]) => JSON.parse((arg as string).trim()));
  }

  it('T01: parsea un mensaje JSON-RPC valido y delega al handler', async () => {
    const handler = vi.fn(async (req: JsonRpcRequest): Promise<JsonRpcResponse> => ({ jsonrpc: '2.0', id: req.id!, result: { ok: true } }));
    transport.onMessage(handler);
    transport.start();

    await dataListener('{"jsonrpc":"2.0","id":1,"method":"test"}\n');

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ method: 'test', id: 1 }));
    expect(sentMessages()).toEqual([{ jsonrpc: '2.0', id: 1, result: { ok: true } }]);
  });

  it('T02: JSON malformado responde -32700 sin llamar al handler', async () => {
    const handler = vi.fn();
    transport.onMessage(handler);
    transport.start();

    await dataListener('{not valid json\n');

    expect(handler).not.toHaveBeenCalled();
    const [msg] = sentMessages();
    expect(msg.error.code).toBe(-32700);
    expect(msg.id).toBeNull();
  });

  it('T03: falta method responde -32600', async () => {
    const handler = vi.fn();
    transport.onMessage(handler);
    transport.start();

    await dataListener('{"jsonrpc":"2.0","id":5}\n');

    expect(handler).not.toHaveBeenCalled();
    const [msg] = sentMessages();
    expect(msg.error.code).toBe(-32600);
    expect(msg.id).toBe(5);
  });

  it('T04: jsonrpc distinto de "2.0" responde -32600', async () => {
    const handler = vi.fn();
    transport.onMessage(handler);
    transport.start();

    await dataListener('{"jsonrpc":"1.0","id":1,"method":"x"}\n');

    expect(handler).not.toHaveBeenCalled();
    expect(sentMessages()[0].error.code).toBe(-32600);
  });

  /**
   * Regresion (ronda 59 del audit, HIGH): `JSON.parse('null')` no lanza
   * (null es JSON valido) — antes el `if (request.jsonrpc !== ...)` de
   * abajo hacia property-access sobre `null` y tiraba un TypeError
   * sincrono dentro de `onData -> processLine`, que nadie awaitea/catchea
   * (llamado fire-and-forget desde el listener 'data' de stdin). Sin
   * `process.on('unhandledRejection')` en el repo, esa excepcion tumbaba
   * el proceso MCP entero — una sola linea "null" por stdin lo mataba.
   * Mismo bug ya arreglado en http-transport.ts (ronda 101), ahora
   * replicado aca.
   */
  it('T04b: una linea "null" (JSON valido) no revienta el transporte, responde -32600', async () => {
    const handler = vi.fn();
    transport.onMessage(handler);
    transport.start();

    await expect(dataListener('null\n')).resolves.toBeUndefined();

    expect(handler).not.toHaveBeenCalled();
    const [msg] = sentMessages();
    expect(msg.error.code).toBe(-32600);
    expect(msg.id).toBeNull();
  });

  it('T04c: una linea con un JSON primitivo no-objeto (numero) tampoco revienta el transporte', async () => {
    const handler = vi.fn();
    transport.onMessage(handler);
    transport.start();

    await expect(dataListener('42\n')).resolves.toBeUndefined();

    expect(handler).not.toHaveBeenCalled();
    expect(sentMessages()[0].error.code).toBe(-32600);
  });

  /**
   * Regresion (ronda 76 del audit, MEDIUM): `buffer` crecia sin limite
   * mientras no llegara un '\n' — un caller que nunca termina una linea
   * (o simplemente ruido) hacia crecer memoria del proceso sin cota.
   */
  it('T04d: una linea sin newline que supera 10MB se descarta con -32600 en vez de crecer sin limite', async () => {
    const handler = vi.fn();
    transport.onMessage(handler);
    transport.start();

    const oversized = 'x'.repeat(10 * 1024 * 1024 + 1);
    await dataListener(oversized);

    expect(handler).not.toHaveBeenCalled();
    const [msg] = sentMessages();
    expect(msg.error.code).toBe(-32600);
    expect(msg.error.message).toContain('exceeds maximum size');

    // Buffer was reset — a subsequent, well-formed, SMALL message after the
    // oversized fragment is parsed normally (not treated as a continuation
    // of the discarded fragment).
    const handler2 = vi.fn(async (req: JsonRpcRequest): Promise<JsonRpcResponse> => ({ jsonrpc: '2.0', id: req.id!, result: 'ok' }));
    transport.onMessage(handler2);
    await dataListener('{"jsonrpc":"2.0","id":1,"method":"test"}\n');
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  it('T05: mensaje partido entre 2 chunks de stdin se reensambla correctamente', async () => {
    const handler = vi.fn(async (req: JsonRpcRequest): Promise<JsonRpcResponse> => ({ jsonrpc: '2.0', id: req.id!, result: 'ok' }));
    transport.onMessage(handler);
    transport.start();

    await dataListener('{"jsonrpc":"2.0","id":1,"met');
    expect(handler).not.toHaveBeenCalled();

    await dataListener('hod":"test"}\n');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ method: 'test' }));
  });

  it('T06: multiples mensajes newline-delimited en un solo chunk se procesan todos, en orden', async () => {
    const handler = vi.fn(async (req: JsonRpcRequest): Promise<JsonRpcResponse> => ({ jsonrpc: '2.0', id: req.id!, result: req.id }));
    transport.onMessage(handler);
    transport.start();

    await dataListener('{"jsonrpc":"2.0","id":1,"method":"a"}\n{"jsonrpc":"2.0","id":2,"method":"b"}\n');

    expect(handler).toHaveBeenCalledTimes(2);
    expect(sentMessages()).toEqual([
      { jsonrpc: '2.0', id: 1, result: 1 },
      { jsonrpc: '2.0', id: 2, result: 2 },
    ]);
  });

  it('T07: un chunk con un mensaje completo + una linea parcial conserva la parcial para el proximo evento', async () => {
    const handler = vi.fn(async (req: JsonRpcRequest): Promise<JsonRpcResponse> => ({ jsonrpc: '2.0', id: req.id!, result: 'ok' }));
    transport.onMessage(handler);
    transport.start();

    await dataListener('{"jsonrpc":"2.0","id":1,"method":"a"}\n{"jsonrpc":"2.0","id":2,"met');
    expect(handler).toHaveBeenCalledTimes(1);

    await dataListener('hod":"b"}\n');
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('T08: handler que retorna null (notification) no escribe respuesta', async () => {
    const handler = vi.fn(async () => null);
    transport.onMessage(handler);
    transport.start();

    await dataListener('{"jsonrpc":"2.0","method":"notify"}\n');

    expect(handler).toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('T09: lineas vacias/whitespace entre mensajes se ignoran', async () => {
    const handler = vi.fn(async (req: JsonRpcRequest): Promise<JsonRpcResponse> => ({ jsonrpc: '2.0', id: req.id!, result: 'ok' }));
    transport.onMessage(handler);
    transport.start();

    await dataListener('\n   \n{"jsonrpc":"2.0","id":1,"method":"a"}\n');

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("T10: start() registra listeners de stdin y llama resume(); stop() llama pause()", () => {
    transport.start();
    expect(stdinSetEncodingSpy).toHaveBeenCalledWith('utf-8');
    expect(stdinResumeSpy).toHaveBeenCalled();
    expect(stdinOnSpy).toHaveBeenCalledWith('data', expect.any(Function));
    expect(stdinOnSpy).toHaveBeenCalledWith('end', expect.any(Function));

    transport.stop();
    expect(stdinPauseSpy).toHaveBeenCalled();
  });

  it("T11: el evento 'end' de stdin detiene el transporte (pause)", () => {
    transport.start();
    endListener();
    expect(stdinPauseSpy).toHaveBeenCalled();
  });

  it('T12: start() es idempotente si ya esta corriendo (no re-registra listeners)', () => {
    transport.start();
    stdinOnSpy.mockClear();
    transport.start();
    expect(stdinOnSpy).not.toHaveBeenCalled();
  });

  it('T13: send() escribe el JSON-RPC response + newline por stdout', () => {
    transport.send({ jsonrpc: '2.0', id: 1, result: 'x' });
    expect(writeSpy).toHaveBeenCalledWith('{"jsonrpc":"2.0","id":1,"result":"x"}\n');
  });

  it('T14: notify() escribe una notificacion (sin id) por stdout', () => {
    transport.notify('progress', { pct: 50 });
    const written = writeSpy.mock.calls[0][0] as string;
    expect(JSON.parse(written.trim())).toEqual({ jsonrpc: '2.0', method: 'progress', params: { pct: 50 } });
  });

  it('T15: un mensaje entrante sin handler registrado no revienta ni escribe nada', async () => {
    transport.start();
    await expect(dataListener('{"jsonrpc":"2.0","id":1,"method":"x"}\n')).resolves.toBeUndefined();
    expect(writeSpy).not.toHaveBeenCalled();
  });
});
