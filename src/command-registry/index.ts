/**
 * @module command-registry
 * @description Almacen central de definiciones y handlers de comandos.
 *
 * Permite registrar comandos con metadata completa, realizar lookups
 * eficientes por namespace:nombre, listar por namespace, y generar
 * la representacion compacta AI-optimizada para el LLM.
 */

import type { CommandDefinition, CommandParam, RegisteredCommand, RegistryError, Result } from './types.js';
import { NAME_PATTERN, isValidParamType } from './types.js';
import { GLOBAL_FLAG_NAMES } from '../parser/types.js';

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

  /** Indice secundario: "namespace:name" -> (version -> RegisteredCommand), para deregistro/lookup sin version en O(versiones-del-comando) */
  private byNsName: Map<string, Map<string, RegisteredCommand>> = new Map();

  /** Cache de la version mas reciente por "namespace:name", para get()/resolve() sin version en O(1) */
  private latestByNsName: Map<string, RegisteredCommand> = new Map();

  /** Indice secundario: namespace -> (fullKey -> RegisteredCommand), para listByNamespace() en O(k) */
  private byNamespace: Map<string, Map<string, RegisteredCommand>> = new Map();

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

    const registered: RegisteredCommand = {
      definition: defCopy,
      handler,
      registeredAt: new Date().toISOString(),
    };

    this.commands.set(key, registered);

    const nsNameKey = this.makeNsNameKey(definition.namespace, definition.name);
    let versions = this.byNsName.get(nsNameKey);
    if (!versions) {
      versions = new Map();
      this.byNsName.set(nsNameKey, versions);
    }
    versions.set(definition.version, registered);

    const currentLatest = this.latestByNsName.get(nsNameKey);
    if (!currentLatest || compareSemver(definition.version, currentLatest.definition.version) > 0) {
      this.latestByNsName.set(nsNameKey, registered);
    }

    let nsCommands = this.byNamespace.get(definition.namespace);
    if (!nsCommands) {
      nsCommands = new Map();
      this.byNamespace.set(definition.namespace, nsCommands);
    }
    nsCommands.set(key, registered);

    return { ok: true, value: undefined };
  }

  /**
   * Elimina un comando del registry.
   * Sin version, elimina todas las versiones.
   */
  unregister(namespace: string, name: string, version?: string): Result<void> {
    const nsNameKey = this.makeNsNameKey(namespace, name);
    const versions = this.byNsName.get(nsNameKey);

    if (version) {
      const key = this.makeKey(namespace, name, version);
      if (!versions || !versions.has(version)) {
        return {
          ok: false,
          error: {
            code: 'COMMAND_NOT_FOUND',
            message: `Command ${namespace}:${name}@${version} not found`,
          },
        };
      }

      this.commands.delete(key);
      versions.delete(version);
      this.byNamespace.get(namespace)?.delete(key);

      if (versions.size === 0) {
        this.byNsName.delete(nsNameKey);
        this.latestByNsName.delete(nsNameKey);
      } else if (this.latestByNsName.get(nsNameKey)?.definition.version === version) {
        // Recompute latest among the remaining versions of this command only
        let newLatest: RegisteredCommand | null = null;
        for (const cmd of versions.values()) {
          if (!newLatest || compareSemver(cmd.definition.version, newLatest.definition.version) > 0) {
            newLatest = cmd;
          }
        }
        this.latestByNsName.set(nsNameKey, newLatest!);
      }

      return { ok: true, value: undefined };
    }

    // Without version: delete all versions
    if (!versions || versions.size === 0) {
      return {
        ok: false,
        error: {
          code: 'COMMAND_NOT_FOUND',
          message: `Command ${namespace}:${name} not found`,
        },
      };
    }

    const nsCommands = this.byNamespace.get(namespace);
    for (const [ver] of versions) {
      const key = this.makeKey(namespace, name, ver);
      this.commands.delete(key);
      nsCommands?.delete(key);
    }
    this.byNsName.delete(nsNameKey);
    this.latestByNsName.delete(nsNameKey);

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

    const latest = this.latestByNsName.get(this.makeNsNameKey(namespace, name));

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
    const nsCommands = this.byNamespace.get(namespace);
    if (!nsCommands) return [];
    return [...nsCommands.values()].map(cmd => cmd.definition);
  }

  /** Retorna todas las definiciones registradas. */
  listAll(): CommandDefinition[] {
    return [...this.commands.values()].map(cmd => cmd.definition);
  }

  /** Retorna todos los namespaces con al menos un comando, ordenados alfabeticamente. */
  getNamespaces(): string[] {
    return [...this.byNamespace.keys()].sort();
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

  private makeNsNameKey(namespace: string, name: string): string {
    return `${namespace}:${name}`;
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
    if (!NAME_PATTERN.test(def.namespace)) {
      return { code: 'INVALID_DEFINITION', message: `Namespace '${def.namespace}' must match ^[a-z][a-z0-9-]{0,49}$` };
    }

    // Item 27: Name regex validation
    if (!def.name || typeof def.name !== 'string') {
      return { code: 'INVALID_DEFINITION', message: 'Name is required and must be a non-empty string' };
    }
    if (!NAME_PATTERN.test(def.name)) {
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
      // Regresion (ronda 70 del audit, HIGH): CommandBuilder._claimParamName()
      // ya rechaza nombres de param duplicados y colisiones con flags
      // globales reservados — pero SOLO ahi, no en este validateDefinition(),
      // el UNICO punto por el que pasa CUALQUIER definicion antes de
      // registrarse. wizard.ts/scaffold.ts arman su `params` array a mano,
      // esquivando el builder por completo. Sin este chequeo, dos params con
      // el mismo nombre pasaban validacion (cada uno type-checkea el mismo
      // valor crudo del caller de forma independiente), pero
      // Core.convertArgTypes/Executor.validateArgs hacen
      // `result[def.name] = converted.value` sobreescribiendo en cada
      // iteracion — el handler termina recibiendo el tipo/valor del ULTIMO
      // duplicado en el array, mientras que la resolucion de required/
      // default usa el PRIMERO, un modo de fallo confuso y dependiente del
      // orden. Un param cuyo nombre colisiona con un flag global reservado
      // (dry-run/validate/confirm/format/limit/offset) nunca puede recibir
      // un valor del caller (el parser los extrae SIEMPRE a un objeto
      // `flags` separado, nunca a `named`) — el comando queda roto en TODA
      // invocacion (required) o usa su default para siempre (optional).
      const seenParamNames = new Set<string>();
      for (const param of def.params) {
        // Regresion (ronda 59 del audit, MEDIUM): `param.name` nunca se
        // validaba en NINGUN punto del pipeline (ni aca, ni en
        // command-builder, ni en scaffold.ts/wizard.ts) a diferencia de
        // namespace/name del comando, que ya pasan por NAME_PATTERN.
        // Core.convertArgTypes/Executor.validateArgs arman el objeto de
        // args resuelto con `result[def.name] = valor` sobre un objeto
        // plano — un param llamado "__proto__" con type 'json'/'array<>'
        // reasigna el PROTOTIPO de ese objeto en vez de setear un campo de
        // datos (asignacion especial que el motor de JS le da a esa key
        // exacta), corrompiendo el args object que recibe el handler.
        // Reachable hoy via wizard:create-command / scaffold:add-command,
        // que solo validaban param.type. NAME_PATTERN excluye "__proto__"
        // (no arranca con letra minuscula), cerrando el hueco en el UNICO
        // punto por el que pasa CUALQUIER definicion antes de registrarse
        // (via builder, scaffold, wizard, o construida a mano).
        if (!param.name || typeof param.name !== 'string' || !NAME_PATTERN.test(param.name)) {
          return {
            code: 'INVALID_DEFINITION',
            message: `Invalid param name '${param.name}': must match ^[a-z][a-z0-9-]{0,49}$`,
          };
        }
        if (seenParamNames.has(param.name)) {
          return {
            code: 'INVALID_DEFINITION',
            message: `Duplicate param name '${param.name}': each param must have a unique name`,
          };
        }
        seenParamNames.add(param.name);
        if ((GLOBAL_FLAG_NAMES as readonly string[]).includes(param.name)) {
          return {
            code: 'INVALID_DEFINITION',
            message: `Param name '${param.name}' collides with a reserved global flag (${GLOBAL_FLAG_NAMES.join(', ')}) and would never be reachable through the parser`,
          };
        }
        if (!isValidParamType(param.type)) {
          return {
            code: 'INVALID_DEFINITION',
            message: `Unknown param type: ${param.type}. Valid: int, float, string, bool, date, json, enum(), array<>`,
          };
        }
      }
    }

    // Regresion (ronda 70 del audit, MEDIUM-HIGH): `tags`/`requiredPermissions`
    // nunca se validaban — un `tags` malformado (ej. un numero en vez de
    // array, producible por un `--tags` mal pasado a wizard:create-command)
    // pasaba registro sin error, y luego registry:stats's `for (const tag of
    // def.tags)` tira TypeError ("not iterable") — rompiendo registry:stats
    // para TODOS los callers, no solo el que registro la definicion
    // malformada, hasta el proximo restart. Mismo riesgo de crash
    // (TypeError: "not a function") para requiredPermissions via
    // matchPermissions()'s `required.every(...)` si no es array.
    if (def.tags !== undefined && !Array.isArray(def.tags)) {
      return { code: 'INVALID_DEFINITION', message: `tags must be an array, got ${typeof def.tags}` };
    }
    if (def.requiredPermissions !== undefined && !Array.isArray(def.requiredPermissions)) {
      return { code: 'INVALID_DEFINITION', message: `requiredPermissions must be an array, got ${typeof def.requiredPermissions}` };
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
