/**
 * Tests para los adapters SQLite.
 *
 * Cubre: SQLiteStorageAdapter (ContextStore) y SQLiteRegistryAdapter (CommandRegistry).
 * Usa mock in-memory del SQLiteDatabase interface para tests sin dependencias externas.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SQLiteStorageAdapter } from '../src/context-store/sqlite-storage-adapter.js';
import { SQLiteRegistryAdapter } from '../src/command-registry/sqlite-registry-adapter.js';
import type { SessionStore } from '../src/context-store/types.js';
import type { CommandDefinition } from '../src/command-registry/types.js';
import type { SQLiteDatabase, SQLiteStatement } from '../src/context-store/sqlite-types.js';

// =====================================================================
// In-memory mock SQLite database (implements SQLiteDatabase interface)
// =====================================================================
class MockDatabase implements SQLiteDatabase {
  private tables = new Map<string, { columns: string[]; rows: any[] }>();
  private indexes = new Set<string>();
  private autoIncrements = new Map<string, number>();

  exec(sql: string): void {
    // Split by semicolons and execute each statement
    const statements = sql.split(';').map(s => s.trim()).filter(s => s.length > 0);
    for (const stmt of statements) {
      this.execSingle(stmt);
    }
  }

  private execSingle(sql: string): void {
    const upper = sql.toUpperCase().trim();
    if (upper.startsWith('CREATE TABLE')) {
      this.createTable(sql);
    } else if (upper.startsWith('CREATE INDEX') || upper.startsWith('CREATE UNIQUE INDEX')) {
      // Just track index existence
      const match = sql.match(/(?:CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?)(\w+)/i);
      if (match) this.indexes.add(match[1]);
    }
  }

  private createTable(sql: string): void {
    const match = sql.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(([\s\S]+)\)/i);
    if (!match) return;
    const tableName = match[1];
    if (this.tables.has(tableName)) return; // IF NOT EXISTS
    const body = match[2];
    const columns: string[] = [];
    // Parse column definitions (simplified)
    const parts = this.splitTopLevel(body);
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed.toUpperCase().startsWith('CONSTRAINT') ||
          trimmed.toUpperCase().startsWith('PRIMARY KEY') ||
          trimmed.toUpperCase().startsWith('UNIQUE') ||
          trimmed.toUpperCase().startsWith('FOREIGN KEY') ||
          trimmed.toUpperCase().startsWith('CHECK')) continue;
      const colMatch = trimmed.match(/^(\w+)\s+/);
      if (colMatch) columns.push(colMatch[1]);
    }
    this.tables.set(tableName, { columns, rows: [] });
    this.autoIncrements.set(tableName, 0);
  }

  private splitTopLevel(str: string): string[] {
    const result: string[] = [];
    let depth = 0;
    let current = '';
    for (const ch of str) {
      if (ch === '(') { depth++; current += ch; }
      else if (ch === ')') { depth--; current += ch; }
      else if (ch === ',' && depth === 0) { result.push(current); current = ''; }
      else { current += ch; }
    }
    if (current.trim()) result.push(current);
    return result;
  }

  prepare(sql: string): SQLiteStatement {
    return new MockStatement(this, sql);
  }

  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T {
    return (...args: any[]) => fn(...args);
  }

  // Internal methods used by MockStatement
  _insert(table: string, columns: string[], values: any[]): { changes: number; lastInsertRowid: number } {
    const t = this.tables.get(table);
    if (!t) throw new Error(`no such table: ${table}`);

    const row: any = {};
    for (const col of t.columns) {
      row[col] = null;
    }

    // Handle auto-increment ID
    if (t.columns.includes('id') && !columns.includes('id')) {
      const next = (this.autoIncrements.get(table) ?? 0) + 1;
      this.autoIncrements.set(table, next);
      row.id = next;
    }

    for (let i = 0; i < columns.length; i++) {
      row[columns[i]] = values[i] ?? null;
    }

    t.rows.push(row);
    return { changes: 1, lastInsertRowid: row.id ?? t.rows.length };
  }

  _upsert(table: string, columns: string[], values: any[], conflictCols: string[], updateCols: string[], updateValues: any[]): { changes: number } {
    const t = this.tables.get(table);
    if (!t) throw new Error(`no such table: ${table}`);

    // Find existing row by conflict columns
    const existing = t.rows.find(r =>
      conflictCols.every((col, i) => r[col] === values[columns.indexOf(col)])
    );

    if (existing) {
      for (let i = 0; i < updateCols.length; i++) {
        existing[updateCols[i]] = updateValues[i];
      }
      return { changes: 1 };
    }

    return this._insert(table, columns, values);
  }

  _select(table: string, where?: Record<string, any>, orderBy?: string, limit?: number): any[] {
    const t = this.tables.get(table);
    if (!t) throw new Error(`no such table: ${table}`);

    let rows = [...t.rows];

    if (where) {
      rows = rows.filter(r => Object.entries(where).every(([k, v]) => r[k] === v));
    }

    if (orderBy) {
      const desc = orderBy.includes('DESC');
      const col = orderBy.replace(/\s*(ASC|DESC)\s*/gi, '').trim();
      rows.sort((a, b) => {
        if (a[col] < b[col]) return desc ? 1 : -1;
        if (a[col] > b[col]) return desc ? -1 : 1;
        return 0;
      });
    }

    if (limit) rows = rows.slice(0, limit);
    return rows;
  }

  _delete(table: string, where: Record<string, any>): { changes: number } {
    const t = this.tables.get(table);
    if (!t) throw new Error(`no such table: ${table}`);
    const before = t.rows.length;
    t.rows = t.rows.filter(r => !Object.entries(where).every(([k, v]) => r[k] === v));
    return { changes: before - t.rows.length };
  }

  _update(table: string, set: Record<string, any>, where: Record<string, any>): { changes: number } {
    const t = this.tables.get(table);
    if (!t) throw new Error(`no such table: ${table}`);
    let changes = 0;
    for (const row of t.rows) {
      if (Object.entries(where).every(([k, v]) => row[k] === v)) {
        Object.assign(row, set);
        changes++;
      }
    }
    return { changes };
  }

  _count(table: string): number {
    const t = this.tables.get(table);
    if (!t) throw new Error(`no such table: ${table}`);
    return t.rows.length;
  }

  _distinct(table: string, column: string, orderBy?: string): any[] {
    const t = this.tables.get(table);
    if (!t) throw new Error(`no such table: ${table}`);
    const values = [...new Set(t.rows.map(r => r[column]))];
    if (orderBy) values.sort();
    return values.map(v => ({ [column]: v }));
  }
}

