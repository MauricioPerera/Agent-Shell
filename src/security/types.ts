/**
 * @module security/types
 * @description Tipos del modulo de seguridad de Agent Shell.
 */

/** Tipos de evento de auditoria. */
export type AuditEventType =
  | 'command:executed'
  | 'command:failed'
  | 'permission:denied'
  | 'confirm:requested'
  | 'confirm:executed'
  | 'confirm:expired'
  | 'session:created'
  | 'session:expired'
  | 'error:handler'
  | 'error:timeout';

/** Evento de auditoria emitido por el AuditLogger. */
export interface AuditEvent {
  type: AuditEventType;
  timestamp: string;
  sessionId: string;
  data: Record<string, any>;
}

/** Listener de eventos de auditoria. */
export interface AuditListener {
  (event: AuditEvent): void;
}

/** Patron para deteccion de secretos. */
export interface SecretPattern {
  name: string;
  pattern: RegExp;
  replacement: string;
}
