/**
 * Tests for Core's AuditLogger wiring.
 *
 * Regression: AuditLogger has been wired into Executor since it existed
 * (permission:denied, command:executed, confirm:*, error:timeout,
 * error:handler), but Core — the only engine cli/index.ts and
 * server/index.ts ever construct — never referenced it at all. Every real
 * deployment silently had zero audit trail. Unlike Executor (constructed
 * fresh per session/request, so a constructor-fixed sessionId is fine),
 * Core is one long-lived instance serving many concurrent sessions, so
 * each event here is tagged with the caller's actual per-call sessionId
 * (AuditLogger.audit()'s new optional 3rd param) instead of relying on a
 * fixed constructor default.
 */

import { describe, it, expect, vi } from 'vitest';
import { Core } from '../src/core/index.js';
import { AuditLogger } from '../src/security/audit-logger.js';

function createMockRegistry() {
  const commands = new Map<string, any>();

  commands.set('users:list', {
    namespace: 'users', name: 'list', version: '1.0.0', description: 'Lista usuarios', params: [],
    handler: async () => ({ success: true, data: [{ id: 1 }] }),
  });
  commands.set('users:delete', {
    namespace: 'users', name: 'delete', version: '1.0.0', description: 'Elimina un usuario',
    params: [{ name: 'id', type: 'int', required: true }],
    handler: async (args: any) => ({ success: true, data: { deleted: args.id } }),
    confirm: true, requiredPermissions: ['users:delete'],
  });
  commands.set('users:fail', {
    namespace: 'users', name: 'fail', version: '1.0.0', description: 'Siempre falla', params: [],
    handler: async () => ({ success: false, data: null, error: 'Something specific went wrong' }),
  });
  commands.set('secret:set', {
    namespace: 'secret', name: 'set', version: '1.0.0', description: 'Guarda un secreto (fixture de test)',
    params: [{ name: 'value', type: 'string', required: false }],
    handler: async () => ({ success: true, data: { set: true } }),
  });
  commands.set('secret:fail', {
    namespace: 'secret', name: 'fail', version: '1.0.0', description: 'Siempre falla, con secreto en el args (fixture de test)',
    params: [{ name: 'value', type: 'string', required: false }],
    handler: async () => ({ success: false, data: null, error: 'boom' }),
  });

  return {
    get(namespace: string, name: string) {
      const key = `${namespace}:${name}`;
      const cmd = commands.get(key);
      if (!cmd) return { ok: false, error: { code: 'COMMAND_NOT_FOUND', message: `Command ${namespace}:${name} not found` } };
      // definition must NOT include the handler function — see the same
      // fix in core.test.ts/integration.test.ts (ronda 54 del audit).
      const { handler, ...definition } = cmd;
      return { ok: true, value: { definition, handler, registeredAt: new Date().toISOString() } };
    },
  };
}

function collectEvents(logger: AuditLogger): any[] {
  const events: any[] = [];
  logger.onAudit('*', (e) => events.push(e));
  return events;
}