class MockStatement implements SQLiteStatement {
  constructor(private db: MockDatabase, private sql: string) {}

  run(...params: any[]): any {
    return this.execute(params);
  }

  get(...params: any[]): any {
    const results = this.execute(params);
    return Array.isArray(results) ? results[0] ?? null : results;
  }

  all(...params: any[]): any[] {
    const results = this.execute(params);
    return Array.isArray(results) ? results : [];
  }

  private execute(params: any[]): any {
    const sql = this.sql.trim();
    const upper = sql.toUpperCase();

    // SELECT 1 AS ok (health check)
    if (upper.includes('SELECT 1 AS OK')) {
      return [{ ok: 1 }];
    }

    // SELECT COUNT(*) AS cnt
    if (upper.includes('SELECT COUNT(*)')) {
      const tableMatch = sql.match(/FROM\s+(\w+)/i);
      if (tableMatch) {
        const count = (this.db as any)._count(tableMatch[1]);
        return [{ cnt: count }];
      }
    }

    // SELECT DISTINCT
    if (upper.includes('SELECT DISTINCT')) {
      const match = sql.match(/SELECT\s+DISTINCT\s+(\w+)\s+FROM\s+(\w+)/i);
      if (match) {
        const orderBy = upper.includes('ORDER BY') ? match[1] : undefined;
        return (this.db as any)._distinct(match[2], match[1], orderBy);
      }
    }

    // SELECT * FROM table WHERE ...
    if (upper.startsWith('SELECT')) {
      const tableMatch = sql.match(/FROM\s+(\w+)/i);
      if (!tableMatch) return [];
      const table = tableMatch[1];
      const where = this.parseWhere(sql, params);
      const orderBy = this.parseOrderBy(sql);
      const limit = this.parseLimit(sql);
      return (this.db as any)._select(table, where, orderBy, limit);
    }

    // INSERT ... ON CONFLICT ... DO UPDATE
    if (upper.includes('ON CONFLICT')) {
      return this.executeUpsert(sql, params);
    }

    // INSERT INTO
    if (upper.startsWith('INSERT')) {
      return this.executeInsert(sql, params);
    }

    // DELETE FROM
    if (upper.startsWith('DELETE')) {
      const tableMatch = sql.match(/FROM\s+(\w+)/i);
      if (!tableMatch) return { changes: 0 };
      const where = this.parseWhere(sql, params);
      return (this.db as any)._delete(tableMatch[1], where ?? {});
    }

    // UPDATE
    if (upper.startsWith('UPDATE')) {
      return this.executeUpdate(sql, params);
    }

    return { changes: 0 };
  }

