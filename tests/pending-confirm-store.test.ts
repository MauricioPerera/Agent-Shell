/**
 * Tests para PendingConfirmStore (src/shared/pending-confirm-store.ts).
 *
 * Extraido de la logica de tokens de confirmacion que Core y Executor
 * tenian duplicada a mano — estos tests cubren el primitivo compartido
 * de forma aislada, independiente de como cada engine lo use.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { PendingConfirmStore } from '../src/shared/pending-confirm-store.js';

describe('PendingConfirmStore', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('T01: create() genera un token distinto por cada llamada', () => {
    const store = new PendingConfirmStore<string>(60_000);
    const a = store.create('payload-a');
    const b = store.create('payload-b');

    expect(a).not.toBe(b);
    expect(store.size).toBe(2);
  });

  it('T02: resolve() de un token existente retorna ok + el payload guardado', () => {
    const store = new PendingConfirmStore<{ x: number }>(60_000);
    const token = store.create({ x: 42 });

    const result = store.resolve(token);
    expect(result).toEqual({ status: 'ok', payload: { x: 42 } });
  });

  it('T03: resolve() consume el token — una segunda resolucion retorna not_found', () => {
    const store = new PendingConfirmStore<string>(60_000);
    const token = store.create('once');

    store.resolve(token);
    const second = store.resolve(token);

    expect(second).toEqual({ status: 'not_found' });
  });

  it('T04: resolve() de un token que nunca existio retorna not_found', () => {
    const store = new PendingConfirmStore<string>(60_000);
    const result = store.resolve('never-existed');

    expect(result).toEqual({ status: 'not_found' });
  });

  it('T05: resolve() de un token vencido retorna expired con ageMs/ttlMs, y lo consume igual', () => {
    vi.useFakeTimers();
    const store = new PendingConfirmStore<string>(1000);
    const token = store.create('stale');

    vi.advanceTimersByTime(1001);
    const result = store.resolve(token);

    expect(result.status).toBe('expired');
    if (result.status === 'expired') {
      expect(result.ageMs).toBeGreaterThan(1000);
      expect(result.ttlMs).toBe(1000);
      expect(result.payload).toBe('stale');
    }

    // Consumido: un segundo intento contra el mismo token da not_found, no expired de nuevo.
    const second = store.resolve(token);
    expect(second).toEqual({ status: 'not_found' });
  });

  it('T06: revoke() borra un token pendiente y retorna su payload; null si no existia', () => {
    const store = new PendingConfirmStore<string>(60_000);
    const token = store.create('to-revoke');

    expect(store.revoke(token)).toBe('to-revoke');
    expect(store.resolve(token)).toEqual({ status: 'not_found' });
    expect(store.revoke(token)).toBeNull();
  });

  it('T07: revokeAll() borra todos los tokens pendientes y retorna cuantos revoco', () => {
    const store = new PendingConfirmStore<string>(60_000);
    store.create('a');
    store.create('b');
    store.create('c');

    const revoked = store.revokeAll();

    expect(revoked).toBe(3);
    expect(store.size).toBe(0);
  });

  it('T08: sweepExpired() borra solo los tokens vencidos, deja los vigentes', () => {
    vi.useFakeTimers();
    const store = new PendingConfirmStore<string>(1000);

    const oldToken = store.create('old');
    vi.advanceTimersByTime(1500);
    const freshToken = store.create('fresh');

    store.sweepExpired();

    expect(store.size).toBe(1);
    expect(store.resolve(freshToken)).toEqual({ status: 'ok', payload: 'fresh' });
    expect(store.resolve(oldToken)).toEqual({ status: 'not_found' });
  });

  /**
   * Regresion (ronda 28 del audit): sweepExpired() descartaba las entradas
   * barridas en silencio (retorno void) — sin forma de que el caller
   * (Core/Executor) auditara confirm:expired para el caso comun (nadie
   * reenvia el token vencido, simplemente expira solo).
   */
  it('T08b: sweepExpired() retorna las entradas barridas (token, payload, ageMs)', () => {
    vi.useFakeTimers();
    const store = new PendingConfirmStore<string>(1000);

    const oldToken = store.create('old');
    vi.advanceTimersByTime(1500);
    store.create('fresh');

    const swept = store.sweepExpired();

    expect(swept).toHaveLength(1);
    expect(swept[0].token).toBe(oldToken);
    expect(swept[0].payload).toBe('old');
    expect(swept[0].ageMs).toBeGreaterThan(1000);
  });

  it('T09: payloads arbitrarios (objetos con handlers/funciones) se preservan por referencia', () => {
    const handler = async () => ({ success: true, data: null });
    const store = new PendingConfirmStore<{ handler: Function; args: Record<string, any> }>(60_000);
    const token = store.create({ handler, args: { id: 1 } });

    const result = store.resolve(token);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.payload.handler).toBe(handler);
      expect(result.payload.args).toEqual({ id: 1 });
    }
  });

  /**
   * Regresion (ronda 46 del audit, HIGH): create() no tenia ningun tope de
   * tamano — un caller que sigue pidiendo confirmaciones sin resolverlas
   * nunca hacia crecer el map sin limite (el rateLimit que lo frenaria no
   * esta wireado por defecto en el CLI/server shipeado). Mismo patron de
   * MAX_SESSIONS ya usado en otros stores acotados de esta base de codigo.
   */
  /**
   * Regresion (ronda 63 del audit, HIGH): distribuido en muchas sesiones
   * distintas (cada una bien por debajo de su propio cap por-sesion), asi
   * que lo que dispara la eviccion aca es especificamente el backstop
   * GLOBAL (MAX_PENDING), no el nuevo cap por-sesion — ver T11/T12 abajo
   * para el cap por-sesion en si.
   */
  it('T10: create() acota el tamano TOTAL del store (backstop global) — evict-ea el token mas viejo GLOBAL', () => {
    const store = new PendingConfirmStore<number>(60_000);
    const MAX_PENDING = 1000; // debe coincidir con la constante interna del modulo
    const GROUP_SIZE = 90; // bien por debajo de MAX_PENDING_PER_SESSION (100)

    const firstToken = store.create(0, 'session-0');
    for (let i = 1; i < MAX_PENDING; i++) {
      store.create(i, `session-${Math.floor(i / GROUP_SIZE)}`);
    }
    expect(store.size).toBe(MAX_PENDING);

    // Un token mas alla del limite GLOBAL, en una sesion nueva: el mas
    // viejo GLOBAL (firstToken, de session-0) se evict-ea igual, aunque
    // este en otra sesion que la que dispara la insercion.
    const overflowToken = store.create(MAX_PENDING, 'session-overflow');
    expect(store.size).toBe(MAX_PENDING);
    expect(store.resolve(firstToken)).toEqual({ status: 'not_found' });
    expect(store.resolve(overflowToken)).toEqual({ status: 'ok', payload: MAX_PENDING });
  });

  /**
   * Regresion (ronda 63 del audit, HIGH): PendingConfirmStore es una
   * UNICA instancia compartida por TODAS las sesiones concurrentes (Core/
   * Executor construyen una sola instancia por proceso). La eviccion
   * antes era global-FIFO puro — una sesion podia saturar el store y
   * evictar el token, todavia fresco (bien dentro del TTL), que ACABABA
   * de generar una sesion completamente distinta: un DoS confiable contra
   * el flujo de confirmacion de OTROS callers, con el mismo bearer token
   * compartido que cualquiera, sin necesitar adivinar ningun
   * X-Session-Id. Ahora la eviccion disparada por UNA sesion que supera
   * su PROPIO cap (MAX_PENDING_PER_SESSION) solo puede borrar la entrada
   * mas vieja de ESA MISMA sesion — nunca la de otra.
   */
  it('T11: la eviccion por MAX_PENDING_PER_SESSION solo afecta a la MISMA sesion, nunca a otra', () => {
    const store = new PendingConfirmStore<string>(60_000);
    const MAX_PENDING_PER_SESSION = 100; // debe coincidir con la constante interna del modulo

    // session-B genera un solo token, fresco, ANTES de que session-A sature su propio cap.
    const freshTokenB = store.create('fresh-from-B', 'session-B');

    // session-A satura su PROPIO cap.
    const firstTokenA = store.create('first-from-A', 'session-A');
    for (let i = 1; i < MAX_PENDING_PER_SESSION; i++) store.create(`item-${i}-from-A`, 'session-A');

    // Un token MAS alla del cap de session-A: evict-ea el mas viejo DE
    // session-A (firstTokenA) — el token de session-B sigue intacto.
    const overflowTokenA = store.create('overflow-from-A', 'session-A');

    expect(store.resolve(firstTokenA)).toEqual({ status: 'not_found' });
    expect(store.resolve(overflowTokenA)).toEqual({ status: 'ok', payload: 'overflow-from-A' });
    expect(store.resolve(freshTokenB)).toEqual({ status: 'ok', payload: 'fresh-from-B' });
  });

  it('T12: sesiones sin sessionKey (ej. stdio, inherentemente single-tenant) caen en un balde compartido por defecto, sin romper', () => {
    const store = new PendingConfirmStore<string>(60_000);
    const a = store.create('a'); // sin sessionKey -> balde default ('')
    const b = store.create('b', ''); // explicito, mismo balde

    expect(store.resolve(a)).toEqual({ status: 'ok', payload: 'a' });
    expect(store.resolve(b)).toEqual({ status: 'ok', payload: 'b' });
  });
});
