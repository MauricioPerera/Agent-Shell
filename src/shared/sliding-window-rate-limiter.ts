/**
 * @module shared/sliding-window-rate-limiter
 * @description Rate limiter de ventana deslizante, con soporte opcional de
 * "burst" (un tope mas estricto sobre una sub-ventana corta, p.ej. 1s).
 *
 * Extraido tras encontrar el MISMO algoritmo de ventana deslizante
 * implementado a mano en Core y en Executor (timestamps[] + filter por
 * windowStart), con Core habiendo agregado ademas un chequeo de burst que
 * Executor nunca recibio. El burst es opcional y por defecto deshabilitado
 * para que Executor, que no lo configura, mantenga su comportamiento exacto.
 */

export interface RateLimiterConfig {
  maxRequests: number;
  windowMs: number;
  /** Si se especifica, ademas del limite de ventana se aplica un tope mas estricto sobre `burstWindowMs` (default 1000ms). */
  burstSize?: number;
  burstWindowMs?: number;
}

export class SlidingWindowRateLimiter {
  private timestamps: number[] = [];

  constructor(private readonly config: RateLimiterConfig) {}

  /** Intenta consumir un slot. Retorna false si el limite (ventana o burst) esta excedido. */
  tryAcquire(now: number = Date.now()): boolean {
    const windowStart = now - this.config.windowMs;
    this.timestamps = this.timestamps.filter(t => t > windowStart);

    if (this.config.burstSize !== undefined) {
      const burstWindowStart = now - (this.config.burstWindowMs ?? 1000);
      const burstCount = this.timestamps.filter(t => t > burstWindowStart).length;
      if (burstCount >= this.config.burstSize) return false;
    }

    if (this.timestamps.length >= this.config.maxRequests) return false;

    this.timestamps.push(now);
    return true;
  }
}
