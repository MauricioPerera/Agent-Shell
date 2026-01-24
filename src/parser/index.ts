/**
 * @module parser
 * @description Parser principal de Agent Shell.
 *
 * Transforma un string de comando recibido via `cli_exec(cmd)` en un AST
 * ({@link ParseResult}) que el Router y Executor pueden consumir.
 *
 * Arquitectura interna (pipeline de procesamiento):
 * ```
 * Input string
 *   → Detectar tipo (batch / pipeline / single)
 *   → Separar segmentos (por `,` o `>>`)
 *   → Para cada segmento:
 *       → Separar filtro jq (split en `|`)
 *       → Tokenizar parte de comando
 *       → Extraer command_id (namespace:cmd o builtin)
 *       → Extraer global flags
 *       → Clasificar argumentos restantes (named/positional)
 *   → Construir ParseResult
 * ```
 *
 * Propiedades del parser:
 * - **Funcion pura**: sin side effects, sin I/O, sin estado mutable compartido
 * - **Determinista**: mismo input siempre produce mismo output
 * - **Zero-dependency**: no usa librerias externas
 * - **Fail-fast**: reporta el primer error encontrado sin intentar recuperarse
 *
 * @example
 * ```ts
 * import { parse } from 'agent-shell';
 *
 * // Comando simple
 * const r1 = parse('users:get --id 42 --dry-run | .name');
 * // → { type: "single", commands: [{ namespace: "users", command: "get", ... }] }
 *
 * // Pipeline
 * const r2 = parse('users:get --id 1 >> orders:list');
 * // → { type: "pipeline", commands: [..., ...] }
 *
 * // Batch
 * const r3 = parse('batch [users:count, orders:count]');
 * // → { type: "batch", commands: [..., ...] }
 *
 * // Error
 * const r4 = parse('');
 * // → { code: 1, errorType: "E_EMPTY_INPUT", ... }
 * ```
 */

import type {
  ParseResult,
  ParsedCommand,
  CommandArgs,
  GlobalFlags,
  JqFilter,
  ParseMeta,
  ParseError,
} from './types.js';
import {
  BUILTIN_COMMANDS,
  VALID_FORMATS,
  MAX_INPUT_LENGTH,
  MAX_PIPELINE_DEPTH,
  MAX_BATCH_SIZE,
} from './types.js';
import {
  emptyInputError,
  invalidNamespaceError,
  missingCommandError,
  invalidFlagValueError,
  invalidFormatError,
  unclosedBatchError,
  emptyBatchError,
  inputTooLongError,
  pipelineDepthError,
  batchSizeError,
  unclosedQuoteError,
  jqTooDeepError,
  jqTooManyFieldsError,
  invalidJqFieldError,
  nestedBatchError,
  pipelineInBatchError,
  controlCharacterError,
} from './errors.js';
import { tokenize, type Token } from './tokenizer.js';

export type { ParseResult, ParsedCommand, ParseError, CommandArgs, GlobalFlags, JqFilter, ParseMeta };

/**
 * Parsea un string de comando y produce un AST estructurado.
 *
 * Punto de entrada publico del modulo. Detecta automaticamente el tipo
 * de input (single, pipeline, batch) y delega al sub-parser correspondiente.
 *
 * @param input - String completo del comando a parsear (tal cual viene de `cli_exec`)
 * @returns {@link ParseResult} si el input es valido, {@link ParseError} si tiene errores de sintaxis
 *
 * @example
 * ```ts
 * const result = parse('users:list --limit 10 --format json');
 *
 * if ('errorType' in result) {
 *   console.error(result.message); // Error de sintaxis
 * } else {
 *   console.log(result.type);                    // "single"
 *   console.log(result.commands[0].namespace);   // "users"
 *   console.log(result.commands[0].flags.limit); // 10
 * }
 * ```
 */
