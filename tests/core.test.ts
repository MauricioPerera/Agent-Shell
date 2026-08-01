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

  commands.set('users:purge', {
    namespace: 'users',
    name: 'purge',
    version: '1.0.0',
    description: 'Elimina permanentemente todos los datos de un usuario (para tests de requiresConfirmation)',
    params: [{ name: 'id', type: 'int', required: true }],
    handler: async (args: any) => {
      return { success: true, data: { purged: args.id } };
    },
    requiresConfirmation: true,
    undoable: false,
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

  commands.set('users:fail', {
    namespace: 'users',
    name: 'fail',
    version: '1.0.0',
    description: 'Comando que siempre falla (para tests de propagacion de errores)',
    params: [],
    handler: async () => {
      return { success: false, data: null, error: 'Something specific went wrong' };
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

  commands.set('users:get', {
    namespace: 'users',
    name: 'get',
    version: '1.0.0',
    description: 'Obtiene un usuario (para tests de $input.field en pipelines)',
    params: [{ name: 'id', type: 'int', required: true }],
    handler: async () => {
      return { success: true, data: { id: 7, name: 'Referenced' } };
    },
    undoable: false,
  });

  commands.set('users:setProfile', {
    namespace: 'users',
    name: 'setProfile',
    version: '1.0.0',
    description: 'Actualiza el perfil de un usuario (para tests de type/constraint validation)',
    params: [
      { name: 'age', type: 'int', required: true, constraints: { min: 0, max: 150 } },
      { name: 'role', type: 'enum', required: true, enumValues: ['admin', 'user'] },
    ],
    handler: async (args: any) => {
      return { success: true, data: args };
    },
    undoable: false,
  });

  commands.set('echo:args', {
    namespace: 'echo',
    name: 'args',
    version: '1.0.0',
    description: 'Devuelve los args recibidos tal cual (para verificar resolucion de $input.field)',
    params: [{ name: 'user-id', type: 'string' }],
    handler: async (args: any) => {
      return { success: true, data: args };
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
    async set(key: string, value: any) { store.set(key, value); return { status: 0 }; },
    async get(key: string) { return { status: 0, data: store.get(key) ?? null }; },
    async getAll() { return { status: 0, data: Object.fromEntries(store) }; },
    async delete(key: string) { store.delete(key); return { status: 0 }; },
    async getHistory() { return { status: 0, data: [] }; },
    async recordCommand() {},
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

    /**
     * Regresion: cuando un handler retorna { success: false, error }, executeCommand
     * descartaba `error` y devolvia `result.data` (null) con code=0 — un falso exito
     * que ocultaba por que fallo el comando (encontrado auditando el flujo real via
     * Core.exec(), el path que usa `agent-shell serve`).
     */
    it('exec("users:fail") propaga success:false como error real, no como falso exito', async () => {
      const response = await core.exec('users:fail');

      expect(response.code).not.toBe(0);
      expect(response.data).toBeNull();
      expect(response.error).toContain('Something specific went wrong');
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

    /**
     * Regresion (ronda 31 del audit): convertArgTypes() solo chequeaba
     * presencia de params requeridos bajo --validate (validateCommand()) —
     * un caller normal, SIN --validate, que omitia un param requerido
     * pasaba directo al handler con ese arg en undefined, en vez de
     * rechazar con code=1/E_INVALID_ARGS como ya hace Executor
     * (validateArgs(), incondicional en todo modo).
     */
    it('T06k: exec SIN --validate y sin args requeridos igual rechaza con code=1', async () => {
      const response = await core.exec('users:create --name Juan');

      expect(response.code).toBe(1);
      expect(response.error).toContain('email');
      expect(response.data).toBeNull();
    });
  });

  /**
   * Regresion: HELP_TEXT ya documentaba "--confirm: Preview before
   * executing" y "code 4: Requires confirmation", pero executeCommand()
   * solo etiquetaba mode='confirm' y ejecutaba el handler igual — el flag
   * no hacia nada. Ahora --confirm devuelve una preview + token (code 4)
   * SIN ejecutar, y solo corre via el nuevo builtin `confirm <token>`.
   */
  describe('Confirmacion en dos pasos (--confirm)', () => {
    it('T06b: --confirm NO ejecuta el handler, retorna preview + token con code=4', async () => {
      const response = await core.exec('users:delete --id 5 --confirm');

      expect(response.code).toBe(4);
      expect(response.meta.mode).toBe('confirm');
      expect(response.data.confirmRequired).toBe(true);
      expect(response.data.preview.command).toBe('users:delete');
      // id is declared type:'int' — Core converts it before building the
      // preview (see core/index.ts's convertArgTypes), so it's the number
      // 5, not the raw string '5' the parser originally produced.
      expect(response.data.preview.args).toEqual({ id: 5 });
      expect(typeof response.data.confirmToken).toBe('string');

      // El handler NO debe haber corrido: confirmar eso via el propio
      // resultado, ya que el mock no tiene side effects observables aparte
      // de su valor de retorno — el siguiente test prueba que SI corre
      // recien al confirmar.
    });

    it('T06c: confirm <token> ejecuta el comando pendiente y retorna su resultado real', async () => {
      const preview = await core.exec('users:delete --id 5 --confirm');
      const token = preview.data.confirmToken;

      const response = await core.exec(`confirm ${token}`);

      expect(response.code).toBe(0);
      expect(response.data).toEqual({ deleted: 5 });
    });

    it('T06d: un token invalido o ya usado retorna error, no ejecuta nada', async () => {
      const preview = await core.exec('users:delete --id 5 --confirm');
      const token = preview.data.confirmToken;

      await core.exec(`confirm ${token}`); // consume el token
      const second = await core.exec(`confirm ${token}`); // reintento

      expect(second.code).toBe(2);
      expect(second.error).toContain('Invalid or expired');
    });

    it('T06e: un token que nunca existio retorna error', async () => {
      const response = await core.exec('confirm not-a-real-token');

      expect(response.code).toBe(2);
      expect(response.error).toContain('Invalid or expired');
    });

    it('T06f: confirm sin token retorna error de uso', async () => {
      const response = await core.exec('confirm');

      expect(response.code).toBe(1);
      expect(response.error).toContain('Usage: confirm');
    });

    it('T06g: un token expirado (TTL vencido) retorna error', async () => {
      const shortTtlCore = new Core({
        registry: createMockRegistry(),
        vectorIndex: createMockVectorIndex(),
        contextStore: createMockContextStore(),
        confirmTTL_ms: 1,
      });

      const preview = await shortTtlCore.exec('users:delete --id 5 --confirm');
      const token = preview.data.confirmToken;

      await new Promise(resolve => setTimeout(resolve, 20));

      const response = await shortTtlCore.exec(`confirm ${token}`);
      expect(response.code).toBe(2);
      expect(response.error).toContain('Invalid or expired');
    });

    /**
     * Regresion: registeredCmd.requiresConfirmation (documentado en
     * contracts/command-registry.md como "Si requiere --confirm por
     * defecto") esta persistido end-to-end (command-builder,
     * sqlite-registry-adapter) desde siempre, pero Core nunca lo leia — solo
     * el --confirm que pasaba el CALLER disparaba la preview. Un comando
     * marcado requiresConfirmation ejecutaba directo sin ningun preview,
     * exactamente el escenario que ese flag existe para prevenir.
     */
    it('T06i: un comando con requiresConfirmation pide preview aunque el caller NO pase --confirm', async () => {
      const response = await core.exec('users:purge --id 9');

      expect(response.code).toBe(4);
      expect(response.meta.mode).toBe('confirm');
      expect(response.data.confirmRequired).toBe(true);
      expect(response.data.preview.command).toBe('users:purge');
      expect(typeof response.data.confirmToken).toBe('string');
    });

    it('T06j: confirmar el token de un comando requiresConfirmation lo ejecuta de verdad', async () => {
      const preview = await core.exec('users:purge --id 9');
      const token = preview.data.confirmToken;

      const response = await core.exec(`confirm ${token}`);

      expect(response.code).toBe(0);
      expect(response.data).toEqual({ purged: 9 });
    });

    it('T06k: --dry-run sigue teniendo prioridad sobre requiresConfirmation (no pide preview)', async () => {
      const response = await core.exec('users:purge --id 9 --dry-run');

      expect(response.code).toBe(0);
      expect(response.meta.mode).toBe('dry-run');
      expect(response.data.dryRun).toBe(true);
    });
  });

  // ----------------------------------------------------------
  // Cancelacion cooperativa en timeout (paridad con Executor)
  // ----------------------------------------------------------
  describe('Cancelacion cooperativa en timeout (signal)', () => {
    it('T06h: el handler recibe {sessionId, signal} y la signal se aborta cuando el timeout global expira', async () => {
      let observedAbort = false;
      let observedSessionId: string | undefined;
      const slowRegistry = createMockRegistry();
      const originalGet = slowRegistry.get.bind(slowRegistry);
      (slowRegistry as any).get = (namespace: string, name: string) => {
        if (namespace === 'slow' && name === 'handler') {
          return {
            ok: true,
            value: {
              definition: { namespace: 'slow', name: 'handler', params: [] },
              handler: async (_args: any, _input: any, ctx: any) => {
                observedSessionId = ctx?.sessionId;
                await new Promise<void>((resolve) => {
                  ctx?.signal?.addEventListener('abort', () => {
                    observedAbort = true;
                    resolve();
                  });
                  // Safety net so the test can't hang if the signal never fires.
                  setTimeout(resolve, 500);
                });
                return { success: true, data: { done: true } };
              },
            },
          };
        }
        return originalGet(namespace, name);
      };

      const shortTimeoutCore = new Core({
        registry: slowRegistry,
        vectorIndex: createMockVectorIndex(),
        contextStore: createMockContextStore(),
        timeouts: { global_ms: 50 },
      });

      const response = await shortTimeoutCore.exec('slow:handler', 'session-abc');

      expect(response.code).toBe(1);
      expect(response.error).toContain('timed out');
      expect(observedAbort).toBe(true);
      expect(observedSessionId).toBe('session-abc');
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

    it('pipe con paso que falla incluye el motivo real del handler en el error', async () => {
      const response = await core.exec('users:fail >> users:export');

      expect(response.code).not.toBe(0);
      expect(response.error).toContain('Something specific went wrong');
    });

    /**
     * Regresion: Executor (el motor NO cableado a ningun entry point real)
     * resuelve referencias $input.campo en pipelines desde siempre; Core (el
     * motor que cli/index.ts y server/index.ts SI cablean) nunca lo hacia —
     * un pipeline como `users:get --id 1 >> echo:args --user-id $input.id`
     * mandaba el string literal "$input.id" al segundo paso en vez del id
     * real resuelto del output del primero.
     */
    it('resuelve referencias $input.campo del output del paso anterior', async () => {
      const response = await core.exec('users:get --id 1 >> echo:args --user-id $input.id');

      expect(response.code).toBe(0);
      // echo:args devuelve los args que recibio: user-id debe ser el id
      // real (7, del mock de users:get), no el string literal "$input.id".
      expect(response.data['user-id']).toBe('7');
    });

    it('deja el literal $input.campo intacto cuando el campo no existe en el output previo', async () => {
      const response = await core.exec('users:get --id 1 >> echo:args --user-id $input.nonexistent');

      expect(response.code).toBe(0);
      expect(response.data['user-id']).toBe('$input.nonexistent');
    });

    it('no intenta resolver $input.campo en el primer paso del pipeline (no hay output previo)', async () => {
      const response = await core.exec('echo:args --user-id $input.id >> users:get --id 1');

      expect(response.code).toBe(0);
      // El primer paso no tiene input previo; el literal llega tal cual.
    });

    /**
     * Regresion (hallazgo de auditoria de seguridad): executePipeline()
     * llamaba registeredCmd.handler(...) directo, sin chequear
     * flags.confirm ni registeredCmd.requiresConfirmation en absoluto —
     * a diferencia de executeCommand()/executeBatch(), que si lo hacen.
     * Un pipeline como `users:list >> users:purge --id 9` corria la
     * purga irreversible sin preview, evadiendo por completo la
     * proteccion que requiresConfirmation existe para dar (T06i-k
     * arriba prueban exactamente ese comando ejecutado SOLO, sin pipeline).
     */
    it('un paso de pipeline con requiresConfirmation pide preview, NO ejecuta el handler', async () => {
      const response = await core.exec('users:list >> users:purge --id 9');

      expect(response.code).toBe(4);
      expect(response.meta.mode).toBe('confirm');
      expect(response.data.confirmRequired).toBe(true);
      expect(response.data.preview.command).toBe('users:purge');
      expect(typeof response.data.confirmToken).toBe('string');
    });

    it('confirmar el token de un paso de pipeline con requiresConfirmation lo ejecuta de verdad', async () => {
      const preview = await core.exec('users:list >> users:purge --id 9');
      const token = preview.data.confirmToken;

      const response = await core.exec(`confirm ${token}`);

      expect(response.code).toBe(0);
      expect(response.data).toEqual({ purged: 9 });
    });

    it('un pipeline sin ningun paso requiresConfirmation sigue ejecutando normal (sin regresion)', async () => {
      const response = await core.exec('users:list >> users:export');

      expect(response.code).toBe(0);
      expect(response.data).toBeDefined();
    });

    /**
     * Regresion (ronda 31 del audit): executePipeline() nunca leia
     * flags.dryRun/flags.validate por paso — un pipeline con --dry-run en
     * el primer comando ejecutaba TODOS los pasos de verdad mientras la
     * respuesta final igual reportaba meta.mode='dry-run' (leido aparte
     * por execInternal). Ahora --dry-run en el primer comando se propaga a
     * todo el pipeline y cada paso se simula en vez de correr su handler.
     */
    it('--dry-run en el primer comando del pipeline se propaga a TODOS los pasos (ninguno ejecuta de verdad)', async () => {
      const response = await core.exec('users:delete --id 5 --dry-run >> users:export');

      expect(response.code).toBe(0);
      expect(response.meta.mode).toBe('dry-run');
      // Si el segundo paso hubiera corrido de verdad, users:export retorna
      // `input || []` (el resultado real de users:delete, { deleted: 5 }).
      // En vez de eso, el paso se simulo: la data final es la forma
      // simulada del ULTIMO paso, no el resultado real de ningun handler.
      expect(response.data).toEqual({
        dryRun: true,
        command: 'users:export',
        args: {},
      });
    });

    /**
     * Regresion (ronda 31 del audit), misma causa que el test anterior:
     * --validate en un paso intermedio de un pipeline se ignoraba por
     * completo — el handler real corria igual. A diferencia de --dry-run,
     * --validate NO se propaga globalmente desde el primer comando (misma
     * asimetria que Executor): solo valida el paso que trae su PROPIO flag.
     */
    it('--validate en un paso intermedio del pipeline lo simula, no propaga a los demas pasos', async () => {
      const response = await core.exec('users:list >> users:create --name Ana --email a@b.com --validate');

      expect(response.code).toBe(0);
      // Si el handler real hubiera corrido, retornaria { id: 42, name:
      // 'Ana', email: 'a@b.com' } en vez de la forma de validacion.
      expect(response.data).toEqual({ valid: true, command: 'users:create' });
    });

    it('un param requerido faltante bajo --validate en un paso de pipeline aborta con code=1', async () => {
      const response = await core.exec('users:list >> users:create --name Ana --validate');

      expect(response.code).toBe(1);
      expect(response.error).toContain('email');
    });
  });

  /**
   * Regresion: Core (el motor que cli/index.ts y server/index.ts realmente
   * cablean) nunca leia param.type/constraints/enumValues — solo chequeaba
   * presencia de params requeridos bajo --validate. Un param declarado
   * type:'int' con constraints {min,max}, o type:'enum', pasaba como string
   * crudo al handler sin ninguna conversion ni chequeo. Executor (nunca
   * cableado a un entry point real) siempre hizo esta conversion via
   * convertType(); ahora Core la porta y la aplica sin condicionar al modo
   * (--validate, --dry-run, --confirm o ejecucion normal).
   */
  describe('Conversion de tipos y constraints de params', () => {
    it('convierte un param type:int a numero antes de llegar al handler', async () => {
      const response = await core.exec('users:setProfile --age 30 --role admin');

      expect(response.code).toBe(0);
      expect(response.data.age).toBe(30);
      expect(typeof response.data.age).toBe('number');
    });

    it('rechaza un param type:int no numerico con E_TYPE_MISMATCH (code=1)', async () => {
      const response = await core.exec('users:setProfile --age abc --role admin');

      expect(response.code).toBe(1);
      expect(response.error).toContain("expects int");
    });

    it('rechaza un param que viola su constraint min/max', async () => {
      const response = await core.exec('users:setProfile --age 200 --role admin');

      expect(response.code).toBe(1);
      expect(response.error).toContain('constraint: max');
    });

    it('rechaza un valor fuera de enumValues para un param type:enum', async () => {
      const response = await core.exec('users:setProfile --age 30 --role superadmin');

      expect(response.code).toBe(1);
      expect(response.error).toContain('must be one of');
    });

    it('aplica la conversion de tipos tambien bajo --dry-run', async () => {
      const response = await core.exec('users:setProfile --age 30 --role admin --dry-run');

      expect(response.code).toBe(0);
      expect(response.meta.mode).toBe('dry-run');
      expect(response.data.args.age).toBe(30);
    });

    it('rechaza el type mismatch incluso bajo --dry-run (no llega a simular)', async () => {
      const response = await core.exec('users:setProfile --age abc --role admin --dry-run');

      expect(response.code).toBe(1);
    });

    it('aplica la conversion de tipos por cada paso de un pipeline', async () => {
      const response = await core.exec('users:setProfile --age 30 --role admin >> echo:args --user-id 1');

      expect(response.code).toBe(0);
    });

    it('un type mismatch en un paso intermedio del pipeline aborta con code=1', async () => {
      const response = await core.exec('users:setProfile --age notanumber --role admin >> echo:args --user-id 1');

      expect(response.code).toBe(1);
      expect(response.error).toContain('expects int');
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

    /**
     * Regresion (ronda 33 del audit): el builtin `undo` estaba stubeado
     * incondicionalmente con code=1 y un mensaje ("Undo not implemented in
     * core standalone mode") mientras HELP_TEXT lo anunciaba como un
     * comando funcional del protocolo — pero ningun comando real del
     * registry esta marcado undoable/reversible, asi que no habia nada
     * que revertir. Se removio el builtin: `undo <id>` ahora cae en el
     * mismo camino que cualquier builtin desconocido, code=2, sin fingir
     * soporte que no existe.
     */
    it('T21b: exec("undo <id>") ya no es un builtin reconocido (removido, era un stub que siempre fallaba)', async () => {
      const response = await core.exec('undo cmd_01');

      expect(response.code).toBe(2);
      expect(response.error).toContain('Unknown builtin command: undo');
    });

    it('T21c: HELP_TEXT ya no anuncia "undo" como comando soportado', () => {
      expect(core.help()).not.toMatch(/\bundo\s*<id>/);
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
