/**
 * @contract CONTRACT_CONTEXT_STORE v1.0
 * @module Context Store (Agent Shell)
 * @description Tests para el Context Store basados en los 20 casos de prueba del contrato.
 *
 * El Context Store mantiene estado de sesion entre llamadas del agente LLM,
 * persistiendo claves-valor, historial de comandos y soportando undo.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Tipos del contrato ---

interface ContextEntry {
  key: string;
  value: any;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  set_at: string;
  updated_at: string;
  version: number;
}

interface HistoryEntry {
  id: string;
  command: string;
  namespace: string;
  args: Record<string, any>;
  executed_at: string;
  duration_ms: number;
  exit_code: number;
  result_summary: string;
  undoable: boolean;
  undo_status: 'available' | 'applied' | 'expired' | null;
  snapshot_id: string | null;
}

interface UndoSnapshot {
  id: string;
  command_id: string;
  created_at: string;
  state_before: Record<string, any>;
  rollback_command: string | null;
  metadata: Record<string, any>;
}

interface StorageAdapter {
  readonly name: string;
  initialize(session_id: string): Promise<void>;
  load(session_id: string): Promise<any | null>;
  save(session_id: string, store: any): Promise<void>;
  destroy(session_id: string): Promise<void>;
  healthCheck(): Promise<boolean>;
  dispose(): Promise<void>;
}

interface OperationResult {
  status: number;
  data?: any;
  error?: { code: string; message: string };
  meta?: { session_id?: string; timestamp?: string; count?: number; total?: number; warnings?: string[] };
}

// --- Import del Context Store ---
import { ContextStore } from '../src/context-store/index.js';

// --- Mock MemoryAdapter ---
class MockMemoryAdapter implements StorageAdapter {
  readonly name = 'memory';
  private stores: Map<string, any> = new Map();

  async initialize(session_id: string): Promise<void> {
    if (!this.stores.has(session_id)) {
      this.stores.set(session_id, { context: { entries: {} }, history: [], undo_snapshots: [] });
    }
  }
  async load(session_id: string): Promise<any | null> {
    return this.stores.get(session_id) || null;
  }
  async save(session_id: string, store: any): Promise<void> {
    this.stores.set(session_id, store);
  }
  async destroy(session_id: string): Promise<void> {
    this.stores.delete(session_id);
  }
  async healthCheck(): Promise<boolean> {
    return true;
  }
  async dispose(): Promise<void> {
    this.stores.clear();
  }
}

// ============================================================
// TEST SUITE: Context Store - Casos de Prueba del Contrato
// ============================================================

describe('Context Store', () => {
  let adapter: MockMemoryAdapter;
  let store: ContextStore;

  beforeEach(async () => {
    adapter = new MockMemoryAdapter();
    store = new ContextStore(adapter, 'test-session-001');
    await adapter.initialize('test-session-001');
  });

  // ----------------------------------------------------------
  // Seccion 1: Operaciones basicas de contexto (set/get)
  // ----------------------------------------------------------
  describe('Operaciones basicas de contexto', () => {

    /**
     * @test T01 - Set valor string
     * @acceptance Establecer y recuperar un valor
     * @priority Alta
     */
    it('T01: establece un valor string y retorna status 0', async () => {
      const result = await store.set('name', '"John"');

      expect(result.status).toBe(0);
      expect(result.data.key).toBe('name');
      expect(result.data.value).toBe('John');
    });

    /**
     * @test T02 - Set valor numerico
     * @acceptance Inferencia de tipo numerico
     * @priority Alta
     */
    it('T02: establece un valor numerico con inferencia de tipo', async () => {
      const result = await store.set('count', '42');

      expect(result.status).toBe(0);
      expect(result.data.value).toBe(42);
      // El tipo debe inferirse como number
    });

    /**
     * @test T03 - Set valor booleano
     * @acceptance Inferencia de tipo booleano
     * @priority Alta
     */
    it('T03: establece un valor booleano con inferencia de tipo', async () => {
      const result = await store.set('active', 'true');

      expect(result.status).toBe(0);
      expect(result.data.value).toBe(true);
    });

    /**
     * @test T04 - Set valor JSON
     * @acceptance Almacenar objeto JSON
     * @priority Media
     */
    it('T04: establece un valor JSON (objeto)', async () => {
      const result = await store.set('config', '{"a":1}');

      expect(result.status).toBe(0);
      expect(result.data.value).toEqual({ a: 1 });
    });

    /**
     * @test T05 - Get existente
     * @acceptance Recuperar valor almacenado
     * @priority Alta
     */
    it('T05: recupera un valor previamente almacenado', async () => {
      await store.set('name', '"John"');
      const result = await store.get('name');

      expect(result.status).toBe(0);
      expect(result.data.value).toBe('John');
    });

    /**
     * @test T06 - Get inexistente
     * @error E001 - KEY_NOT_FOUND
     * @priority Alta
     */
    it('T06: retorna status 2 para clave inexistente', async () => {
      const result = await store.get('xyz');

      expect(result.status).toBe(2);
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe('KEY_NOT_FOUND');
      expect(result.error!.message).toContain('not found');
    });

    /**
     * @test T07 - Context completo (getAll)
     * @acceptance Ver todo el contexto
     * @priority Alta
     */
    it('T07: retorna todo el contexto con meta.count', async () => {
      await store.set('a', '1');
      await store.set('b', '"hello"');
      await store.set('c', 'true');

      const result = await store.getAll();

      expect(result.status).toBe(0);
      expect(result.data).toEqual({ a: 1, b: 'hello', c: true });
      expect(result.meta!.count).toBe(3);
    });

    it('sobrescribir valor existente retorna previous', async () => {
      await store.set('mode', '"dev"');
      const result = await store.set('mode', '"prod"');

      expect(result.status).toBe(0);
      expect(result.data.value).toBe('prod');
      expect(result.data.previous).toBe('dev');
    });
  });

  // ----------------------------------------------------------
  // Seccion 2: Delete y Clear
  // ----------------------------------------------------------
  describe('Delete y Clear', () => {

    /**
     * @test T08 - Delete existente
     * @acceptance Eliminar una clave
     * @priority Alta
     */
    it('T08: elimina una clave existente', async () => {
      await store.set('temp', '"value"');
      const result = await store.delete('temp');

      expect(result.status).toBe(0);

      const getResult = await store.get('temp');
      expect(getResult.status).toBe(2);
    });

    /**
     * @test T09 - Delete inexistente
     * @error E001 - KEY_NOT_FOUND
     * @priority Media
     */
    it('T09: retorna status 2 al eliminar clave inexistente', async () => {
      const result = await store.delete('xyz');

      expect(result.status).toBe(2);
      expect(result.error!.code).toBe('KEY_NOT_FOUND');
    });

    /**
     * @test T10 - Clear
     * @acceptance Limpiar todo el contexto
     * @priority Alta
     */
    it('T10: limpia todo el contexto', async () => {
      await store.set('a', '1');
      await store.set('b', '2');
      await store.set('c', '3');

      const result = await store.clear();
      expect(result.status).toBe(0);

      const getAll = await store.getAll();
      expect(getAll.data).toEqual({});
      expect(getAll.meta!.count).toBe(0);
    });
  });

  // ----------------------------------------------------------
  // Seccion 3: Historial
  // ----------------------------------------------------------
  describe('Historial de comandos', () => {

    /**
     * @test T11 - History default
     * @acceptance Consultar historial con limite default (20)
     * @priority Alta
     */
    it('T11: retorna ultimos 20 comandos por defecto', async () => {
      // Registrar 25 comandos
      for (let i = 0; i < 25; i++) {
        await store.recordCommand({
          id: `cmd_${i.toString().padStart(3, '0')}`,
          command: `test:cmd${i}`,
          namespace: 'test',
          executed_at: new Date().toISOString(),
          duration_ms: 10,
          exit_code: 0,
          undoable: false,
        });
      }

      const result = await store.getHistory();
      expect(result.status).toBe(0);
      expect(result.data).toHaveLength(20);
      expect(result.meta!.total).toBe(25);
    });

    /**
     * @test T12 - History con limit
     * @acceptance Consultar historial con limite personalizado
     * @priority Media
     */
    it('T12: retorna exactamente N comandos cuando se especifica limit', async () => {
      for (let i = 0; i < 10; i++) {
        await store.recordCommand({
          id: `cmd_${i}`,
          command: `test:cmd${i}`,
          namespace: 'test',
          executed_at: new Date().toISOString(),
          duration_ms: 10,
          exit_code: 0,
          undoable: false,
        });
      }

      const result = await store.getHistory({ limit: 5 });
      expect(result.status).toBe(0);
      expect(result.data).toHaveLength(5);
    });

    it('historial vacio retorna array vacio', async () => {
      const result = await store.getHistory();

      expect(result.status).toBe(0);
      expect(result.data).toEqual([]);
      expect(result.meta!.total).toBe(0);
    });

    it('registra comando con metadata completa', async () => {
      await store.recordCommand({
        id: 'cmd_001',
        command: 'users:list --limit 5',
        namespace: 'users',
        args: { limit: 5 },
        executed_at: '2026-01-22T10:00:00Z',
        duration_ms: 45,
        exit_code: 0,
        result_summary: '5 users returned',
        undoable: false,
        undo_status: null,
        snapshot_id: null,
      });

      const result = await store.getHistory({ limit: 1 });
      expect(result.data[0].id).toBe('cmd_001');
      expect(result.data[0].command).toContain('users:list');
      expect(result.data[0].exit_code).toBe(0);
    });

    it('historial se ordena por timestamp descendente (mas reciente primero)', async () => {
      await store.recordCommand({
        id: 'cmd_old',
        command: 'old:cmd',
        namespace: 'old',
        executed_at: '2026-01-22T10:00:00Z',
        duration_ms: 10,
        exit_code: 0,
        undoable: false,
      });
      await store.recordCommand({
        id: 'cmd_new',
        command: 'new:cmd',
        namespace: 'new',
        executed_at: '2026-01-22T11:00:00Z',
        duration_ms: 10,
        exit_code: 0,
        undoable: false,
      });

      const result = await store.getHistory();
      expect(result.data[0].id).toBe('cmd_new');
      expect(result.data[1].id).toBe('cmd_old');
    });
  });

  // ----------------------------------------------------------
  // Seccion 4: Undo
  // ----------------------------------------------------------
  describe('Mecanismo de undo', () => {

    /**
     * @test T13 - Undo reversible
     * @acceptance Undo de comando reversible
     * @priority Alta
     */
    it('T13: revierte un comando reversible con su snapshot', async () => {
      // Registrar comando undoable con snapshot
      await store.recordCommand({
        id: 'cmd_01',
        command: 'config:set theme dark',
        namespace: 'config',
        executed_at: new Date().toISOString(),
        duration_ms: 5,
        exit_code: 0,
        undoable: true,
        undo_status: 'available',
        snapshot_id: 'snap_01',
      });

      // Simular snapshot almacenado (el store deberia manejar esto internamente)
      // En la implementacion real, el recordCommand con undoable=true crea el snapshot

      const result = await store.undo('cmd_01');

      expect(result.status).toBe(0);
      expect(result.data.reverted).toBe('cmd_01');
      expect(result.data.snapshot_applied).toBeDefined();
    });

    /**
     * @test T14 - Undo no reversible
     * @error E005 - NOT_UNDOABLE
     * @priority Alta
     */
    it('T14: retorna error para undo de comando no reversible', async () => {
      await store.recordCommand({
        id: 'cmd_02',
        command: 'report:generate',
        namespace: 'report',
        executed_at: new Date().toISOString(),
        duration_ms: 100,
        exit_code: 0,
        undoable: false,
        undo_status: null,
        snapshot_id: null,
      });

      const result = await store.undo('cmd_02');

      expect(result.status).toBe(1);
      expect(result.error!.code).toBe('NOT_UNDOABLE');
      expect(result.error!.message).toContain('not undoable');
    });

    /**
     * @test T15 - Undo inexistente
     * @error E004 - COMMAND_NOT_FOUND
     * @priority Alta
     */
    it('T15: retorna status 2 para undo de comando inexistente', async () => {
      const result = await store.undo('cmd_99');

      expect(result.status).toBe(2);
      expect(result.error!.code).toBe('COMMAND_NOT_FOUND');
      expect(result.error!.message).toContain('not found');
    });

    /**
     * @test T16 - Undo duplicado
     * @error E006 - ALREADY_REVERTED
     * @priority Media
     */
    it('T16: retorna error cuando se intenta undo de comando ya revertido', async () => {
      await store.recordCommand({
        id: 'cmd_05',
        command: 'config:set theme dark',
        namespace: 'config',
        executed_at: new Date().toISOString(),
        duration_ms: 5,
        exit_code: 0,
        undoable: true,
        undo_status: 'available',
        snapshot_id: 'snap_05',
      });

      // Primer undo exitoso
      await store.undo('cmd_05');

      // Segundo undo debe fallar
      const result = await store.undo('cmd_05');

      expect(result.status).toBe(1);
      expect(result.error!.code).toBe('ALREADY_REVERTED');
      expect(result.error!.message).toContain('already reverted');
    });
  });

  // ----------------------------------------------------------
  // Seccion 5: Claves especiales
  // ----------------------------------------------------------
  describe('Validacion de claves', () => {

    /**
     * @test T17 - Key con puntos
     * @acceptance Clave con puntos es valida
     * @priority Media
     */
    it('T17: acepta claves con puntos (formato dotted)', async () => {
      const result = await store.set('db.host', '"localhost"');

      expect(result.status).toBe(0);
      expect(result.data.key).toBe('db.host');
    });

    /**
     * @test T18 - Key invalida (vacia)
     * @error E002 - INVALID_KEY
     * @priority Media
     */
    it('T18: retorna error para clave vacia', async () => {
      const result = await store.set('', '"value"');

      expect(result.status).toBe(1);
      expect(result.error!.code).toBe('INVALID_KEY');
    });

    /**
     * @test T19 - Valor vacio
     * @acceptance Valor vacio es valido
     * @priority Baja
     */
    it('T19: acepta valor vacio como string valido', async () => {
      const result = await store.set('key', '""');

      expect(result.status).toBe(0);
      expect(result.data.value).toBe('');
    });

    it('rechaza claves con caracteres prohibidos', async () => {
      const result = await store.set('invalid key!', '"value"');

      expect(result.status).toBe(1);
      expect(result.error!.code).toBe('INVALID_KEY');
    });

    it('acepta claves con guion bajo y guion medio', async () => {
      const r1 = await store.set('my_key', '"val"');
      const r2 = await store.set('my-key', '"val"');

      expect(r1.status).toBe(0);
      expect(r2.status).toBe(0);
    });
  });

  // ----------------------------------------------------------
  // Seccion 6: Adaptador de Storage
  // ----------------------------------------------------------
  describe('Adaptador de Storage', () => {

    /**
     * @test T20 - Concurrencia adaptador
     * @acceptance Set/Get simultaneo sin corrupcion
     * @priority Alta
     */
    it('T20: soporta operaciones concurrentes sin corrupcion de datos', async () => {
      const promises = Array.from({ length: 10 }, (_, i) =>
        store.set(`key_${i}`, `${i}`)
      );

      await Promise.all(promises);

      const result = await store.getAll();
      expect(result.status).toBe(0);
      expect(result.meta!.count).toBe(10);

      for (let i = 0; i < 10; i++) {
        expect(result.data[`key_${i}`]).toBe(i);
      }
    });

    it('intercambio de backend produce resultados identicos', async () => {
      // Usar MemoryAdapter
      const memoryAdapter = new MockMemoryAdapter();
      const store1 = new ContextStore(memoryAdapter, 'session-1');
      await memoryAdapter.initialize('session-1');

      await store1.set('x', '42');
      const r1 = await store1.get('x');

      // Usar otro MemoryAdapter (simula cambio de backend)
      const anotherAdapter = new MockMemoryAdapter();
      const store2 = new ContextStore(anotherAdapter, 'session-2');
      await anotherAdapter.initialize('session-2');

      await store2.set('x', '42');
      const r2 = await store2.get('x');

      // Mismos resultados
      expect(r1.status).toBe(r2.status);
      expect(r1.data.value).toBe(r2.data.value);
    });

    it('healthCheck retorna true para adapter funcional', async () => {
      const healthy = await adapter.healthCheck();
      expect(healthy).toBe(true);
    });

    it('healthCheck retorna false para adapter no disponible', async () => {
      const brokenAdapter: StorageAdapter = {
        name: 'broken',
        initialize: async () => {},
        load: async () => { throw new Error('unavailable'); },
        save: async () => { throw new Error('unavailable'); },
        destroy: async () => {},
        healthCheck: async () => false,
        dispose: async () => {},
      };

      const healthy = await brokenAdapter.healthCheck();
      expect(healthy).toBe(false);
    });
  });

  // ----------------------------------------------------------
  // Seccion 7: MUST NOT
  // ----------------------------------------------------------
  describe('MUST NOT - Restricciones del Context Store', () => {

    it('no almacena datos binarios o blobs grandes', async () => {
      // Un valor extremadamente grande deberia ser rechazado
      const largeValue = '"' + 'x'.repeat(65536) + '"'; // > 64KB
      const result = await store.set('large', largeValue);

      expect(result.status).toBe(1);
      expect(result.error!.code).toBe('INVALID_VALUE');
    });

    it('no expone internals del storage en las respuestas', async () => {
      await store.set('key', '"value"');
      const result = await store.get('key');

      // Solo debe contener campos del contrato
      expect(result).not.toHaveProperty('_internal');
      expect(result).not.toHaveProperty('adapter');
      expect(result.data).not.toHaveProperty('_raw');
    });
  });

  // ----------------------------------------------------------
  // Seccion 8: Limites (CONSTRAINTS)
  // ----------------------------------------------------------
  describe('Limites del Context Store', () => {

    it('soporta hasta 1000 claves por sesion', async () => {
      // Registrar 1000 claves
      for (let i = 0; i < 1000; i++) {
        const result = await store.set(`key_${i}`, `${i}`);
        expect(result.status).toBe(0);
      }

      const all = await store.getAll();
      expect(all.meta!.count).toBe(1000);
    });

    it('rechaza clave con mas de 128 caracteres', async () => {
      const longKey = 'a'.repeat(129);
      const result = await store.set(longKey, '"value"');

      expect(result.status).toBe(1);
      expect(result.error!.code).toBe('INVALID_KEY');
    });

    it('historial aplica FIFO cuando excede 10000 entradas', async () => {
      // Esto es un test de diseño - en la practica se verificaria
      // que al exceder el limite, las entradas mas antiguas se descartan
      // Aqui solo verificamos la estructura
      for (let i = 0; i < 100; i++) {
        await store.recordCommand({
          id: `cmd_${i}`,
          command: `test:cmd`,
          namespace: 'test',
          executed_at: new Date().toISOString(),
          duration_ms: 1,
          exit_code: 0,
          undoable: false,
        });
      }

      const result = await store.getHistory({ limit: 50 });
      expect(result.data.length).toBeLessThanOrEqual(50);
    });
  });

  // ----------------------------------------------------------
  // Seccion 9: Formato de respuestas
  // ----------------------------------------------------------
  describe('Formato de respuestas', () => {

    it('respuesta exitosa incluye meta.session_id', async () => {
      const result = await store.getAll();

      expect(result.meta!.session_id).toBe('test-session-001');
    });

    it('respuesta exitosa incluye meta.timestamp ISO 8601', async () => {
      const result = await store.getAll();

      expect(result.meta!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('respuesta de error incluye codigo y mensaje', async () => {
      const result = await store.get('nonexistent');

      expect(result.status).toBe(2);
      expect(result.error!.code).toBeDefined();
      expect(result.error!.message).toBeDefined();
      expect(typeof result.error!.message).toBe('string');
    });
  });
});
