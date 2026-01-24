/**
 * @module context-store
 * @description Almacen de estado de sesion para Agent Shell.
 *
 * Mantiene pares clave-valor, historial de comandos ejecutados y
 * snapshots de undo. Delega la persistencia a un StorageAdapter
 * inyectado, permitiendo backends intercambiables (memoria, disco, Redis).
 */

import type { StorageAdapter, SessionStore, HistoryEntry, UndoSnapshot, OperationResult, ContextStoreConfig, RetentionPolicy } from './types.js';
import { MAX_KEY_LENGTH, MAX_VALUE_SIZE, MAX_KEYS, MAX_HISTORY, DEFAULT_HISTORY_LIMIT, KEY_PATTERN } from './types.js';
import { maskSecrets, containsSecret } from '../security/secret-patterns.js';

export { type StorageAdapter, type OperationResult, type HistoryEntry, type UndoSnapshot, type SessionStore, type ContextStoreConfig } from './types.js';
export { EncryptedStorageAdapter, type EncryptionConfig } from './encrypted-storage-adapter.js';
export { SQLiteStorageAdapter } from './sqlite-storage-adapter.js';
export { type SQLiteDatabase, type SQLiteStorageConfig } from './sqlite-types.js';

class SessionExpiredError extends Error {
  constructor(sessionId: string, age: number, ttl: number) {
    super(`Session '${sessionId}' expired: age ${Math.round(age / 1000)}s exceeds TTL ${Math.round(ttl / 1000)}s`);
    this.name = 'SessionExpiredError';
  }
}

const MAX_SNAPSHOTS = 100;

/**
 * Context Store: almacen de estado de sesion con historial y undo.
 *
 * @example
 * ```ts
 * const store = new ContextStore(memoryAdapter, 'session-001');
 * await store.set('project', '"my-app"');
 * const result = await store.get('project');
 * // result.data.value === 'my-app'
 * ```
 */
export class ContextStore {
  private adapter: StorageAdapter;
  private sessionId: string;
  private config: ContextStoreConfig;

  constructor(adapter: StorageAdapter, sessionId?: string, config?: ContextStoreConfig) {
    this.adapter = adapter;
    this.sessionId = sessionId || crypto.randomUUID();
    this.config = config ?? {};
  }

  /**
   * Establece un par clave-valor en el contexto.
   * El valor se parsea con inferencia de tipo (JSON.parse).
   */
  async set(key: string, value: string): Promise<OperationResult> {
    // Validate key
    const keyError = this.validateKey(key);
    if (keyError) return keyError;

    // Validate value size
    if (value.length > MAX_VALUE_SIZE) {
      return this.errorResult(1, 'INVALID_VALUE', `Value exceeds maximum size of ${MAX_VALUE_SIZE} bytes`);
    }

    // Secret detection
    if (this.config.secretDetection) {
      const { mode, patterns } = this.config.secretDetection;
      if (containsSecret(value, patterns)) {
        if (mode === 'reject') {
          return this.errorResult(1, 'SECRET_DETECTED', `Value for key '${key}' appears to contain a secret and was rejected`);
        }
      }
    }

    const parsed = parseValue(value);
    const serialized = JSON.stringify(parsed);
    if (serialized.length > MAX_VALUE_SIZE) {
      return this.errorResult(1, 'INVALID_VALUE', `Serialized value exceeds maximum size of ${MAX_VALUE_SIZE} bytes`);
    }

    let store: SessionStore;
    try {
      store = await this.loadStore();
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        return this.errorResult(1, 'SESSION_EXPIRED', err.message);
      }
      throw err;
    }

    const now = new Date().toISOString();
    const existing = store.context.entries[key];

    // Enforce MAX_KEYS limit (only for new keys)
    if (!existing) {
      const currentKeyCount = Object.keys(store.context.entries).length;
      if (currentKeyCount >= MAX_KEYS) {
        return this.errorResult(1, 'MAX_KEYS_EXCEEDED', `Cannot add key '${key}': session has reached maximum of ${MAX_KEYS} keys`);
      }
    }
    const previous = existing ? existing.value : undefined;

    store.context.entries[key] = {
      key,
      value: parsed,
      type: getType(parsed),
      set_at: existing ? existing.set_at : now,
      updated_at: now,
      version: existing ? existing.version + 1 : 1,
    };

    await this.saveStore(store);

    const data: any = { key, value: parsed };
    if (previous !== undefined) {
      data.previous = previous;
    }

