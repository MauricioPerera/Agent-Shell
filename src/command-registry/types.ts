/**
 * @module command-registry/types
 * @description Tipos del modulo Command Registry de Agent Shell.
 *
 * Define las interfaces para definiciones de comandos, parametros,
 * output shapes, y el tipo Result para manejo de errores sin excepciones.
 */

/** Definicion completa de un comando registrable. */
export interface CommandDefinition {
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
  requiredPermissions?: string[];
}

/** Parametro de un comando. */
export interface CommandParam {
  name: string;
  type: string;
  required: boolean;
  default?: any;
  constraints?: string;
  description?: string;
}

/** Forma del output de un comando. */
export interface OutputShape {
  type: string;
  description?: string;
}

/** Comando registrado con handler y metadata de registro. */
export interface RegisteredCommand {
  definition: CommandDefinition;
  handler: Function;
  registeredAt: string;
}

/** Error estructurado del registry. */
export interface RegistryError {
  code: string;
  message: string;
  context?: Record<string, any>;
}

/** Tipo Result: exito o error sin excepciones. */
export type Result<T> = { ok: true; value: T } | { ok: false; error: RegistryError };

/** Tipos de parametro validos (base, sin incluir enum() y array<>). */
export const BASE_PARAM_TYPES = ['int', 'float', 'string', 'bool', 'date', 'json'];

/** Patron para validar tipos enum: enum(val1,val2,...) */
export const ENUM_TYPE_PATTERN = /^enum\(.+\)$/;

/** Patron para validar tipos array: array<tipo> */
export const ARRAY_TYPE_PATTERN = /^array<.+>$/;