export function parse(input: string): ParseResult | ParseError {
  // Constraint: max length
  if (input.length > MAX_INPUT_LENGTH) {
    return inputTooLongError(input);
  }

  // Empty input check
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return emptyInputError(input);
  }

  // Control character validation (ASCII < 32 except tab, newline, CR)
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      return controlCharacterError(i, code, input);
    }
  }

  // Detect type and dispatch
  if (trimmed.startsWith('batch [') || trimmed === 'batch []') {
    return parseBatch(trimmed, input);
  }

  if (containsPipelineOutsideQuotes(trimmed)) {
    return parsePipeline(trimmed, input);
  }

  return parseSingle(trimmed, input, 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Type detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detecta si el input contiene un operador de pipeline (`>>`) fuera de comillas.
 * Recorre caracter por caracter rastreando el estado de comillas.
 */
function containsPipelineOutsideQuotes(input: string): boolean {
  let inQuote: string | null = null;
  for (let i = 0; i < input.length - 1; i++) {
    const ch = input[i];
    if ((ch === '"' || ch === "'") && inQuote === null) {
      inQuote = ch;
    } else if (ch === inQuote) {
      inQuote = null;
    } else if (inQuote === null && ch === '>' && input[i + 1] === '>') {
      return true;
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Batch parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parsea un input de tipo batch: `batch [cmd1, cmd2, ...]`.
 * Extrae el contenido entre corchetes, separa por coma, y parsea cada segmento.
 */
function parseBatch(trimmed: string, raw: string): ParseResult | ParseError {
  const openBracket = trimmed.indexOf('[');
  if (openBracket === -1) {
    return unclosedBatchError(0, raw);
  }

  const closeBracket = findClosingBracket(trimmed, openBracket);
  if (closeBracket === -1) {
    return unclosedBatchError(openBracket, raw);
  }

  const content = trimmed.substring(openBracket + 1, closeBracket).trim();
  if (content.length === 0) {
    return emptyBatchError(openBracket, raw);
  }

  const segments = splitByCommaRespectingQuotes(content);

  if (segments.length > MAX_BATCH_SIZE) {
    return batchSizeError(raw);
  }

  const commands: ParsedCommand[] = [];
  let offset = openBracket + 1;

  for (const segment of segments) {
    const segTrimmed = segment.trim();
    if (segTrimmed.length === 0) continue;

    // Prevent nested batch
    if (segTrimmed.startsWith('batch [') || segTrimmed === 'batch []') {
      return nestedBatchError(raw);
    }

    // Prevent pipeline inside batch
    if (containsPipelineOutsideQuotes(segTrimmed)) {
      return pipelineInBatchError(raw);
    }

    const segStart = trimmed.indexOf(segTrimmed, offset);
    const result = parseSingleCommand(segTrimmed, raw, segStart);
    if ('errorType' in result) return result;
    commands.push(result);
    offset = segStart + segTrimmed.length;
  }

  return { type: 'batch', commands, raw };
}

/** Encuentra el `]` de cierre correspondiente, respetando comillas. */
function findClosingBracket(input: string, openPos: number): number {
  let inQuote: string | null = null;
  for (let i = openPos + 1; i < input.length; i++) {
    const ch = input[i];
    if ((ch === '"' || ch === "'") && inQuote === null) {
      inQuote = ch;
    } else if (ch === inQuote) {
      inQuote = null;
    } else if (inQuote === null && ch === ']') {
      return i;
    }
  }
  return -1;
}

/** Separa un string por comas, ignorando comas dentro de comillas. */
function splitByCommaRespectingQuotes(input: string): string[] {
  const segments: string[] = [];
  let current = '';
  let inQuote: string | null = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if ((ch === '"' || ch === "'") && inQuote === null) {
      inQuote = ch;
      current += ch;
    } else if (ch === inQuote) {
      inQuote = null;
      current += ch;
    } else if (inQuote === null && ch === ',') {
      segments.push(current);
      current = '';
    } else {
      current += ch;
    }
  }

  if (current.length > 0) {
    segments.push(current);
  }

  return segments;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parsea un input de tipo pipeline: `cmd1 >> cmd2 >> cmd3`.
 * Separa por `>>` fuera de comillas y parsea cada segmento como comando individual.
 */
function parsePipeline(trimmed: string, raw: string): ParseResult | ParseError {
  const segments = splitByPipelineRespectingQuotes(trimmed);

  if (segments.length > MAX_PIPELINE_DEPTH) {
    return pipelineDepthError(raw);
  }

  const commands: ParsedCommand[] = [];
  let offset = 0;

  for (const segment of segments) {
    const segTrimmed = segment.trim();
    if (segTrimmed.length === 0) continue;

    const segStart = trimmed.indexOf(segTrimmed, offset);
    const result = parseSingleCommand(segTrimmed, raw, segStart);
    if ('errorType' in result) return result;
    commands.push(result);
    offset = segStart + segTrimmed.length;
  }

  return { type: 'pipeline', commands, raw };
}

/** Separa un string por `>>`, ignorando `>>` dentro de comillas. */
function splitByPipelineRespectingQuotes(input: string): string[] {
  const segments: string[] = [];
  let current = '';
  let inQuote: string | null = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if ((ch === '"' || ch === "'") && inQuote === null) {
      inQuote = ch;
      current += ch;
    } else if (ch === inQuote) {
      inQuote = null;
      current += ch;
    } else if (inQuote === null && ch === '>' && i + 1 < input.length && input[i + 1] === '>') {
      segments.push(current);
      current = '';
      i++; // skip second >
    } else {
      current += ch;
    }
  }

  if (current.length > 0) {
    segments.push(current);
  }

  return segments;
}

// ─────────────────────────────────────────────────────────────────────────────
// Single command parsing
// ─────────────────────────────────────────────────────────────────────────────

/** Parsea un comando unico y lo envuelve en un ParseResult de tipo "single". */
function parseSingle(trimmed: string, raw: string, startPos: number): ParseResult | ParseError {
  const result = parseSingleCommand(trimmed, raw, startPos);
  if ('errorType' in result) return result;
  return { type: 'single', commands: [result], raw };
}

/**
 * Parsea un segmento individual de comando (sin `>>` ni batch).
 *
 * Flujo:
 * 1. Separar filtro jq (todo despues de `| .` o `| [.`)
 * 2. Tokenizar la parte de comando
 * 3. Extraer identidad (namespace:cmd o builtin)
 * 4. Extraer flags globales y clasificar argumentos
 * 5. Construir ParsedCommand con metadata de posicion
 */
function parseSingleCommand(input: string, raw: string, startPos: number): ParsedCommand | ParseError {
  const { commandPart, jqPart } = splitJqFilter(input);

  let jqFilter: JqFilter | null = null;
  if (jqPart !== null) {
    const jqResult = parseJqExpression(jqPart, raw);
    if ('errorType' in jqResult) return jqResult;
    jqFilter = jqResult;
  }

  const tokens = tokenize(commandPart, startPos);
  if (!Array.isArray(tokens)) {
    return tokens;
  }

  if (tokens.length === 0) {
    return emptyInputError(raw);
  }

  const firstToken = tokens[0];
  const identityResult = parseCommandIdentity(firstToken, raw);
  if ('errorType' in identityResult) return identityResult;

  const { namespace, command } = identityResult;
  const remainingTokens = tokens.slice(1);

  const flagsResult = extractFlagsAndArgs(remainingTokens, namespace, command, raw);
  if ('errorType' in flagsResult) return flagsResult;

  const { flags, args } = flagsResult;

  const meta: ParseMeta = {
    startPos,
    endPos: startPos + input.length,
    rawSegment: input,
  };

  return { namespace, command, args, flags, jqFilter, meta };
}

// ─────────────────────────────────────────────────────────────────────────────
// JQ Filter detection and parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Separa el input en parte de comando y parte de filtro jq.
 *
 * Un pipe (`|`) se considera jq filter solo si va seguido de `.` o `[.`
 * (opcionalmente con whitespace). Pipes dentro de comillas se ignoran.
 *
 * @returns commandPart (sin el pipe ni el filtro) y jqPart (la expresion jq sin el pipe)
 */
function splitJqFilter(input: string): { commandPart: string; jqPart: string | null } {
  let inQuote: string | null = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if ((ch === '"' || ch === "'") && inQuote === null) {
      inQuote = ch;
    } else if (ch === inQuote) {
      inQuote = null;
    } else if (inQuote === null && ch === '|') {
      const afterPipe = input.substring(i + 1).trimStart();
      if (afterPipe.startsWith('.') || afterPipe.startsWith('[.')) {
        return {
          commandPart: input.substring(0, i).trim(),
          jqPart: afterPipe,
        };
      }
    }
  }

  return { commandPart: input, jqPart: null };
}

/**
 * Parsea una expresion jq en un objeto {@link JqFilter}.
 *
 * Soporta dos formas:
 * - Campo simple: `.nombre` o `.campo.subcampo`
 * - Multi-campo: `[.campo1, .campo2, ...]`
 *
 * No evalua la expresion; solo la descompone para que el Executor
 * pueda aplicarla sobre el output JSON.
 */
const JQ_FIELD_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const JQ_ARRAY_INDEX_PATTERN = /^\[\d+\]$/;
const MAX_JQ_DEPTH = 5;
const MAX_JQ_FIELDS = 10;

function validateJqFieldPath(fieldPath: string, raw: string): ParseError | null {
  const segments = fieldPath.split('.');
  if (segments.length > MAX_JQ_DEPTH) {
    return jqTooDeepError(fieldPath, raw);
  }
  for (const segment of segments) {
    if (segment.length > 0 && !JQ_FIELD_NAME_PATTERN.test(segment) && !JQ_ARRAY_INDEX_PATTERN.test(segment)) {
      return invalidJqFieldError(segment, raw);
    }
  }
  return null;
}

function parseJqExpression(expr: string, raw?: string): JqFilter | ParseError {
  const trimmed = expr.trim();
  const errorRaw = raw || trimmed;

  // Multi-field: [.field1, .field2, ...]
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.substring(1, trimmed.length - 1);
    const fields = inner.split(',').map(f => {
      const field = f.trim();
      return field.startsWith('.') ? field.substring(1) : field;
    });

    // Validate field count
    if (fields.length > MAX_JQ_FIELDS) {
      return jqTooManyFieldsError(fields.length, errorRaw);
    }

    // Validate each field path
    for (const field of fields) {
      const err = validateJqFieldPath(field, errorRaw);
      if (err) return err;
    }

    return {
      raw: trimmed,
      type: 'multi_field',
      fields,
    };
  }

  // Single field: .field or .field.subfield
  if (trimmed.startsWith('.')) {
    const fieldPath = trimmed.substring(1);
    const err = validateJqFieldPath(fieldPath, errorRaw);
    if (err) return err;

    return {
      raw: trimmed,
      type: 'field',
      fields: [fieldPath],
    };
  }

  // Fallback (no deberia alcanzarse si splitJqFilter funciona correctamente)
  return {
    raw: trimmed,
    type: 'field',
    fields: [trimmed],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Command identity parsing
// ─────────────────────────────────────────────────────────────────────────────

interface CommandIdentity {
  namespace: string | null;
  command: string;
}

/**
 * Extrae namespace y comando del primer token.
 *
 * Reglas de resolucion:
 * 1. Si el valor es un builtin conocido → `{ namespace: null, command: valor }`
 * 2. Si contiene `:` → separar en namespace y comando, validando ambos
 * 3. Si no contiene `:` ni es builtin → `{ namespace: null, command: valor }`
 *    (el Router se encargara de resolver o rechazar)
 */
function parseCommandIdentity(token: Token, raw: string): CommandIdentity | ParseError {
  const value = token.value;

  if (BUILTIN_COMMANDS.includes(value as any)) {
    return { namespace: null, command: value };
  }

  const colonIdx = value.indexOf(':');
  if (colonIdx !== -1) {
    const namespace = value.substring(0, colonIdx);
    const command = value.substring(colonIdx + 1);

    if (namespace.length === 0) {
      return invalidNamespaceError('', token.position, raw);
    }
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(namespace)) {
      return invalidNamespaceError(namespace, token.position, raw);
    }

    if (command.length === 0) {
      return missingCommandError(namespace, token.position + colonIdx + 1, raw);
    }

    return { namespace, command };
  }

  return { namespace: null, command: value };
}

// ─────────────────────────────────────────────────────────────────────────────
// Flags and arguments extraction
// ─────────────────────────────────────────────────────────────────────────────

interface FlagsAndArgs {
  flags: GlobalFlags;
  args: CommandArgs;
}

/**
 * Clasifica los tokens restantes (despues del command_id) en flags globales
 * y argumentos del comando.
 *
 * Reglas de precedencia:
 * - Flags globales (`--dry-run`, `--validate`, `--confirm`, `--format`, `--limit`, `--offset`)
 *   siempre se extraen al objeto `flags`, nunca aparecen en `args.named`
 * - Un token `--flag` seguido de otro `--flag` o al final del input se interpreta como boolean (true)
 * - Un token `--flag` seguido de un valor se interpreta como named arg con ese valor
 * - Para el builtin `search`, todos los tokens no-flag se unen en un unico positional
 *   (la query de busqueda semantica)
 */
function extractFlagsAndArgs(
  tokens: Token[],
  namespace: string | null,
  command: string,
  raw: string
): FlagsAndArgs | ParseError {
  const flags: GlobalFlags = {
    dryRun: false,
    validate: false,
    confirm: false,
    format: null,
    limit: null,
    offset: null,
  };

  const named: Record<string, string | boolean> = {};
  const positional: string[] = [];

  const isSearch = namespace === null && command === 'search';

  let i = 0;
  const searchParts: string[] = [];

  while (i < tokens.length) {
    const token = tokens[i];

    if (!token.quoted && token.value.startsWith('--')) {
      const flagName = token.value.substring(2);

      // Global flags
      if (flagName === 'dry-run') {
        flags.dryRun = true;
        i++;
        continue;
      }
      if (flagName === 'validate') {
        flags.validate = true;
        i++;
        continue;
      }
      if (flagName === 'confirm') {
        flags.confirm = true;
        i++;
        continue;
      }
      if (flagName === 'format') {
        i++;
        if (i >= tokens.length) {
          return invalidFormatError('', token.position + token.value.length, raw);
        }
        const formatValue = tokens[i].value;
        if (!VALID_FORMATS.includes(formatValue as any)) {
          return invalidFormatError(formatValue, tokens[i].position, raw);
        }
        flags.format = formatValue as 'json' | 'table' | 'csv';
        i++;
        continue;
      }
      if (flagName === 'limit') {
        i++;
        if (i >= tokens.length) {
          return invalidFlagValueError('limit', '', token.position + token.value.length, raw);
        }
        const limitValue = tokens[i].value;
        const num = parseInt(limitValue, 10);
        if (isNaN(num) || String(num) !== limitValue) {
          return invalidFlagValueError('limit', limitValue, tokens[i].position, raw);
        }
        flags.limit = num;
        i++;
        continue;
      }
      if (flagName === 'offset') {
        i++;
        if (i >= tokens.length) {
          return invalidFlagValueError('offset', '', token.position + token.value.length, raw);
        }
        const offsetValue = tokens[i].value;
        const num = parseInt(offsetValue, 10);
        if (isNaN(num) || String(num) !== offsetValue) {
          return invalidFlagValueError('offset', offsetValue, tokens[i].position, raw);
        }
        flags.offset = num;
        i++;
        continue;
      }

      // Regular named argument: consume next token as value if it's not another flag
      if (i + 1 < tokens.length && !(!tokens[i + 1].quoted && tokens[i + 1].value.startsWith('--'))) {
        named[flagName] = tokens[i + 1].value;
        i += 2;
      } else {
        named[flagName] = true;
        i++;
      }
    } else {
      // Positional argument
      if (isSearch) {
        searchParts.push(token.value);
      } else {
        positional.push(token.value);
      }
      i++;
    }
  }

  // Para search: unir todas las partes posicionales en una sola query
  if (isSearch && searchParts.length > 0) {
    positional.push(searchParts.join(' '));
  }

  return { flags, args: { positional, named } };
}
