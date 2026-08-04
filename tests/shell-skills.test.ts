/**
 * Tests for shell system skills: http, json, file, shell exec, env.
 *
 * Uses mocks for network, filesystem, and child_process to avoid
 * side effects in tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CommandRegistry } from '../src/command-registry/index.js';
import { httpCommands } from '../src/skills/shell-http.js';

// Mock node:dns/promises so SSRF validation tests can simulate DNS resolution
// without touching the network. Default resolves any hostname to a public IP.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));
import { lookup as dnsLookup } from 'node:dns/promises';

// doFetch() (shell-http.ts) calls undici's OWN `fetch` export, not the
// Node-global one — see doFetch()'s docstring: passing an undici Agent
// dispatcher to global fetch throws, since global fetch runs Node's
// separately-versioned internal copy of undici, which doesn't accept a
// Dispatcher from a different undici module instance. Proxying undici's
// `fetch` through to `globalThis.fetch` at call time (not import time)
// keeps every existing `globalThis.fetch = vi.fn(...)` test below working
// unchanged — Agent itself is left as the real implementation so a pinned
// request still gets a real, closeable Agent instance.
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    fetch: (...args: Parameters<typeof globalThis.fetch>) => (globalThis.fetch as any)(...args),
  };
});
import { jsonCommands } from '../src/skills/shell-json.js';
import { createFileCommands } from '../src/skills/shell-file.js';
import { createShellCommands } from '../src/skills/shell-exec.js';
import { envCommands } from '../src/skills/shell-env.js';
import { registerShellSkills } from '../src/skills/index.js';
import { createGitCommands } from '../src/skills/shell-git.js';
import { NativeShellAdapter } from '../src/just-bash/adapter.js';
import type { SkillEntry } from '../src/skills/scaffold.js';

// Create adapter-bound commands for testing
const nativeAdapter = new NativeShellAdapter();
const shellCommands = createShellCommands(nativeAdapter);
const fileCommands = createFileCommands(nativeAdapter);

function findHandler(entries: SkillEntry[], namespace: string, name: string): Function {
  const entry = entries.find(e => e.definition.namespace === namespace && e.definition.name === name);
  if (!entry) throw new Error(`Handler not found: ${namespace}:${name}`);
  return entry.handler;
}

// ===========================================================================
// JSON Skills (no mocks needed — pure logic)
// ===========================================================================

describe('JSON Skills', () => {

  it('JS01: json:filter applies jq expression to input', async () => {
    const handler = findHandler(jsonCommands, 'json', 'filter');
    const result = await handler({
      expression: '.name',
      input: { name: 'Alice', age: 30 },
    });

    expect(result.success).toBe(true);
    expect(result.data).toBe('Alice');
  });

  it('JS02: json:filter works with pipeline input', async () => {
    const handler = findHandler(jsonCommands, 'json', 'filter');
    const result = await handler(
      { expression: '.users' },
      { users: [1, 2, 3] }, // pipeline input
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual([1, 2, 3]);
  });

  it('JS03: json:filter returns error without input', async () => {
    const handler = findHandler(jsonCommands, 'json', 'filter');
    const result = await handler({ expression: '.name' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('No input data');
  });

  it('JS04: json:filter parses JSON string input', async () => {
    const handler = findHandler(jsonCommands, 'json', 'filter');
    const result = await handler({
      expression: '.x',
      input: '{"x": 42}',
    });

    expect(result.success).toBe(true);
    expect(result.data).toBe(42);
  });

  it('JS05: json:parse parses valid JSON', async () => {
    const handler = findHandler(jsonCommands, 'json', 'parse');
    const result = await handler({ text: '{"key": "value", "num": 123}' });

    expect(result.success).toBe(true);
    expect(result.data.key).toBe('value');
    expect(result.data.num).toBe(123);
  });

  it('JS06: json:parse returns error for invalid JSON', async () => {
    const handler = findHandler(jsonCommands, 'json', 'parse');
    const result = await handler({ text: 'not json {' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid JSON');
  });

  /**
   * Regresion (ronda 62 del audit, HIGH): a diferencia de json:filter
   * (cuyo --input es type:'json' y ya recibe un chequeo de profundidad
   * de Core/Executor's convertType, mas el propio limite de tamano de
   * applyFilter()'s validateInput()), json:parse no tenia NINGUNA
   * validacion sobre el resultado parseado. Un texto de apenas ~10KB con
   * anidamiento profundo (`[[[[...]]]]`) parseaba instantaneo, pero un
   * JSON.stringify() posterior (al serializar la RESPUESTA hacia el
   * caller, en la capa de transporte MCP) revienta con "RangeError:
   * Maximum call stack size exceeded", degradando a un "Internal error"
   * opaco — un DoS barato y repetible alcanzable con el permiso mas bajo
   * del modelo (json:read).
   */
  it('JS07: json:parse rechaza un resultado demasiado anidado para serializar de forma segura', async () => {
    const handler = findHandler(jsonCommands, 'json', 'parse');
    const deeplyNested = '['.repeat(5000) + ']'.repeat(5000);
    const result = await handler({ text: deeplyNested });

    expect(result.success).toBe(false);
    expect(result.error).toContain('too deeply nested');
  });

  it('JS08: json:parse sigue aceptando JSON normal, no anidado, sin falsos positivos', async () => {
    const handler = findHandler(jsonCommands, 'json', 'parse');
    const result = await handler({ text: '{"users":[{"name":"Alice"},{"name":"Bob"}],"count":2}' });

    expect(result.success).toBe(true);
    expect(result.data.count).toBe(2);
  });

  /**
   * Regresion (ronda 69 del audit, HIGH): applyFilter()'s propio
   * validateInput() ya limitaba el tamano a MAX_INPUT_SIZE_BYTES, pero
   * recien DESPUES de que JSON.parse(data) ya pagara el costo completo de
   * parsear (y, dentro de validateInput(), un JSON.stringify() adicional
   * para medir el tamano). Un payload plano grande (sin necesitar
   * anidamiento, asi que el chequeo de profundidad de Core/convertType
   * tampoco lo agarraba) pagaba ese costo antes de ser rechazado — peor
   * aun via pipeline, que nunca pasa por Core.convertType en absoluto.
   */
  it('JS09: json:filter rechaza un --input string que excede el cap de tamano ANTES de parsearlo', async () => {
    const handler = findHandler(jsonCommands, 'json', 'filter');
    const oversized = '"' + 'a'.repeat(10 * 1024 * 1024 + 1) + '"';
    const result = await handler({ expression: '.', input: oversized });

    expect(result.success).toBe(false);
    expect(result.error).toContain('exceeds maximum size');
  });

  it('JS10: json:filter rechaza un input de PIPELINE (string) que excede el cap, no solo --input', async () => {
    const handler = findHandler(jsonCommands, 'json', 'filter');
    const oversized = '"' + 'a'.repeat(10 * 1024 * 1024 + 1) + '"';
    const result = await handler({ expression: '.' }, oversized);

    expect(result.success).toBe(false);
    expect(result.error).toContain('exceeds maximum size');
  });

  it('JS11: json:filter sigue funcionando normalmente con --input string chico', async () => {
    const handler = findHandler(jsonCommands, 'json', 'filter');
    const result = await handler({ expression: '.x', input: '{"x": 42}' });

    expect(result.success).toBe(true);
    expect(result.data).toBe(42);
  });
});

