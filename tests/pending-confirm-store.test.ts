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
});
