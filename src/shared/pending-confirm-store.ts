/**
 * @module shared/pending-confirm-store
 * @description Store generico, acotado por TTL, para tokens de confirmacion
 * en dos pasos (`--confirm` -> preview + token -> `confirm <token>`).
 *
 * Extraido tras encontrar el MISMO patron implementado dos veces a mano:
 * Executor ya lo tenia (pendingConfirms + cleanExpiredConfirms + el chequeo
 * de TTL inline en confirm()), y Core lo re-implemento identico al agregar
 * su propio --confirm. Sin un solo lugar donde vive esta logica, un fix
 * futuro (TTL, eviccion, forma del token) tiene que aplicarse dos veces a
 * mano — exactamente la clase de bug que ya paso una vez esta sesion con
 * el masking de secretos en el historial.
 */

import { randomUUID } from 'node:crypto';

/**
 * Bounds how many pending confirm tokens this store holds at once. Without
 * this, a caller that keeps issuing --confirm-requiring commands without
 * ever resolving them grows the map without limit — the rateLimit config
 * that would throttle this isn't wired by default in the shipped CLI/
 * server, so in practice nothing else stops it. Same evict-before-insert
 * FIFO pattern already used for MAX_SESSIONS in WorkspaceSessionStore/
 * SessionScopedContextStore/InMemoryStorageAdapter (ronda 46 del audit).
 */
const MAX_PENDING = 1000;

interface StoredEntry<T> {
  payload: T;
  createdAt: number;
}

/** Resultado de intentar resolver (consumir) un token pendiente. */
export type ResolveResult<T> =
  | { status: 'ok'; payload: T }
  | { status: 'not_found' }
  | { status: 'expired'; ageMs: number; ttlMs: number; payload: T };

/** Una entrada barrida por sweepExpired(), para que el caller pueda auditarla. */
export interface SweptEntry<T> {
  token: string;
  payload: T;
  ageMs: number;
}

/**
 * Store de tokens pendientes, parametrizado por el tipo de payload que cada
 * caller necesite guardar (Core y Executor guardan formas distintas — este
 * store no le impone nada al payload).
 */
export class PendingConfirmStore<T> {
  private readonly entries = new Map<string, StoredEntry<T>>();

  constructor(private readonly ttlMs: number) {}

  /** Cantidad de tokens actualmente almacenados (incluye posibles expirados aun no barridos). */
  get size(): number {
    return this.entries.size;
  }

  /** Genera un token nuevo, guarda el payload, y lo retorna. */
  create(payload: T): string {
    const token = randomUUID();
    // Bound the map BEFORE inserting — same reasoning as MAX_SESSIONS
    // elsewhere in this codebase. Evicts the OLDEST pending confirm (Map
    // iteration order is insertion order) to make room; a token evicted
    // this way simply stops existing, same as one that expires unresolved
    // via sweepExpired() — the caller who requested it just never manages
    // to resolve it, same failure mode as letting the TTL lapse.
    if (this.entries.size >= MAX_PENDING) {
      const oldestToken = this.entries.keys().next().value;
      if (oldestToken !== undefined) this.entries.delete(oldestToken);
    }
    this.entries.set(token, { payload, createdAt: Date.now() });
    return token;
  }

  /**
   * Busca un token y lo CONSUME (lo borra) sin importar el resultado — un
   * token es de un solo uso tanto si resuelve ok como si esta expirado,
   * para que no se pueda reintentar contra el mismo token una vez visto.
   */
  resolve(token: string): ResolveResult<T> {
    const entry = this.entries.get(token);
    if (!entry) return { status: 'not_found' };

    this.entries.delete(token);

    const ageMs = Date.now() - entry.createdAt;
    if (ageMs > this.ttlMs) {
      return { status: 'expired', ageMs, ttlMs: this.ttlMs, payload: entry.payload };
    }
    return { status: 'ok', payload: entry.payload };
  }

  /** Revoca un token pendiente sin ejecutarlo. Retorna el payload si existia (para poder auditar que se revoco), o null. */
  revoke(token: string): T | null {
    const entry = this.entries.get(token);
    if (!entry) return null;
    this.entries.delete(token);
    return entry.payload;
  }

  /** Revoca todos los tokens pendientes. Retorna cuantos se revocaron. */
  revokeAll(): number {
    const count = this.entries.size;
    this.entries.clear();
    return count;
  }

  /**
   * Barre tokens mas viejos que el TTL configurado. Pensado para llamarse
   * una vez por request entrante. Retorna las entradas barridas — antes se
   * descartaban en silencio, dejando la ruta comun de expiracion (nadie
   * reenvia el token vencido, simplemente nunca vuelve) sin ningun rastro
   * de auditoria; solo el reenvio explicito de un token ya vencido, o
   * revoke(), generaban un evento confirm:expired.
   */
  sweepExpired(): SweptEntry<T>[] {
    const now = Date.now();
    const swept: SweptEntry<T>[] = [];
    for (const [token, entry] of this.entries) {
      const ageMs = now - entry.createdAt;
      if (ageMs > this.ttlMs) {
        this.entries.delete(token);
        swept.push({ token, payload: entry.payload, ageMs });
      }
    }
    return swept;
  }
}
