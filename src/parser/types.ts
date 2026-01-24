/**
 * @module parser/types
 * @description Tipos del AST producido por el Parser de Agent Shell.
 *
 * El Parser transforma un string de comando recibido via `cli_exec(cmd)` en un
 * arbol de sintaxis abstracta (AST) representado por estas interfaces. El resultado
 * es consumido por el Router y Executor para despachar la ejecucion.
 *
 * @example
 * ```ts
 * import { parse } from 'agent-shell';
 * import type { ParseResult, ParseError } from 'agent-shell';
 *
 * const result = parse('users:get --id 42 | .name');
 * if ('errorType' in result) {
 *   // Handle ParseError
 * } else {
 *   // Use ParseResult
 *   console.log(result.commands[0].namespace); // "users"
 * }
 * ```
 */

/**
 * Resultado principal del parser. Envuelve uno o mas comandos parseados
 * y preserva el input original.
 *
 * @property type - Tipo de input detectado:
 *   - `"single"`: un unico comando
 *   - `"pipeline"`: comandos encadenados con `>>`
 *   - `"batch"`: comandos independientes dentro de `batch [...]`
 * @property commands - Lista de comandos parseados (1 para single, N para pipeline/batch)
 * @property raw - Input original sin modificar
 */
export interface ParseResult {
  type: 'single' | 'pipeline' | 'batch';
  commands: ParsedCommand[];
  raw: string;
}

/**
 * Representacion estructurada de un comando individual dentro del AST.
 *
 * @property namespace - Agrupador logico del comando (ej: `"users"`, `"orders"`).
 *   Es `null` para comandos builtin (`search`, `help`, etc.)
 * @property command - Nombre del comando (ej: `"list"`, `"create"`, `"search"`)
 * @property args - Argumentos del comando (posicionales y nombrados)
 * @property flags - Flags globales de ejecucion extraidas del input
 * @property jqFilter - Filtro jq detectado despues del pipe, o `null` si no hay
 * @property meta - Metadata de posicion para diagnosticos y debugging
 */
export interface ParsedCommand {
  namespace: string | null;
  command: string;
  args: CommandArgs;
  flags: GlobalFlags;
  jqFilter: JqFilter | null;
  meta: ParseMeta;
}

/**
 * Argumentos extraidos del comando, separados en posicionales y nombrados.
 *
 * @property positional - Argumentos sin nombre, en orden de aparicion.
 *   Para el builtin `search`, todo el texto restante se une en un unico positional.
 * @property named - Argumentos con nombre (`--key value`). Si un flag no tiene valor
 *   (ej: `--verbose`), su valor es `true`.
 *
 * @example
 * ```
 * "users:create --name 'John' --verbose admin"
 * // positional: ["admin"]
 * // named: { name: "John", verbose: true }
 * ```
 */
export interface CommandArgs {
  positional: string[];
  named: Record<string, string | boolean>;
}

/**
 * Flags globales que modifican el modo de ejecucion del comando.
 * Estas flags se extraen del input y NO aparecen en `args.named`.
 *
 * @property dryRun - `--dry-run`: simular sin ejecutar
 * @property validate - `--validate`: solo validar sintaxis y permisos
 * @property confirm - `--confirm`: mostrar preview antes de ejecutar
 * @property format - `--format json|table|csv`: formato de respuesta, o `null` si no se especifico
 * @property limit - `--limit N`: maximo N resultados, o `null` si no se especifico
 * @property offset - `--offset N`: saltar primeros N resultados, o `null` si no se especifico
 */
export interface GlobalFlags {
  dryRun: boolean;
  validate: boolean;
  confirm: boolean;
  format: 'json' | 'table' | 'csv' | null;
  limit: number | null;
  offset: number | null;
}

/**
 * Filtro jq detectado en el input despues del operador pipe (`|`).
 * Solo se soporta field access simple; no se evalua la expresion.
 *
 * @property raw - Expresion jq tal cual fue escrita (ej: `".name"`, `"[.name, .email]"`)
 * @property type - Tipo de filtro:
 *   - `"field"`: acceso a un campo (`.campo` o `.campo.subcampo`)
 *   - `"multi_field"`: extraccion de multiples campos (`[.campo1, .campo2]`)
 * @property fields - Lista de campos extraidos. Para tipo `"field"` contiene un solo
 *   elemento con el path completo (ej: `["address.city"]`). Para `"multi_field"`
 *   contiene cada campo por separado.
 *
 * @example
 * ```
 * // Input: "users:get --id 1 | .address.city"
 * // jqFilter: { raw: ".address.city", type: "field", fields: ["address.city"] }
 *
 * // Input: "users:get --id 1 | [.name, .email]"
 * // jqFilter: { raw: "[.name, .email]", type: "multi_field", fields: ["name", "email"] }
 * ```
 */
export interface JqFilter {
  raw: string;
  type: 'field' | 'multi_field';
  fields: string[];
}

/**
 * Metadata de posicion del comando dentro del input original.
 * Util para reportar errores y para debugging de pipelines/batch.
 *
 * @property startPos - Posicion (0-indexed) del primer caracter del segmento
 * @property endPos - Posicion del caracter siguiente al ultimo del segmento
 * @property rawSegment - Substring del input original que corresponde a este comando
 */
export interface ParseMeta {
  startPos: number;
  endPos: number;
  rawSegment: string;
}

/**
 * Error estructurado retornado cuando el input tiene sintaxis invalida.
 * El parser nunca lanza excepciones; siempre retorna `ParseResult | ParseError`.
 *
 * @property code - Siempre `1` (error de sintaxis segun el protocolo Agent Shell)
 * @property errorType - Codigo de error especifico (ej: `"E_EMPTY_INPUT"`, `"E_UNCLOSED_QUOTE"`)
 * @property message - Mensaje legible para diagnostico
 * @property position - Posicion (0-indexed) en el input donde se detecto el error
 * @property length - Longitud del token problematico
 * @property raw - Input original completo (o truncado si excede limites)
 * @property suggestion - Sugerencia de correccion (opcional)
 *
 * @see {@link https://github.com/agent-shell/spec/blob/main/contracts/parser.md#4-error-handling Error Handling}
 */
export interface ParseError {
  code: number;
  errorType: string;
  message: string;
  position: number;
  length: number;
  raw: string;
  suggestion?: string;
}

/** Comandos builtin del protocolo Agent Shell (no requieren namespace). */
export const BUILTIN_COMMANDS = ['search', 'describe', 'help', 'context', 'history', 'undo'] as const;

/** Union type de los nombres de comandos builtin. */
export type BuiltinCommand = typeof BUILTIN_COMMANDS[number];

/** Formatos de salida validos para el flag `--format`. */
export const VALID_FORMATS = ['json', 'table', 'csv'] as const;

/** Union type de los formatos validos. */
export type ValidFormat = typeof VALID_FORMATS[number];

/** Nombres de flags globales reconocidas por el parser. */
export const GLOBAL_FLAG_NAMES = ['dry-run', 'validate', 'confirm', 'format', 'limit', 'offset'] as const;

/** Longitud maxima de input aceptada (en caracteres). Inputs mayores se rechazan con error. */
export const MAX_INPUT_LENGTH = 4096;

/** Maximo de comandos encadenados con `>>` en un pipeline. */
export const MAX_PIPELINE_DEPTH = 10;

/** Maximo de comandos dentro de un `batch [...]`. */
export const MAX_BATCH_SIZE = 20;
