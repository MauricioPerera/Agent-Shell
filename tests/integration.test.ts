/**
 * Tests de integracion - Flujo completo.
 *
 * Validan el ciclo end-to-end: Parser → Core → Executor → JQ Filter → Response.
 * Usan mock ligero de VectorIndex (sin embedding real) para probar el flujo
 * de discovery, ejecucion, pipelines, batch, modos y context.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Core } from '../src/core/index.js';

// --- Mock Registry con multiples comandos ---
function createIntegrationRegistry() {
  const commands = new Map<string, any>();

  commands.set('users:list', {
    namespace: 'users',
    name: 'list',
    version: '1.0.0',
    description: 'Lista todos los usuarios del sistema',
    params: [
      { name: 'limit', type: 'int', required: false, default: 10 },
      { name: 'active', type: 'bool', required: false },
    ],
    handler: async (args: any) => {
      const users = [
        { id: 1, name: 'Alice', email: 'alice@test.com', active: true },
        { id: 2, name: 'Bob', email: 'bob@test.com', active: false },
        { id: 3, name: 'Charlie', email: 'charlie@test.com', active: true },
      ];
      const limit = args.limit ?? 10;
      return { success: true, data: users.slice(0, limit) };
    },
    undoable: false,
  });

  commands.set('users:get', {
    namespace: 'users',
    name: 'get',
    version: '1.0.0',
    description: 'Obtiene un usuario por ID',
    params: [
      { name: 'id', type: 'int', required: true },
    ],
    handler: async (args: any) => {
      return { success: true, data: { id: args.id, name: 'Alice', email: 'alice@test.com' } };
    },
    undoable: false,
  });

  commands.set('users:create', {
    namespace: 'users',
    name: 'create',
    version: '1.0.0',
    description: 'Crea un nuevo usuario',
    params: [
      { name: 'name', type: 'string', required: true },
      { name: 'email', type: 'string', required: true },
    ],
    handler: async (args: any) => {
      return { success: true, data: { id: 99, name: args.name, email: args.email } };
    },
    undoable: true,
  });

  commands.set('users:count', {
    namespace: 'users',
    name: 'count',
    version: '1.0.0',
    description: 'Cuenta el total de usuarios',
    params: [],
    handler: async (_args: any, input: any) => {
      if (input && Array.isArray(input)) {
        return { success: true, data: { count: input.length } };
      }
      return { success: true, data: { count: 3 } };
    },
    undoable: false,
  });

  commands.set('users:delete', {
    namespace: 'users',
    name: 'delete',
    version: '1.0.0',
    description: 'Elimina un usuario por ID',
    params: [
      { name: 'id', type: 'int', required: true },
    ],
    handler: async (args: any) => {
      return { success: true, data: { deleted: args.id } };
    },
    confirm: true,
    undoable: true,
    requiredPermissions: ['users:delete'],
  });

  commands.set('math:add', {
    namespace: 'math',
    name: 'add',
    version: '1.0.0',
    description: 'Suma dos numeros',
    params: [
      { name: 'a', type: 'int', required: true },
      { name: 'b', type: 'int', required: true },
    ],
    handler: async (args: any) => {
      return { success: true, data: { result: Number(args.a) + Number(args.b) } };
    },
    undoable: false,
  });

  commands.set('system:echo', {
    namespace: 'system',
    name: 'echo',
    version: '1.0.0',
    description: 'Repite el input recibido',
    params: [
      { name: 'message', type: 'string', required: true },
    ],
    handler: async (args: any) => {
      return { success: true, data: { echo: args.message } };
    },
    undoable: false,
  });

  return {
    get(namespace: string, name: string) {
      const cmd = commands.get(`${namespace}:${name}`);
      if (!cmd) return { ok: false, error: { code: 'COMMAND_NOT_FOUND', message: `Command ${namespace}:${name} not found` } };
      return { ok: true, value: { definition: cmd, handler: cmd.handler, registeredAt: new Date().toISOString() } };
    },
    resolve(namespace: string, name: string) {
      return this.get(namespace, name);
    },
    listAll() {
      return Array.from(commands.values());
    },
    listByNamespace(ns: string) {
      return Array.from(commands.values()).filter((c: any) => c.namespace === ns);
    },
    getNamespaces() {
      return [...new Set(Array.from(commands.values()).map((c: any) => c.namespace))];
    },
  };
}

function createMockVectorIndex() {
  return {
    async search(query: string) {
      const all = [
        { commandId: 'users:list', score: 0.9, command: 'list', namespace: 'users', description: 'Lista usuarios', signature: 'users:list --limit --active', example: '' },
        { commandId: 'users:create', score: 0.85, command: 'create', namespace: 'users', description: 'Crea un usuario', signature: 'users:create --name --email', example: '' },
        { commandId: 'users:get', score: 0.8, command: 'get', namespace: 'users', description: 'Obtiene usuario por ID', signature: 'users:get --id', example: '' },
        { commandId: 'math:add', score: 0.7, command: 'add', namespace: 'math', description: 'Suma numeros', signature: 'math:add --a --b', example: '' },
      ];
      // Simple keyword matching for the mock
      const q = query.toLowerCase();
      const results = all.filter(r =>
        r.description.toLowerCase().includes(q) ||
        r.namespace.includes(q) ||
        r.command.includes(q)
      );
      return {
        query,
        results: results.length > 0 ? results : all.slice(0, 2),
        totalIndexed: all.length,
        searchTimeMs: 1,
        model: 'mock',
      };
    },
  };
}

function createMockContextStore() {
  const store = new Map<string, any>();
  const history: any[] = [];
  return {
    set(key: string, value: any) { store.set(key, value); return { status: 0 }; },
    get(key: string) { return { status: 0, data: store.get(key) ?? null }; },
    getAll() { return { status: 0, data: Object.fromEntries(store) }; },
    delete(key: string) { store.delete(key); return { status: 0 }; },
    getHistory() { return { status: 0, data: history }; },
    recordCommand(entry: any) { history.push(entry); },
  };
}

// =====================================================================

describe('Integration: Flujo completo', () => {
  let core: Core;

  beforeEach(() => {
    core = new Core({
      registry: createIntegrationRegistry(),
      vectorIndex: createMockVectorIndex(),
      contextStore: createMockContextStore(),
    });
  });

  // --- Ejecucion basica ---

  describe('Ejecucion de comandos', () => {
    it('T01: ejecuta un comando simple y retorna code=0', async () => {
      const res = await core.exec('users:list');
      expect(res.code).toBe(0);
      expect(res.data).toHaveLength(3);
      expect(res.error).toBeNull();
    });

    it('T02: ejecuta comando con argumentos named', async () => {
      const res = await core.exec('users:create --name "John" --email "j@t.com"');
      expect(res.code).toBe(0);
      expect(res.data.name).toBe('John');
      expect(res.data.email).toBe('j@t.com');
    });

    it('T03: ejecuta comando con argumento numerico', async () => {
      const res = await core.exec('math:add --a 5 --b 3');
      expect(res.code).toBe(0);
      expect(res.data.result).toBe(8);
    });

    it('T04: comando inexistente retorna code=2', async () => {
      const res = await core.exec('unknown:cmd');
      expect(res.code).toBe(2);
      expect(res.error).toBeTruthy();
    });

    it('T05: --validate falla si argumento requerido falta', async () => {
      const res = await core.exec('users:create --name "John" --validate');
      expect(res.code).toBe(1);
      expect(res.error).toContain('email');
    });
  });

  // --- JQ Filter ---

  describe('JQ Filter sobre output', () => {
    it('T06: extrae campo con .campo', async () => {
      const res = await core.exec('users:get --id 1 | .name');
      expect(res.code).toBe(0);
      expect(res.data).toBe('Alice');
    });

    it('T07: extrae campo anidado', async () => {
      const res = await core.exec('users:get --id 1 | .email');
      expect(res.code).toBe(0);
      expect(res.data).toBe('alice@test.com');
    });

    it('T08: multi-select extrae multiples campos', async () => {
      const res = await core.exec('users:get --id 1 | [.name, .email]');
      expect(res.code).toBe(0);
      expect(res.data).toEqual(['Alice', 'alice@test.com']);
    });
  });

  // --- Modos de ejecucion ---

  describe('Modos de ejecucion', () => {
    it('T09: --dry-run simula sin ejecutar handler', async () => {
      const res = await core.exec('users:create --name "Test" --email "t@t.com" --dry-run');
      expect(res.code).toBe(0);
      expect(res.meta.mode).toBe('dry-run');
      expect(res.data.dryRun).toBe(true);
      expect(res.data.args.name).toBe('Test');
    });

    it('T10: --validate con params correctos retorna valid=true', async () => {
      const res = await core.exec('users:create --name "Test" --email "t@t.com" --validate');
      expect(res.code).toBe(0);
      expect(res.meta.mode).toBe('validate');
      expect(res.data.valid).toBe(true);
    });

    it('T11: --validate falla si argumento requerido falta', async () => {
      const res = await core.exec('users:create --name "Test" --validate');
      expect(res.code).toBe(1);
      expect(res.error).toContain('email');
    });

    it('T12: --confirm establece mode=confirm', async () => {
      const res = await core.exec('users:delete --id 5 --confirm');
      expect(res.meta.mode).toBe('confirm');
    });
  });

  // --- Discovery ---

  describe('Discovery y builtins', () => {
    it('T13: help() retorna texto del protocolo', () => {
      const text = core.help();
      expect(text).toContain('Agent Shell');
      expect(text).toContain('search');
      expect(text).toContain('cli_exec');
    });

    it('T14: search retorna resultados del vector index', async () => {
      const res = await core.exec('search crear usuario');
      expect(res.code).toBe(0);
      expect(res.data.results).toBeDefined();
      expect(res.data.results.length).toBeGreaterThan(0);
    });

    it('T15: describe retorna definicion de un comando', async () => {
      const res = await core.exec('describe users:list');
      expect(res.code).toBe(0);
      expect(res.data.namespace).toBe('users');
      expect(res.data.name).toBe('list');
    });

    it('T16: describe de comando inexistente retorna code=2', async () => {
      const res = await core.exec('describe fake:cmd');
      expect(res.code).toBe(2);
    });
  });

  // --- Context ---

  describe('Context store', () => {
    it('T17: context:set persiste un valor', async () => {
      const res = await core.exec('context:set tema dark');
      expect(res.code).toBe(0);
    });

    it('T18: context retorna valores persistidos', async () => {
      await core.exec('context:set lang es');
      const res = await core.exec('context');
      expect(res.code).toBe(0);
    });
  });

  // --- Pipeline ---

  describe('Pipeline (>>)', () => {
    it('T19: pipeline pasa output de cmd1 como input de cmd2', async () => {
      const res = await core.exec('users:list >> users:count');
      expect(res.code).toBe(0);
      expect(res.data.count).toBe(3);
    });
  });

  // --- Batch ---

  describe('Batch execution', () => {
    it('T20: batch ejecuta multiples comandos', async () => {
      const res = await core.exec('batch [math:add --a 1 --b 2, math:add --a 3 --b 4]');
      expect(res.code).toBe(0);
      expect(res.data).toHaveLength(2);
      expect(res.data[0].data.result).toBe(3);
      expect(res.data[1].data.result).toBe(7);
    });
  });

  // --- Response format ---

  describe('Formato de respuesta', () => {
    it('T21: toda respuesta tiene code, data, error y meta', async () => {
      const res = await core.exec('users:list');
      expect(res).toHaveProperty('code');
      expect(res).toHaveProperty('data');
      expect(res).toHaveProperty('error');
      expect(res).toHaveProperty('meta');
    });

    it('T22: meta incluye duration_ms, command, mode y timestamp', async () => {
      const res = await core.exec('users:list');
      expect(res.meta.duration_ms).toBeGreaterThanOrEqual(0);
      expect(res.meta.command).toBe('users:list');
      expect(res.meta.mode).toBe('execute');
      expect(res.meta.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('T23: --format json es el default', async () => {
      const res = await core.exec('users:list --format json');
      expect(res.code).toBe(0);
    });
  });

  // --- Input validation ---

  describe('Validacion de input', () => {
    it('T24: input vacio retorna error', async () => {
      const res = await core.exec('');
      expect(res.code).not.toBe(0);
    });

    it('T25: input que excede maxInputLength retorna error', async () => {
      const longCore = new Core({
        registry: createIntegrationRegistry(),
        maxInputLength: 20,
      });
      const res = await longCore.exec('users:list --limit 10 --format json');
      expect(res.code).toBe(1);
    });
  });

  // --- Flujo completo del agente ---

  describe('Flujo tipico del agente LLM', () => {
    it('T26: flujo completo help → search → describe → dry-run → exec con filter', async () => {
      // 1. Agente obtiene protocolo
      const help = core.help();
      expect(help).toContain('search');

      // 2. Agente busca comandos
      const searchRes = await core.exec('search lista usuarios');
      expect(searchRes.code).toBe(0);
      expect(searchRes.data.results.length).toBeGreaterThan(0);

      // 3. Agente describe el comando encontrado
      const descRes = await core.exec('describe users:list');
      expect(descRes.code).toBe(0);
      expect(descRes.data.name).toBe('list');

      // 4. Agente ejecuta con dry-run para simular
      const dryRes = await core.exec('users:list --dry-run');
      expect(dryRes.code).toBe(0);
      expect(dryRes.meta.mode).toBe('dry-run');
      expect(dryRes.data.dryRun).toBe(true);

      // 5. Agente ejecuta real y filtra primer elemento
      const execRes = await core.exec('users:list | .[0].name');
      expect(execRes.code).toBe(0);
      expect(execRes.data).toBe('Alice');
    });
  });
});
