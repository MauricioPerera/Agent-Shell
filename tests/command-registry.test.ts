/**
 * @contract CONTRACT_COMMAND_REGISTRY v1.0
 * @module Command Registry (Agent Shell)
 * @description Tests para el Command Registry basados en los 22 casos de prueba del contrato.
 *
 * El Command Registry es el almacen central de definiciones y handlers de comandos.
 * Permite registrar, buscar, listar y generar representaciones compactas de comandos.
 */

import { describe, it, expect, beforeEach } from 'vitest';

// --- Tipos del contrato ---

interface CommandDefinition {
  namespace: string;
  name: string;
  version: string;
  description: string;
  longDescription?: string;
  params: CommandParam[];
  output: OutputShape;
  example: string;
  tags: string[];
  reversible: boolean;
  requiresConfirmation: boolean;
  deprecated: boolean;
  deprecatedMessage?: string;
}

interface CommandParam {
  name: string;
  type: string; // ParamType
  required: boolean;
  default?: any;
  constraints?: string;
  description?: string;
}

interface OutputShape {
  type: string;
  description?: string;
}

interface RegisteredCommand {
  definition: CommandDefinition;
  handler: Function;
  registeredAt: string;
}

interface RegistryError {
  code: string;
  message: string;
  context?: Record<string, any>;
}

type Result<T> = { ok: true; value: T } | { ok: false; error: RegistryError };

// --- Import del Command Registry ---
import { CommandRegistry } from '../src/command-registry/index.js';

// --- Helpers ---

function createValidDefinition(overrides: Partial<CommandDefinition> = {}): CommandDefinition {
  return {
    namespace: 'users',
    name: 'create',
    version: '1.0.0',
    description: 'Crea un nuevo usuario en el sistema',
    params: [
      { name: 'name', type: 'string', required: true, constraints: 'min:2,max:100' },
      { name: 'email', type: 'string', required: true, constraints: 'email' },
      { name: 'role', type: 'enum(admin,user,viewer)', required: false, default: 'user' },
    ],
    output: { type: '{id, name, email, role, createdAt}' },
    example: 'users:create --name "John" --email john@test.com | .id',
    tags: ['user', 'creation'],
    reversible: true,
    requiresConfirmation: false,
    deprecated: false,
    ...overrides,
  };
}

function createMockHandler(): Function {
  return async (args: any) => ({ id: 1, ...args });
}

// ============================================================
// TEST SUITE: Command Registry - Casos de Prueba del Contrato
// ============================================================

