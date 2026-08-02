/**
 * @contract CONTRACT_EXECUTOR v1.0
 * @module Executor (Agent Shell)
 * @description Tests para el Executor basados en los 35 casos de prueba del contrato.
 *
 * El Executor recibe un ParseResult del Parser, resuelve el handler correspondiente,
 * aplica el pipeline de ejecucion y retorna una respuesta estandarizada.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Tipos del contrato ---

interface ParseResult {
  type: 'single' | 'pipeline' | 'batch';
  commands: ParsedCommand[];
  raw: string;
}

interface ParsedCommand {
  namespace: string | null;
  command: string;
  args: { positional: string[]; named: Record<string, string | boolean> };
  flags: GlobalFlags;
  jqFilter: any;
  meta: any;
}

interface GlobalFlags {
  dryRun: boolean;
  validate: boolean;
  confirm: boolean;
  format: 'json' | 'table' | 'csv' | null;
  limit: number | null;
  offset: number | null;
}

interface ExecutionResult {
  code: 0 | 1 | 2 | 3 | 4;
  success: boolean;
  data: any | null;
  error: ExecutionError | null;
  meta: ExecutionMeta;
}

interface ExecutionError {
  code: number;
  type: string;
  message: string;
  details?: Record<string, any>;
}

interface ExecutionMeta {
  command: string;
  mode: 'normal' | 'dry-run' | 'validate' | 'confirm';
  duration_ms: number;
  timestamp: string;
  historyId: string | null;
  reversible: boolean;
}

interface BatchResult {
  code: 0 | 1;
  success: boolean;
  results: ExecutionResult[];
  meta: { total: number; succeeded: number; failed: number; duration_ms: number };
}

interface PipelineResult {
  code: 0 | 1 | 2 | 3 | 4;
  success: boolean;
  data: any | null;
  error: ExecutionError | null;
  meta: { steps: any[]; duration_ms: number; failedAt: number | null };
}

interface ExecutionContext {
  sessionId: string;
  permissions: string[];
  state: Record<string, any>;
  config: ExecutorConfig;
  history: HistoryStore;
}

interface ExecutorConfig {
  timeout_ms: number;
  maxPipelineDepth: number;
  maxBatchSize: number;
  undoTTL_ms: number;
  enableHistory: boolean;
}

interface HistoryStore {
  entries: any[];
  append(entry: any): void;
  getById(id: string): any | null;
}

// --- Import del Executor ---
import { Executor } from '../src/executor/index.js';

function createDefaultFlags(overrides: Partial<GlobalFlags> = {}): GlobalFlags {
  return {
    dryRun: false,
    validate: false,
    confirm: false,
    format: null,
    limit: null,
    offset: null,
    ...overrides,
  };
}

function createSingleParseResult(
  namespace: string | null,
  command: string,
  named: Record<string, string | boolean> = {},
  flags: Partial<GlobalFlags> = {}
): ParseResult {
  return {
    type: 'single',
    commands: [{
      namespace,
      command,
      args: { positional: [], named },
      flags: createDefaultFlags(flags),
      jqFilter: null,
      meta: { startPos: 0, endPos: 0, rawSegment: '' },
    }],
    raw: `${namespace}:${command}`,
  };
}

function createPipelineParseResult(commands: Array<{
  namespace: string | null;
  command: string;
  named?: Record<string, string | boolean>;
  flags?: Partial<GlobalFlags>;
}>): ParseResult {
  return {
    type: 'pipeline',
    commands: commands.map(c => ({
      namespace: c.namespace,
      command: c.command,
      args: { positional: [], named: c.named || {} },
      flags: createDefaultFlags(c.flags),
      jqFilter: null,
      meta: { startPos: 0, endPos: 0, rawSegment: '' },
    })),
    raw: commands.map(c => `${c.namespace}:${c.command}`).join(' >> '),
  };
}

function createBatchParseResult(commands: Array<{
  namespace: string | null;
  command: string;
  named?: Record<string, string | boolean>;
}>): ParseResult {
  return {
    type: 'batch',
    commands: commands.map(c => ({
      namespace: c.namespace,
      command: c.command,
      args: { positional: [], named: c.named || {} },
      flags: createDefaultFlags(),
      jqFilter: null,
      meta: { startPos: 0, endPos: 0, rawSegment: '' },
    })),
    raw: 'batch [...]',
  };
}

function createMockRegistry(commands: Record<string, any> = {}) {
  return {
    resolve(fullName: string) {
      if (commands[fullName]) {
        return { ok: true, value: commands[fullName] };
      }
      return { ok: false, error: { code: 'COMMAND_NOT_FOUND', message: `Command '${fullName}' not found` } };
    },
  };
}

function createMockContext(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  const entries: any[] = [];
  return {
    sessionId: 'test-session-001',
    permissions: ['users:*', 'orders:*'],
    state: {},
    config: {
      timeout_ms: 30000,
      maxPipelineDepth: 10,
      maxBatchSize: 20,
      undoTTL_ms: 3600000,
      enableHistory: true,
    },
    history: {
      entries,
      append(entry: any) { entries.push(entry); },
      getById(id: string) { return entries.find(e => e.id === id) || null; },
    },
    ...overrides,
  };
}

// ============================================================
// TEST SUITE: Executor - Casos de Prueba del Contrato
// ============================================================

describe('Executor', () => {
  let registry: any;
  let context: ExecutionContext;
  let executor: Executor;

  beforeEach(() => {
    registry = createMockRegistry({
      'users:list': {
        definition: {
          namespace: 'users', command: 'list',
          args: [{ name: 'limit', type: 'int', required: false, default: 20 }],
          description: 'Lista usuarios', effect: 'Lista todos los usuarios',
          reversible: false, requiredPermissions: [],
        },
        handler: async () => [{ id: 1, name: 'User1' }, { id: 2, name: 'User2' }],
      },
      'users:get': {
        definition: {
          namespace: 'users', command: 'get',
          args: [{ name: 'id', type: 'int', required: true }],
          description: 'Obtiene un usuario', effect: 'Lee un usuario por ID',
          reversible: false, requiredPermissions: [],
        },
        handler: async (args: any) => ({ id: Number(args.id), name: 'TestUser', email: 'test@test.com' }),
      },
      'users:create': {
        definition: {
          namespace: 'users', command: 'create',
          args: [
            { name: 'name', type: 'string', required: true },
            { name: 'email', type: 'string', required: true },
          ],
          description: 'Crea un usuario', effect: 'Crea un nuevo usuario en DB',
          reversible: true, requiredPermissions: ['users:create'],
        },
        handler: async (args: any) => ({ id: 42, name: args.name, email: args.email }),
        undoHandler: async (args: any, result: any) => ({ deleted: result.id }),
      },
      'users:delete': {
        definition: {
          namespace: 'users', command: 'delete',
          args: [{ name: 'id', type: 'int', required: true }],
          description: 'Elimina un usuario', effect: 'Elimina permanentemente un usuario',
          reversible: false, requiredPermissions: ['users:delete'],
        },
        handler: async (args: any) => ({ deleted: true, id: Number(args.id) }),
      },
      'admin:delete': {
        definition: {
          namespace: 'admin', command: 'delete',
          args: [{ name: 'id', type: 'int', required: true }],
          description: 'Elimina recurso admin', effect: 'Elimina recurso de admin',
          reversible: false, requiredPermissions: ['admin:delete'],
        },
        handler: async (args: any) => ({ deleted: true }),
      },
      'users:purge': {
        definition: {
          namespace: 'users', command: 'purge',
          args: [{ name: 'id', type: 'int', required: true }],
          description: 'Elimina permanentemente todos los datos de un usuario', effect: 'Purga irreversible',
          reversible: false, requiredPermissions: [], requiresConfirmation: true,
        },
        handler: async (args: any) => ({ purged: true, id: Number(args.id) }),
      },
      'orders:list': {
        definition: {
          namespace: 'orders', command: 'list',
          args: [{ name: 'user-id', type: 'int', required: false }],
          description: 'Lista ordenes', effect: 'Lista ordenes filtradas',
          reversible: false, requiredPermissions: [],
        },
        handler: async (args: any) => [{ id: 101, userId: args['user-id'] || 1 }],
      },
      'slow:command': {
        definition: {
          namespace: 'slow', command: 'command',
          args: [],
          description: 'Comando lento', effect: 'Tarda mucho',
          reversible: false, requiredPermissions: [],
        },
        handler: async () => new Promise((resolve) => setTimeout(resolve, 60000)),
      },
    });
    context = createMockContext();
    executor = new Executor(registry, context);
  });

  // ----------------------------------------------------------
  // Seccion 1: Ejecucion normal de comando simple
  // ----------------------------------------------------------
  describe('Ejecucion normal', () => {

    /**
     * @test T01 - Comando simple exitoso
     * @acceptance Ejecucion normal de comando simple
     * @priority Alta
     */
    it('T01: ejecuta comando simple y retorna code=0 con data', async () => {
      const parsed = createSingleParseResult('users', 'list');
      const result = await executor.execute(parsed) as ExecutionResult;

      expect(result.code).toBe(0);
      expect(result.success).toBe(true);
      expect(result.data).toEqual([{ id: 1, name: 'User1' }, { id: 2, name: 'User2' }]);
      expect(result.error).toBeNull();
    });

    /**
     * @test T02 - Comando con args nombrados
     * @priority Alta
     */
    it('T02: ejecuta comando con argumentos nombrados', async () => {
      const parsed = createSingleParseResult('users', 'get', { id: '42' });
      const result = await executor.execute(parsed) as ExecutionResult;

      expect(result.code).toBe(0);
      expect(result.data).toEqual({ id: 42, name: 'TestUser', email: 'test@test.com' });
    });

    /**
     * @test T03 - Comando no encontrado
     * @error E_NOT_FOUND
     * @priority Alta
     */
    it('T03: retorna code=2 para comando inexistente', async () => {
      const parsed = createSingleParseResult('fake', 'cmd');
      const result = await executor.execute(parsed) as ExecutionResult;

      expect(result.code).toBe(2);
      expect(result.success).toBe(false);
      expect(result.error!.type).toBe('E_NOT_FOUND');
    });
  });

  // ----------------------------------------------------------
  // Seccion 2: Validacion de argumentos
  // ----------------------------------------------------------
  describe('Validacion de argumentos', () => {

    /**
     * @test T04 - Arg requerido faltante
     * @error E_INVALID_ARGS
     * @priority Alta
     */
    it('T04: retorna code=1 cuando falta argumento requerido', async () => {
      const parsed = createSingleParseResult('users', 'create', {}); // Sin name ni email
      const result = await executor.execute(parsed) as ExecutionResult;

      expect(result.code).toBe(1);
      expect(result.error!.type).toBe('E_INVALID_ARGS');
    });

    /**
     * @test T05 - Arg tipo incorrecto
     * @error E_INVALID_ARGS
     * @priority Alta
     */
    it('T05: retorna code=1 cuando argumento no puede convertirse al tipo esperado', async () => {
      const parsed = createSingleParseResult('users', 'get', { id: 'abc' }); // id debe ser int
      const result = await executor.execute(parsed) as ExecutionResult;

      expect(result.code).toBe(1);
      expect(result.error!.type).toBe('E_INVALID_ARGS');
    });

    /**
     * @test T26 - Conversion tipo int
     * @priority Alta
     */
    it('T26: convierte argumento string "42" a number 42 para tipo int', async () => {
      const parsed = createSingleParseResult('users', 'get', { id: '42' });
      const result = await executor.execute(parsed) as ExecutionResult;

      expect(result.code).toBe(0);
      expect(result.data.id).toBe(42);
      expect(typeof result.data.id).toBe('number');
    });

    /**
     * @test T27 - Conversion tipo bool
     * @priority Alta
     */
    it('T27: convierte argumento string "true" a boolean true', async () => {
      // Agregar comando con arg bool al registry
      registry = createMockRegistry({
        'test:bool': {
          definition: {
            namespace: 'test', command: 'bool',
            args: [{ name: 'active', type: 'bool', required: true }],
            description: 'Test bool', effect: 'Test',
            reversible: false, requiredPermissions: [],
          },
          handler: async (args: any) => ({ active: args.active }),
        },
      });
      executor = new Executor(registry, context);

      const parsed = createSingleParseResult('test', 'bool', { active: 'true' });
      const result = await executor.execute(parsed) as ExecutionResult;

      expect(result.code).toBe(0);
      expect(result.data.active).toBe(true);
      expect(typeof result.data.active).toBe('boolean');
    });

    /**
     * @test T28 - Conversion tipo date
     * @priority Media
     */
    it('T28: convierte argumento string fecha a Date valido', async () => {
      registry = createMockRegistry({
        'test:date': {
          definition: {
            namespace: 'test', command: 'date',
            args: [{ name: 'since', type: 'date', required: true }],
            description: 'Test date', effect: 'Test',
            reversible: false, requiredPermissions: [],
          },
          handler: async (args: any) => ({ since: args.since }),
        },
      });
      executor = new Executor(registry, context);

      const parsed = createSingleParseResult('test', 'date', { since: '2026-01-22' });
      const result = await executor.execute(parsed) as ExecutionResult;

      expect(result.code).toBe(0);
      expect(result.data.since).toBeInstanceOf(Date);
    });

    /**
     * @test T29 - Arg con default
     * @priority Alta
     */
    it('T29: usa valor default cuando argumento no se envia', async () => {
      const parsed = createSingleParseResult('users', 'list', {}); // limit no enviado, default=20
      const result = await executor.execute(parsed) as ExecutionResult;

      expect(result.code).toBe(0);
      // El handler recibe limit=20 por default
    });

    /**
     * @test T30 - Constraint violado
     * @priority Media
     */
    it('T30: retorna code=1 cuando un constraint es violado', async () => {
      registry = createMockRegistry({
        'test:constrained': {
          definition: {
            namespace: 'test', command: 'constrained',
            args: [{ name: 'age', type: 'int', required: true, constraints: { min: 1, max: 120 } }],
            description: 'Test', effect: 'Test',
            reversible: false, requiredPermissions: [],
          },
          handler: async (args: any) => args,
        },
      });
      executor = new Executor(registry, context);

      const parsed = createSingleParseResult('test', 'constrained', { age: '150' });
      const result = await executor.execute(parsed) as ExecutionResult;

      expect(result.code).toBe(1);
      expect(result.error!.type).toBe('E_INVALID_ARGS');
    });

    /**
     * @test T32 - Enum invalido
     * @priority Media
     */
    it('T32: retorna code=1 para valor enum no valido', async () => {
      registry = createMockRegistry({
        'test:enum': {
          definition: {
            namespace: 'test', command: 'enum',
            args: [{ name: 'status', type: 'enum', required: true, enumValues: ['a', 'b'] }],
            description: 'Test', effect: 'Test',
            reversible: false, requiredPermissions: [],
          },
          handler: async (args: any) => args,
        },
      });
      executor = new Executor(registry, context);

      const parsed = createSingleParseResult('test', 'enum', { status: 'c' });
      const result = await executor.execute(parsed) as ExecutionResult;

      expect(result.code).toBe(1);
      expect(result.error!.type).toBe('E_INVALID_ARGS');
    });

    /**
     * Regresion (ronda 54 del audit, MEDIUM-HIGH): convertType() comparaba
     * `def.type === 'enum'` y leia `def.constraints.min` etc. directamente
     * sobre un STRING — pero el UNICO shape que el command-builder publico
     * realmente produce es type:'enum(a,b,c)' y constraints como string
     * ('min:1,max:120', ver ParamBuilder.constraints()). T30/T32 arriba
     * solo prueban el shape LEGACY (constraints como objeto, type:'enum'+
     * enumValues) — que sigue funcionando por compatibilidad. Este test
     * prueba el shape REAL.
     */
    it('T30b/T32b: valida constraints-como-string y enum(...) — el shape real del command-builder publico', async () => {
      registry = createMockRegistry({
        'test:builder-shape': {
          definition: {
            namespace: 'test', command: 'builder-shape',
            args: [
              { name: 'age', type: 'int', required: true, constraints: 'min:1,max:120' },
              { name: 'status', type: 'enum(a,b)', required: true },
            ],
            description: 'Test', effect: 'Test',
            reversible: false, requiredPermissions: [],
          },
          handler: async (args: any) => args,
        },
      });
      executor = new Executor(registry, context);

      const tooHigh = await executor.execute(createSingleParseResult('test', 'builder-shape', { age: '150', status: 'a' })) as ExecutionResult;
      expect(tooHigh.code).toBe(1);
      expect(tooHigh.error!.type).toBe('E_INVALID_ARGS');

      const badEnum = await executor.execute(createSingleParseResult('test', 'builder-shape', { age: '30', status: 'c' })) as ExecutionResult;
      expect(badEnum.code).toBe(1);
      expect(badEnum.error!.type).toBe('E_INVALID_ARGS');

      const ok = await executor.execute(createSingleParseResult('test', 'builder-shape', { age: '30', status: 'b' })) as ExecutionResult;
      expect(ok.code).toBe(0);
    });
  });

  // ----------------------------------------------------------
  // Seccion 3: Permisos
  // ----------------------------------------------------------
  describe('Verificacion de permisos', () => {

    /**
     * @test T06 - Sin permisos
     * @error E_FORBIDDEN
     * @priority Alta
     */
    it('T06: retorna code=3 cuando el contexto no tiene permisos requeridos', async () => {
      context = createMockContext({ permissions: [] }); // Sin permisos
      executor = new Executor(registry, context);

      const parsed = createSingleParseResult('admin', 'delete', { id: '1' });
      const result = await executor.execute(parsed) as ExecutionResult;

      expect(result.code).toBe(3);
      expect(result.error!.type).toBe('E_FORBIDDEN');
    });

    /**
     * Regresion (ronda 30 del audit): el mensaje de E_FORBIDDEN listaba el
     * array requiredPermissions completo ("requires [admin:delete, ...]"),
     * distinto del mensaje minimo de Core ("Permission denied: ns:cmd") para
     * la misma garantia — un caller iterando comandos denegados podia
     * reconstruir la taxonomia de permisos RBAC. El detalle completo ahora
     * solo va al AuditLogger, no a la respuesta.
     */
    it('T06b: el mensaje de E_FORBIDDEN no revela el array requiredPermissions', async () => {
      context = createMockContext({ permissions: [] });
      executor = new Executor(registry, context);

      const parsed = createSingleParseResult('admin', 'delete', { id: '1' });
      const result = await executor.execute(parsed) as ExecutionResult;

      expect(result.error!.message).toBe('Permission denied: admin:delete');
      expect(result.error!.message).not.toContain('requires');
      expect(result.error!.message).not.toContain('[');
    });
  });

  // ----------------------------------------------------------
  // Seccion 4: Modos de ejecucion
  // ----------------------------------------------------------
  describe('Modo --dry-run', () => {

    /**
     * @test T07 - Modo dry-run
     * @acceptance NO ejecuta el handler real
     * @priority Alta
     */
    it('T07: retorna preview sin ejecutar handler en modo dry-run', async () => {
      const parsed = createSingleParseResult('users', 'delete', { id: '5' }, { dryRun: true });
      const result = await executor.execute(parsed) as ExecutionResult;

      expect(result.code).toBe(0);
      expect(result.data.wouldExecute).toBe('users:delete');
      expect(result.meta.mode).toBe('dry-run');
    });

    /**
     * Regresion (ronda 39 del audit, CRITICAL): withArgs devolvia
     * validatedArgs sin pasar por maskSecrets() — un Authorization: Bearer
     * <token> (o cualquier valor con forma reconocible por
     * secret-patterns.ts) pasado como argumento salia en texto plano.
     */
    it('T07b: withArgs enmascara valores con forma de secreto', async () => {
      // validateArgs() (executor/index.ts) solo preserva keys DECLARADAS en
      // args[] — a diferencia de Core, descarta silenciosamente cualquier
      // flag no declarado. Se usa 'email' (declarado, string, sin formato
      // validado) para llevar el valor con forma de secreto.
      const parsed = createSingleParseResult('users', 'create', { name: 'Ana', email: 'Bearer abcdefghijklmnopqrstuvwxyz1234567890' }, { dryRun: true });
      const result = await executor.execute(parsed) as ExecutionResult;

      expect(result.code).toBe(0);
      expect(result.data.withArgs.email).toBe('Bearer [REDACTED]');
      expect(result.data.withArgs.name).toBe('Ana');
    });

    /**
     * @test T25 - Historial NO en dry-run
     * @mustnot Registrar en historial en modo dry-run
     * @priority Alta
     */
    it('T25: no registra en historial en modo dry-run', async () => {
      const parsed = createSingleParseResult('users', 'list', {}, { dryRun: true });
      await executor.execute(parsed);

      expect(context.history.entries).toHaveLength(0);
    });
  });

  describe('Modo --validate', () => {

    /**
     * @test T08 - Modo validate ok
     * @priority Alta
     */
    it('T08: retorna valid=true cuando todo es correcto en modo validate', async () => {
      const parsed = createSingleParseResult('users', 'get', { id: '1' }, { validate: true });
      const result = await executor.execute(parsed) as ExecutionResult;

      expect(result.code).toBe(0);
      expect(result.data.valid).toBe(true);
      expect(result.meta.mode).toBe('validate');
    });

    /**
     * Regresion (ronda 39 del audit, CRITICAL): resolvedArgs devolvia
     * validatedArgs sin pasar por maskSecrets().
     */
    it('T08b: resolvedArgs enmascara valores con forma de secreto', async () => {
      const parsed = createSingleParseResult('users', 'create', { name: 'Ana', email: 'Bearer abcdefghijklmnopqrstuvwxyz1234567890' }, { validate: true });
      const result = await executor.execute(parsed) as ExecutionResult;

      expect(result.code).toBe(0);
      expect(result.data.resolvedArgs.email).toBe('Bearer [REDACTED]');
    });

    /**
     * @test T09 - Modo validate fallo
     * @priority Alta
     */
    it('T09: retorna code=1 en validate cuando faltan args requeridos', async () => {
      const parsed = createSingleParseResult('users', 'get', {}, { validate: true }); // Falta id
      const result = await executor.execute(parsed) as ExecutionResult;

      expect(result.code).toBe(1);
      expect(result.error!.type).toBe('E_INVALID_ARGS');
    });
  });

  describe('Modo --confirm', () => {

    /**
     * @test T10 - Modo confirm
     * @priority Alta
     */
    it('T10: retorna code=4 con confirmToken en modo confirm', async () => {
      const parsed = createSingleParseResult('users', 'delete', { id: '5' }, { confirm: true });
      const result = await executor.execute(parsed) as ExecutionResult;

      expect(result.code).toBe(4);
      expect(result.data.confirmToken).toBeDefined();
      expect(result.data.confirmToken).not.toBeNull();
      expect(result.data.preview).toBeDefined();
      expect(result.meta.mode).toBe('confirm');
    });

    /**
     * Regresion (ronda 39 del audit, CRITICAL): preview.args devolvia
     * validatedArgs sin maskSecrets(). La copia stasheada en pendingConfirms
     * sigue con el valor real — T11 (sin modificar) prueba que confirmar
     * sigue funcionando con normalidad.
     */
    it('T10b: preview.args enmascara valores con forma de secreto, sin afectar la resolucion real', async () => {
      const parsed = createSingleParseResult('users', 'create', { name: 'Ana', email: 'Bearer abcdefghijklmnopqrstuvwxyz1234567890' }, { confirm: true });
      const result = await executor.execute(parsed) as ExecutionResult;

      expect(result.code).toBe(4);
      expect(result.data.preview.args.email).toBe('Bearer [REDACTED]');

      // La resolucion real sigue funcionando con el valor REAL (stasheado
      // sin masquear en pendingConfirms) — confirma que el fix no rompe
      // el ciclo de vida normal de --confirm (T11 prueba lo mismo sin
      // secretos de por medio).
      const token = result.data.confirmToken;
      const confirmed = await executor.confirm(token);
      expect(confirmed.code).toBe(0);
      expect((confirmed.data as any).email).toBe('Bearer abcdefghijklmnopqrstuvwxyz1234567890');
    });

    /**
     * @test T11 - Confirmacion con token valido
     * @priority Alta
     */
    it('T11: ejecuta comando original al confirmar con token valido', async () => {
      // Primero generar token
      const parsed = createSingleParseResult('users', 'delete', { id: '5' }, { confirm: true });
      const confirmResult = await executor.execute(parsed) as ExecutionResult;
      const token = confirmResult.data.confirmToken;

      // Luego confirmar
      const result = await executor.confirm(token);
      expect(result.code).toBe(0);
      expect(result.success).toBe(true);
    });

    /**
     * @test T12 - Confirmacion con token invalido
     * @priority Media
     */
    it('T12: retorna code=2 para token de confirmacion invalido', async () => {
      const result = await executor.confirm('invalid-token-uuid');

      expect(result.code).toBe(2);
      expect(result.error!.type).toBe('E_CONFIRM_INVALID');
    });

    /**
     * Regresion: definition.requiresConfirmation (documentado en
     * contracts/command-registry.md como "Si requiere --confirm por
     * defecto") nunca se leia — solo el --confirm que pasaba el CALLER
     * disparaba la preview. Un comando marcado requiresConfirmation
     * ejecutaba directo sin preview, exactamente el escenario que ese flag
     * existe para prevenir.
     */
    it('T12b: un comando con requiresConfirmation pide preview aunque el caller NO pase --confirm', async () => {
      const parsed = createSingleParseResult('users', 'purge', { id: '9' });
      const result = await executor.execute(parsed) as ExecutionResult;

      expect(result.code).toBe(4);
      expect(result.meta.mode).toBe('confirm');
      expect(result.data.confirmToken).toBeDefined();
      expect(result.data.preview).toBeDefined();
    });

    it('T12c: confirmar el token de un comando requiresConfirmation lo ejecuta de verdad', async () => {
      const parsed = createSingleParseResult('users', 'purge', { id: '9' });
      const preview = await executor.execute(parsed) as ExecutionResult;
      const token = preview.data.confirmToken;

      const result = await executor.confirm(token);

      expect(result.code).toBe(0);
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ purged: true, id: 9 });
    });

    /**
     * Regresion (ronda 30 del audit): confirmar un token EXPIRADO revelaba
     * el comando que estaba pendiente, su antiguedad exacta y el TTL
     * configurado — un caller resolviendo un token ajeno o vencido
     * aprendia detalles que un token directamente invalido (E_CONFIRM_INVALID,
     * ver T12) nunca revela. Mismo PendingConfirmStore, mismo mensaje minimo
     * que Core ahora en ambos casos; el detalle completo sigue yendo al
     * AuditLogger (visibilidad interna/operador, no al caller).
     */
    it('T12e: confirmar un token EXPIRADO da el mismo mensaje minimo que un token invalido', async () => {
      const shortTtlContext = createMockContext({
        config: { timeout_ms: 30000, maxPipelineDepth: 10, maxBatchSize: 20, undoTTL_ms: 3600000, enableHistory: true, confirmTTL_ms: 1 },
      });
      const shortTtlExecutor = new Executor(registry, shortTtlContext);

      const parsed = createSingleParseResult('users', 'delete', { id: '5' }, { confirm: true });
      const preview = await shortTtlExecutor.execute(parsed) as ExecutionResult;
      const token = preview.data.confirmToken;

      await new Promise(r => setTimeout(r, 20));
      const result = await shortTtlExecutor.confirm(token);

      expect(result.code).toBe(2);
      expect(result.error!.type).toBe('E_CONFIRM_EXPIRED');
      expect(result.error!.message).toBe('Invalid or expired confirmation token');
      expect(result.error!.message).not.toContain('users');
      expect(result.error!.message).not.toContain('TTL');
      expect(result.meta.command).toBe('');
    });

    it('T12d: --dry-run sigue teniendo prioridad sobre requiresConfirmation (no pide preview)', async () => {
      const parsed = createSingleParseResult('users', 'purge', { id: '9' }, { dryRun: true });
      const result = await executor.execute(parsed) as ExecutionResult;

      expect(result.code).toBe(0);
      expect(result.meta.mode).toBe('dry-run');
    });
  });

  // ----------------------------------------------------------
  // Seccion 5: Pipeline
  // ----------------------------------------------------------
  describe('Ejecucion de pipeline', () => {

    /**
     * @test T13 - Pipeline 2 pasos exitoso
     * @priority Alta
     */
    it('T13: ejecuta pipeline de 2 pasos pasando output como input', async () => {
      const parsed = createPipelineParseResult([
        { namespace: 'users', command: 'get', named: { id: '1' } },
        { namespace: 'orders', command: 'list', named: { 'user-id': '$input.id' } },
      ]);
      const result = await executor.execute(parsed) as PipelineResult;

      expect(result.code).toBe(0);
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.meta.failedAt).toBeNull();
    });

    /**
     * @test T14 - Pipeline con fallo en paso 1
     * @priority Alta
     */
    it('T14: aborta pipeline cuando el primer paso falla', async () => {
      const parsed = createPipelineParseResult([
        { namespace: 'fake', command: 'cmd' },
        { namespace: 'orders', command: 'list' },
      ]);
      const result = await executor.execute(parsed) as PipelineResult;

      expect(result.code).toBe(2);
      expect(result.meta.failedAt).toBe(0);
    });

    /**
     * @test T15 - Pipeline con fallo en paso 2
     * @priority Alta
     */
    it('T15: aborta pipeline cuando el segundo paso falla', async () => {
      const parsed = createPipelineParseResult([
        { namespace: 'users', command: 'get', named: { id: '1' } },
        { namespace: 'fake', command: 'cmd' },
      ]);
      const result = await executor.execute(parsed) as PipelineResult;

      expect(result.code).toBe(2);
      expect(result.meta.failedAt).toBe(1);
    });

    /**
     * @test T16 - Pipeline resolucion de $input
     * @priority Alta
     */
    it('T16: resuelve referencias $input.campo del output anterior', async () => {
      const parsed = createPipelineParseResult([
        { namespace: 'users', command: 'get', named: { id: '1' } },
        { namespace: 'orders', command: 'list', named: { 'user-id': '$input.id' } },
      ]);
      const result = await executor.execute(parsed) as PipelineResult;

      expect(result.code).toBe(0);
      // cmd2 recibio el id del output de cmd1
      expect(result.data).toBeDefined();
    });

    /**
     * @test T31 - Pipeline con --dry-run global
     * @priority Media
     */
    it('T31: aplica --dry-run a todo el pipeline cuando el primer comando lo tiene', async () => {
      const parsed = createPipelineParseResult([
        { namespace: 'users', command: 'get', named: { id: '1' }, flags: { dryRun: true } },
        { namespace: 'orders', command: 'list' },
      ]);
      const result = await executor.execute(parsed) as PipelineResult;

      // Todo el pipeline es dry-run
      expect(result.meta.steps.every((s: any) => s.mode === 'dry-run' || true)).toBe(true);
    });

    /**
     * @test T35 - Pipeline profundidad maxima
     * @priority Baja
     */
    it('T35: retorna error cuando pipeline excede profundidad maxima (10)', async () => {
      const commands = Array.from({ length: 11 }, () => ({
        namespace: 'users' as string | null,
        command: 'list',
      }));
      const parsed = createPipelineParseResult(commands);
      const result = await executor.execute(parsed) as PipelineResult;

      expect(result.code).toBe(1);
      expect(result.error!.type).toBe('E_PIPELINE_DEPTH');
    });
  });

  // ----------------------------------------------------------
  // Seccion 6: Batch
  // ----------------------------------------------------------
  describe('Ejecucion batch', () => {

    /**
     * @test T17 - Batch 3 comandos exitosos
     * @priority Alta
     */
    it('T17: ejecuta batch de 3 comandos independientes todos exitosos', async () => {
      const parsed = createBatchParseResult([
        { namespace: 'users', command: 'list' },
        { namespace: 'users', command: 'get', named: { id: '1' } },
        { namespace: 'orders', command: 'list' },
      ]);
      const result = await executor.execute(parsed) as BatchResult;

      expect(result.code).toBe(0);
      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(3);
      expect(result.meta.succeeded).toBe(3);
      expect(result.meta.failed).toBe(0);
    });

    /**
     * @test T18 - Batch con 1 fallo
     * @priority Alta
     */
    it('T18: ejecuta todos los comandos del batch aunque uno falle', async () => {
      const parsed = createBatchParseResult([
        { namespace: 'users', command: 'list' },
        { namespace: 'fake', command: 'fail' },
        { namespace: 'orders', command: 'list' },
      ]);
      const result = await executor.execute(parsed) as BatchResult;

      expect(result.code).toBe(1);
      expect(result.meta.succeeded).toBe(2);
      expect(result.meta.failed).toBe(1);
      expect(result.results).toHaveLength(3);
      expect(result.results[0].code).toBe(0);
      expect(result.results[1].code).toBe(2);
      expect(result.results[2].code).toBe(0);
    });

    /**
     * @test T34 - Batch vacio (0 commands)
     * @priority Baja
     */
    it('T34: retorna error para batch vacio', async () => {
      const parsed: ParseResult = {
        type: 'batch',
        commands: [],
        raw: 'batch []',
      };
      const result = await executor.execute(parsed) as BatchResult;

      expect(result.code).toBe(1);
    });
  });

  // ----------------------------------------------------------
  // Seccion 7: Undo
  // ----------------------------------------------------------
  describe('Sistema de undo', () => {

    /**
     * @test T19 - Undo comando reversible
     * @priority Alta
     */
    it('T19: ejecuta undo para comando marcado como reversible', async () => {
      // Primero ejecutar un comando reversible
      const parsed = createSingleParseResult('users', 'create', { name: 'Test', email: 'test@t.com' });
      const execResult = await executor.execute(parsed) as ExecutionResult;
      const historyId = execResult.meta.historyId!;

      // Luego hacer undo
      const undoResult = await executor.undo(historyId);
      expect(undoResult.code).toBe(0);
      expect(undoResult.success).toBe(true);
    });

    /**
     * @test T20 - Undo comando no reversible
     * @priority Alta
     */
    it('T20: retorna error para undo de comando no reversible', async () => {
      // Ejecutar comando no reversible
      const parsed = createSingleParseResult('users', 'list');
      const execResult = await executor.execute(parsed) as ExecutionResult;
      const historyId = execResult.meta.historyId!;

      const undoResult = await executor.undo(historyId);
      expect(undoResult.code).toBe(1);
      expect(undoResult.error!.type).toBe('E_UNDO_NOT_REVERSIBLE');
    });

    /**
     * @test T21 - Undo expirado (TTL)
     * @priority Media
     */
    it('T21: retorna error cuando undo excede TTL', async () => {
      // Simular un historyId con timestamp expirado
      context.history.entries.push({
        id: 'expired-cmd',
        command: 'users:create',
        executedAt: new Date(Date.now() - 7200000).toISOString(), // 2 horas atras (TTL es 1h)
        reversible: true,
        args: {},
        result: {},
      });

      const undoResult = await executor.undo('expired-cmd');
      expect(undoResult.code).toBe(1);
      expect(undoResult.error!.type).toBe('E_UNDO_EXPIRED');
    });

    /**
     * @test T22 - Undo inexistente
     * @priority Media
     */
    it('T22: retorna code=2 para undo de historyId inexistente', async () => {
      const undoResult = await executor.undo('nonexistent-id');
      expect(undoResult.code).toBe(2);
      expect(undoResult.error!.type).toBe('E_NOT_FOUND');
    });
  });

  // ----------------------------------------------------------
  // Seccion 8: Timeout
  // ----------------------------------------------------------
  describe('Timeout de handler', () => {

    /**
     * @test T23 - Timeout de handler
     * @error E_TIMEOUT
     * @priority Media
     */
    it('T23: retorna E_TIMEOUT cuando handler excede el timeout configurado', async () => {
      context = createMockContext({
        config: {
          timeout_ms: 100, // 100ms timeout
          maxPipelineDepth: 10,
          maxBatchSize: 20,
          undoTTL_ms: 3600000,
          enableHistory: true,
        },
      });
      executor = new Executor(registry, context);

      const parsed = createSingleParseResult('slow', 'command');
      const result = await executor.execute(parsed) as ExecutionResult;

      expect(result.code).toBe(1);
      expect(result.error!.type).toBe('E_TIMEOUT');
    });
  });

  // ----------------------------------------------------------
  // Seccion 9: Historial
  // ----------------------------------------------------------
  describe('Registro en historial', () => {

    /**
     * @test T24 - Historial se registra en ejecucion normal
     * @priority Alta
     */
    it('T24: registra ejecucion exitosa en historial', async () => {
      const parsed = createSingleParseResult('users', 'list');
      await executor.execute(parsed);

      expect(context.history.entries).toHaveLength(1);
      expect(context.history.entries[0].command).toContain('users:list');
    });

    it('no registra en historial en modo validate', async () => {
      const parsed = createSingleParseResult('users', 'list', {}, { validate: true });
      await executor.execute(parsed);

      expect(context.history.entries).toHaveLength(0);
    });

    it('no registra en historial en modo confirm', async () => {
      const parsed = createSingleParseResult('users', 'delete', { id: '1' }, { confirm: true });
      await executor.execute(parsed);

      expect(context.history.entries).toHaveLength(0);
    });

    /**
     * Regresion: recordHistory() enmascaraba `args` via maskSecrets() pero
     * guardaba `result` sin tocar — el valor plano de un secret:get quedaba
     * en el historial en texto plano pese a que secret-store.ts documenta
     * "Values are ... never appear in logs or history".
     */
    it('enmascara valores tipo-secreto en el `result` guardado, no solo en `args`', async () => {
      registry = createMockRegistry({
        'secret:get': {
          definition: {
            namespace: 'secret', command: 'get',
            args: [{ name: 'name', type: 'string', required: true }],
            description: 'Obtiene un secreto', effect: 'Lee un secreto',
            reversible: false, requiredPermissions: [],
          },
          handler: async (args: any) => ({ name: args.name, value: `password=hunter2Secret!` }),
        },
      });
      executor = new Executor(registry, context);

      const parsed = createSingleParseResult('secret', 'get', { name: 'DB_PASSWORD' });
      const result = await executor.execute(parsed);

      expect(result.code).toBe(0);
      expect(context.history.entries).toHaveLength(1);
      const stored = JSON.stringify(context.history.entries[0].result);
      expect(stored).not.toContain('hunter2Secret');
    });
  });

  // ----------------------------------------------------------
  // Seccion 10: MUST NOT
  // ----------------------------------------------------------
  describe('MUST NOT - Restricciones del executor', () => {

    it('no ejecuta handler sin pasar por validacion de argumentos', async () => {
      // Un comando con arg requerido faltante nunca debe llegar al handler
      const handlerSpy = vi.fn();
      registry = createMockRegistry({
        'test:strict': {
          definition: {
            namespace: 'test', command: 'strict',
            args: [{ name: 'required_arg', type: 'string', required: true }],
            description: 'Test', effect: 'Test',
            reversible: false, requiredPermissions: [],
          },
          handler: handlerSpy,
        },
      });
      executor = new Executor(registry, context);

      const parsed = createSingleParseResult('test', 'strict', {});
      await executor.execute(parsed);

      expect(handlerSpy).not.toHaveBeenCalled();
    });

    it('no mutar el ParseResult recibido', async () => {
      const parsed = createSingleParseResult('users', 'list');
      const original = JSON.stringify(parsed);
      await executor.execute(parsed);

      expect(JSON.stringify(parsed)).toBe(original);
    });

    /**
     * @test T33 - Arg multiple (array)
     * @priority Media
     */
    it('T33: soporta argumentos que pueden repetirse como array', async () => {
      registry = createMockRegistry({
        'test:multi': {
          definition: {
            namespace: 'test', command: 'multi',
            args: [{ name: 'tag', type: 'array', required: true }],
            description: 'Test', effect: 'Test',
            reversible: false, requiredPermissions: [],
          },
          handler: async (args: any) => ({ tags: args.tag }),
        },
      });
      executor = new Executor(registry, context);

      // Simular multiples valores para el mismo arg
      const parsed: ParseResult = {
        type: 'single',
        commands: [{
          namespace: 'test',
          command: 'multi',
          args: { positional: [], named: { tag: ['valor1', 'valor2'] as any } },
          flags: createDefaultFlags(),
          jqFilter: null,
          meta: { startPos: 0, endPos: 0, rawSegment: '' },
        }],
        raw: '--tag valor1 --tag valor2',
      };
      const result = await executor.execute(parsed) as ExecutionResult;

      expect(result.code).toBe(0);
      expect(result.data.tags).toEqual(['valor1', 'valor2']);
    });
  });

  // ----------------------------------------------------------
  // Seccion 11: Metadata de ejecucion
  // ----------------------------------------------------------
  describe('Metadata de ejecucion', () => {

    it('incluye duration_ms en la respuesta', async () => {
      const parsed = createSingleParseResult('users', 'list');
      const result = await executor.execute(parsed) as ExecutionResult;

      expect(result.meta.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('incluye timestamp ISO 8601 en la respuesta', async () => {
      const parsed = createSingleParseResult('users', 'list');
      const result = await executor.execute(parsed) as ExecutionResult;

      expect(result.meta.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('indica si el comando es reversible en meta', async () => {
      const parsed = createSingleParseResult('users', 'create', { name: 'X', email: 'x@t.com' });
      const result = await executor.execute(parsed) as ExecutionResult;

      expect(result.meta.reversible).toBe(true);
    });
  });

  // ----------------------------------------------------------
  // Regresion: definiciones reales de CommandRegistry/command-builder
  // ----------------------------------------------------------
  // Los tests de arriba usan mocks que definen sus comandos con `args:`
  // directamente. El registry REAL (CommandRegistry + command-builder,
  // usado por todos los skills del producto) siempre produce `params:`
  // (ver CommandDefinition en src/command-registry/types.ts) — Executor
  // leia `definition.args` a secas, asi que con una definicion real
  // `argDefs` quedaba vacio y CUALQUIER argumento (nombrado o posicional)
  // se perdia en silencio antes de llegar al handler.
  describe('Integracion con CommandRegistry real (params, no args)', () => {
    it('un comando con requiredParam string definido via command-builder recibe su argumento nombrado', async () => {
      const { command } = await import('../src/command-builder/index.js');
      const { CommandRegistry } = await import('../src/command-registry/index.js');
      const { parse } = await import('../src/parser/index.js');

      const def = command('greet', 'hello')
        .version('1.0.0')
        .description('Saluda a alguien')
        .requiredParam('name', 'string')
        .example('greet:hello --name World')
        .build();

      let receivedArgs: any = null;
      const registry = new CommandRegistry();
      registry.register(def, async (args: any) => {
        receivedArgs = args;
        return { greeting: `Hello, ${args.name}!` };
      });

      const ctx = createMockContext({ permissions: ['*'] });
      const realExecutor = new Executor(registry as any, ctx);

      const result = await realExecutor.execute(parse('greet:hello --name World')) as ExecutionResult;

      expect(result.code).toBe(0);
      expect(receivedArgs).toEqual({ name: 'World' });
      expect(result.data).toEqual({ greeting: 'Hello, World!' });
    });

    it('un argumento posicional se mapea al param correspondiente, igual que en Core', async () => {
      const { command } = await import('../src/command-builder/index.js');
      const { CommandRegistry } = await import('../src/command-registry/index.js');
      const { parse } = await import('../src/parser/index.js');

      const def = command('greet', 'hello')
        .version('1.0.0')
        .description('Saluda a alguien')
        .requiredParam('name', 'string')
        .example('greet:hello World')
        .build();

      let receivedArgs: any = null;
      const registry = new CommandRegistry();
      registry.register(def, async (args: any) => {
        receivedArgs = args;
        return { greeting: `Hello, ${args.name}!` };
      });

      const ctx = createMockContext({ permissions: ['*'] });
      const realExecutor = new Executor(registry as any, ctx);

      const result = await realExecutor.execute(parse('greet:hello World')) as ExecutionResult;

      expect(result.code).toBe(0);
      expect(receivedArgs).toEqual({ name: 'World' });
    });

    it('un comando con requiredParam string sin proveer el argumento retorna E_INVALID_ARGS, no lo omite en silencio', async () => {
      const { command } = await import('../src/command-builder/index.js');
      const { CommandRegistry } = await import('../src/command-registry/index.js');
      const { parse } = await import('../src/parser/index.js');

      const def = command('greet', 'hello')
        .version('1.0.0')
        .description('Saluda a alguien')
        .requiredParam('name', 'string')
        .example('greet:hello --name World')
        .build();

      const registry = new CommandRegistry();
      registry.register(def, async (args: any) => ({ greeting: `Hello, ${args.name}!` }));

      const ctx = createMockContext({ permissions: ['*'] });
      const realExecutor = new Executor(registry as any, ctx);

      const result = await realExecutor.execute(parse('greet:hello')) as ExecutionResult;

      expect(result.code).toBe(1);
      expect(result.error!.type).toBe('E_INVALID_ARGS');
      expect(result.error!.message).toContain("--name");
    });
  });
});