    // Warn mode: success but with warning
    if (this.config.secretDetection?.mode === 'warn' && containsSecret(value, this.config.secretDetection.patterns)) {
      return this.successResult(data, { warnings: [`Value for key '${key}' may contain a secret`] });
    }

    return this.successResult(data);
  }

  /** Recupera un valor del contexto por clave. */
  async get(key: string): Promise<OperationResult> {
    let store: SessionStore;
    try {
      store = await this.loadStore();
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        return this.errorResult(1, 'SESSION_EXPIRED', err.message);
      }
      throw err;
    }
    const entry = store.context.entries[key];

    if (!entry) {
      return this.errorResult(2, 'KEY_NOT_FOUND', `Key '${key}' not found in context`);
    }

    return this.successResult({ key, value: entry.value });
  }

  /** Retorna todo el contexto como mapa clave-valor plano. */
  async getAll(): Promise<OperationResult> {
    let store: SessionStore;
    try {
      store = await this.loadStore();
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        return this.errorResult(1, 'SESSION_EXPIRED', err.message);
      }
      throw err;
    }
    const entries = store.context.entries;
    const data: Record<string, any> = {};

    for (const [k, entry] of Object.entries(entries)) {
      data[k] = entry.value;
    }

    return this.successResult(data, { count: Object.keys(entries).length });
  }

  /** Elimina una clave del contexto. */
  async delete(key: string): Promise<OperationResult> {
    let store: SessionStore;
    try {
      store = await this.loadStore();
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        return this.errorResult(1, 'SESSION_EXPIRED', err.message);
      }
      throw err;
    }

    if (!(key in store.context.entries)) {
      return this.errorResult(2, 'KEY_NOT_FOUND', `Key '${key}' not found in context`);
    }

    delete store.context.entries[key];
    await this.saveStore(store);

    return this.successResult({ key, deleted: true });
  }

  /** Limpia todo el contexto de la sesion. */
  async clear(): Promise<OperationResult> {
    let store: SessionStore;
    try {
      store = await this.loadStore();
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        return this.errorResult(1, 'SESSION_EXPIRED', err.message);
      }
      throw err;
    }
    store.context.entries = {};
    await this.saveStore(store);

    return this.successResult({}, { count: 0 });
  }

  /** Consulta el historial de comandos ejecutados. */
  async getHistory(options?: { limit?: number; offset?: number }): Promise<OperationResult> {
    let store: SessionStore;
    try {
      store = await this.loadStore();
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        return this.errorResult(1, 'SESSION_EXPIRED', err.message);
      }
      throw err;
    }
    const limit = options?.limit ?? DEFAULT_HISTORY_LIMIT;
    const offset = options?.offset ?? 0;

    // Sort by executed_at descending
    const sorted = [...store.history].sort((a, b) => {
      return new Date(b.executed_at).getTime() - new Date(a.executed_at).getTime();
    });

    const sliced = sorted.slice(offset, offset + limit);

    return this.successResult(sliced, { total: store.history.length });
  }

  /** Retorna el identificador de sesion. */
  getSessionId(): string {
    return this.sessionId;
  }

  /** Libera recursos del storage adapter. */
  async dispose(): Promise<void> {
    await this.adapter.dispose();
  }

  /** Registra un comando ejecutado en el historial. */
  async recordCommand(entry: Partial<HistoryEntry>): Promise<void> {
    const store = await this.loadStore();

    const fullEntry: HistoryEntry = {
      id: entry.id || crypto.randomUUID(),
      command: entry.command || '',
      namespace: entry.namespace || '',
      args: maskSecrets(entry.args || {}),
      executed_at: entry.executed_at || new Date().toISOString(),
      duration_ms: entry.duration_ms ?? 0,
      exit_code: entry.exit_code ?? 0,
      result_summary: maskSecrets(entry.result_summary || ''),
      undoable: entry.undoable ?? false,
      undo_status: entry.undo_status ?? null,
      snapshot_id: entry.snapshot_id ?? null,
    };

    // Create undo snapshot if command is undoable
    if (fullEntry.undoable && fullEntry.snapshot_id) {
      const snapshot: UndoSnapshot = {
        id: fullEntry.snapshot_id,
        command_id: fullEntry.id,
        created_at: new Date().toISOString(),
        state_before: { ...store.context.entries },
        rollback_command: null,
        metadata: {},
      };
      store.undo_snapshots.push(snapshot);

      // Limit snapshots to MAX_SNAPSHOTS (FIFO)
      if (store.undo_snapshots.length > MAX_SNAPSHOTS) {
        store.undo_snapshots = store.undo_snapshots.slice(store.undo_snapshots.length - MAX_SNAPSHOTS);
      }
    }

    store.history.push(fullEntry);

    // FIFO: discard oldest entries when exceeding limit
    if (store.history.length > MAX_HISTORY) {
      store.history = store.history.slice(store.history.length - MAX_HISTORY);
    }

    // Apply retention policy
    if (this.config.retentionPolicy) {
      store.history = applyRetentionPolicy(store.history, this.config.retentionPolicy);
    }

    await this.saveStore(store);
  }

  /** Revierte un comando previamente ejecutado usando su snapshot. */
  async undo(commandId: string): Promise<OperationResult> {
    let store: SessionStore;
    try {
      store = await this.loadStore();
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        return this.errorResult(1, 'SESSION_EXPIRED', err.message);
      }
      throw err;
    }

    // Find command in history
    const command = store.history.find(h => h.id === commandId);
    if (!command) {
      return this.errorResult(2, 'COMMAND_NOT_FOUND', `Command '${commandId}' not found in history`);
    }

    // Check if undoable
    if (!command.undoable) {
      return this.errorResult(1, 'NOT_UNDOABLE', `Command '${commandId}' is not undoable`);
    }

    // Check if already reverted
    if (command.undo_status === 'applied') {
      return this.errorResult(1, 'ALREADY_REVERTED', `Command '${commandId}' was already reverted`);
    }

    // Find snapshot
    const snapshot = store.undo_snapshots.find(s => s.command_id === commandId);

    // Mark as applied
    command.undo_status = 'applied';
    await this.saveStore(store);

    return this.successResult({
      reverted: commandId,
      snapshot_applied: snapshot ? snapshot.state_before : {},
    });
  }

  // --- Private helpers ---

  private validateKey(key: string): OperationResult | null {
    if (key.length === 0) {
      return this.errorResult(1, 'INVALID_KEY', 'Key must not be empty');
    }
    if (key.length > MAX_KEY_LENGTH) {
      return this.errorResult(1, 'INVALID_KEY', `Key must not exceed ${MAX_KEY_LENGTH} characters`);
    }
    if (!KEY_PATTERN.test(key)) {
      return this.errorResult(1, 'INVALID_KEY', 'Key must match pattern [a-zA-Z][a-zA-Z0-9._-]*');
    }
    return null;
  }

  private async loadStore(): Promise<SessionStore> {
    const loaded = await this.adapter.load(this.sessionId);

    if (!loaded) {
      return { context: { entries: {} }, history: [], undo_snapshots: [], createdAt: new Date().toISOString(), lastAccessAt: new Date().toISOString() };
    }

    // Check session TTL
    if (this.config.ttl_ms && loaded.createdAt) {
      const age = Date.now() - new Date(loaded.createdAt).getTime();
      if (age > this.config.ttl_ms) {
        await this.adapter.destroy(this.sessionId);
        this.config.onExpired?.(this.sessionId);
        throw new SessionExpiredError(this.sessionId, age, this.config.ttl_ms);
      }
    }

    loaded.lastAccessAt = new Date().toISOString();
    return loaded;
  }

  private async saveStore(store: SessionStore): Promise<void> {
    await this.adapter.save(this.sessionId, store);
  }

  private successResult(data: any, extraMeta?: Record<string, any>): OperationResult {
    return {
      status: 0,
      data,
      meta: {
        session_id: this.sessionId,
        timestamp: new Date().toISOString(),
        ...extraMeta,
      },
    };
  }

  private errorResult(status: number, code: string, message: string): OperationResult {
    return {
      status,
      error: { code, message },
      meta: {
        session_id: this.sessionId,
        timestamp: new Date().toISOString(),
      },
    };
  }
}

/** Parsea un string de valor con inferencia de tipo via JSON.parse. */
function parseValue(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Determina el tipo de un valor parseado. */
function getType(value: any): 'string' | 'number' | 'boolean' | 'object' | 'array' {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'object';
  return typeof value as 'string' | 'number' | 'boolean' | 'object';
}

/** Aplica politica de retencion al historial. */
function applyRetentionPolicy(history: HistoryEntry[], policy: RetentionPolicy): HistoryEntry[] {
  let result = history;

  if (policy.maxAge_ms) {
    const cutoff = Date.now() - policy.maxAge_ms;
    result = result.filter(entry => new Date(entry.executed_at).getTime() > cutoff);
  }

  if (policy.maxEntries && result.length > policy.maxEntries) {
    result.sort((a, b) => new Date(b.executed_at).getTime() - new Date(a.executed_at).getTime());
    result = result.slice(0, policy.maxEntries);
  }

  return result;
}