describe('Core + AuditLogger', () => {
  it('AU01: command:executed se emite en una ejecucion exitosa, con sessionId', async () => {
    const auditLogger = new AuditLogger('default');
    const events = collectEvents(auditLogger);
    const core = new Core({ registry: createMockRegistry() as any, auditLogger });

    await core.exec('users:list', 'session-A');

    const evt = events.find(e => e.type === 'command:executed');
    expect(evt).toBeDefined();
    expect(evt.sessionId).toBe('session-A');
    expect(evt.data.command).toContain('users:list');
  });

  it('AU02: permission:denied se emite cuando isVisibleToAgent deniega, con sessionId', async () => {
    const auditLogger = new AuditLogger('default');
    const events = collectEvents(auditLogger);
    const core = new Core({ registry: createMockRegistry() as any, auditLogger, permissions: ['users:list'] });

    const res = await core.exec('users:delete --id 1', 'session-B');
    expect(res.code).toBe(3);

    const evt = events.find(e => e.type === 'permission:denied');
    expect(evt).toBeDefined();
    expect(evt.sessionId).toBe('session-B');
  });

  it('AU03: permission:denied (rate-limit) se emite cuando se excede el rate limit', async () => {
    const auditLogger = new AuditLogger('default');
    const events = collectEvents(auditLogger);
    const core = new Core({ registry: createMockRegistry() as any, auditLogger, rateLimit: { maxRequests: 1, windowMs: 60_000 } });

    await core.exec('users:list', 'session-C');
    await core.exec('users:list', 'session-C');

    const evt = events.find(e => e.type === 'permission:denied' && e.data.reason === 'rate-limit');
    expect(evt).toBeDefined();
    expect(evt.sessionId).toBe('session-C');
  });

  it('AU04: error:handler se emite cuando el handler reporta success:false', async () => {
    const auditLogger = new AuditLogger('default');
    const events = collectEvents(auditLogger);
    const core = new Core({ registry: createMockRegistry() as any, auditLogger });

    await core.exec('users:fail', 'session-D');

    const evt = events.find(e => e.type === 'error:handler');
    expect(evt).toBeDefined();
    expect(evt.sessionId).toBe('session-D');
    expect(evt.data.error).toContain('Something specific went wrong');
  });

  it('AU05: error:timeout se emite cuando el timeout global expira', async () => {
    const auditLogger = new AuditLogger('default');
    const events = collectEvents(auditLogger);
    const slowRegistry = {
      get(namespace: string, name: string) {
        if (namespace === 'slow' && name === 'handler') {
          return {
            ok: true,
            value: {
              definition: { namespace: 'slow', name: 'handler', params: [] },
              handler: () => new Promise(() => {}), // never resolves
            },
          };
        }
        return { ok: false, error: { code: 'NOT_FOUND', message: 'not found' } };
      },
    };
    const core = new Core({ registry: slowRegistry as any, auditLogger, timeouts: { global_ms: 30 } });

    await core.exec('slow:handler', 'session-E');

    const evt = events.find(e => e.type === 'error:timeout');
    expect(evt).toBeDefined();
    expect(evt.sessionId).toBe('session-E');
  });

  /**
   * Ciclo de vida completo de confirm, mirroring Executor's exact 3 eventos
   * (requested/executed/expired) — ahora posible porque Core comparte
   * PendingConfirmStore con Executor.
   */
  it('AU06: confirm:requested y confirm:executed se emiten en el ciclo --confirm', async () => {
    const auditLogger = new AuditLogger('default');
    const events = collectEvents(auditLogger);
    const core = new Core({ registry: createMockRegistry() as any, auditLogger, permissions: ['users:delete'] });

    const preview = await core.exec('users:delete --id 5 --confirm', 'session-F');
    const requestedEvt = events.find(e => e.type === 'confirm:requested');
    expect(requestedEvt).toBeDefined();
    expect(requestedEvt.sessionId).toBe('session-F');

    await core.exec(`confirm ${preview.data.confirmToken}`, 'session-F');
    const executedEvt = events.find(e => e.type === 'confirm:executed');
    expect(executedEvt).toBeDefined();
    expect(executedEvt.sessionId).toBe('session-F');
  });

  it('AU07: confirm:expired se emite cuando el token vencio', async () => {
    const auditLogger = new AuditLogger('default');
    const events = collectEvents(auditLogger);
    const core = new Core({ registry: createMockRegistry() as any, auditLogger, permissions: ['users:delete'], confirmTTL_ms: 1 });

    const preview = await core.exec('users:delete --id 5 --confirm', 'session-G');
    await new Promise(r => setTimeout(r, 20));
    await core.exec(`confirm ${preview.data.confirmToken}`, 'session-G');

    const evt = events.find(e => e.type === 'confirm:expired');
    expect(evt).toBeDefined();
    expect(evt.sessionId).toBe('session-G');
  });

  /**
   * Regresion central: UNA sola instancia de AuditLogger compartida entre
   * llamadas de sesiones distintas debe etiquetar cada evento con el
   * sessionId REAL del caller, no con un sessionId fijo del constructor.
   */
  it('AU08: una unica instancia de AuditLogger etiqueta correctamente eventos de sesiones distintas', async () => {
    const auditLogger = new AuditLogger('constructor-default');
    const events = collectEvents(auditLogger);
    const core = new Core({ registry: createMockRegistry() as any, auditLogger });

    await core.exec('users:list', 'session-X');
    await core.exec('users:list', 'session-Y');

    const sessionIds = events.filter(e => e.type === 'command:executed').map(e => e.sessionId);
    expect(sessionIds).toEqual(['session-X', 'session-Y']);
    expect(sessionIds).not.toContain('constructor-default');
  });

  it('AU09: sin sessionId (stdio), los eventos usan el sessionId por defecto del constructor', async () => {
    const auditLogger = new AuditLogger('stdio-default');
    const events = collectEvents(auditLogger);
    const core = new Core({ registry: createMockRegistry() as any, auditLogger });

    await core.exec('users:list');

    const evt = events.find(e => e.type === 'command:executed');
    expect(evt.sessionId).toBe('stdio-default');
  });

  it('AU10: sin auditLogger configurado, Core funciona igual (no-op silencioso)', async () => {
    const core = new Core({ registry: createMockRegistry() as any });
    const res = await core.exec('users:list');
    expect(res.code).toBe(0);
  });

  /**
   * Regresion (ronda 28 del audit): executeBatch() ruteaba cada item por
   * executeCommand() pero nunca tocaba auditLogger — el mismo chequeo de
   * permission:denied/error:handler/command:executed que execInternal()
   * aplica al comando suelto y al pipeline se saltaba en silencio para
   * TODO comando dentro de un batch[]. Blind spot total en Core (el unico
   * engine que cli/index.ts y server/index.ts construyen).
   */
  it('AU11: batch[] audita cada item individualmente (command:executed y error:handler)', async () => {
    const auditLogger = new AuditLogger('default');
    const events = collectEvents(auditLogger);
    const core = new Core({ registry: createMockRegistry() as any, auditLogger });

    await core.exec('batch[users:list, users:fail]', 'session-H');

    const executed = events.find(e => e.type === 'command:executed' && e.data.command.includes('users:list'));
    const failed = events.find(e => e.type === 'error:handler' && e.data.command.includes('users:fail'));
    expect(executed).toBeDefined();
    expect(executed.sessionId).toBe('session-H');
    expect(failed).toBeDefined();
    expect(failed.sessionId).toBe('session-H');
  });

  /**
   * Regresion (ronda 28 del audit): confirm:expired solo se emitia si el
   * caller reenviaba explicitamente el token ya vencido. El barrido
   * proactivo por TTL (cleanExpiredConfirms(), corrido una vez por
   * exec()) descartaba tokens vencidos en silencio — el caso COMUN, ya
   * que la mayoria de previews nunca se confirman en absoluto.
   */
  it('AU12: confirm:expired se emite via el barrido de TTL, no solo al reenviar el token vencido', async () => {
    const auditLogger = new AuditLogger('default');
    const events = collectEvents(auditLogger);
    const core = new Core({ registry: createMockRegistry() as any, auditLogger, permissions: ['users:delete', 'users:list'], confirmTTL_ms: 1 });

    const preview = await core.exec('users:delete --id 5 --confirm', 'session-I');
    await new Promise(r => setTimeout(r, 20));
    // Un comando NO relacionado dispara cleanExpiredConfirms() internamente
    // — el token de arriba nunca se reenvia.
    await core.exec('users:list', 'session-I');

    const evt = events.find(e => e.type === 'confirm:expired');
    expect(evt).toBeDefined();
    expect(evt.data.reason).toBe('ttl-sweep');
    expect(evt.data.command).toContain('users:delete');
    expect(preview.data.confirmToken).toBeTruthy();
  });

  /**
   * Regresion (ronda 31 del audit): resolveConfirmation() ya auditaba
   * confirm:executed bajo el nombre real del comando confirmado, pero la
   * post-procesamiento GENERICA de execInternal() (compartida con todo
   * comando/pipeline/batch) volvia a auditar la MISMA resolucion una
   * segunda vez como command:executed, etiquetada con el string literal
   * "confirm <token>" en vez del comando real. Ahora ese bloque generico
   * se salta para resoluciones de confirm (isConfirmResolution).
   */
  it('AU13: confirmar un token NO duplica el audit trail ni lo etiqueta como "confirm <token>"', async () => {
    const auditLogger = new AuditLogger('default');
    const events = collectEvents(auditLogger);
    const core = new Core({ registry: createMockRegistry() as any, auditLogger, permissions: ['users:delete'] });

    const preview = await core.exec('users:delete --id 5 --confirm', 'session-J');
    const token = preview.data.confirmToken;
    events.length = 0; // solo nos interesan los eventos de la resolucion

    await core.exec(`confirm ${token}`, 'session-J');

    const executed = events.filter(e => e.type === 'confirm:executed' || e.type === 'command:executed');
    expect(executed).toHaveLength(1);
    expect(executed[0].type).toBe('confirm:executed');
    expect(executed[0].data.command).toBe('users:delete');
    expect(events.some(e => e.data?.command === `confirm ${token}`)).toBe(false);
  });

  /**
   * Misma regresion que AU13, ahora sobre la resolucion de un historial:
   * antes se grababa DOS entradas por cada confirm exitoso (una generica
   * mal etiquetada "confirm <token>", otra — la nueva, correcta — bajo el
   * comando real). Ahora solo debe quedar UNA entrada, con el nombre real.
   */
  it('AU14: confirmar un token graba UNA sola entrada de history, bajo el comando real', async () => {
    const auditLogger = new AuditLogger('default');
    const core = new Core({ registry: createMockRegistry() as any, auditLogger, permissions: ['users:delete', 'history'] });

    const preview = await core.exec('users:delete --id 5 --confirm', 'session-K');
    const token = preview.data.confirmToken;
    await core.exec(`confirm ${token}`, 'session-K');

    // Una sola llamada a "history" al final: su propia entrada solo se
    // graba DESPUES de computar la data que devuelve, asi que el snapshot
    // no se incluye a si mismo. Deben quedar exactamente 2 entradas: la
    // preview (--confirm) y la resolucion — bajo el comando real, no bajo
    // el string literal "confirm <token>" (el bug que esto regresiona).
    const history = await core.exec('history', 'session-K');
    expect(history.data).toHaveLength(2);
    expect(history.data[0].command).toBe('users:delete --id 5 --confirm');
    expect(history.data[1].command).toBe('users:delete');
  });

  /**
   * Regresion (ronda 31 del audit): al suprimir el bloque generico de
   * execInternal para TODA resolucion de confirm, un handler que responde
   * result.success===false dentro de resolveConfirmation() se quedaba SIN
   * ningun audit (antes lo cubria, mal etiquetado, el bloque generico
   * suprimido). Se agrego un audit explicito ahi mismo para no perder la
   * señal.
   */
  it('AU15: un handler confirmado que falla (success:false) SI audita error:handler, bajo el comando real', async () => {
    const auditLogger = new AuditLogger('default');
    const events = collectEvents(auditLogger);
    const failRegistry = {
      get(namespace: string, name: string) {
        if (namespace === 'users' && name === 'delete') {
          return {
            ok: true,
            value: {
              definition: {
                namespace: 'users', name: 'delete', version: '1.0.0', description: 'Elimina (falla)',
                params: [{ name: 'id', type: 'int', required: true }],
                confirm: true, requiredPermissions: ['users:delete'],
              },
              handler: async () => ({ success: false, data: null, error: 'delete blocked by policy' }),
              registeredAt: new Date().toISOString(),
            },
          };
        }
        return { ok: false, error: { code: 'NOT_FOUND', message: 'not found' } };
      },
    };
    const core = new Core({ registry: failRegistry as any, auditLogger, permissions: ['users:delete'] });

    const preview = await core.exec('users:delete --id 5 --confirm', 'session-L');
    events.length = 0;
    const response = await core.exec(`confirm ${preview.data.confirmToken}`, 'session-L');

    expect(response.code).toBe(1);
    expect(response.error).toContain('delete blocked by policy');

    const failed = events.filter(e => e.type === 'error:handler');
    expect(failed).toHaveLength(1);
    expect(failed[0].data.command).toBe('users:delete');
    expect(failed[0].sessionId).toBe('session-L');
  });

  /**
   * Regresion (ronda 37 del audit): executePipeline() nunca llamaba
   * auditLogger directamente — cada paso caia al bloque generico de
   * execInternal, que audita UN SOLO evento etiquetado con el string
   * COMPLETO del pipeline (ambiguo sobre cual paso especifico fallo/tuvo
   * exito). executeBatch() ya audita cada item individualmente desde la
   * ronda 28 (ver AU11); este test fija el mismo comportamiento para
   * pipelines.
   */
  it('AU16: pipeline audita cada paso individualmente (command:executed y error:handler), bajo SU PROPIO namespace:command', async () => {
    const auditLogger = new AuditLogger('default');
    const events = collectEvents(auditLogger);
    const core = new Core({ registry: createMockRegistry() as any, auditLogger });

    await core.exec('users:list >> users:fail', 'session-M');

    const executed = events.find(e => e.type === 'command:executed' && e.data.command === 'users:list');
    const failed = events.find(e => e.type === 'error:handler' && e.data.command === 'users:fail');
    expect(executed).toBeDefined();
    expect(executed.sessionId).toBe('session-M');
    expect(failed).toBeDefined();
    expect(failed.sessionId).toBe('session-M');
  });

  /**
   * Misma regresion que AU16: confirma que el bloque generico de
   * execInternal NO duplica la señal con un evento adicional etiquetado
   * con el string completo del pipeline ("users:list >> users:fail") —
   * solo deben existir los 2 eventos por-paso de AU16, nada mas.
   */
  it('AU17: pipeline NO genera un evento generico adicional etiquetado con el string completo del pipeline', async () => {
    const auditLogger = new AuditLogger('default');
    const events = collectEvents(auditLogger);
    const core = new Core({ registry: createMockRegistry() as any, auditLogger });

    await core.exec('users:list >> users:fail', 'session-N');

    const genericPipelineEvent = events.find(e => typeof e.data?.command === 'string' && e.data.command.includes('>>'));
    expect(genericPipelineEvent).toBeUndefined();
    expect(events.filter(e => e.type === 'command:executed' || e.type === 'error:handler')).toHaveLength(2);
  });

  /**
   * Regresion (ronda 49 del audit, HIGH): exec()/execInternal()/
   * executeBatch() pasaban el texto CRUDO del comando a auditLogger.audit()
   * sin pasar por maskSecrets(), a diferencia de recordHistory() dos lineas
   * mas abajo en la misma clase. Un comando con un secreto inline (p.ej.
   * "password=hunter2secret") quedaba en texto plano en cualquier listener
   * de auditoria (el logger de stderr de produccion, un futuro sink
   * persistente/SIEM). Estos tests cubren los 8 call sites tocados.
   */
  it('AU18: command:executed enmascara secretos inline en el texto del comando', async () => {
    const auditLogger = new AuditLogger('default');
    const events = collectEvents(auditLogger);
    const core = new Core({ registry: createMockRegistry() as any, auditLogger });

    await core.exec('secret:set --value password=hunter2secret', 'session-O');

    const evt = events.find(e => e.type === 'command:executed');
    expect(evt).toBeDefined();
    expect(evt.data.command).not.toContain('hunter2secret');
    // Regresion (ronda 63 del audit, HIGH): redactSecretSetValue() ahora
    // fuerza el redactado del --value de secret:set INCONDICIONALMENTE
    // (antes de que maskSecrets() intente su deteccion por patron), asi
    // que el placeholder generico "[REDACTED]" reemplaza al especifico
    // "[REDACTED:password]" que solo aplicaba por coincidencia con este
    // valor de test en particular (que casualmente tenia forma de
    // password=... reconocible por el patron generico).
    expect(evt.data.command).toContain('--value [REDACTED]');
  });

  it('AU19: error:handler (falla generica) enmascara secretos inline en el texto del comando', async () => {
    const auditLogger = new AuditLogger('default');
    const events = collectEvents(auditLogger);
    const core = new Core({ registry: createMockRegistry() as any, auditLogger });

    await core.exec('secret:fail --value password=hunter2secret', 'session-P');

    const evt = events.find(e => e.type === 'error:handler');
    expect(evt).toBeDefined();
    expect(evt.data.command).not.toContain('hunter2secret');
    expect(evt.data.command).toContain('[REDACTED:password]');
  });

  it('AU20: permission:denied (rate-limit) enmascara secretos inline en el texto del comando', async () => {
    const auditLogger = new AuditLogger('default');
    const events = collectEvents(auditLogger);
    const core = new Core({ registry: createMockRegistry() as any, auditLogger, rateLimit: { maxRequests: 1, windowMs: 60_000 } });

    await core.exec('secret:set --value password=hunter2secret', 'session-Q');
    await core.exec('secret:set --value password=hunter2secret', 'session-Q');

    const evt = events.find(e => e.type === 'permission:denied' && e.data.reason === 'rate-limit');
    expect(evt).toBeDefined();
    expect(evt.data.command).not.toContain('hunter2secret');
    // Regresion (ronda 63 del audit, HIGH): ver comentario identico en AU18.
    expect(evt.data.command).toContain('--value [REDACTED]');
  });

  it('AU21: error:timeout enmascara secretos inline en el texto del comando', async () => {
    const auditLogger = new AuditLogger('default');
    const events = collectEvents(auditLogger);
    const slowRegistry = {
      get(namespace: string, name: string) {
        if (namespace === 'slow' && name === 'handler') {
          return {
            ok: true,
            value: {
              definition: { namespace: 'slow', name: 'handler', params: [{ name: 'value', type: 'string', required: false }] },
              handler: () => new Promise(() => {}), // never resolves
            },
          };
        }
        return { ok: false, error: { code: 'NOT_FOUND', message: 'not found' } };
      },
    };
    const core = new Core({ registry: slowRegistry as any, auditLogger, timeouts: { global_ms: 30 } });

    await core.exec('slow:handler --value password=hunter2secret', 'session-R');

    const evt = events.find(e => e.type === 'error:timeout');
    expect(evt).toBeDefined();
    expect(evt.data.command).not.toContain('hunter2secret');
    expect(evt.data.command).toContain('[REDACTED:password]');
  });

  it('AU22: batch[] enmascara secretos inline en el texto de cada item', async () => {
    const auditLogger = new AuditLogger('default');
    const events = collectEvents(auditLogger);
    const core = new Core({ registry: createMockRegistry() as any, auditLogger });

    await core.exec('batch[secret:set --value password=hunter2secret]', 'session-S');

    const evt = events.find(e => e.type === 'command:executed' && e.data.command?.includes('secret:set'));
    expect(evt).toBeDefined();
    expect(evt.data.command).not.toContain('hunter2secret');
    // Regresion (ronda 63 del audit, HIGH): ver comentario identico en AU18.
    expect(evt.data.command).toContain('--value [REDACTED]');
  });

  /**
   * Regresion (ronda 49 del audit, MEDIUM-HIGH): convertArgTypes() nunca
   * aplicaba param.default para un param ausente — a diferencia de
   * Executor.validateArgs(), que si lo hace (tanto para required como
   * optional). Un handler que confiara en el default declarado por
   * optionalParam() (patron usado en 40+ lugares en los skills shipeados)
   * recibia undefined en vez del valor default.
   */
  it('AU23: convertArgTypes aplica param.default para un param optional ausente', async () => {
    const registry = {
      get(namespace: string, name: string) {
        if (namespace === 'greet' && name === 'hello') {
          return {
            ok: true,
            value: {
              definition: {
                namespace: 'greet', name: 'hello',
                params: [{ name: 'greeting', type: 'string', required: false, default: 'hi' }],
              },
              handler: async (args: any) => ({ success: true, data: { greeting: args.greeting } }),
            },
          };
        }
        return { ok: false, error: { code: 'NOT_FOUND', message: 'not found' } };
      },
    };
    const core = new Core({ registry: registry as any });

    const res = await core.exec('greet:hello');

    expect(res.code).toBe(0);
    expect(res.data.greeting).toBe('hi');
  });

  it('AU24: convertArgTypes aplica param.default para un param required ausente (evita el error de required)', async () => {
    const registry = {
      get(namespace: string, name: string) {
        if (namespace === 'greet' && name === 'hello2') {
          return {
            ok: true,
            value: {
              definition: {
                namespace: 'greet', name: 'hello2',
                params: [{ name: 'greeting', type: 'string', required: true, default: 'hi' }],
              },
              handler: async (args: any) => ({ success: true, data: { greeting: args.greeting } }),
            },
          };
        }
        return { ok: false, error: { code: 'NOT_FOUND', message: 'not found' } };
      },
    };
    const core = new Core({ registry: registry as any });

    const res = await core.exec('greet:hello2');

    expect(res.code).toBe(0);
    expect(res.data.greeting).toBe('hi');
  });

  /**
   * Regresion (ronda 66 del audit, CRITICAL): this.logger.log() (tanto el
   * de execInternal() como los dos dentro de buildResponse()) pasaban el
   * comando CRUDO sin maskSecrets(redactSecretSetValue(...)) — a diferencia
   * de auditLogger.audit()/recordHistory(), que si lo hacen desde ronda
   * 49/63. Un secret:set cuyo VALOR no matchea ningun patron conocido (ej.
   * "hunter2") y que ademas tiene un typo en OTRO flag (asi nunca parsea
   * con exito) nunca llega a recordHistory() — el logger.log() terminaba
   * siendo el UNICO registro del comando fallido, en texto plano.
   */
  describe('logger.log() (config.logging.onLog) enmascara secretos — ronda 66', () => {
    function collectLogs(entries: any[]) {
      return (entry: any) => entries.push(entry);
    }

    it('AU25: el logger.log() de execInternal() (nivel INFO, cada comando) enmascara el secreto', async () => {
      const entries: any[] = [];
      const core = new Core({
        registry: createMockRegistry() as any,
        logging: { level: 'DEBUG', onLog: collectLogs(entries) },
      });

      await core.exec('secret:set --value password=hunter2secret', 'session-T');

      const evt = entries.find(e => e.module === 'core' && e.message === 'exec');
      expect(evt).toBeDefined();
      expect(JSON.stringify(evt.data)).not.toContain('hunter2secret');
      expect(evt.data.command).toContain('--value [REDACTED]');
    });

    it('AU26: el logger.log() de buildResponse() en el branch de parseError enmascara el secreto (recordHistory() nunca corre para este caso)', async () => {
      const entries: any[] = [];
      const core = new Core({
        registry: createMockRegistry() as any,
        logging: { level: 'DEBUG', onLog: collectLogs(entries) },
      });

      // --limit invalido hace que el comando nunca parsee con exito, asi
      // que recordHistory() (el otro sitio que enmascara) jamas corre para
      // este caso — el logger.log() de buildResponse() es el UNICO registro.
      await core.exec('secret:set --value password=hunter2secret --limit xx', 'session-U');

      const evt = entries.find(e => e.level === 'ERROR' && e.module === 'core');
      expect(evt).toBeDefined();
      expect(JSON.stringify(evt.data)).not.toContain('hunter2secret');
      expect(evt.data.command).toContain('--value [REDACTED]');
    });
  });
});
