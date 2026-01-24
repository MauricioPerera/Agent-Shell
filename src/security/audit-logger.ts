/**
 * @module security/audit-logger
 * @description Logger de auditoria basado en EventEmitter.
 *
 * Emite eventos tipados para acciones relevantes de seguridad:
 * ejecuciones, denegaciones, confirmaciones, errores.
 */

import { EventEmitter } from 'node:events';
import type { AuditEvent, AuditEventType, AuditListener } from './types.js';

export class AuditLogger extends EventEmitter {
  private readonly sessionId: string;

  constructor(sessionId: string) {
    super();
    this.sessionId = sessionId;
  }

  /** Emite un evento de auditoria tipado. */
  audit(type: AuditEventType, data: Record<string, any>): void {
    const event: AuditEvent = {
      type,
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      data,
    };
    this.emit(type, event);
    this.emit('*', event);
  }

  /** Registra un listener para un tipo de evento o wildcard '*'. */
  onAudit(type: AuditEventType | '*', listener: AuditListener): this {
    return this.on(type, listener);
  }
}