describe('Command Registry', () => {
  let registry: CommandRegistry;

  beforeEach(() => {
    registry = new CommandRegistry();
  });

  // ----------------------------------------------------------
  // Seccion 1: Registro de comandos
  // ----------------------------------------------------------
  describe('Registro de comandos', () => {

    /**
     * @test T01 - Registro y lookup basico
     * @acceptance Registro exitoso de comando completo
     * @priority Alta
     */
    it('T01: registra un comando y lo recupera con el mismo handler', () => {
      const def = createValidDefinition();
      const handler = createMockHandler();

      const regResult = registry.register(def, handler);
      expect(regResult.ok).toBe(true);

      const getResult = registry.get('users', 'create');
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;

      expect(getResult.value.definition.namespace).toBe('users');
      expect(getResult.value.definition.name).toBe('create');
      expect(getResult.value.handler).toBe(handler);
    });

    /**
     * @test T02 - Rechazo de duplicados
     * @acceptance Registro duplicado rechazado
     * @priority Alta
     */
    it('T02: rechaza registro duplicado con mismo namespace:name:version', () => {
      const def = createValidDefinition();
      const handler1 = createMockHandler();
      const handler2 = createMockHandler();

      registry.register(def, handler1);
      const result = registry.register(def, handler2);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('COMMAND_ALREADY_EXISTS');

      // Verificar que el original no se modifico
      const getResult = registry.get('users', 'create');
      if (!getResult.ok) return;
      expect(getResult.value.handler).toBe(handler1);
    });

    /**
     * @test T03 - Validacion de definicion sin namespace
     * @acceptance Definicion invalida rechazada
     * @priority Alta
     */
    it('T03: rechaza definicion sin namespace', () => {
      const def = createValidDefinition({ namespace: '' });
      const result = registry.register(def, createMockHandler());

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INVALID_DEFINITION');
    });

    /**
     * @test T04 - Validacion de definicion sin name
     * @acceptance Definicion invalida rechazada
     * @priority Alta
     */
    it('T04: rechaza definicion sin name', () => {
      const def = createValidDefinition({ name: '' });
      const result = registry.register(def, createMockHandler());

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INVALID_DEFINITION');
    });

    /**
     * @test T05 - Validacion de definicion sin version
     * @acceptance Definicion invalida rechazada
     * @priority Alta
     */
    it('T05: rechaza definicion sin version', () => {
      const def = createValidDefinition({ version: '' });
      const result = registry.register(def, createMockHandler());

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INVALID_DEFINITION');
    });

    /**
     * @test T06 - Validacion de param type invalido
     * @error INVALID_DEFINITION
     * @priority Media
     */
    it('T06: rechaza definicion con tipo de parametro invalido', () => {
      const def = createValidDefinition({
        params: [{ name: 'arg', type: 'invalid_type', required: true }],
      });
      const result = registry.register(def, createMockHandler());

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INVALID_DEFINITION');
    });

    /**
     * @test T21 - Handler no es modificado
     * @mustnot Modificar el handler recibido
     * @priority Alta
     */
    it('T21: almacena el handler por referencia identica sin modificarlo', () => {
      const handler = async (args: any) => ({ result: args });
      const def = createValidDefinition();

      registry.register(def, handler);

      const getResult = registry.get('users', 'create');
      if (!getResult.ok) return;

      expect(getResult.value.handler).toBe(handler);
    });
  });

  // ----------------------------------------------------------
  // Seccion 2: Versionado
  // ----------------------------------------------------------
  describe('Versionado de comandos', () => {

    /**
     * @test T07 - Multiples versiones coexisten
     * @acceptance Multiples versiones del mismo comando
     * @priority Alta
     */
    it('T07: permite registrar multiples versiones del mismo comando', () => {
      const v1 = createValidDefinition({ version: '1.0.0' });
      const v2 = createValidDefinition({ version: '2.0.0', description: 'V2 del comando' });
      const handler1 = createMockHandler();
      const handler2 = createMockHandler();

      registry.register(v1, handler1);
      registry.register(v2, handler2);

      const r1 = registry.get('users', 'create', '1.0.0');
      const r2 = registry.get('users', 'create', '2.0.0');

      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      if (!r1.ok || !r2.ok) return;

      expect(r1.value.handler).toBe(handler1);
      expect(r2.value.handler).toBe(handler2);
    });

    /**
     * @test T08 - Version mas reciente por defecto
     * @acceptance get sin version retorna la mas reciente
     * @priority Alta
     */
    it('T08: retorna la version mas reciente cuando no se especifica version', () => {
      const v1 = createValidDefinition({ version: '1.0.0' });
      const v2 = createValidDefinition({ version: '2.0.0' });
      const handler1 = createMockHandler();
      const handler2 = createMockHandler();

      registry.register(v1, handler1);
      registry.register(v2, handler2);

      const result = registry.get('users', 'create');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.definition.version).toBe('2.0.0');
      expect(result.value.handler).toBe(handler2);
    });
  });

  // ----------------------------------------------------------
  // Seccion 3: Lookup de comandos
  // ----------------------------------------------------------
  describe('Lookup de comandos', () => {

    /**
     * @test T19 - Resolve con version "@1.0.0"
     * @acceptance Lookup con version explicita
     * @priority Alta
     */
    it('T19: resuelve comando con version explicita usando formato ns:cmd@version', () => {
      const def = createValidDefinition({ version: '1.0.0' });
      registry.register(def, createMockHandler());

      const result = registry.resolve('users:create@1.0.0');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.definition.version).toBe('1.0.0');
    });

    /**
     * @test T20 - Resolve formato invalido
     * @error INVALID_FORMAT
     * @priority Media
     */
    it('T20: retorna error para formato de resolve invalido', () => {
      const result = registry.resolve('invalido');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INVALID_FORMAT');
    });

    it('resolve retorna COMMAND_NOT_FOUND para comando inexistente', () => {
      const result = registry.resolve('ghost:command');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('COMMAND_NOT_FOUND');
    });
  });

  // ----------------------------------------------------------
  // Seccion 4: Listado
  // ----------------------------------------------------------
  describe('Listado de comandos', () => {

    /**
     * @test T09 - Listado por namespace correcto
     * @acceptance Listado por namespace
     * @priority Alta
     */
    it('T09: lista correctamente los comandos de un namespace', () => {
      registry.register(createValidDefinition({ namespace: 'users', name: 'create' }), createMockHandler());
      registry.register(createValidDefinition({ namespace: 'users', name: 'list' }), createMockHandler());
      registry.register(createValidDefinition({ namespace: 'users', name: 'delete' }), createMockHandler());
      registry.register(createValidDefinition({ namespace: 'orders', name: 'create' }), createMockHandler());

      const userCmds = registry.listByNamespace('users');
      expect(userCmds).toHaveLength(3);
      userCmds.forEach(cmd => {
        expect(cmd.namespace).toBe('users');
      });
    });

    /**
     * @test T10 - Listado namespace inexistente
     * @acceptance Retorna array vacio para namespace sin comandos
     * @priority Media
     */
    it('T10: retorna array vacio para namespace inexistente (no error)', () => {
      const result = registry.listByNamespace('nonexistent');
      expect(result).toEqual([]);
    });

    /**
     * @test T11 - getNamespaces ordenado
     * @acceptance Namespaces ordenados alfabeticamente
     * @priority Media
     */
    it('T11: retorna namespaces ordenados alfabeticamente', () => {
      registry.register(createValidDefinition({ namespace: 'users', name: 'list' }), createMockHandler());
      registry.register(createValidDefinition({ namespace: 'orders', name: 'list' }), createMockHandler());
      registry.register(createValidDefinition({ namespace: 'products', name: 'list' }), createMockHandler());

      const namespaces = registry.getNamespaces();
      expect(namespaces).toEqual(['orders', 'products', 'users']);
    });

    it('listAll retorna todas las definiciones registradas', () => {
      registry.register(createValidDefinition({ namespace: 'users', name: 'create' }), createMockHandler());
      registry.register(createValidDefinition({ namespace: 'users', name: 'list' }), createMockHandler());
      registry.register(createValidDefinition({ namespace: 'orders', name: 'create' }), createMockHandler());

      const all = registry.listAll();
      expect(all).toHaveLength(3);
    });
  });

  // ----------------------------------------------------------
  // Seccion 5: Formato compacto AI-optimizado
  // ----------------------------------------------------------
  describe('Generacion de texto compacto', () => {

    /**
     * @test T12 - Formato compacto sin params
     * @acceptance Generacion basica
     * @priority Alta
     */
    it('T12: genera formato compacto para comando sin parametros', () => {
      const def = createValidDefinition({
        namespace: 'system',
        name: 'status',
        params: [],
        description: 'Muestra el estado del sistema',
        output: { type: '{status, uptime}' },
        example: 'system:status',
      });

      const text = registry.toCompactText(def);

      expect(text).toContain('system:status | Muestra el estado del sistema');
      expect(text).toContain('-> output: {status, uptime}');
      expect(text).toContain('Ejemplo: system:status');
    });

    /**
     * @test T13 - Formato compacto con required
     * @acceptance Parametros required muestran [REQUIRED]
     * @priority Alta
     */
    it('T13: incluye [REQUIRED] para parametros obligatorios', () => {
      const def = createValidDefinition({
        params: [
          { name: 'email', type: 'string', required: true, constraints: 'email' },
        ],
      });

      const text = registry.toCompactText(def);
      expect(text).toContain('--email: string (email) [REQUIRED]');
    });

    /**
     * @test T14 - Formato compacto con default
     * @acceptance Parametros con default muestran = valor
     * @priority Alta
     */
    it('T14: incluye = valor para parametros con default', () => {
      const def = createValidDefinition({
        params: [
          { name: 'role', type: 'enum(admin,user,viewer)', required: false, default: 'user' },
        ],
      });

      const text = registry.toCompactText(def);
      expect(text).toContain('--role: enum(admin,user,viewer) = user');
    });

    /**
     * @test T15 - Formato compacto con constraints
     * @acceptance Constraints entre parentesis
     * @priority Media
     */
    it('T15: muestra constraints entre parentesis', () => {
      const def = createValidDefinition({
        params: [
          { name: 'limit', type: 'int', required: false, default: 10, constraints: '>0' },
        ],
      });

      const text = registry.toCompactText(def);
      expect(text).toContain('--limit: int (>0) = 10');
    });

    /**
     * @test T16 - Formato compacto deprecated
     * @acceptance Comando deprecated muestra mensaje
     * @priority Media
     */
    it('T16: incluye linea [DEPRECATED] para comandos deprecados', () => {
      const def = createValidDefinition({
        deprecated: true,
        deprecatedMessage: 'Usar users:create-v2',
      });

      const text = registry.toCompactText(def);
      expect(text).toContain('[DEPRECATED: Usar users:create-v2]');
    });

    /**
     * @test T17 - Batch separado por linea vacia
     * @acceptance Generacion batch
     * @priority Alta
     */
    it('T17: genera batch con bloques separados por linea en blanco', () => {
      const def1 = createValidDefinition({ namespace: 'users', name: 'list', description: 'Lista usuarios' });
      const def2 = createValidDefinition({ namespace: 'orders', name: 'list', description: 'Lista ordenes' });
      const def3 = createValidDefinition({ namespace: 'products', name: 'list', description: 'Lista productos' });

      const text = registry.toCompactTextBatch([def1, def2, def3]);

      // Verificar que hay 2 lineas vacias separadoras entre los 3 bloques
      const blocks = text.split('\n\n');
      expect(blocks.length).toBeGreaterThanOrEqual(3);
    });

    it('genera formato exacto del ejemplo del contrato', () => {
      const def: CommandDefinition = {
        namespace: 'users',
        name: 'create',
        version: '1.0.0',
        description: 'Crea un nuevo usuario en el sistema',
        params: [
          { name: 'name', type: 'string', required: true, constraints: 'min:2,max:100' },
          { name: 'email', type: 'string', required: true, constraints: 'email' },
          { name: 'role', type: 'enum(admin,user,viewer)', required: false, default: 'user' },
        ],
        output: { type: '{id, name, email, role, createdAt}' },
        example: 'users:create --name "John" --email john@test.com | .id',
        tags: ['user', 'creation'],
        reversible: true,
        requiresConfirmation: false,
        deprecated: false,
      };

      const text = registry.toCompactText(def);

      expect(text).toContain('users:create | Crea un nuevo usuario en el sistema');
      expect(text).toContain('  --name: string (min:2,max:100) [REQUIRED]');
      expect(text).toContain('  --email: string (email) [REQUIRED]');
      expect(text).toContain('  --role: enum(admin,user,viewer) = user');
      expect(text).toContain('  -> output: {id, name, email, role, createdAt}');
      expect(text).toContain('  Ejemplo: users:create --name "John" --email john@test.com | .id');
    });
  });

  // ----------------------------------------------------------
  // Seccion 6: Deregistro
  // ----------------------------------------------------------
  describe('Deregistro de comandos', () => {

    /**
     * @test T18 - Deregistro exitoso
     * @acceptance Deregistro elimina comando del registry
     * @priority Alta
     */
    it('T18: elimina exitosamente un comando registrado', () => {
      const def = createValidDefinition({ version: '1.0.0' });
      registry.register(def, createMockHandler());

      const result = registry.unregister('users', 'create', '1.0.0');
      expect(result.ok).toBe(true);

      const getResult = registry.get('users', 'create', '1.0.0');
      expect(getResult.ok).toBe(false);
      if (getResult.ok) return;
      expect(getResult.error.code).toBe('COMMAND_NOT_FOUND');
    });

    it('deregistro sin version elimina todas las versiones', () => {
      registry.register(createValidDefinition({ version: '1.0.0' }), createMockHandler());
      registry.register(createValidDefinition({ version: '2.0.0' }), createMockHandler());

      const result = registry.unregister('users', 'create');
      expect(result.ok).toBe(true);

      const r1 = registry.get('users', 'create', '1.0.0');
      const r2 = registry.get('users', 'create', '2.0.0');
      expect(r1.ok).toBe(false);
      expect(r2.ok).toBe(false);
    });

    it('deregistro de comando inexistente retorna COMMAND_NOT_FOUND', () => {
      const result = registry.unregister('ghost', 'cmd');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('COMMAND_NOT_FOUND');
    });
  });

  // ----------------------------------------------------------
  // Seccion 7: Instancias multiples
  // ----------------------------------------------------------
  describe('Instancias multiples', () => {

    /**
     * @test T22 - Registry multiples instancias
     * @mustnot Usar singleton global
     * @priority Media
     */
    it('T22: multiples instancias de registry son independientes', () => {
      const registry1 = new CommandRegistry();
      const registry2 = new CommandRegistry();

      registry1.register(createValidDefinition({ namespace: 'users', name: 'create' }), createMockHandler());

      const r1 = registry1.get('users', 'create');
      const r2 = registry2.get('users', 'create');

      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(false);
    });
  });

  // ----------------------------------------------------------
  // Seccion 8: MUST NOT - Restricciones
  // ----------------------------------------------------------
  describe('MUST NOT - Restricciones del registry', () => {

    it('no permite modificar definicion registrada in-place', () => {
      const def = createValidDefinition();
      registry.register(def, createMockHandler());

      // Modificar la definicion original no debe afectar al registro
      def.description = 'Modificado despues del registro';

      const getResult = registry.get('users', 'create');
      if (!getResult.ok) return;
      expect(getResult.value.definition.description).toBe('Crea un nuevo usuario en el sistema');
    });

    it('no lanza excepciones - siempre retorna Result', () => {
      // Intentar operaciones invalidas no debe lanzar excepciones
      expect(() => registry.get('', '')).not.toThrow();
      expect(() => registry.resolve('')).not.toThrow();
      expect(() => registry.unregister('', '')).not.toThrow();
    });
  });
});
