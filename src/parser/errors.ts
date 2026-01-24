/**
 * @module parser/errors
 * @description Factories de errores estructurados del parser.
 *
 * Cada funcion produce un {@link ParseError} con `code: 1` (error de sintaxis)
 * y un `errorType` especifico que identifica la condicion exacta del fallo.
 * El parser nunca lanza excepciones; usa estas factories para construir
 * errores deterministas con posicion precisa.
 *
 * Codigos de error:
 * | errorType            | Condicion                                    |
 * |----------------------|----------------------------------------------|
 * | E_EMPTY_INPUT        | Input vacio o solo whitespace                |
 * | E_INVALID_NAMESPACE  | Namespace no cumple `[a-zA-Z][a-zA-Z0-9_-]*` |
 * | E_MISSING_COMMAND    | Namespace seguido de `:` sin nombre          |
 * | E_UNCLOSED_QUOTE     | Comilla abierta sin cierre                   |
 * | E_INVALID_FLAG_VALUE | `--limit`/`--offset` con valor no entero     |
 * | E_INVALID_FORMAT     | `--format` con valor no soportado            |
 * | E_UNCLOSED_BATCH     | `batch [` sin `]` de cierre                  |
 * | E_EMPTY_BATCH        | `batch []` sin comandos                      |
 * | E_INVALID_JQ         | Filtro jq con sintaxis no reconocida         |
 * | E_INPUT_TOO_LONG     | Input excede 4096 caracteres                 |
 * | E_PIPELINE_DEPTH     | Pipeline con mas de 10 comandos              |
 * | E_BATCH_SIZE         | Batch con mas de 20 comandos                 |
 */

import type { ParseError } from './types.js';

/**
 * Factory base para construir un ParseError con todos los campos requeridos.
 *
 * @param errorType - Codigo de error especifico (E_EMPTY_INPUT, E_UNCLOSED_QUOTE, etc.)
 * @param message - Mensaje legible con contexto del error
 * @param position - Posicion (0-indexed) en el input donde ocurre el error
 * @param length - Longitud del token problematico
 * @param raw - Input original completo
 * @param suggestion - Sugerencia de correccion (opcional)
 * @returns ParseError con code=1
 */
export function createParseError(
  errorType: string,
  message: string,
  position: number,
  length: number,
  raw: string,
  suggestion?: string
): ParseError {
  return {
    code: 1,
    errorType,
    message,
    position,
    length,
    raw,
    ...(suggestion !== undefined && { suggestion }),
  };
}

/** Input vacio o compuesto solo de whitespace. */
export function emptyInputError(raw: string): ParseError {
  return createParseError('E_EMPTY_INPUT', 'Empty input: expected a command', 0, 0, raw);
}

/** Namespace no cumple la regex `[a-zA-Z][a-zA-Z0-9_-]*` (ej: `:comando`). */
export function invalidNamespaceError(value: string, position: number, raw: string): ParseError {
  return createParseError(
    'E_INVALID_NAMESPACE',
    `Invalid namespace '${value}' at position ${position}`,
    position,
    value.length,
    raw
  );
}

/** Se encontro `namespace:` pero no hay nombre de comando despues de los dos puntos. */
export function missingCommandError(ns: string, position: number, raw: string): ParseError {
  return createParseError(
    'E_MISSING_COMMAND',
    `Expected command name after '${ns}:' at position ${position}`,
    position,
    1,
    raw
  );
}

/**
 * Comilla (simple o doble) abierta sin su cierre correspondiente.
 * @param quoteType - `"single"` o `"double"` para el mensaje
 */
export function unclosedQuoteError(quoteType: string, position: number, raw: string): ParseError {
  return createParseError(
    'E_UNCLOSED_QUOTE',
    `Unclosed ${quoteType} quote starting at position ${position}`,
    position,
    1,
    raw
  );
}

/** `--limit` o `--offset` seguido de un valor que no es entero valido. */
export function invalidFlagValueError(flag: string, value: string, position: number, raw: string): ParseError {
  return createParseError(
    'E_INVALID_FLAG_VALUE',
    `Expected integer value for --${flag}, got '${value}' at position ${position}`,
    position,
    value.length,
    raw
  );
}

