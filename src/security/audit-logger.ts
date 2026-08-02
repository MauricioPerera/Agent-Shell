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
      // Regresion (ronda 43 del audit, HIGH): antes se pasaba `data` tal
      // cual — una referencia VIVA a estado interno de quien llama (p.ej.
      // executor/index.ts pasa el `requiredPermissions` que devuelve
      // CommandRegistry.resolve()/.get(), que NO clona a diferencia de
      // register()). Un listener que mutara event.data podia deshabilitar
      // permisos para el resto del proceso. Clonar aca es la unica
      // garantia real, sin depender de que cada call site lo haga bien.
      data: structuredClone(data),
    };
    // Regresion (ronda 43 del audit, HIGH): this.emit(type, event) y
    // this.emit('*', event) eran dos statements sueltos. EventEmitter no
    // aisla listeners entre si — un throw sincronico en CUALQUIER listener
    // de `type` (a) corta el resto de los listeners de ESE emit y (b) hace
    // que el emit('*', ...) de abajo NUNCA se alcance, dejando ciego al
    // listener wildcard de produccion (createAuditLoggerToStderr). La
    // excepcion ademas escapaba sin catch hacia quien llama a audit() —
    // ningun call site (30 en total) envuelve la llamada. safeEmit()
    // reimplementa el despacho aislando cada listener individualmente.
    this.safeEmit(type, event);
    this.safeEmit('*', event);
  }

  /** Registra un listener para un tipo de evento o wildcard '*'. */
  onAudit(type: AuditEventType | '*', listener: AuditListener): this {
    return this.on(type, listener);
  }

  /**
   * Invoca cada listener registrado para `type` en su propio try/catch, de
   * forma que un listener que tira excepcion no bloquee a los demas
   * listeners del mismo tipo, no bloquee el otro emit (type-especifico vs
   * '*'), y no escape hacia quien llamo a audit(). AuditLogger es la propia
   * capa de logging (no hay otra a la que delegar), asi que un listener
   * roto se reporta a stderr en vez de desaparecer sin rastro.
   */
  private safeEmit(type: string, event: AuditEvent): void {
    for (const listener of this.listeners(type)) {
      try {
        (listener as AuditListener)(event);
      } catch (err) {
        console.error(`[audit-logger] listener for '${type}' threw:`, err);
      }
    }
  }
}
