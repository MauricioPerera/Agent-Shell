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

/** Patron para namespace/name de un comando: minusculas, digitos, guiones, empieza con letra. */
export const NAME_PATTERN = /^[a-z][a-z0-9-]{0,49}$/;

/** Valida que un tipo de parametro es reconocido (base, enum(), o array<>). */
export function isValidParamType(type: string): boolean {
  if (BASE_PARAM_TYPES.includes(type)) return true;
  if (ENUM_TYPE_PATTERN.test(type)) return true;
  if (ARRAY_TYPE_PATTERN.test(type)) return true;
  return false;
}

/**
 * Regresion (ronda 54 del audit, MEDIUM-HIGH): Core.convertType()/
 * Executor.convertType() chequeaban `def.type === 'enum'` y leian
 * `def.enumValues` — pero el UNICO formato que el command-builder publico
 * (y esta misma definicion de tipo) produce es el string 'enum(a,b,c)'
 * (ver ENUM_TYPE_PATTERN arriba), nunca un tipo literal 'enum' ni un
 * campo enumValues aparte. La comparacion nunca matcheaba: cualquier
 * param enum(...) pasaba sin validar. Este parser extrae los valores
 * permitidos directamente del string de tipo, que es la unica fuente de
 * verdad real.
 */
export function parseEnumValues(type: string): string[] {
  const match = type.match(/^enum\((.+)\)$/);
  if (!match) return [];
  return match[1].split(',').map(v => v.trim()).filter(v => v.length > 0);
}

/** Constraints ya parseadas a numeros, en vez del string crudo que CommandParam.constraints guarda. */
export interface ParsedConstraints {
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  maxDepth?: number;
}

const CONSTRAINT_KEYS = new Set(['min', 'max', 'minLength', 'maxLength', 'minItems', 'maxItems', 'maxDepth']);

/**
 * Regresion (ronda 54 del audit, MEDIUM-HIGH): mismo hueco que
 * parseEnumValues arriba, pero para constraints — CommandParam.constraints
 * es un STRING ('min:0,max:100', el unico formato que
 * ParamBuilder.constraints() y contracts/command-registry.md documentan),
 * pero Core.convertType()/Executor.convertType() leian `def.constraints.min`
 * directamente sobre ese string — un string no tiene esa propiedad, asi
 * que la comparacion (`undefined !== undefined`) nunca disparaba. Ningun
 * skill shipeado usa .constraints() hoy, asi que esto estaba latente, pero
 * es la forma documentada/testeada de declarar limites numericos/de
 * longitud — el primer skill real en usarla perdia la validacion en
 * silencio. Segmentos malformados o claves desconocidas se ignoran (no
 * hacen fallar el parseo entero por un typo en OTRA constraint).
 */
export function parseConstraints(raw: string | ParsedConstraints | undefined): ParsedConstraints {
  const result: ParsedConstraints = {};
  if (!raw) return result;
  // A caller constructing a CommandParam by hand (bypassing the builder,
  // e.g. a test fixture or a library consumer) may already pass a
  // structured object here — accepted as-is rather than only supporting
  // the string wire format the public builder produces.
  if (typeof raw === 'object') return raw;
  for (const segment of raw.split(',')) {
    const [rawKey, rawVal] = segment.split(':');
    const key = rawKey?.trim();
    const val = rawVal?.trim();
    if (!key || val === undefined || !CONSTRAINT_KEYS.has(key)) continue;
    const num = Number(val);
    if (Number.isNaN(num)) continue;
    (result as Record<string, number>)[key] = num;
  }
  return result;
}
