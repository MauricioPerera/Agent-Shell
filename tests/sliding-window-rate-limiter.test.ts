/**
 * Tests para SlidingWindowRateLimiter (src/shared/sliding-window-rate-limiter.ts).
 *
 * Extraido del mismo algoritmo de ventana deslizante que Core y Executor
 * tenian implementado a mano por separado — estos tests cubren el
 * primitivo compartido de forma aislada.
 */

import { describe, it, expect } from 'vitest';
import { SlidingWindowRateLimiter } from '../src/shared/sliding-window-rate-limiter.js';

describe('SlidingWindowRateLimiter', () => {
  it('T01: permite hasta maxRequests dentro de la ventana, luego rechaza', () => {
    const limiter = new SlidingWindowRateLimiter({ maxRequests: 3, windowMs: 1000 });
    const now = 10_000;

    expect(limiter.tryAcquire(now)).toBe(true);
    expect(limiter.tryAcquire(now)).toBe(true);
    expect(limiter.tryAcquire(now)).toBe(true);
    expect(limiter.tryAcquire(now)).toBe(false);
  });

  it('T02: la ventana se desliza — timestamps viejos expiran y liberan cupo', () => {
    const limiter = new SlidingWindowRateLimiter({ maxRequests: 2, windowMs: 1000 });

    expect(limiter.tryAcquire(0)).toBe(true);
    expect(limiter.tryAcquire(100)).toBe(true);
    expect(limiter.tryAcquire(200)).toBe(false);

    // Avanza mas alla de la ventana de los dos primeros timestamps.
    expect(limiter.tryAcquire(1100)).toBe(true);
  });

  it('T03: sin burstSize configurado, solo el limite de ventana aplica (comportamiento de Executor)', () => {
    const limiter = new SlidingWindowRateLimiter({ maxRequests: 5, windowMs: 1000 });
    const now = 0;

    for (let i = 0; i < 5; i++) {
      expect(limiter.tryAcquire(now + i)).toBe(true);
    }
    expect(limiter.tryAcquire(now + 5)).toBe(false);
  });

  it('T04: con burstSize configurado, el tope de burst corta antes que el de ventana', () => {
    const limiter = new SlidingWindowRateLimiter({ maxRequests: 100, windowMs: 60_000, burstSize: 2, burstWindowMs: 1000 });
    const now = 0;

    expect(limiter.tryAcquire(now)).toBe(true);
    expect(limiter.tryAcquire(now + 10)).toBe(true);
    expect(limiter.tryAcquire(now + 20)).toBe(false); // burst excedido, aunque la ventana global tiene cupo de sobra

    // Fuera de la sub-ventana de burst, vuelve a permitir (la ventana global sigue con cupo).
    expect(limiter.tryAcquire(now + 1001)).toBe(true);
  });

  it('T05: burstWindowMs por defecto es 1000ms cuando burstSize esta configurado', () => {
    const limiter = new SlidingWindowRateLimiter({ maxRequests: 100, windowMs: 60_000, burstSize: 1 });

    expect(limiter.tryAcquire(0)).toBe(true);
    expect(limiter.tryAcquire(999)).toBe(false);
    expect(limiter.tryAcquire(1001)).toBe(true);
  });
});
