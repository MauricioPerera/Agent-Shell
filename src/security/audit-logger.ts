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
  private readonly defaultSessionId: string;

  constructor(sessionId: string) {
    super();
    this.defaultSessionId = sessionId;
  }

  /**
   * Emite un evento de auditoria tipado.
   *
   * @param sessionId - Sobreescribe el sessionId fijado en el constructor
   *   para este evento puntual. Necesario para Core, que atiende muchas
   *   sesiones concurrentes con UNA sola instancia de AuditLogger (a
   *   diferencia de Executor, que se construye de nuevo por sesion/request
   *   y por eso le alcanza con el sessionId fijo del constructor). No hay
   *   estado por sesion que aislar aca — AuditLogger solo emite eventos,
   *   asi que compartir una instancia entre sesiones es seguro; lo unico
   *   que cambiaba por llamada era la etiqueta.
   */
  audit(type: AuditEventType, data: Record<string, any>, sessionId?: string): void {
    const event: AuditEvent = {
      type,
      timestamp: new Date().toISOString(),
      sessionId: sessionId ?? this.defaultSessionId,
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