// ===========================================================================
// HTTP Skills (mock fetch)
// ===========================================================================

describe('HTTP Skills', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn(async (url: string, opts?: any) => ({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ url, method: opts?.method || 'GET' }),
      text: async () => JSON.stringify({ url, method: opts?.method || 'GET' }),
    })) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // Default: DNS resolves any hostname to a public IP (fail-open preserved for
  // the existing HT01-HT04 tests, which use fictional hostnames + mocked fetch).
  beforeEach(() => {
    vi.mocked(dnsLookup).mockReset();
    vi.mocked(dnsLookup).mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
    ] as any);
  });

  it('HT01: http:get calls fetch with GET', async () => {
    const handler = findHandler(httpCommands, 'http', 'get');
    const result = await handler({ url: 'https://api.test.com/data' });

    expect(result.success).toBe(true);
    expect(result.data.status).toBe(200);
    expect(result.data.body.method).toBe('GET');
  });

  it('HT02: http:post calls fetch with POST', async () => {
    const handler = findHandler(httpCommands, 'http', 'post');
    const result = await handler({ url: 'https://api.test.com/data', body: { name: 'test' } });

    expect(result.success).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalled();
    const callArgs = (globalThis.fetch as any).mock.calls[0];
    expect(callArgs[1].method).toBe('POST');
  });

  it('HT03: http:request supports custom method', async () => {
    const handler = findHandler(httpCommands, 'http', 'request');
    const result = await handler({ url: 'https://api.test.com/data/1', method: 'DELETE' });

    expect(result.success).toBe(true);
    const callArgs = (globalThis.fetch as any).mock.calls[0];
    expect(callArgs[1].method).toBe('DELETE');
  });

  it('HT04: http:get handles fetch failure gracefully', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('Network error'); }) as any;

    const handler = findHandler(httpCommands, 'http', 'get');
    const result = await handler({ url: 'https://unreachable.com' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Network error');
  });

  // -------------------------------------------------------------------------
  // SSRF protection tests (HT05+) — blocking is unconditional.
  // -------------------------------------------------------------------------

  it('HT05: blocks non-http/https scheme (ftp)', async () => {
    const handler = findHandler(httpCommands, 'http', 'get');
    const result = await handler({ url: 'ftp://example.com/file' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('ftp:');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('HT06: blocks literal cloud metadata IP (169.254.169.254) without fetch', async () => {
    const handler = findHandler(httpCommands, 'http', 'get');
    const result = await handler({ url: 'http://169.254.169.254/latest/meta-data/' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Blocked');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('HT07: blocks literal loopback IP (127.0.0.1)', async () => {
    const handler = findHandler(httpCommands, 'http', 'get');
    const result = await handler({ url: 'http://127.0.0.1:6379/' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Blocked');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  /**
   * Regresion (ronda 68 del audit, CRITICAL): isBlockedIpv6Bytes() solo
   * bloqueaba ::1 (chequeando el ultimo byte === 1) — la direccion
   * "unspecified" :: (los 16 bytes en cero) nunca se chequeaba, pese a
   * rutear a servicios en loopback en la practica (verificado con un
   * socket real durante el audit).
   */
  it('HT07c: blocks the IPv6 unspecified address (::)', async () => {
    const handler = findHandler(httpCommands, 'http', 'get');
    const result = await handler({ url: 'http://[::]/' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Blocked');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  /**
   * Regresion (ronda 68 del audit, CRITICAL): isBlockedIpv6Bytes() solo
   * desenvolvia la forma IPv4-mapped moderna (::ffff:a.b.c.d, bytes 10-11 =
   * 0xffff) — la forma IPv4-compatible obsoleta (::a.b.c.d, bytes 10-11 =
   * 0x0000, RFC 4291 §2.5.5.1) pasaba sin chequear. El parser WHATWG URL
   * normaliza esta forma a notacion hex pura (::a9fe:a9fe para
   * ::169.254.169.254 = el endpoint de metadata cloud) antes de llegar a
   * este codigo, asi que el bypass no depende de notacion punteada.
   */
  it('HT07d: blocks the IPv6 IPv4-compatible form of the cloud metadata IP (::a9fe:a9fe = ::169.254.169.254)', async () => {
    const handler = findHandler(httpCommands, 'http', 'get');
    const result = await handler({ url: 'http://[::a9fe:a9fe]/' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Blocked');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('HT08: blocks when DNS resolves hostname to a private IP', async () => {
    vi.mocked(dnsLookup).mockResolvedValue([
      { address: '169.254.169.254', family: 4 },
    ] as any);

    const handler = findHandler(httpCommands, 'http', 'get');
    const result = await handler({ url: 'http://internal.evil.example/' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Blocked');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(dnsLookup).toHaveBeenCalledWith('internal.evil.example', { all: true });
  });

  it('HT09: allows request when DNS resolves hostname to a public IP', async () => {
    vi.mocked(dnsLookup).mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
    ] as any);

    const handler = findHandler(httpCommands, 'http', 'get');
    const result = await handler({ url: 'http://public.test.example/' });

    expect(result.success).toBe(true);
    expect(result.data.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalled();
  });

  it('HT10: fail-open when DNS does not resolve (ENOTFOUND) -> still reaches fetch', async () => {
    const dnsErr: NodeJS.ErrnoException = new Error('getaddrinfo ENOTFOUND fail.test.example');
    dnsErr.code = 'ENOTFOUND';
    vi.mocked(dnsLookup).mockRejectedValue(dnsErr);

    const handler = findHandler(httpCommands, 'http', 'get');
    const result = await handler({ url: 'http://fail.test.example/' });

    expect(result.success).toBe(true);
    expect(result.data.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalled();
  });

  /**
   * Regresion: assertUrlSafe() validaba la resolucion DNS pero la descartaba
   * — fetch() hacia su PROPIA resolucion DNS independiente unos milisegundos
   * despues, y un atacante controlando el DNS del hostname podia devolver
   * una IP publica para la validacion y una privada (ej. 169.254.169.254)
   * para la conexion real de fetch (DNS-rebinding TOCTOU). doFetch() ahora
   * pinea la conexion a la MISMA IP que assertUrlSafe() ya valido, via un
   * dispatcher (undici Agent) con connect.lookup fijo — nunca deja que
   * fetch resuelva DNS de nuevo por su cuenta.
   */
  it('HT09b: request a un hostname resuelto por DNS pinea la conexion (pasa un dispatcher a fetch)', async () => {
    vi.mocked(dnsLookup).mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
    ] as any);

    const handler = findHandler(httpCommands, 'http', 'get');
    await handler({ url: 'http://public.test.example/' });

    const fetchMock = globalThis.fetch as any;
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.dispatcher).toBeDefined();
    // El dispatcher pineado se cierra despues de usarlo (no queda colgado).
    expect(typeof opts.dispatcher.close).toBe('function');
  });

  it('HT07b: request a una IP literal no pinea (no hay nada que resolver — la IP YA es el destino)', async () => {
    const handler = findHandler(httpCommands, 'http', 'get');
    await handler({ url: 'http://93.184.216.34/' });

    const fetchMock = globalThis.fetch as any;
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.dispatcher).toBeUndefined();
  });

  it('HT10b: fail-open (DNS no resuelve) tampoco pinea — fetch resuelve DNS por su cuenta, sin dispatcher', async () => {
    const dnsErr: NodeJS.ErrnoException = new Error('getaddrinfo ENOTFOUND fail.test.example');
    dnsErr.code = 'ENOTFOUND';
    vi.mocked(dnsLookup).mockRejectedValue(dnsErr);

    const handler = findHandler(httpCommands, 'http', 'get');
    await handler({ url: 'http://fail.test.example/' });

    const fetchMock = globalThis.fetch as any;
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.dispatcher).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Redirect SSRF protection tests (HT11+) — a redirect target bypasses
  // assertUrlSafe() unless each hop is re-validated before being followed.
  // -------------------------------------------------------------------------

  it('HT11: blocks a redirect to a private/internal address', async () => {
    globalThis.fetch = vi.fn(async () => ({
      status: 302,
      headers: new Headers({ location: 'http://169.254.169.254/latest/meta-data/' }),
      json: async () => ({}),
      text: async () => '',
    })) as any;

    const handler = findHandler(httpCommands, 'http', 'get');
    const result = await handler({ url: 'https://external.example.com/redirect-me' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Blocked');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('HT12: follows a redirect to a safe address and re-validates it', async () => {
    let call = 0;
    globalThis.fetch = vi.fn(async (url: string) => {
      call++;
      if (call === 1) {
        return {
          status: 302,
          headers: new Headers({ location: 'https://safe.example.com/final' }),
          json: async () => ({}),
          text: async () => '',
        };
      }
      return {
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ url }),
        text: async () => JSON.stringify({ url }),
      };
    }) as any;

    const handler = findHandler(httpCommands, 'http', 'get');
    const result = await handler({ url: 'https://external.example.com/redirect-me' });

    expect(result.success).toBe(true);
    expect(result.data.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect((globalThis.fetch as any).mock.calls[1][0]).toBe('https://safe.example.com/final');
  });

  it('HT13: blocks a redirect chain exceeding the max hop count', async () => {
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      call++;
      return {
        status: 302,
        headers: new Headers({ location: `https://external.example.com/hop-${call}` }),
        json: async () => ({}),
        text: async () => '',
      };
    }) as any;

    const handler = findHandler(httpCommands, 'http', 'get');
    const result = await handler({ url: 'https://external.example.com/redirect-me' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('too many redirects');
  });

  it('HT14: blocks a redirect response with no Location header', async () => {
    globalThis.fetch = vi.fn(async () => ({
      status: 302,
      headers: new Headers({}),
      json: async () => ({}),
      text: async () => '',
    })) as any;

    const handler = findHandler(httpCommands, 'http', 'get');
    const result = await handler({ url: 'https://external.example.com/redirect-me' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Location');
  });

  it('HT15: 303 downgrades a POST redirect to GET with no body', async () => {
    let call = 0;
    globalThis.fetch = vi.fn(async (_url: string, opts?: any) => {
      call++;
      if (call === 1) {
        expect(opts.method).toBe('POST');
        return {
          status: 303,
          headers: new Headers({ location: 'https://safe.example.com/result' }),
          json: async () => ({}),
          text: async () => '',
        };
      }
      expect(opts.method).toBe('GET');
      expect(opts.body).toBeUndefined();
      return {
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ ok: true }),
        text: async () => JSON.stringify({ ok: true }),
      };
    }) as any;

    const handler = findHandler(httpCommands, 'http', 'post');
    const result = await handler({ url: 'https://external.example.com/submit', body: { name: 'test' } });

    expect(result.success).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Ronda 48 del audit: response size cap, cross-origin redirect header
  // stripping, AbortSignal wiring, and the broken JSON-parse fallback.
  // -------------------------------------------------------------------------

  /**
   * Regresion (ronda 48 del audit, HIGH #2): baseHeaders se reusaba sin
   * cambios en CADA hop de un redirect, sin importar si el origin cambiaba
   * — un caller pasando --headers '{"Authorization":"Bearer <secreto>"}'
   * a una URL confiable que luego 302-eaba a un origin distinto (atacante)
   * reenviaba el header verbatim. stripSensitiveHeadersForRedirect() ahora
   * lo saca cuando el origin del siguiente hop difiere del actual.
   */
  it('HT16: no reenvia Authorization a un redirect cross-origin', async () => {
    let call = 0;
    globalThis.fetch = vi.fn(async (_url: string, opts?: any) => {
      call++;
      if (call === 1) {
        expect(opts.headers.Authorization).toBe('Bearer secret-token');
        return {
          status: 302,
          headers: new Headers({ location: 'https://attacker.example.com/collect' }),
          json: async () => ({}),
          text: async () => '',
        };
      }
      expect(opts.headers.Authorization).toBeUndefined();
      return {
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ ok: true }),
        text: async () => JSON.stringify({ ok: true }),
      };
    }) as any;

    const handler = findHandler(httpCommands, 'http', 'get');
    const result = await handler({ url: 'https://trusted.example.com/x', headers: { Authorization: 'Bearer secret-token' } });

    expect(result.success).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('HT17: SI mantiene Authorization en un redirect same-origin (no over-stripea)', async () => {
    let call = 0;
    globalThis.fetch = vi.fn(async (_url: string, opts?: any) => {
      call++;
      if (call === 1) {
        return {
          status: 302,
          headers: new Headers({ location: 'https://trusted.example.com/y' }),
          json: async () => ({}),
          text: async () => '',
        };
      }
      expect(opts.headers.Authorization).toBe('Bearer secret-token');
      return {
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ ok: true }),
        text: async () => JSON.stringify({ ok: true }),
      };
    }) as any;

    const handler = findHandler(httpCommands, 'http', 'get');
    const result = await handler({ url: 'https://trusted.example.com/x', headers: { Authorization: 'Bearer secret-token' } });

    expect(result.success).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  /**
   * Regresion (ronda 48 del audit, HIGH #1): no habia ningun cap de tamano
   * en la respuesta bufferizada — a diferencia del guard inbound de
   * http-transport.ts (maxBodySize). Este mock simula un body en streaming
   * real (via getReader(), como el Response real de undici) para ejercitar
   * el loop de lectura con cap, no el fallback de res.text() que usan los
   * demas mocks de este archivo.
   */
  it('HT18: rechaza una respuesta que excede el tamano maximo en vez de bufferizarla sin limite', async () => {
    const bigChunk = new Uint8Array(6 * 1024 * 1024); // 6MB por chunk
    let reads = 0;
    globalThis.fetch = vi.fn(async () => ({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: {
        getReader: () => ({
          read: async () => {
            reads++;
            if (reads > 2) return { done: true, value: undefined };
            return { done: false, value: bigChunk }; // 2 chunks = 12MB > cap de 10MB
          },
          cancel: async () => {},
        }),
      },
    })) as any;

    const handler = findHandler(httpCommands, 'http', 'get');
    const result = await handler({ url: 'https://api.test.com/huge' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('exceeds maximum size');
  });

  /**
   * Regresion (ronda 48 del audit, MEDIUM #6): res.json() consume el body
   * stream; cuando fallaba por JSON invalido, el fallback `await res.text()`
   * tiraba "Body is unusable: Body has already been read" en vez de
   * devolver el texto real. Leer el texto UNA sola vez y despues intentar
   * JSON.parse sobre esa copia en memoria elimina el doble-consumo.
   */
  it('HT19: un body con content-type json pero JSON invalido devuelve el texto crudo, no tira error', async () => {
    globalThis.fetch = vi.fn(async () => ({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => 'not valid json{',
    })) as any;

    const handler = findHandler(httpCommands, 'http', 'get');
    const result = await handler({ url: 'https://api.test.com/bad-json' });

    expect(result.success).toBe(true);
    expect(result.data.body).toBe('not valid json{');
  });

  /**
   * Regresion (ronda 48 del audit, #4): ningun handler leia el 3er
   * argumento ({sessionId, signal}) que Core.invokeHandler() inyecta para
   * cancelacion cooperativa — el AbortSignal se perdia en silencio, asi
   * que el timeout de Core no cancelaba el fetch real en curso.
   */
  it('HT20: reenvia el AbortSignal de Core al fetch subyacente', async () => {
    const handler = findHandler(httpCommands, 'http', 'get');
    const controller = new AbortController();
    await handler({ url: 'https://api.test.com/data' }, null, { signal: controller.signal });

    const fetchMock = globalThis.fetch as any;
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.signal).toBe(controller.signal);
  });
});

// ===========================================================================
// Env Skills (uses real process.env, safe to test)
// ===========================================================================

describe('Env Skills', () => {

  it('EV01: env:get returns existing variable', async () => {
    process.env.TEST_SHELL_VAR = 'hello123';
    const handler = findHandler(envCommands, 'env', 'get');
    const result = await handler({ name: 'TEST_SHELL_VAR' });

    expect(result.success).toBe(true);
    expect(result.data.value).toBe('hello123');
    expect(result.data.exists).toBe(true);
    delete process.env.TEST_SHELL_VAR;
  });

  it('EV02: env:get returns exists=false for missing variable', async () => {
    const handler = findHandler(envCommands, 'env', 'get');
    const result = await handler({ name: 'NONEXISTENT_VAR_XYZ' });

    expect(result.success).toBe(true);
    expect(result.data.exists).toBe(false);
  });

  it('EV03: env:get masks sensitive variables', async () => {
    process.env.MY_SECRET_TOKEN = 'super-secret-123';
    const handler = findHandler(envCommands, 'env', 'get');
    const result = await handler({ name: 'MY_SECRET_TOKEN' });

    expect(result.success).toBe(true);
    expect(result.data.value).toBe('***MASKED***');
    expect(result.data.exists).toBe(true);
    delete process.env.MY_SECRET_TOKEN;
  });

  it('EV04: env:list filters by prefix', async () => {
    process.env.ASHELL_TEST_A = '1';
    process.env.ASHELL_TEST_B = '2';
    const handler = findHandler(envCommands, 'env', 'list');
    const result = await handler({ prefix: 'ASHELL_TEST_' });

    expect(result.success).toBe(true);
    expect(result.data.count).toBe(2);
    expect(result.data.variables.ASHELL_TEST_A).toBe('1');
    delete process.env.ASHELL_TEST_A;
    delete process.env.ASHELL_TEST_B;
  });

  it('EV05: env:list masks sensitive keys', async () => {
    process.env.ASHELL_API_KEY = 'secret';
    process.env.ASHELL_NORMAL = 'visible';
    const handler = findHandler(envCommands, 'env', 'list');
    const result = await handler({ prefix: 'ASHELL_' });

    expect(result.data.variables.ASHELL_API_KEY).toBe('***MASKED***');
    expect(result.data.variables.ASHELL_NORMAL).toBe('visible');
    delete process.env.ASHELL_API_KEY;
    delete process.env.ASHELL_NORMAL;
  });

  /**
   * Regresion: el enmascarado solo miraba el NOMBRE de la variable. Una
   * variable con nombre "inocente" (DATABASE_URL, SENTRY_DSN) pero con una
   * credencial embebida en el VALOR (user:pass@host, DSN con key@host) se
   * devolvia en texto plano.
   */
  it('EV06: env:get enmascara por CONTENIDO aunque el nombre sea inocente', async () => {
    process.env.ASHELL_DATABASE_URL = 'postgres://admin:hunter2@db.internal:5432/prod';
    const handler = findHandler(envCommands, 'env', 'get');
    const result = await handler({ name: 'ASHELL_DATABASE_URL' });

    expect(result.data.value).toBe('***MASKED***');
    delete process.env.ASHELL_DATABASE_URL;
  });

  it('EV07: env:list enmascara por contenido y deja pasar valores inocentes', async () => {
    process.env.ASHELL_SENTRY_DSN = 'https://abc123key@o12345.ingest.sentry.io/6789';
    process.env.ASHELL_NODE_ENV = 'production';
    const handler = findHandler(envCommands, 'env', 'list');
    const result = await handler({ prefix: 'ASHELL_' });

    expect(result.data.variables.ASHELL_SENTRY_DSN).toBe('***MASKED***');
    expect(result.data.variables.ASHELL_NODE_ENV).toBe('production');
    delete process.env.ASHELL_SENTRY_DSN;
    delete process.env.ASHELL_NODE_ENV;
  });
});

// ===========================================================================
// Shell Exec Skills (mock execSync)
// ===========================================================================

describe('Shell Exec Skills', () => {

  it('SH01: shell:which finds a common program', async () => {
    const handler = findHandler(shellCommands, 'shell', 'which');
    // 'node' should exist in any test environment
    const result = await handler({ program: 'node' });

    expect(result.success).toBe(true);
    expect(result.data.found).toBe(true);
    expect(result.data.program).toBe('node');
  });

  it('SH02: shell:which returns found=false for missing program', async () => {
    const handler = findHandler(shellCommands, 'shell', 'which');
    const result = await handler({ program: 'nonexistent-program-xyz-12345' });

    expect(result.success).toBe(true);
    expect(result.data.found).toBe(false);
  });

  it('SH03: shell:exec runs a simple command', async () => {
    const handler = findHandler(shellCommands, 'shell', 'exec');
    const result = await handler({ command: 'echo hello' });

    expect(result.success).toBe(true);
    expect(result.data.stdout).toContain('hello');
    expect(result.data.exitCode).toBe(0);
  });

  it('SH04: shell:exec captures exit code on failure', async () => {
    const handler = findHandler(shellCommands, 'shell', 'exec');
    const result = await handler({ command: 'exit 1', timeout: 5000 });

    expect(result.success).toBe(true); // command ran, even if failed
    expect(result.data.exitCode).not.toBe(0);
  });
});

/**
 * Regresion (ronda 26 del audit): a diferencia de file:*, git:*, workspace:*,
 * process:*, y cron:*, createShellCommands() no aceptaba jailRoot en absoluto
 * — shell:exec's --cwd (y por lo tanto de-facto process.cwd() del comando)
 * nunca se validaba pese a que jailRoot estuviera configurado. Esta
 * contencion es necesariamente parcial (el comando en si puede `cd` a
 * cualquier lado): acota el default/caso accidental, no sandboxea el
 * comando — mismo alcance que process:spawn/cron:schedule ya tienen para
 * su propio --cwd.
 */
describe('Shell Exec Jail (opt-in path containment)', () => {
  let jailDir: string;
  let outsideDir: string;
  let jailed: SkillEntry[];

  beforeEach(() => {
    // realpathSync: on Windows, tmpdir() can return an 8.3 short-name path
    // (e.g. ADMINI~1) that's really an alias for the canonical long-name
    // directory — createPathJail's symlink-resolution (ronda 36 del audit)
    // now canonicalizes this the same way it would a real symlink, so tests
    // comparing against jailDir need the same canonical form.
    jailDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'shelljail-')));
    outsideDir = mkdtempSync(join(tmpdir(), 'shelljail-outside-'));
    jailed = createShellCommands(nativeAdapter, jailDir);
  });

  afterEach(() => {
    rmSync(jailDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it('SHJ01: --cwd inside the jail works normally', async () => {
    const handler = findHandler(jailed, 'shell', 'exec');
    const res = await handler({ command: 'echo hi', cwd: jailDir });
    expect(res.success).toBe(true);
  });

  it('SHJ02: --cwd pointing outside the jail is blocked', async () => {
    const handler = findHandler(jailed, 'shell', 'exec');
    const res = await handler({ command: 'echo hi', cwd: outsideDir });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/jail|outside/i);
  });

  it('SHJ03: no --cwd defaults inside the jail, not process.cwd()', async () => {
    // Uses node's own process.cwd() rather than a shell builtin (pwd/cd):
    // exec's underlying spawn runs via the OS default shell (cmd.exe on
    // native Windows, not a POSIX shell) — same reasoning as PJ03 in
    // infra-complete.test.ts.
    const handler = findHandler(jailed, 'shell', 'exec');
    const res = await handler({ command: 'node -e "console.log(process.cwd())"' });
    expect(res.success).toBe(true);
    expect(res.data.stdout.trim().toLowerCase()).toBe(jailDir.toLowerCase());
  });

  it('SHJ04: without jailRoot, --cwd is unrestricted (legacy shellCommands export)', async () => {
    const handler = findHandler(shellCommands, 'shell', 'exec');
    const res = await handler({ command: 'echo hi', cwd: outsideDir });
    expect(res.success).toBe(true);
  });
});

// ===========================================================================
// File Skills (test with temp directory)
// ===========================================================================

import { mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('File Skills', () => {

  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ashell-test-'));
    writeFileSync(join(tempDir, 'test.txt'), 'hello world');
    writeFileSync(join(tempDir, 'data.json'), '{"key":"value"}');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('FL01: file:read returns file content', async () => {
    const handler = findHandler(fileCommands, 'file', 'read');
    const result = await handler({ path: join(tempDir, 'test.txt') });

    expect(result.success).toBe(true);
    expect(result.data.content).toBe('hello world');
    expect(result.data.size).toBeGreaterThan(0);
  });

  it('FL02: file:read returns error for missing file', async () => {
    const handler = findHandler(fileCommands, 'file', 'read');
    const result = await handler({ path: join(tempDir, 'missing.txt') });

    expect(result.success).toBe(false);
    expect(result.error).toContain('file:read failed');
  });

  it('FL03: file:write creates a file', async () => {
    const handler = findHandler(fileCommands, 'file', 'write');
    const path = join(tempDir, 'output.txt');
    const result = await handler({ path, content: 'written content' });

    expect(result.success).toBe(true);
    expect(result.data.written).toBe(true);

    // Verify file was actually written
    expect(readFileSync(path, 'utf-8')).toBe('written content');
  });

  it('FL04: file:list returns directory entries', async () => {
    const handler = findHandler(fileCommands, 'file', 'list');
    const result = await handler({ path: tempDir });

    expect(result.success).toBe(true);
    expect(result.data.count).toBe(2);
    const names = result.data.entries.map((e: any) => e.name);
    expect(names).toContain('test.txt');
    expect(names).toContain('data.json');
  });

  it('FL05: file:list filters by pattern', async () => {
    const handler = findHandler(fileCommands, 'file', 'list');
    const result = await handler({ path: tempDir, pattern: '.json' });

    expect(result.success).toBe(true);
    expect(result.data.count).toBe(1);
    expect(result.data.entries[0].name).toBe('data.json');
  });
});

// ===========================================================================
// Integration: Registration
// ===========================================================================

describe('Shell Skills Registration', () => {

  it('INT01: registerShellSkills registers 18 commands', () => {
    const registry = new CommandRegistry();
    registerShellSkills(registry);

    const all = registry.listAll();
    expect(all).toHaveLength(40);
  });

  it('INT02: all shell skill definitions have requiredPermissions', () => {
    const allSkills = [...httpCommands, ...jsonCommands, ...fileCommands, ...shellCommands, ...envCommands];

    for (const { definition } of allSkills) {
      expect(definition.requiredPermissions).toBeDefined();
      expect(definition.requiredPermissions!.length).toBeGreaterThan(0);
    }
  });

  it('INT03: shell skills span 5 namespaces', () => {
    const registry = new CommandRegistry();
    registerShellSkills(registry);

    const namespaces = registry.getNamespaces();
    expect(namespaces).toContain('http');
    expect(namespaces).toContain('json');
    expect(namespaces).toContain('file');
    expect(namespaces).toContain('shell');
    expect(namespaces).toContain('env');
  });

  /**
   * Regresion: registerShellSkills() no tenia forma de recibir un jailRoot
   * y reenviarlo a createFileCommands/createGitCommands/createWorkspaceCommands
   * — cli/index.ts y server/index.ts (los unicos llamadores reales) nunca
   * podian activar la contencion agregada en la sesion previa. Verifica que
   * un jailRoot pasado a registerShellSkills() efectivamente llega hasta
   * el handler de file:read.
   */
  it('INT04: registerShellSkills reenvia jailRoot a file:read', async () => {
    const registry = new CommandRegistry();
    registerShellSkills(registry, nativeAdapter, 'C:/jail-root');

    const resolved = registry.get('file', 'read');
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const result = await resolved.value.handler({ path: 'C:/outside-jail/secret.txt' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('resolves outside jail root');
  });
});

/**
 * Regresion (ronda 20 del audit): file:delete era el UNICO comando
 * tageado requiresConfirmation. Auditoria completa de los 49 comandos
 * registrados encontro 4 mas con el mismo blast radius (sobreescritura
 * sin undo o efecto real fuera del sandbox) sin gatear. Este test fija
 * la politica para que una regresion futura (alguien construye un nuevo
 * comando de definicion sin copiar el flag) se detecte aca, no en
 * produccion.
 */
describe('requiresConfirmation tagging on dangerous commands', () => {
  it('DG01: file:delete y file:rename requieren confirmacion', () => {
    const fileCmds = createFileCommands(nativeAdapter);
    const deleteDef = fileCmds.find(c => c.definition.name === 'delete')!.definition;
    const renameDef = fileCmds.find(c => c.definition.name === 'rename')!.definition;
    expect(deleteDef.requiresConfirmation).toBe(true);
    expect(renameDef.requiresConfirmation).toBe(true);
  });

  /**
   * Regresion (ronda 21 del audit): file:rename tenia el mismo blast radius
   * que file:delete (rename() sobreescribe el destino sin undo si ya
   * existe), pero solo exigia file:write, no file:delete.
   */
  it('DG01b: file:rename exige tambien file:delete, no solo file:write', () => {
    const fileCmds = createFileCommands(nativeAdapter);
    const renameDef = fileCmds.find(c => c.definition.name === 'rename')!.definition;
    expect(renameDef.requiredPermissions).toEqual(expect.arrayContaining(['file:write', 'file:delete']));
  });

  it('DG02: http:post y http:request requieren confirmacion, http:get no', () => {
    const postDef = httpCommands.find(c => c.definition.name === 'post')!.definition;
    const requestDef = httpCommands.find(c => c.definition.name === 'request')!.definition;
    const getDef = httpCommands.find(c => c.definition.name === 'get')!.definition;
    expect(postDef.requiresConfirmation).toBe(true);
    expect(requestDef.requiresConfirmation).toBe(true);
    expect(getDef.requiresConfirmation).toBe(false);
  });

  it('DG03: git:push requiere confirmacion, git:pull/commit no', () => {
    const gitCmds = createGitCommands();
    const pushDef = gitCmds.find(c => c.definition.name === 'push')!.definition;
    const pullDef = gitCmds.find(c => c.definition.name === 'pull')!.definition;
    const commitDef = gitCmds.find(c => c.definition.name === 'commit')!.definition;
    expect(pushDef.requiresConfirmation).toBe(true);
    expect(pullDef.requiresConfirmation).toBe(false);
    expect(commitDef.requiresConfirmation).toBe(false);
  });
});
