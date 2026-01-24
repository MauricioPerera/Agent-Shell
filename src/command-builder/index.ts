/**
 * @module command-builder
 * @description Fluent builder pattern for constructing CommandDefinitions.
 *
 * Simplifies command definition by providing a chainable API that validates
 * the resulting definition at build time.
 *
 * @example
 * ```typescript
 * const def = command('users', 'create')
 *   .version('1.0.0')
 *   .description('Creates a new user')
 *   .param('name', 'string', p => p.required().description('User name'))
 *   .param('email', 'string', p => p.required())
 *   .param('role', 'enum(admin,user)', p => p.default('user'))
 *   .output('object', 'The created user')
 *   .example('users:create --name "John" --email "j@t.com"')
 *   .tags('users', 'crud')
 *   .reversible()
 *   .build();
 * ```
 */

import type { CommandDefinition, CommandParam, OutputShape } from '../command-registry/types.js';

/** Builder for a single parameter. */
export class ParamBuilder {
  private _required = false;
  private _default?: any;
  private _constraints?: string;
  private _description?: string;

  constructor(private _name: string, private _type: string) {}

  /** Mark this parameter as required. */
  required(): this {
    this._required = true;
    return this;
  }

  /** Set a default value. */
  default(value: any): this {
    this._default = value;
    return this;
  }

  /** Set validation constraints (e.g. 'min:0,max:100'). */
  constraints(c: string): this {
    this._constraints = c;
    return this;
  }

  /** Set parameter description. */
  description(d: string): this {
    this._description = d;
    return this;
  }

  /** @internal Build the CommandParam object. */
  _build(): CommandParam {
    const param: CommandParam = {
      name: this._name,
      type: this._type,
      required: this._required,
    };
    if (this._default !== undefined) param.default = this._default;
    if (this._constraints) param.constraints = this._constraints;
    if (this._description) param.description = this._description;
    return param;
  }
}

/** Fluent builder for CommandDefinition. */
export class CommandBuilder {
  private _namespace: string;
  private _name: string;
  private _version = '1.0.0';
  private _description = '';
  private _longDescription?: string;
  private _params: ParamBuilder[] = [];
  private _output: OutputShape = { type: 'object' };
  private _example = '';
  private _tags: string[] = [];
  private _reversible = false;
  private _requiresConfirmation = false;
  private _deprecated = false;
  private _deprecatedMessage?: string;
  private _requiredPermissions: string[] = [];

  constructor(namespace: string, name: string) {
    this._namespace = namespace;
    this._name = name;
  }

  /** Set command version (semver). */
  version(v: string): this {
    this._version = v;
    return this;
  }

  /** Set short description (max ~200 chars, shown to LLM). */
  description(d: string): this {
    this._description = d;
    return this;
  }

  /** Set extended description (for detailed help). */
  longDescription(d: string): this {
    this._longDescription = d;
    return this;
  }

  /**
   * Add a parameter.
   * @param name - Parameter name
   * @param type - Type: 'string' | 'int' | 'float' | 'bool' | 'date' | 'json' | 'enum(...)' | 'array<...>'
   * @param configure - Optional callback to configure required/default/constraints
   */
  param(name: string, type: string, configure?: (p: ParamBuilder) => void): this {
    const p = new ParamBuilder(name, type);
    if (configure) configure(p);
    this._params.push(p);
    return this;
  }

  /** Add a required string parameter (shorthand). */
  requiredParam(name: string, type: string, description?: string): this {
    const p = new ParamBuilder(name, type);
    p.required();
    if (description) p.description(description);
    this._params.push(p);
    return this;
  }

  /** Add an optional parameter with default (shorthand). */
  optionalParam(name: string, type: string, defaultValue: any, description?: string): this {
    const p = new ParamBuilder(name, type);
    p.default(defaultValue);
    if (description) p.description(description);
    this._params.push(p);
    return this;
  }

  /** Set output shape. */
  output(type: string, description?: string): this {
    this._output = { type, description };
    return this;
  }

  /** Set usage example. */
  example(e: string): this {
    this._example = e;
    return this;
  }

  /** Set search tags. */
  tags(...t: string[]): this {
    this._tags = t;
    return this;
  }

  /** Mark command as reversible (supports undo). */
  reversible(): this {
    this._reversible = true;
    return this;
  }

  /** Mark command as requiring confirmation before execution. */
  requiresConfirmation(): this {
    this._requiresConfirmation = true;
    return this;
  }

  /** Mark command as deprecated. */
  deprecated(message?: string): this {
    this._deprecated = true;
    this._deprecatedMessage = message;
    return this;
  }

  /** Set required permissions for this command. */
  permissions(...perms: string[]): this {
    this._requiredPermissions = perms;
    return this;
  }

  /** Build the CommandDefinition. Throws if required fields are missing. */
  build(): CommandDefinition {
    if (!this._namespace) throw new Error('CommandBuilder: namespace is required');
    if (!this._name) throw new Error('CommandBuilder: name is required');
    if (!this._description) throw new Error('CommandBuilder: description is required');

    return {
      namespace: this._namespace,
      name: this._name,
      version: this._version,
      description: this._description,
      longDescription: this._longDescription,
      params: this._params.map(p => p._build()),
      output: this._output,
      example: this._example,
      tags: this._tags,
      reversible: this._reversible,
      requiresConfirmation: this._requiresConfirmation,
      deprecated: this._deprecated,
      deprecatedMessage: this._deprecatedMessage,
      requiredPermissions: this._requiredPermissions.length > 0 ? this._requiredPermissions : undefined,
    };
  }
}

/**
 * Create a new command builder.
 *
 * @example
 * ```typescript
 * const def = command('users', 'create')
 *   .description('Creates a user')
 *   .param('name', 'string', p => p.required())
 *   .build();
 * ```
 */
export function command(namespace: string, name: string): CommandBuilder {
  return new CommandBuilder(namespace, name);
}