  private executeInsert(sql: string, params: any[]): any {
    const match = sql.match(/INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
    if (!match) return { changes: 0 };
    const table = match[1];
    const columns = match[2].split(',').map(c => c.trim());
    const values = this.resolveParams(match[3], params);
    return (this.db as any)._insert(table, columns, values);
  }

  private executeUpsert(sql: string, params: any[]): any {
    const insertMatch = sql.match(/INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
    if (!insertMatch) return { changes: 0 };
    const table = insertMatch[1];
    const columns = insertMatch[2].split(',').map(c => c.trim());

    const conflictMatch = sql.match(/ON\s+CONFLICT\s*\(([^)]+)\)/i);
    const conflictCols = conflictMatch ? conflictMatch[1].split(',').map(c => c.trim()) : [];

    const updateMatch = sql.match(/DO\s+UPDATE\s+SET\s+([\s\S]+?)(?:$)/i);
    const updateCols: string[] = [];
    const updateIdxs: number[] = [];

    if (updateMatch) {
      const setParts = this.splitTopLevel(updateMatch[1]);
      for (const part of setParts) {
        const m = part.match(/(\w+)\s*=\s*(?:excluded\.(\w+)|(\?))/i);
        if (m) {
          updateCols.push(m[1]);
        }
      }
    }

    // All params: first N for INSERT values, rest implicitly for upsert (same values)
    const insertValues = params.slice(0, columns.length);

    // For ON CONFLICT DO UPDATE SET col = excluded.col, the values come from the INSERT values
    const updateValues = updateCols.map(col => {
      const idx = columns.indexOf(col);
      return idx >= 0 ? insertValues[idx] : null;
    });

    return (this.db as any)._upsert(table, columns, insertValues, conflictCols, updateCols, updateValues);
  }

  private executeUpdate(sql: string, params: any[]): any {
    const tableMatch = sql.match(/UPDATE\s+(\w+)\s+SET/i);
    if (!tableMatch) return { changes: 0 };

    const setMatch = sql.match(/SET\s+([\s\S]+?)(?:WHERE|$)/i);
    const whereMatch = sql.match(/WHERE\s+([\s\S]+)$/i);

    const set: Record<string, any> = {};
    let paramIdx = 0;

    if (setMatch) {
      const parts = this.splitTopLevel(setMatch[1]);
      for (const part of parts) {
        const m = part.trim().match(/(\w+)\s*=\s*\?/);
        if (m) {
          set[m[1]] = params[paramIdx++];
        }
      }
    }

    const where: Record<string, any> = {};
    if (whereMatch) {
      const conditions = whereMatch[1].split(/\s+AND\s+/i);
      for (const cond of conditions) {
        const m = cond.trim().match(/(\w+)\s*=\s*\?/);
        if (m) {
          where[m[1]] = params[paramIdx++];
        }
      }
    }

    return (this.db as any)._update(tableMatch[1], set, where);
  }

  private parseWhere(sql: string, params: any[]): Record<string, any> | undefined {
    const whereMatch = sql.match(/WHERE\s+([\s\S]+?)(?:ORDER|LIMIT|$)/i);
    if (!whereMatch) return undefined;

    const where: Record<string, any> = {};
    const conditions = whereMatch[1].split(/\s+AND\s+/i);

    // Count params before WHERE to determine offset
    const beforeWhere = sql.substring(0, sql.toUpperCase().indexOf('WHERE'));
    const paramsBefore = (beforeWhere.match(/\?/g) || []).length;

    let idx = paramsBefore;
    for (const cond of conditions) {
      const m = cond.trim().match(/(\w+)\s*=\s*\?/);
      if (m && idx < params.length) {
        where[m[1]] = params[idx++];
      }
    }
    return Object.keys(where).length > 0 ? where : undefined;
  }

  private parseOrderBy(sql: string): string | undefined {
    const match = sql.match(/ORDER\s+BY\s+([\w.]+(?:\s+(?:ASC|DESC))?)/i);
    return match ? match[1] : undefined;
  }

  private parseLimit(sql: string): number | undefined {
    const match = sql.match(/LIMIT\s+(\d+)/i);
    return match ? parseInt(match[1]) : undefined;
  }

  private resolveParams(valuePart: string, params: any[]): any[] {
    const placeholders = valuePart.split(',');
    const values: any[] = [];
    let paramIdx = 0;
    for (const ph of placeholders) {
      if (ph.trim() === '?') {
        values.push(params[paramIdx++]);
      } else {
        // Literal or default expression
        values.push(null);
      }
    }
    return values;
  }

  private splitTopLevel(str: string): string[] {
    const result: string[] = [];
    let depth = 0;
    let current = '';
    for (const ch of str) {
      if (ch === '(') { depth++; current += ch; }
      else if (ch === ')') { depth--; current += ch; }
      else if (ch === ',' && depth === 0) { result.push(current); current = ''; }
      else { current += ch; }
    }
    if (current.trim()) result.push(current);
    return result;
  }
}

function createSampleStore(): SessionStore {
  return {
    context: {
      entries: {
        theme: { key: 'theme', value: 'dark', type: 'string', set_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', version: 1 },
        count: { key: 'count', value: 42, type: 'number', set_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T01:00:00Z', version: 3 },
      },
    },
    history: [
      {
        id: 'cmd-001',
        command: 'users:list',
        namespace: 'users',
        args: { limit: 10 },
        executed_at: '2026-01-01T00:00:00Z',
        duration_ms: 15,
        exit_code: 0,
        result_summary: '3 users returned',
        undoable: false,
        undo_status: null,
        snapshot_id: null,
      },
      {
        id: 'cmd-002',
        command: 'users:create --name "Test"',
        namespace: 'users',
        args: { name: 'Test' },
        executed_at: '2026-01-01T00:01:00Z',
        duration_ms: 25,
        exit_code: 0,
        result_summary: 'User created',
        undoable: true,
        undo_status: 'available',
        snapshot_id: 'snap-001',
      },
    ],
    undo_snapshots: [
      {
        id: 'snap-001',
        command_id: 'cmd-002',
        created_at: '2026-01-01T00:01:00Z',
        state_before: { users: [{ id: 1 }] },
        rollback_command: 'users:delete --id 99',
        metadata: { reason: 'create' },
      },
    ],
    createdAt: '2026-01-01T00:00:00Z',
    lastAccessAt: '2026-01-01T00:01:00Z',
  };
}

function createSampleDefinition(overrides?: Partial<CommandDefinition>): CommandDefinition {
  return {
    namespace: 'users',
    name: 'create',
    version: '1.0.0',
    description: 'Crea un nuevo usuario',
    params: [
      { name: 'name', type: 'string', required: true },
      { name: 'email', type: 'string', required: true },
    ],
    output: { type: 'object', description: 'User object' },
    example: 'users:create --name "John" --email "j@t.com"',
    tags: ['users', 'create', 'crud'],
    reversible: true,
    requiresConfirmation: false,
    deprecated: false,
    ...overrides,
  };
}

// =====================================================================
// SQLiteStorageAdapter
// =====================================================================
describe('SQLiteStorageAdapter', () => {
  let db: any;
  let adapter: SQLiteStorageAdapter;

  beforeEach(() => {
    db = new MockDatabase();
    adapter = new SQLiteStorageAdapter({ db });
  });

  it('T01: initialize crea tablas y registra la sesion', async () => {
    await adapter.initialize('sess-1');
    const row = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get('sess-1');
    expect(row).toBeTruthy();
    expect(row.status).toBe('active');
  });

  it('T02: initialize no duplica si se llama multiples veces', async () => {
    await adapter.initialize('sess-1');
    await adapter.initialize('sess-1');
    const rows = db.prepare('SELECT * FROM sessions WHERE session_id = ?').all('sess-1');
    expect(rows).toHaveLength(1);
  });

  it('T03: load retorna null para sesion inexistente', async () => {
    await adapter.initialize('sess-1');
    const result = await adapter.load('nonexistent');
    expect(result).toBeNull();
  });

  it('T04: save y load roundtrip preserva context entries', async () => {
    const store = createSampleStore();
    await adapter.save('sess-1', store);
    const loaded = await adapter.load('sess-1');

    expect(loaded).not.toBeNull();
    expect(loaded!.context.entries.theme.value).toBe('dark');
    expect(loaded!.context.entries.theme.type).toBe('string');
    expect(loaded!.context.entries.theme.version).toBe(1);
    expect(loaded!.context.entries.count.value).toBe(42);
    expect(loaded!.context.entries.count.type).toBe('number');
    expect(loaded!.context.entries.count.version).toBe(3);
  });

  it('T05: save y load roundtrip preserva history', async () => {
    const store = createSampleStore();
    await adapter.save('sess-1', store);
    const loaded = await adapter.load('sess-1');

    expect(loaded!.history).toHaveLength(2);
    expect(loaded!.history[0].id).toBe('cmd-001');
    expect(loaded!.history[0].command).toBe('users:list');
    expect(loaded!.history[0].args).toEqual({ limit: 10 });
    expect(loaded!.history[0].undoable).toBe(false);
    expect(loaded!.history[1].id).toBe('cmd-002');
    expect(loaded!.history[1].undoable).toBe(true);
    expect(loaded!.history[1].undo_status).toBe('available');
  });

  it('T06: save y load roundtrip preserva undo_snapshots', async () => {
    const store = createSampleStore();
    await adapter.save('sess-1', store);
    const loaded = await adapter.load('sess-1');

    expect(loaded!.undo_snapshots).toHaveLength(1);
    expect(loaded!.undo_snapshots[0].id).toBe('snap-001');
    expect(loaded!.undo_snapshots[0].command_id).toBe('cmd-002');
    expect(loaded!.undo_snapshots[0].state_before).toEqual({ users: [{ id: 1 }] });
    expect(loaded!.undo_snapshots[0].rollback_command).toBe('users:delete --id 99');
  });

  it('T07: save sobrescribe datos anteriores de la misma sesion', async () => {
    const store1 = createSampleStore();
    await adapter.save('sess-1', store1);

    const store2: SessionStore = {
      context: { entries: { newKey: { key: 'newKey', value: 'newVal', type: 'string', set_at: '', updated_at: '', version: 1 } } },
      history: [],
      undo_snapshots: [],
    };
    await adapter.save('sess-1', store2);

    const loaded = await adapter.load('sess-1');
    expect(Object.keys(loaded!.context.entries)).toEqual(['newKey']);
    expect(loaded!.history).toHaveLength(0);
    expect(loaded!.undo_snapshots).toHaveLength(0);
  });

  it('T08: multiples sesiones son independientes', async () => {
    const store1: SessionStore = {
      context: { entries: { a: { key: 'a', value: 1, type: 'number', set_at: '', updated_at: '', version: 1 } } },
      history: [],
      undo_snapshots: [],
    };
    const store2: SessionStore = {
      context: { entries: { b: { key: 'b', value: 2, type: 'number', set_at: '', updated_at: '', version: 1 } } },
      history: [],
      undo_snapshots: [],
    };

    await adapter.save('sess-A', store1);
    await adapter.save('sess-B', store2);

    const loadedA = await adapter.load('sess-A');
    const loadedB = await adapter.load('sess-B');

    expect(Object.keys(loadedA!.context.entries)).toEqual(['a']);
    expect(Object.keys(loadedB!.context.entries)).toEqual(['b']);
  });

  it('T09: destroy elimina todos los datos de la sesion', async () => {
    await adapter.save('sess-1', createSampleStore());
    await adapter.destroy('sess-1');

    const loaded = await adapter.load('sess-1');
    expect(loaded).toBeNull();

    // Verify tables are clean
    const ctx = db.prepare('SELECT * FROM session_context WHERE session_id = ?').all('sess-1');
    const hist = db.prepare('SELECT * FROM command_history WHERE session_id = ?').all('sess-1');
    const snaps = db.prepare('SELECT * FROM undo_snapshots WHERE session_id = ?').all('sess-1');
    expect(ctx).toHaveLength(0);
    expect(hist).toHaveLength(0);
    expect(snaps).toHaveLength(0);
  });

  it('T10: healthCheck retorna true con DB valida', async () => {
    const result = await adapter.healthCheck();
    expect(result).toBe(true);
  });

  it('T11: autoMigrate=false no crea tablas automaticamente', async () => {
    const noMigrate = new SQLiteStorageAdapter({ db: new MockDatabase(), autoMigrate: false });
    await expect(noMigrate.load('sess-1')).rejects.toThrow();
  });

  it('T12: valores complejos (objetos y arrays) se preservan', async () => {
    const store: SessionStore = {
      context: {
        entries: {
          config: {
            key: 'config',
            value: { nested: { deep: [1, 2, 3] }, flag: true },
            type: 'object',
            set_at: '',
            updated_at: '',
            version: 1,
          },
          list: {
            key: 'list',
            value: [{ id: 1 }, { id: 2 }],
            type: 'array',
            set_at: '',
            updated_at: '',
            version: 1,
          },
        },
      },
      history: [],
      undo_snapshots: [],
    };

    await adapter.save('sess-1', store);
    const loaded = await adapter.load('sess-1');

    expect(loaded!.context.entries.config.value).toEqual({ nested: { deep: [1, 2, 3] }, flag: true });
    expect(loaded!.context.entries.list.value).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('T13: history con args complejos se serializa correctamente', async () => {
    const store: SessionStore = {
      context: { entries: {} },
      history: [{
        id: 'cmd-complex',
        command: 'test:cmd',
        namespace: 'test',
        args: { filters: [{ field: 'name', op: 'eq', value: 'John' }], nested: { a: 1 } },
        executed_at: '2026-01-01T00:00:00Z',
        duration_ms: 10,
        exit_code: 0,
        result_summary: 'done',
        undoable: false,
        undo_status: null,
        snapshot_id: null,
      }],
      undo_snapshots: [],
    };

    await adapter.save('sess-1', store);
    const loaded = await adapter.load('sess-1');

    expect(loaded!.history[0].args).toEqual({
      filters: [{ field: 'name', op: 'eq', value: 'John' }],
      nested: { a: 1 },
    });
  });

  it('T14: dispose es no-op (no lanza)', async () => {
    await expect(adapter.dispose()).resolves.not.toThrow();
  });

  it('T15: sesion vacia (sin entries, history ni snapshots) se guarda y carga', async () => {
    const empty: SessionStore = { context: { entries: {} }, history: [], undo_snapshots: [] };
    await adapter.save('empty-sess', empty);
    const loaded = await adapter.load('empty-sess');

    expect(loaded).not.toBeNull();
    expect(Object.keys(loaded!.context.entries)).toHaveLength(0);
    expect(loaded!.history).toHaveLength(0);
    expect(loaded!.undo_snapshots).toHaveLength(0);
  });
});

// =====================================================================
// SQLiteRegistryAdapter
// =====================================================================
describe('SQLiteRegistryAdapter', () => {
  let db: any;
  let adapter: SQLiteRegistryAdapter;

  beforeEach(() => {
    db = new MockDatabase();
    adapter = new SQLiteRegistryAdapter({ db });
    adapter.initialize();
  });

  it('T16: initialize permite queries contra la tabla commands', () => {
    // After initialize, the commands table should exist and be queryable
    const rows = adapter.loadAll();
    expect(rows).toHaveLength(0);
  });

  it('T17: save persiste una definicion', () => {
    adapter.save(createSampleDefinition());
    const count = adapter.count();
    expect(count).toBe(1);
  });

  it('T18: loadAll retorna todas las definiciones', () => {
    adapter.save(createSampleDefinition());
    adapter.save(createSampleDefinition({ name: 'list', description: 'Lista usuarios' }));
    adapter.save(createSampleDefinition({ namespace: 'orders', name: 'list', description: 'Lista ordenes' }));

    const all = adapter.loadAll();
    expect(all).toHaveLength(3);
  });

  it('T19: loadOne retorna la definicion correcta', () => {
    adapter.save(createSampleDefinition());
    const def = adapter.loadOne('users', 'create');
    expect(def).not.toBeNull();
    expect(def!.namespace).toBe('users');
    expect(def!.name).toBe('create');
    expect(def!.description).toBe('Crea un nuevo usuario');
  });

  it('T20: loadOne con version especifica', () => {
    adapter.save(createSampleDefinition({ version: '1.0.0' }));
    adapter.save(createSampleDefinition({ version: '2.0.0', description: 'V2 create' }));

    const v1 = adapter.loadOne('users', 'create', '1.0.0');
    const v2 = adapter.loadOne('users', 'create', '2.0.0');

    expect(v1!.description).toBe('Crea un nuevo usuario');
    expect(v2!.description).toBe('V2 create');
  });

  it('T21: loadOne sin version retorna la mas reciente', () => {
    adapter.save(createSampleDefinition({ version: '1.0.0' }));
    adapter.save(createSampleDefinition({ version: '2.0.0', description: 'V2 create' }));

    const latest = adapter.loadOne('users', 'create');
    expect(latest!.version).toBe('2.0.0');
    expect(latest!.description).toBe('V2 create');
  });

  it('T22: loadOne retorna null para comando inexistente', () => {
    const result = adapter.loadOne('fake', 'cmd');
    expect(result).toBeNull();
  });

  it('T23: loadByNamespace filtra correctamente', () => {
    adapter.save(createSampleDefinition({ namespace: 'users', name: 'create' }));
    adapter.save(createSampleDefinition({ namespace: 'users', name: 'list' }));
    adapter.save(createSampleDefinition({ namespace: 'orders', name: 'list' }));

    const users = adapter.loadByNamespace('users');
    const orders = adapter.loadByNamespace('orders');

    expect(users).toHaveLength(2);
    expect(orders).toHaveLength(1);
  });

  it('T24: getNamespaces retorna namespaces unicos', () => {
    adapter.save(createSampleDefinition({ namespace: 'users', name: 'create' }));
    adapter.save(createSampleDefinition({ namespace: 'users', name: 'list' }));
    adapter.save(createSampleDefinition({ namespace: 'orders', name: 'list' }));
    adapter.save(createSampleDefinition({ namespace: 'notes', name: 'create' }));

    const namespaces = adapter.getNamespaces();
    expect(namespaces).toEqual(['notes', 'orders', 'users']);
  });

  it('T25: delete elimina un comando y retorna true', () => {
    adapter.save(createSampleDefinition());
    const deleted = adapter.delete('users', 'create', '1.0.0');
    expect(deleted).toBe(true);
    expect(adapter.count()).toBe(0);
  });

  it('T26: delete retorna false si no existe', () => {
    const deleted = adapter.delete('fake', 'cmd', '1.0.0');
    expect(deleted).toBe(false);
  });

  it('T27: save upserts (actualiza si ya existe)', () => {
    adapter.save(createSampleDefinition({ description: 'Original' }));
    adapter.save(createSampleDefinition({ description: 'Updated' }));

    expect(adapter.count()).toBe(1);
    const loaded = adapter.loadOne('users', 'create');
    expect(loaded!.description).toBe('Updated');
  });

  it('T28: saveBatch inserta multiples en una transaccion', () => {
    const defs = [
      createSampleDefinition({ name: 'create' }),
      createSampleDefinition({ name: 'list', description: 'Lista usuarios' }),
      createSampleDefinition({ name: 'delete', description: 'Elimina usuario' }),
    ];

    adapter.saveBatch(defs);
    expect(adapter.count()).toBe(3);
  });

  it('T29: params se serializan y deserializan correctamente', () => {
    const def = createSampleDefinition({
      params: [
        { name: 'name', type: 'string', required: true, description: 'Nombre' },
        { name: 'age', type: 'int', required: false, default: 18, constraints: 'min:0' },
      ],
    });

    adapter.save(def);
    const loaded = adapter.loadOne('users', 'create');

    expect(loaded!.params).toHaveLength(2);
    expect(loaded!.params[0].name).toBe('name');
    expect(loaded!.params[0].required).toBe(true);
    expect(loaded!.params[1].default).toBe(18);
    expect(loaded!.params[1].constraints).toBe('min:0');
  });

  it('T30: tags se preservan', () => {
    const def = createSampleDefinition({ tags: ['crud', 'admin', 'user-management'] });
    adapter.save(def);
    const loaded = adapter.loadOne('users', 'create');
    expect(loaded!.tags).toEqual(['crud', 'admin', 'user-management']);
  });

  it('T31: campos booleanos se mapean correctamente', () => {
    const def = createSampleDefinition({
      reversible: true,
      requiresConfirmation: true,
      deprecated: true,
      deprecatedMessage: 'Use users:create-v2 instead',
    });

    adapter.save(def);
    const loaded = adapter.loadOne('users', 'create');

    expect(loaded!.reversible).toBe(true);
    expect(loaded!.requiresConfirmation).toBe(true);
    expect(loaded!.deprecated).toBe(true);
    expect(loaded!.deprecatedMessage).toBe('Use users:create-v2 instead');
  });

  it('T32: requiredPermissions se persisten', () => {
    const def = createSampleDefinition({
      requiredPermissions: ['users:write', 'admin:access'],
    });

    adapter.save(def);
    const loaded = adapter.loadOne('users', 'create');
    expect(loaded!.requiredPermissions).toEqual(['users:write', 'admin:access']);
  });

  it('T33: output shape se preserva', () => {
    const def = createSampleDefinition({
      output: { type: 'array', description: 'List of user objects' },
    });

    adapter.save(def);
    const loaded = adapter.loadOne('users', 'create');
    expect(loaded!.output).toEqual({ type: 'array', description: 'List of user objects' });
  });

  it('T34: count retorna 0 para tabla vacia', () => {
    expect(adapter.count()).toBe(0);
  });

  it('T35: autoMigrate=false no crea tablas', () => {
    const noMigrate = new SQLiteRegistryAdapter({ db: new MockDatabase(), autoMigrate: false });
    expect(() => noMigrate.loadAll()).toThrow();
  });
});
