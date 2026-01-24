/**
 * Tests del modulo de seguridad.
 *
 * Cubre: AuditLogger, Secret Detection/Masking, RBAC, EncryptedStorageAdapter.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuditLogger, maskSecrets, containsSecret, RBAC, matchPermission, matchPermissions, resolvePermission, getMissingPermissions } from '../src/security/index.js';
import { EncryptedStorageAdapter } from '../src/context-store/encrypted-storage-adapter.js';
import { randomBytes } from 'node:crypto';
import type { StorageAdapter, SessionStore } from '../src/context-store/types.js';

// --- Mock StorageAdapter ---
function createMockStorage(): StorageAdapter & { store: Map<string, any> } {
  const store = new Map<string, any>();
  return {
    name: 'mock-storage',
    store,
    async initialize() {},
    async load(id: string) { return store.get(id) ?? null; },
    async save(id: string, data: any) { store.set(id, data); },
    async destroy(id: string) { store.delete(id); },
    async healthCheck() { return true; },
    async dispose() { store.clear(); },
  };
}

// =====================================================================
// AuditLogger
// =====================================================================
describe('AuditLogger', () => {
  let logger: AuditLogger;

  beforeEach(() => {
    logger = new AuditLogger('session-001');
  });

  it('T01: emite eventos tipados con timestamp y sessionId', () => {
    const handler = vi.fn();
    logger.onAudit('command:executed', handler);
    logger.audit('command:executed', { command: 'users:list' });

    expect(handler).toHaveBeenCalledOnce();
    const event = handler.mock.calls[0][0];
    expect(event.type).toBe('command:executed');
    expect(event.sessionId).toBe('session-001');
    expect(event.data.command).toBe('users:list');
    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('T02: wildcard "*" recibe todos los eventos', () => {
    const handler = vi.fn();
    logger.onAudit('*', handler);

    logger.audit('command:executed', { a: 1 });
    logger.audit('permission:denied', { b: 2 });
    logger.audit('error:timeout', { c: 3 });

    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('T03: listeners especificos no reciben otros tipos', () => {
    const handler = vi.fn();
    logger.onAudit('command:executed', handler);

    logger.audit('permission:denied', { x: 1 });

    expect(handler).not.toHaveBeenCalled();
  });

  it('T04: multiples listeners para el mismo tipo todos reciben', () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    logger.onAudit('session:created', h1);
    logger.onAudit('session:created', h2);

    logger.audit('session:created', { user: 'test' });

    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });

  it('T05: data se incluye intacta en el evento', () => {
    const handler = vi.fn();
    logger.onAudit('command:failed', handler);

    const data = { error: 'timeout', duration: 5000, nested: { a: [1, 2] } };
    logger.audit('command:failed', data);

    expect(handler.mock.calls[0][0].data).toEqual(data);
  });

  it('T06: soporta todos los tipos de evento definidos', () => {
    const allTypes = [
      'command:executed', 'command:failed', 'permission:denied',
      'confirm:requested', 'confirm:executed', 'confirm:expired',
      'session:created', 'session:expired', 'error:handler', 'error:timeout',
    ] as const;

    const handler = vi.fn();
    logger.onAudit('*', handler);

    for (const type of allTypes) {
      logger.audit(type, {});
    }

    expect(handler).toHaveBeenCalledTimes(10);
  });
});

// =====================================================================
// Secret Detection & Masking
// =====================================================================
describe('Secret Detection (containsSecret)', () => {
  it('T07: detecta API keys genericas', () => {
    expect(containsSecret('api_key=sk_live_abc123def456ghi789jkl')).toBe(true);
    expect(containsSecret('apikey: mySecretApiKey12345678')).toBe(true);
  });

  it('T08: detecta Bearer tokens', () => {
    expect(containsSecret('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJ')).toBe(true);
  });

  it('T09: detecta passwords', () => {
    expect(containsSecret('password=superSecret123!')).toBe(true);
    expect(containsSecret('pwd: mypass1234')).toBe(true);
  });

  it('T10: detecta AWS keys', () => {
    expect(containsSecret('AKIAIOSFODNN7EXAMPLE')).toBe(true);
  });

  it('T11: detecta JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(containsSecret(jwt)).toBe(true);
  });

  it('T12: detecta private keys', () => {
    expect(containsSecret('-----BEGIN RSA PRIVATE KEY-----')).toBe(true);
    expect(containsSecret('-----BEGIN PRIVATE KEY-----')).toBe(true);
  });

  it('T13: detecta hex secrets 32+ chars', () => {
    expect(containsSecret('secret=a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4')).toBe(true);
  });

  it('T14: no detecta valores normales', () => {
    expect(containsSecret('hello world')).toBe(false);
    expect(containsSecret('users:list --limit 10')).toBe(false);
    expect(containsSecret('email=user@example.com')).toBe(false);
  });

  it('T15: detecta secretos en objetos', () => {
    expect(containsSecret({ auth: 'Bearer abc123def456ghi789jkl0123456789' })).toBe(true);
  });

  it('T16: detecta secretos en arrays', () => {
    expect(containsSecret(['normal', 'password=secret123456'])).toBe(true);
  });
});

describe('Secret Masking (maskSecrets)', () => {
  it('T17: enmascara API keys con placeholder', () => {
    const input = 'api_key=sk_live_abc123def456ghi789jkl';
    const masked = maskSecrets(input);
    expect(masked).toContain('[REDACTED:api-key]');
    expect(masked).not.toContain('sk_live_abc123');
  });

  it('T18: enmascara Bearer tokens', () => {
    const input = 'Bearer eyJhbGciOiJIUzI1NiJ9abcde';
    const masked = maskSecrets(input);
    expect(masked).toBe('Bearer [REDACTED]');
  });

  it('T19: enmascara passwords', () => {
    const input = 'password=mySecretPass123';
    const masked = maskSecrets(input);
    expect(masked).toContain('[REDACTED:password]');
    expect(masked).not.toContain('mySecretPass');
  });

  it('T20: enmascara recursivamente en objetos', () => {
    const input = {
      user: 'john',
      config: { auth: 'api_key=secretKeyValue1234567890abc' },
    };
    const masked = maskSecrets(input);
    expect(masked.user).toBe('john');
    expect(masked.config.auth).toContain('[REDACTED:api-key]');
  });

  it('T21: enmascara recursivamente en arrays', () => {
    const input = ['normal', 'password=hidden123456'];
    const masked = maskSecrets(input);
    expect(masked[0]).toBe('normal');
    expect(masked[1]).toContain('[REDACTED:password]');
  });

  it('T22: no modifica valores sin secretos', () => {
    expect(maskSecrets('hello world')).toBe('hello world');
    expect(maskSecrets(42)).toBe(42);
    expect(maskSecrets(null)).toBe(null);
    expect(maskSecrets(true)).toBe(true);
  });

  it('T23: multiples secretos en un string se enmascaran todos', () => {
    const input = 'api_key=abc123def456ghi789jkl012 and password=secret99';
    const masked = maskSecrets(input);
    expect(masked).toContain('[REDACTED:api-key]');
    expect(masked).toContain('[REDACTED:password]');
  });
});

// =====================================================================
// RBAC
// =====================================================================
describe('RBAC', () => {
  let rbac: InstanceType<typeof RBAC>;

  beforeEach(() => {
    rbac = new RBAC({
      roles: [
        { name: 'viewer', permissions: ['users:list', 'users:get'] },
        { name: 'editor', permissions: ['users:create', 'users:update'], inherits: ['viewer'] },
        { name: 'admin', permissions: ['users:delete', 'system:*'], inherits: ['editor'] },
      ],
    });
  });

  it('T24: hasRole retorna true para roles existentes', () => {
    expect(rbac.hasRole('viewer')).toBe(true);
    expect(rbac.hasRole('editor')).toBe(true);
    expect(rbac.hasRole('admin')).toBe(true);
  });

  it('T25: hasRole retorna false para roles inexistentes', () => {
    expect(rbac.hasRole('superadmin')).toBe(false);
  });

  it('T26: getRoles retorna todos los roles registrados', () => {
    const roles = rbac.getRoles();
    expect(roles).toContain('viewer');
    expect(roles).toContain('editor');
    expect(roles).toContain('admin');
    expect(roles).toHaveLength(3);
  });

  it('T27: getRolePermissions retorna permisos directos sin herencia', () => {
    expect(rbac.getRolePermissions('viewer')).toEqual(['users:list', 'users:get']);
    expect(rbac.getRolePermissions('editor')).toEqual(['users:create', 'users:update']);
  });

  it('T28: resolvePermissions resuelve herencia de roles', () => {
    const perms = rbac.resolvePermissions({ roles: ['editor'] });
    expect(perms).toContain('users:create');
    expect(perms).toContain('users:update');
    // Heredados de viewer
    expect(perms).toContain('users:list');
    expect(perms).toContain('users:get');
  });

  it('T29: resolvePermissions resuelve herencia multinivel', () => {
    const perms = rbac.resolvePermissions({ roles: ['admin'] });
    // Directos de admin
    expect(perms).toContain('users:delete');
    expect(perms).toContain('system:*');
    // Heredados de editor
    expect(perms).toContain('users:create');
    expect(perms).toContain('users:update');
    // Heredados de viewer (via editor)
    expect(perms).toContain('users:list');
    expect(perms).toContain('users:get');
  });

  it('T30: resolvePermissions incluye permisos directos del contexto', () => {
    const perms = rbac.resolvePermissions({
      roles: ['viewer'],
      permissions: ['custom:action'],
    });
    expect(perms).toContain('custom:action');
    expect(perms).toContain('users:list');
  });

  it('T31: resolvePermissions no duplica permisos', () => {
    const perms = rbac.resolvePermissions({
      roles: ['admin'],
      permissions: ['users:list'], // ya heredado
    });
    const occurrences = perms.filter(p => p === 'users:list');
    expect(occurrences).toHaveLength(1);
  });

  it('T32: herencia circular no causa loop infinito', () => {
    const circularRbac = new RBAC({
      roles: [
        { name: 'a', permissions: ['perm:a'], inherits: ['b'] },
        { name: 'b', permissions: ['perm:b'], inherits: ['a'] },
      ],
    });

    const perms = circularRbac.resolvePermissions({ roles: ['a'] });
    expect(perms).toContain('perm:a');
    expect(perms).toContain('perm:b');
  });

  it('T33: rol inexistente en herencia se ignora', () => {
    const rbacMissing = new RBAC({
      roles: [
        { name: 'child', permissions: ['perm:child'], inherits: ['nonexistent'] },
      ],
    });

    const perms = rbacMissing.resolvePermissions({ roles: ['child'] });
    expect(perms).toEqual(['perm:child']);
  });

  it('T34: getRolePermissions retorna array vacio para rol inexistente', () => {
    expect(rbac.getRolePermissions('unknown')).toEqual([]);
  });

  it('T35: multiples roles en contexto combina permisos', () => {
    const perms = rbac.resolvePermissions({ roles: ['viewer', 'editor'] });
    expect(perms).toContain('users:list');
    expect(perms).toContain('users:create');
  });
});

// =====================================================================
// EncryptedStorageAdapter
// =====================================================================
describe('EncryptedStorageAdapter', () => {
  let mockStorage: ReturnType<typeof createMockStorage>;
  let key: Buffer;
  let adapter: EncryptedStorageAdapter;

  beforeEach(() => {
    mockStorage = createMockStorage();
    key = randomBytes(32);
    adapter = new EncryptedStorageAdapter(mockStorage, { key });
  });

  it('T36: nombre incluye el adapter subyacente', () => {
    expect(adapter.name).toBe('encrypted(mock-storage)');
  });

  it('T37: save encripta y load desencripta correctamente', async () => {
    const data: SessionStore = {
      context: { entries: { user: { value: 'test', version: 1, updatedAt: '' } } },
      history: [],
      undo_snapshots: [],
    };

    await adapter.save('sess-1', data);
    const loaded = await adapter.load('sess-1');

    expect(loaded).toEqual(data);
  });

  it('T38: datos almacenados estan encriptados (no plaintext)', async () => {
    const data: SessionStore = {
      context: { entries: { secret: { value: 'very-sensitive-value', version: 1, updatedAt: '' } } },
      history: [],
      undo_snapshots: [],
    };

    await adapter.save('sess-2', data);
    const raw = mockStorage.store.get('sess-2');

    expect(raw._encrypted).toBe(true);
    expect(raw.iv).toBeDefined();
    expect(raw.tag).toBeDefined();
    expect(raw.data).toBeDefined();
    // El payload encriptado no contiene el valor en texto plano
    expect(JSON.stringify(raw)).not.toContain('very-sensitive-value');
  });

  it('T39: load retorna null si no existe la sesion', async () => {
    const result = await adapter.load('nonexistent');
    expect(result).toBeNull();
  });

  it('T40: backward compat - load de datos no encriptados los retorna directamente', async () => {
    const plainData = { context: { entries: { x: { value: 1, version: 1, updatedAt: '' } } }, history: [], undo_snapshots: [] };
    mockStorage.store.set('plain-sess', plainData);

    const loaded = await adapter.load('plain-sess');
    expect(loaded).toEqual(plainData);
  });

  it('T41: lanza error si la clave no es de 32 bytes', () => {
    expect(() => {
      new EncryptedStorageAdapter(mockStorage, { key: Buffer.alloc(16) });
    }).toThrow('32 bytes');
  });

  it('T42: destroy delega al adapter subyacente', async () => {
    mockStorage.store.set('to-delete', { context: { entries: {} } });
    await adapter.destroy('to-delete');
    expect(mockStorage.store.has('to-delete')).toBe(false);
  });

  it('T43: healthCheck delega al adapter subyacente', async () => {
    const healthy = await adapter.healthCheck();
    expect(healthy).toBe(true);
  });

  it('T44: cada save genera un IV diferente (no reutiliza)', async () => {
    const data: SessionStore = { context: { entries: {} }, history: [], undo_snapshots: [] };

    await adapter.save('sess-a', data);
    await adapter.save('sess-b', data);

    const rawA = mockStorage.store.get('sess-a');
    const rawB = mockStorage.store.get('sess-b');
    expect(rawA.iv).not.toBe(rawB.iv);
  });

  it('T45: datos corruptos causan error en load', async () => {
    mockStorage.store.set('corrupt', {
      _encrypted: true,
      iv: Buffer.from('badiv').toString('base64'),
      tag: Buffer.from('badtag').toString('base64'),
      data: 'corrupted-data',
    });

    await expect(adapter.load('corrupt')).rejects.toThrow();
  });
});

// =====================================================================
// Resource-Level Permissions (Permission Matcher)
// =====================================================================
describe('Permission Matcher (Resource-Level)', () => {
  it('T46: matchPermission con match exacto 2-level', () => {
    expect(matchPermission(['users:delete'], 'users:delete')).toBe(true);
  });

  it('T47: matchPermission con match exacto 3-level', () => {
    expect(matchPermission(['users:delete:123'], 'users:delete:123')).toBe(true);
  });

  it('T48: matchPermission deniega si no hay match', () => {
    expect(matchPermission(['users:read'], 'users:delete')).toBe(false);
  });

  it('T49: resource wildcard ns:action:* matchea cualquier resourceId', () => {
    const perms = ['users:delete:*'];
    expect(matchPermission(perms, 'users:delete:123')).toBe(true);
    expect(matchPermission(perms, 'users:delete:456')).toBe(true);
    expect(matchPermission(perms, 'users:delete:abc')).toBe(true);
  });

  it('T50: resource wildcard no matchea otro action', () => {
    expect(matchPermission(['users:delete:*'], 'users:create:123')).toBe(false);
  });

  it('T51: namespace wildcard ns:* matchea 2-level y 3-level', () => {
    const perms = ['users:*'];
    expect(matchPermission(perms, 'users:delete')).toBe(true);
    expect(matchPermission(perms, 'users:delete:123')).toBe(true);
    expect(matchPermission(perms, 'users:create')).toBe(true);
  });

  it('T52: namespace wildcard no matchea otro namespace', () => {
    expect(matchPermission(['users:*'], 'orders:delete')).toBe(false);
  });

  it('T53: global wildcard matchea todo', () => {
    const perms = ['*'];
    expect(matchPermission(perms, 'users:delete')).toBe(true);
    expect(matchPermission(perms, 'orders:create:456')).toBe(true);
    expect(matchPermission(perms, 'anything:here')).toBe(true);
  });

  it('T54: resolvePermission resuelve $param placeholders', () => {
    expect(resolvePermission('users:delete:$id', { id: 123 })).toBe('users:delete:123');
    expect(resolvePermission('$ns:$action', { ns: 'orders', action: 'read' })).toBe('orders:read');
  });

  it('T55: resolvePermission deja placeholder si arg no existe', () => {
    expect(resolvePermission('users:delete:$id', {})).toBe('users:delete:$id');
    expect(resolvePermission('users:delete:$id')).toBe('users:delete:$id');
  });

  it('T56: matchPermission con $param resuelve contra args', () => {
    const perms = ['users:delete:123'];
    expect(matchPermission(perms, 'users:delete:$id', { args: { id: 123 } })).toBe(true);
    expect(matchPermission(perms, 'users:delete:$id', { args: { id: 456 } })).toBe(false);
  });

  it('T57: matchPermissions verifica TODOS los requeridos', () => {
    const perms = ['users:read', 'users:create', 'orders:read'];
    expect(matchPermissions(perms, ['users:read', 'users:create'])).toBe(true);
    expect(matchPermissions(perms, ['users:read', 'users:delete'])).toBe(false);
  });

  it('T58: getMissingPermissions retorna los que faltan', () => {
    const perms = ['users:read', 'orders:read'];
    const missing = getMissingPermissions(perms, ['users:read', 'users:delete', 'orders:write']);
    expect(missing).toEqual(['users:delete', 'orders:write']);
  });

  it('T59: getMissingPermissions retorna vacio si todos satisfechos', () => {
    const perms = ['users:*'];
    expect(getMissingPermissions(perms, ['users:read', 'users:write'])).toEqual([]);
  });

  it('T60: RBAC.checkPermission integra resolvePermissions + matchPermission', () => {
    const rbac = new RBAC({
      roles: [
        { name: 'user-manager', permissions: ['users:read', 'users:delete:*'] },
      ],
    });
    const ctx = { roles: ['user-manager'] };

    expect(rbac.checkPermission(ctx, 'users:read')).toBe(true);
    expect(rbac.checkPermission(ctx, 'users:delete:123')).toBe(true);
    expect(rbac.checkPermission(ctx, 'users:delete:456')).toBe(true);
    expect(rbac.checkPermission(ctx, 'users:create')).toBe(false);
  });

  it('T61: RBAC.checkPermissions verifica multiples permisos', () => {
    const rbac = new RBAC({
      roles: [
        { name: 'admin', permissions: ['*'] },
        { name: 'viewer', permissions: ['users:read', 'orders:read'] },
      ],
    });

    expect(rbac.checkPermissions({ roles: ['admin'] }, ['users:delete:999', 'orders:create'])).toBe(true);
    expect(rbac.checkPermissions({ roles: ['viewer'] }, ['users:read', 'orders:write'])).toBe(false);
  });

  it('T62: RBAC.getMissingPermissions reporta faltantes con herencia', () => {
    const rbac = new RBAC({
      roles: [
        { name: 'viewer', permissions: ['users:read'] },
        { name: 'editor', permissions: ['users:create', 'users:update'], inherits: ['viewer'] },
      ],
    });

    const missing = rbac.getMissingPermissions(
      { roles: ['editor'] },
      ['users:read', 'users:create', 'users:delete']
    );
    expect(missing).toEqual(['users:delete']);
  });

  it('T63: RBAC.checkPermission con $param y args', () => {
    const rbac = new RBAC({
      roles: [
        { name: 'owner', permissions: ['docs:read:doc-1', 'docs:write:doc-1'] },
      ],
    });

    expect(rbac.checkPermission(
      { roles: ['owner'] },
      'docs:write:$docId',
      { args: { docId: 'doc-1' } }
    )).toBe(true);

    expect(rbac.checkPermission(
      { roles: ['owner'] },
      'docs:write:$docId',
      { args: { docId: 'doc-2' } }
    )).toBe(false);
  });
});
