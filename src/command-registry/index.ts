/**
 * @module command-registry
 * @description Almacen central de definiciones y handlers de comandos.
 *
 * Permite registrar comandos con metadata completa, realizar lookups
 * eficientes por namespace:nombre, listar por namespace, y generar
 * la representacion compacta AI-optimizada para el LLM.
 */

import type { CommandDefinition, CommandParam, RegisteredCommand, RegistryError, Result } from './types.js';
import { BASE_PARAM_TYPES, ENUM_TYPE_PATTERN, ARRAY_TYPE_PATTERN } from './types.js';

export { type CommandDefinition, type CommandParam, type RegisteredCommand, type RegistryError, type Result } from './types.js';

/**
 * Command Registry: almacen in-memory de definiciones y handlers.
 *
 * @example
 * ```ts
 * const registry = new CommandRegistry();
 * registry.register(definition, handler);
 * const result = registry.resolve('users:create');
 * ```
 */
export class CommandRegistry {
  /** Mapa interno: key = "namespace:name:version" -> RegisteredCommand */
  private commands: Map<string, RegisteredCommand> = new Map();

  /**
   * Registra un comando con su handler.
   * Valida la definicion y rechaza duplicados.
   */
  register(definition: CommandDefinition, handler: Function): Result<void> {
    // Validate definition
    const validationError = this.validateDefinition(definition, handler);
    if (validationError) return { ok: false, error: validationError };

    const key = this.makeKey(definition.namespace, definition.name, definition.version);

    // Check for duplicates
    if (this.commands.has(key)) {
      return {
        ok: false,
        error: {
          code: 'COMMAND_ALREADY_EXISTS',
          message: `Command ${definition.namespace}:${definition.name}@${definition.version} already registered`,
          context: { namespace: definition.namespace, name: definition.name, version: definition.version },
        },
      };
    }

    // Deep-copy definition to prevent external mutation
    const defCopy = structuredClone(definition);

    this.commands.set(key, {
      definition: defCopy,
      handler,
      registeredAt: new Date().toISOString(),
    });

    return { ok: true, value: undefined };
  }

  /**
   * Elimina un comando del registry.
   * Sin version, elimina todas las versiones.
   */
  unregister(namespace: string, name: string, version?: string): Result<void> {
    if (version) {
      const key = this.makeKey(namespace, name, version);
      if (!this.commands.has(key)) {
        return {
          ok: false,
          error: {
            code: 'COMMAND_NOT_FOUND',
            message: `Command ${namespace}:${name}@${version} not found`,
          },
        };
      }
      this.commands.delete(key);
      return { ok: true, value: undefined };
    }

    // Without version: delete all versions
    const prefix = `${namespace}:${name}:`;
    let found = false;
    for (const key of [...this.commands.keys()]) {
      if (key.startsWith(prefix)) {
        this.commands.delete(key);
        found = true;
      }
    }

    if (!found) {
      return {
        ok: false,
        error: {
          code: 'COMMAND_NOT_FOUND',
          message: `Command ${namespace}:${name} not found`,
        },
      };
    }

    return { ok: true, value: undefined };
  }

  /**
   * Recupera un comando registrado por namespace y nombre.
   * Sin version, retorna la mas reciente (mayor semver).
   */
  get(namespace: string, name: string, version?: string): Result<RegisteredCommand> {
    if (version) {
      const key = this.makeKey(namespace, name, version);
      const cmd = this.commands.get(key);
      if (!cmd) {
        return {
          ok: false,
          error: {
            code: 'COMMAND_NOT_FOUND',
            message: `Command ${namespace}:${name}@${version} not found`,
          },
        };
      }
      return { ok: true, value: cmd };
    }

    // Find the most recent version
    const prefix = `${namespace}:${name}:`;
    let latest: RegisteredCommand | null = null;

    for (const [key, cmd] of this.commands) {
      if (key.startsWith(prefix)) {
        if (!latest || compareSemver(cmd.definition.version, latest.definition.version) > 0) {
          latest = cmd;
        }
      }
    }

    if (!latest) {
      return {
        ok: false,
        error: {
          code: 'COMMAND_NOT_FOUND',
          message: `Command ${namespace}:${name} not found`,
        },
      };
    }

    return { ok: true, value: latest };
  }

  /**
   * Resuelve un comando por formato "namespace:name" o "namespace:name@version".
   */
  resolve(fullName: string): Result<RegisteredCommand> {
    if (!fullName || !fullName.includes(':')) {
      return {
        ok: false,
        error: {
          code: 'INVALID_FORMAT',
          message: 'Invalid command format: expected namespace:name[@version]',
        },
      };
    }

    const atIdx = fullName.indexOf('@');
    let nsName: string;
    let version: string | undefined;

    if (atIdx !== -1) {
      nsName = fullName.substring(0, atIdx);
      version = fullName.substring(atIdx + 1);
    } else {
      nsName = fullName;
    }

    const colonIdx = nsName.indexOf(':');
    if (colonIdx === -1) {
      return {
        ok: false,
        error: {
          code: 'INVALID_FORMAT',
          message: 'Invalid command format: expected namespace:name[@version]',
        },
      };
    }

    const namespace = nsName.substring(0, colonIdx);
    const name = nsName.substring(colonIdx + 1);

    return this.get(namespace, name, version);
  }

