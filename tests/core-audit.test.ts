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

  return {
    get(namespace: string, name: string) {
      const key = `${namespace}:${name}`;
      const cmd = commands.get(key);
      if (!cmd) return { ok: false, error: { code: 'COMMAND_NOT_FOUND', message: `Command ${namespace}:${name} not found` } };
      return { ok: true, value: { definition: cmd, handler: cmd.handler, registeredAt: new Date().toISOString() } };
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
});
