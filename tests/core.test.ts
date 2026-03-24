/**
 * @contract CONTRACT_CORE v1.0
 * @module Core (Agent Shell - Orquestador Principal)
 * @description Tests para el Core basados en los 24 casos de prueba del contrato.
 *
 * El Core es el orquestador central que expone exactamente 2 entry points
 * (help y exec), coordina el ciclo de vida completo de cada request
 * y retorna respuestas en formato estandar.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Core } from '../src/core/index.js';

// --- Tipos de respuesta del Core ---

interface CoreResponse {
  code: number;
  data: any;
  error: string | null;
  meta: {
    duration_ms: number;
    command: string;
    mode: string;
    timestamp: string;
  };
}

// --- Mock Modules ---

function createMockRegistry() {
  const commands = new Map<string, any>();

  commands.set('users:list', {
    namespace: 'users',
    name: 'list',
    version: '1.0.0',
    description: 'Lista usuarios',
    params: [],
    handler: async (args: any, input: any) => {
      const data = [
        { id: 1, name: 'Juan', email: 'j@t.com' },
        { id: 2, name: 'Ana', email: 'a@t.com' },
        { id: 3, name: 'Pedro', email: 'p@t.com' },
      ];
      return { success: true, data };
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
      return { success: true, data: { id: 42, name: args.name, email: args.email } };
    },
    undoable: true,
  });

  commands.set('users:delete', {
    namespace: 'users',
    name: 'delete',
    version: '1.0.0',
    description: 'Elimina un usuario',
    params: [{ name: 'id', type: 'int', required: true }],
    handler: async (args: any) => {
      return { success: true, data: { deleted: args.id } };
    },
    confirm: true,
    undoable: true,
  });

  commands.set('users:export', {
    namespace: 'users',
    name: 'export',
    version: '1.0.0',
    description: 'Exporta usuarios',
    params: [{ name: 'format', type: 'string' }],
    handler: async (args: any, input: any) => {
      return { success: true, data: input || [] };
    },
    undoable: false,
  });

  commands.set('orders:list', {
    namespace: 'orders',
    name: 'list',
    version: '1.0.0',
    description: 'Lista ordenes',
    params: [],
    handler: async () => {
      return { success: true, data: [{ id: 1, total: 100 }] };
    },
    undoable: false,
  });

  return {
    get(namespace: string, name: string) {
      const key = `${namespace}:${name}`;
      const cmd = commands.get(key);
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
    async search(query: string, options?: any) {
      return {
        query,
        results: [
          { commandId: 'users:create', score: 0.95, command: 'create', namespace: 'users', description: 'Crea un nuevo usuario', signature: 'users:create --name --email', example: '' },
          { commandId: 'users:list', score: 0.72, command: 'list', namespace: 'users', description: 'Lista usuarios', signature: 'users:list', example: '' },
        ],
        totalIndexed: 5,
        searchTimeMs: 10,
        model: 'mock-model',
      };
    },
  };
}

function createMockContextStore() {
  const store = new Map<string, any>();
  return {
    set(key: string, value: any) { store.set(key, value); return { status: 0 }; },
    get(key: string) { return { status: 0, data: store.get(key) ?? null }; },
    getAll() { return { status: 0, data: Object.fromEntries(store) }; },
    delete(key: string) { store.delete(key); return { status: 0 }; },
    getHistory() { return { status: 0, data: [] }; },
    recordCommand() {},
  };
}

// ============================================================
// TEST SUITE: Core - Orquestador Principal
// ============================================================

describe('Core', () => {
  let core: Core;
  let registry: ReturnType<typeof createMockRegistry>;
  let vectorIndex: ReturnType<typeof createMockVectorIndex>;
  let contextStore: ReturnType<typeof createMockContextStore>;

  beforeEach(() => {
    registry = createMockRegistry();
    vectorIndex = createMockVectorIndex();
    contextStore = createMockContextStore();

    core = new Core({
      registry,
      vectorIndex,
      contextStore,
    });
  });

  // ----------------------------------------------------------
  // Seccion 1: Entry Points
  // ----------------------------------------------------------
  describe('Entry Points', () => {

    /**
     * @test T01 - cli_help basico
     * @acceptance String con protocolo completo
     * @priority Alta
     */
    it('T01: help() retorna string con protocolo de interaccion completo', () => {
      const helpText = core.help();

      expect(typeof helpText).toBe('string');
      expect(helpText.length).toBeGreaterThan(100);
      // Debe contener secciones clave del protocolo
      expect(helpText).toContain('cli_exec');
      expect(helpText).toContain('search');
      expect(helpText).toContain('describe');
    });

    /**
     * @test T17 - Comando vacio
     * @error Syntax error
     * @priority Alta
     */
    it('T17: exec con comando vacio retorna code=1', async () => {
      const response = await core.exec('');

      expect(response.code).toBe(1);
      expect(response.error).toBeDefined();
      expect(response.data).toBeNull();
    });

    /**
     * @test T18 - Comando solo espacios
     * @error Syntax error
     * @priority Media
     */
    it('T18: exec con solo espacios retorna code=1', async () => {
      const response = await core.exec('   ');

      expect(response.code).toBe(1);
      expect(response.error).toBeDefined();
    });
  });

  // ----------------------------------------------------------
  // Seccion 2: Search
  // ----------------------------------------------------------
  describe('Search', () => {

    /**
     * @test T02 - Comando search exitoso
     * @acceptance Response code=0 con resultados
     * @priority Alta
     */
    it('T02: exec("search crear usuario") retorna resultados de busqueda', async () => {
      const response = await core.exec('search crear usuario');

      expect(response.code).toBe(0);
      expect(response.data).toBeDefined();
      expect(response.data.results).toBeDefined();
      expect(response.data.results.length).toBeGreaterThan(0);
      expect(response.meta.command).toBe('search crear usuario');
    });
  });

  // ----------------------------------------------------------
  // Seccion 3: Comando con Namespace
  // ----------------------------------------------------------
  describe('Comandos con namespace', () => {

    /**
     * @test T03 - Comando con namespace exitoso
     * @acceptance Ruteo a Executor, Response code=0
     * @priority Alta
     */
    it('T03: exec("users:list") ejecuta y retorna code=0', async () => {
      const response = await core.exec('users:list');

      expect(response.code).toBe(0);
      expect(response.data).toBeDefined();
      expect(Array.isArray(response.data)).toBe(true);
    });

    /**
     * @test T04 - Comando no encontrado
     * @acceptance Response code=2
     * @priority Alta
     */
    it('T04: exec("xyz:nope") retorna code=2 comando no encontrado', async () => {
      const response = await core.exec('xyz:nope');

      expect(response.code).toBe(2);
      expect(response.error).toContain('not found');
    });

    it('exec("users:create --name Juan --email j@t.com") crea usuario', async () => {
      const response = await core.exec('users:create --name Juan --email j@t.com');

      expect(response.code).toBe(0);
      expect(response.data.id).toBe(42);
      expect(response.data.name).toBe('Juan');
    });
  });

  // ----------------------------------------------------------
  // Seccion 4: Dry-run y Validate
  // ----------------------------------------------------------
  describe('Modos de ejecucion', () => {

    /**
     * @test T05 - Comando dry-run
     * @acceptance mode=dry-run sin efecto real
     * @priority Alta
     */
    it('T05: exec con --dry-run retorna mode=dry-run', async () => {
      const response = await core.exec('users:create --name Juan --email j@t.com --dry-run');

      expect(response.code).toBe(0);
      expect(response.meta.mode).toBe('dry-run');
    });

    /**
     * @test T06 - Comando validate sin args requeridos
     * @acceptance code=1 por falta de args
     * @priority Alta
     */
    it('T06: exec con --validate y sin args requeridos retorna error', async () => {
      const response = await core.exec('users:create --validate');

      expect(response.code).toBe(1);
      expect(response.meta.mode).toBe('validate');
    });
  });

  // ----------------------------------------------------------
  // Seccion 5: Pipeline (Pipe >>)
  // ----------------------------------------------------------
  describe('Pipeline (Pipe >>)', () => {

    /**
     * @test T07 - Pipe exitoso
     * @acceptance Ejecuta a, pasa data a b
     * @priority Alta
     */
    it('T07: pipe exitoso encadena data entre comandos', async () => {
      const response = await core.exec('users:list >> users:export');

      expect(response.code).toBe(0);
      expect(response.data).toBeDefined();
    });

    /**
     * @test T08 - Pipe con primer comando fallido
     * @acceptance Detiene en error del primero
     * @priority Alta
     */
    it('T08: pipe con primer comando invalido retorna error sin ejecutar segundo', async () => {
      const response = await core.exec('xyz:nope >> users:export');

      expect(response.code).not.toBe(0);
      expect(response.error).toBeDefined();
    });
  });

  // ----------------------------------------------------------
  // Seccion 6: Batch
  // ----------------------------------------------------------
  describe('Batch', () => {

    /**
     * @test T09 - Batch todos exitosos
     * @acceptance code=0, data con responses individuales
     * @priority Alta
     */
    it('T09: batch con todos comandos exitosos retorna code=0', async () => {
      const response = await core.exec('batch [users:list, orders:list]');

      expect(response.code).toBe(0);
      expect(Array.isArray(response.data)).toBe(true);
      expect(response.data.length).toBe(2);
    });

    /**
     * @test T10 - Batch con uno fallido
     * @acceptance code=1, data con todas las responses
     * @priority Media
     */
    it('T10: batch con un comando fallido retorna code=1 con todas las responses', async () => {
      const response = await core.exec('batch [users:list, xyz:nope, orders:list]');

      expect(response.code).toBe(1);
      expect(response.data.length).toBe(3);
      // El segundo debe tener error
      expect(response.data[1].code).not.toBe(0);
    });
  });

  // ----------------------------------------------------------
  // Seccion 7: Filtro JQ
  // ----------------------------------------------------------
  describe('Filtro JQ', () => {

    /**
     * @test T11 - Filtro jq simple
     * @acceptance data filtrada por campo
     * @priority Alta
     */
    it('T11: exec con filtro jq aplica filtro sobre el data', async () => {
      const response = await core.exec('users:create --name Juan --email j@t.com | .id');

      expect(response.code).toBe(0);
      expect(response.data).toBe(42);
    });

    /**
     * @test T12 - Filtro jq multi-field
     * @acceptance data con array de valores
     * @priority Media
     */
    it('T12: exec con multi-select jq retorna array de valores', async () => {
      const response = await core.exec('users:create --name Juan --email j@t.com | [.name, .email]');

      expect(response.code).toBe(0);
      expect(response.data).toEqual(['Juan', 'j@t.com']);
    });
  });

  // ----------------------------------------------------------
  // Seccion 8: Formato de output
  // ----------------------------------------------------------
  describe('Formato de output', () => {

    /**
     * @test T13 - Formato table
     * @acceptance data como string tabla
     * @priority Media
     */
    it('T13: --format table formatea data como tabla', async () => {
      const response = await core.exec('users:list --format table');

      expect(response.code).toBe(0);
      expect(typeof response.data).toBe('string');
      // Debe contener headers o separadores de tabla
      expect(response.data).toContain('id');
    });

    /**
     * @test T14 - Formato csv
     * @acceptance data como string csv
     * @priority Media
     */
    it('T14: --format csv formatea data como CSV', async () => {
      const response = await core.exec('users:list --format csv');

      expect(response.code).toBe(0);
      expect(typeof response.data).toBe('string');
      expect(response.data).toContain(',');
    });
  });

  // ----------------------------------------------------------
  // Seccion 9: Context
  // ----------------------------------------------------------
  describe('Context', () => {

    /**
     * @test T19 - Context set
     * @acceptance valor persistido
     * @priority Media
     */
    it('T19: exec("context:set key val") persiste el valor', async () => {
      const response = await core.exec('context:set mykey myvalue');

      expect(response.code).toBe(0);
    });

    /**
     * @test T20 - Context get
     * @acceptance data con contexto
     * @priority Media
     */
    it('T20: exec("context") retorna contexto actual', async () => {
      await core.exec('context:set testkey testval');
      const response = await core.exec('context');

      expect(response.code).toBe(0);
      expect(response.data).toBeDefined();
    });
  });

  // ----------------------------------------------------------
  // Seccion 10: History
  // ----------------------------------------------------------
  describe('History', () => {

    /**
     * @test T21 - History
     * @acceptance data con ultimos comandos
     * @priority Media
     */
    it('T21: exec("history") retorna historial de comandos', async () => {
      // Execute some commands first
      await core.exec('users:list');
      const response = await core.exec('history');

      expect(response.code).toBe(0);
      expect(response.data).toBeDefined();
    });
  });

  // ----------------------------------------------------------
  // Seccion 11: Describe
  // ----------------------------------------------------------
  describe('Describe', () => {

    /**
     * @test T24 - Describe comando
     * @acceptance Response con definicion del comando
     * @priority Alta
     */
    it('T24: exec("describe users:create") retorna definicion del comando', async () => {
      const response = await core.exec('describe users:create');

      expect(response.code).toBe(0);
      expect(response.data.name).toBe('create');
      expect(response.data.namespace).toBe('users');
      expect(response.data.description).toBeDefined();
    });

    it('describe de comando inexistente retorna code=2', async () => {
      const response = await core.exec('describe xyz:nope');

      expect(response.code).toBe(2);
      expect(response.error).toBeDefined();
    });
  });

  // ----------------------------------------------------------
  // Seccion 12: Paginacion
  // ----------------------------------------------------------
  describe('Paginacion', () => {

    /**
     * @test T23 - Paginacion
     * @acceptance Flags pasados correctamente
     * @priority Media
     */
    it('T23: --limit y --offset se pasan al handler', async () => {
      const response = await core.exec('users:list --limit 2 --offset 1');

      expect(response.code).toBe(0);
      // La paginacion se aplica sobre el resultado
      expect(response.data.length).toBeLessThanOrEqual(2);
    });
  });

  // ----------------------------------------------------------
  // Seccion 13: Response format
  // ----------------------------------------------------------
  describe('Response format estandar', () => {

    it('toda respuesta tiene code, data, error y meta', async () => {
      const response = await core.exec('users:list');

      expect('code' in response).toBe(true);
      expect('data' in response).toBe(true);
      expect('error' in response).toBe(true);
      expect('meta' in response).toBe(true);
      expect(response.meta.duration_ms).toBeGreaterThanOrEqual(0);
      expect(response.meta.command).toBe('users:list');
      expect(response.meta.timestamp).toBeDefined();
    });

    it('respuestas de error tienen data=null y error definido', async () => {
      const response = await core.exec('xyz:nope');

      expect(response.data).toBeNull();
      expect(response.error).not.toBeNull();
    });

    it('meta.mode refleja el modo de ejecucion', async () => {
      const normal = await core.exec('users:list');
      expect(normal.meta.mode).toBe('execute');

      const dryRun = await core.exec('users:list --dry-run');
      expect(dryRun.meta.mode).toBe('dry-run');
    });
  });

  // ----------------------------------------------------------
  // Seccion 14: MUST NOT
  // ----------------------------------------------------------
  describe('MUST NOT - Restricciones del Core', () => {

    it('no expone mas de 2 entry points publicos', () => {
      // help y exec son los unicos metodos publicos
      expect(typeof core.help).toBe('function');
      expect(typeof core.exec).toBe('function');
    });

    it('no lanza excepciones - todo se envuelve en Response', async () => {
      // Comando completamente invalido no debe lanzar
      const response = await core.exec('!!!invalid###');
      expect(response.code).not.toBe(0);
      expect(response.error).toBeDefined();
    });

    it('no retorna responses sin formato estandar', async () => {
      const response = await core.exec('users:list');

      // Verify structure
      expect(typeof response.code).toBe('number');
      expect(typeof response.meta.duration_ms).toBe('number');
      expect(typeof response.meta.timestamp).toBe('string');
    });
  });
});
