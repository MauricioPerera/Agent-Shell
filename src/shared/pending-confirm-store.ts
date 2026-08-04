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
 *
 * Kept as a GLOBAL backstop on top of MAX_PENDING_PER_SESSION below (ronda
 * 63 del audit) — many distinct sessions each individually under their own
 * per-session cap could still sum past a sane total.
 */
const MAX_PENDING = 1000;

/**
 * Regresion (ronda 63 del audit, HIGH): esta store es UNA SOLA instancia
 * compartida por TODAS las sesiones concurrentes (Core/Executor cada uno
 * construyen una unica instancia para todo el proceso — ver
 * core/index.ts, executor/index.ts). El cap de arriba (MAX_PENDING) era
 * puramente global: la eviccion FIFO al llegar al techo borraba el token
 * mas viejo SIN IMPORTAR de que sesion era. Una sesion (con el mismo
 * bearer token compartido que cualquier otro caller legitimo del
 * deployment, sin necesitar adivinar ningun X-Session-Id) podia disparar
 * 1000 `--confirm` rapidos y evictar el token, todavia fresco (bien
 * dentro del TTL), que ACABABA de generar una sesion completamente
 * distinta — un DoS confiable contra el flujo de confirmacion de OTROS
 * callers. Este cap por-sesion hace que la eviccion, cuando la dispara
 * UNA sesion, borre SOLO la entrada mas vieja de ESA MISMA sesion —
 * jamas la de otra.
 */
const MAX_PENDING_PER_SESSION = 100;

interface StoredEntry<T> {
  payload: T;
  createdAt: number;
  sessionKey: string;
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

  /**
   * Genera un token nuevo, guarda el payload, y lo retorna.
   *
   * @param sessionKey Identifica la sesion duena de este token, SOLO para
   *   acotar a que entradas puede afectar la eviccion (ver
   *   MAX_PENDING_PER_SESSION arriba) — nunca se usa para autorizar quien
   *   puede resolverlo despues (eso sigue dependiendo unicamente de
   *   conocer el token, un UUID no adivinable; ver el comentario de
   *   resolve() en los callers sobre por que eso es seguro). Sesiones sin
   *   identidad propia (ej. stdio, inherentemente single-tenant) pueden
   *   omitirlo — todas caen en el mismo balde compartido, lo cual es
   *   inofensivo ahi porque no hay OTRAS sesiones concurrentes con las
   *   que competir.
   */
  create(payload: T, sessionKey: string = ''): string {
    const token = randomUUID();

    // Bound BEFORE inserting, igual que antes — pero ahora en dos capas.
    // Capa 1 (por-sesion): si ESTA sesion ya esta en su propio techo,
    // evict SOLO su entrada mas vieja — nunca la de otra sesion.
    if (this.countBySession(sessionKey) >= MAX_PENDING_PER_SESSION) {
      this.evictOldestForSession(sessionKey);
    }
    // Capa 2 (backstop global): igual que antes de este fix, protege
    // contra que MUCHAS sesiones distintas, cada una bajo su propio cap,
    // sumen igual un total no acotado.
    if (this.entries.size >= MAX_PENDING) {
      const oldestToken = this.entries.keys().next().value;
      if (oldestToken !== undefined) this.entries.delete(oldestToken);
    }

    this.entries.set(token, { payload, createdAt: Date.now(), sessionKey });
    return token;
  }

  private countBySession(sessionKey: string): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.sessionKey === sessionKey) count++;
    }
    return count;
  }

  private evictOldestForSession(sessionKey: string): void {
    for (const [token, entry] of this.entries) {
      if (entry.sessionKey === sessionKey) {
        this.entries.delete(token);
        return;
      }
    }
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