/** `--format` con un valor distinto a `json`, `table` o `csv`. */
export function invalidFormatError(value: string, position: number, raw: string): ParseError {
  return createParseError(
    'E_INVALID_FORMAT',
    `Invalid format '${value}'. Expected: json, table, csv`,
    position,
    value.length,
    raw
  );
}

/** `batch [` encontrado sin `]` de cierre. */
export function unclosedBatchError(position: number, raw: string): ParseError {
  return createParseError(
    'E_UNCLOSED_BATCH',
    `Unclosed batch: expected ']' to close batch started at position ${position}`,
    position,
    1,
    raw
  );
}

/** `batch []` encontrado sin ningun comando dentro de los corchetes. */
export function emptyBatchError(position: number, raw: string): ParseError {
  return createParseError(
    'E_EMPTY_BATCH',
    'Empty batch: at least one command required',
    position,
    2,
    raw
  );
}

/** Expresion jq con sintaxis no reconocida (no es `.campo` ni `[.campo1, ...]`). */
export function invalidJqError(expr: string, position: number, raw: string): ParseError {
  return createParseError(
    'E_INVALID_JQ',
    `Invalid jq filter syntax: '${expr}' at position ${position}`,
    position,
    expr.length,
    raw
  );
}

/** Input excede el limite de {@link MAX_INPUT_LENGTH} (4096) caracteres. */
export function inputTooLongError(raw: string): ParseError {
  return createParseError(
    'E_INPUT_TOO_LONG',
    `Input exceeds maximum length of 4096 characters`,
    0,
    raw.length,
    raw.substring(0, 100)
  );
}

/** Pipeline contiene mas de {@link MAX_PIPELINE_DEPTH} (10) comandos encadenados. */
export function pipelineDepthError(raw: string): ParseError {
  return createParseError(
    'E_PIPELINE_DEPTH',
    'Pipeline exceeds maximum depth of 10 commands',
    0,
    raw.length,
    raw
  );
}

/** Batch contiene mas de {@link MAX_BATCH_SIZE} (20) comandos. */
export function batchSizeError(raw: string): ParseError {
  return createParseError(
    'E_BATCH_SIZE',
    'Batch exceeds maximum size of 20 commands',
    0,
    raw.length,
    raw
  );
}

/** JQ field path excede profundidad maxima de 5 niveles. */
export function jqTooDeepError(field: string, raw: string): ParseError {
  return createParseError(
    'E_JQ_TOO_DEEP',
    `JQ field path '${field}' exceeds maximum depth of 5 levels`,
    0,
    field.length,
    raw
  );
}

/** JQ multi-field excede maximo de 10 campos. */
export function jqTooManyFieldsError(count: number, raw: string): ParseError {
  return createParseError(
    'E_JQ_TOO_MANY_FIELDS',
    `JQ filter exceeds maximum of 10 fields (found ${count})`,
    0,
    0,
    raw
  );
}

/** Nombre de campo JQ invalido (no cumple [a-zA-Z_][a-zA-Z0-9_]*). */
export function invalidJqFieldError(field: string, raw: string): ParseError {
  return createParseError(
    'E_INVALID_JQ_FIELD',
    `Invalid JQ field name '${field}': must match [a-zA-Z_][a-zA-Z0-9_]*`,
    0,
    field.length,
    raw
  );
}

/** Batch anidado: se detecto `batch [` dentro de un batch. */
export function nestedBatchError(raw: string): ParseError {
  return createParseError(
    'E_NESTED_BATCH',
    'Nested batch is not allowed inside batch',
    0,
    raw.length,
    raw
  );
}

/** Pipeline dentro de batch: se detecto `>>` dentro de un batch. */
export function pipelineInBatchError(raw: string): ParseError {
  return createParseError(
    'E_PIPELINE_IN_BATCH',
    'Pipeline (>>) is not allowed inside batch',
    0,
    raw.length,
    raw
  );
}

/** Input contiene caracteres de control (ASCII < 32). */
export function controlCharacterError(position: number, charCode: number, raw: string): ParseError {
  return createParseError(
    'E_CONTROL_CHARACTER',
    `Input contains control character at position ${position} (ASCII ${charCode})`,
    position,
    1,
    raw
  );
}