  /** Retorna todas las definiciones de un namespace. */
  listByNamespace(namespace: string): CommandDefinition[] {
    const results: CommandDefinition[] = [];
    for (const cmd of this.commands.values()) {
      if (cmd.definition.namespace === namespace) {
        results.push(cmd.definition);
      }
    }
    return results;
  }

  /** Retorna todas las definiciones registradas. */
  listAll(): CommandDefinition[] {
    return [...this.commands.values()].map(cmd => cmd.definition);
  }

  /** Retorna todos los namespaces con al menos un comando, ordenados alfabeticamente. */
  getNamespaces(): string[] {
    const namespaces = new Set<string>();
    for (const cmd of this.commands.values()) {
      namespaces.add(cmd.definition.namespace);
    }
    return [...namespaces].sort();
  }

  /** Genera la representacion compacta AI-optimizada de un comando. */
  toCompactText(definition: CommandDefinition): string {
    const lines: string[] = [];

    // Header: namespace:name | description
    lines.push(`${definition.namespace}:${definition.name} | ${definition.description}`);

    // Parameters
    for (const param of definition.params) {
      lines.push(formatParam(param));
    }

    // Output
    lines.push(`  -> output: ${definition.output.type}`);

    // Example
    lines.push(`  Ejemplo: ${definition.example}`);

    // Deprecated
    if (definition.deprecated && definition.deprecatedMessage) {
      lines.push(`  [DEPRECATED: ${definition.deprecatedMessage}]`);
    } else if (definition.deprecated) {
      lines.push(`  [DEPRECATED]`);
    }

    return lines.join('\n');
  }

  /** Genera multiples definiciones separadas por linea en blanco. */
  toCompactTextBatch(definitions: CommandDefinition[]): string {
    return definitions.map(def => this.toCompactText(def)).join('\n\n');
  }

  // --- Private helpers ---

  private makeKey(namespace: string, name: string, version: string): string {
    return `${namespace}:${name}:${version}`;
  }

  private validateDefinition(def: CommandDefinition, handler: Function): RegistryError | null {
    if (!def) {
      return { code: 'INVALID_DEFINITION', message: 'Definition is required' };
    }

    // Item 31: Handler must be a callable function
    if (typeof handler !== 'function') {
      return { code: 'INVALID_DEFINITION', message: 'Handler must be a callable function' };
    }

    // Item 26: Namespace regex validation
    if (!def.namespace || typeof def.namespace !== 'string') {
      return { code: 'INVALID_DEFINITION', message: 'Namespace is required and must be a non-empty string' };
    }
    if (!/^[a-z][a-z0-9-]{0,49}$/.test(def.namespace)) {
      return { code: 'INVALID_DEFINITION', message: `Namespace '${def.namespace}' must match ^[a-z][a-z0-9-]{0,49}$` };
    }

    // Item 27: Name regex validation
    if (!def.name || typeof def.name !== 'string') {
      return { code: 'INVALID_DEFINITION', message: 'Name is required and must be a non-empty string' };
    }
    if (!/^[a-z][a-z0-9-]{0,49}$/.test(def.name)) {
      return { code: 'INVALID_DEFINITION', message: `Name '${def.name}' must match ^[a-z][a-z0-9-]{0,49}$` };
    }

    // Item 28: Strict semver X.Y.Z validation
    if (!def.version || typeof def.version !== 'string') {
      return { code: 'INVALID_DEFINITION', message: 'Version is required and must be a non-empty string' };
    }
    if (!/^\d+\.\d+\.\d+$/.test(def.version)) {
      return { code: 'INVALID_DEFINITION', message: `Version '${def.version}' must be strict semver X.Y.Z format` };
    }

    // Item 29: Description non-empty
    if (!def.description || typeof def.description !== 'string' || def.description.trim().length === 0) {
      return { code: 'INVALID_DEFINITION', message: 'Description is required and must be a non-empty string' };
    }

    // Item 30: Example non-empty
    if (!def.example || typeof def.example !== 'string' || def.example.trim().length === 0) {
      return { code: 'INVALID_DEFINITION', message: 'Example is required and must be a non-empty string' };
    }

    // Validate params
    if (def.params && Array.isArray(def.params)) {
      for (const param of def.params) {
        if (!isValidParamType(param.type)) {
          return {
            code: 'INVALID_DEFINITION',
            message: `Unknown param type: ${param.type}. Valid: int, float, string, bool, date, json, enum(), array<>`,
          };
        }
      }
    }

    return null;
  }
}

/** Formatea un parametro para la representacion compacta. */
function formatParam(param: CommandParam): string {
  let line = `  --${param.name}: ${param.type}`;

  if (param.constraints) {
    line += ` (${param.constraints})`;
  }

  if (param.default !== undefined) {
    line += ` = ${param.default}`;
  }

  if (param.required) {
    line += ' [REQUIRED]';
  }

  return line;
}

/** Valida que un tipo de parametro es reconocido. */
function isValidParamType(type: string): boolean {
  if (BASE_PARAM_TYPES.includes(type)) return true;
  if (ENUM_TYPE_PATTERN.test(type)) return true;
  if (ARRAY_TYPE_PATTERN.test(type)) return true;
  return false;
}

/** Compara dos versiones semver. Retorna positivo si a > b, negativo si a < b. */
function compareSemver(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    const diff = (partsA[i] || 0) - (partsB[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
