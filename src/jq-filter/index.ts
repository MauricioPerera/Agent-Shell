/**
 * @module jq-filter
 * @description Procesador de filtros jq-subset para Agent Shell.
 *
 * Aplica expresiones de filtrado con sintaxis compatible con un subset de jq
 * sobre output JSON, reduciendo la cantidad de datos que el agente recibe.
 *
 * Sintaxis soportada:
 * - `.campo` - Campo simple
 * - `.a.b.c` - Campos anidados
 * - `.[N]` / `.[-N]` - Indice de array (positivo/negativo)
 * - `.[].campo` - Iteracion sobre array
 * - `[.a, .b]` - Multi-select
 * - `.` - Identidad
 *
 * @example
 * ```ts
 * import { applyFilter } from 'agent-shell';
 *
 * const data = { users: [{ name: 'Juan' }, { name: 'Ana' }] };
 * const result = applyFilter(data, '.users.[].name');
 * // → { success: true, result: ['Juan', 'Ana'], ... }
 * ```
 */

import type { FilterResult, FilterError } from './types.js';
import { MAX_INPUT_SIZE_BYTES } from './types.js';
import { parseExpression } from './parser.js';
import { resolve } from './resolver.js';

export type { FilterResult, FilterSuccess, FilterError } from './types.js';

/**
 * Aplica una expresion de filtrado jq-subset sobre datos JSON.
 *
 * @param data - Datos JSON (object, array, o primitivo). Si es un string que no es JSON valido, retorna E002.
 * @param expression - Expresion jq-subset (ej: `.name`, `.[0]`, `[.a, .b]`)
 * @returns FilterResult - exito con el valor filtrado, o error estructurado
 */
export function applyFilter(data: any, expression: string): FilterResult {
  // Validate expression (E001)
  const parsed = parseExpression(expression);
  if ('success' in parsed && !parsed.success) {
    return parsed as FilterError;
  }

  // Validate input (E002)
  const inputValidation = validateInput(data);
  if (inputValidation !== null) {
    return inputValidation;
  }

  // Apply filter
  return resolve(data, parsed as any, expression);
}

/**
 * Valida que el input sea JSON valido y no exceda limites.
 * Retorna null si es valido, o FilterError si no.
 */
function validateInput(data: any): FilterError | null {
  // Check if data is a string (could be unparsed JSON or invalid)
  if (typeof data === 'string') {
    // Try to parse as JSON
    try {
      JSON.parse(data);
    } catch {
      return {
        success: false,
        error: {
          code: 'E002',
          message: 'Input is not valid JSON. Cannot apply filter.',
        },
      };
    }
    // If it parses, it's a valid JSON string value - but the contract says
    // strings passed as data that aren't valid JSON objects/arrays are E002
    return {
      success: false,
      error: {
        code: 'E002',
        message: 'Input is not valid JSON. Cannot apply filter.',
      },
    };
  }

  // Check for undefined
  if (data === undefined) {
    return {
      success: false,
      error: {
        code: 'E002',
        message: 'Input is not valid JSON. Cannot apply filter.',
      },
    };
  }

  // Size check (approximate - serialize and check length)
  try {
    const serialized = JSON.stringify(data);
    if (serialized && serialized.length > MAX_INPUT_SIZE_BYTES) {
      return {
        success: false,
        error: {
          code: 'E002',
          message: `Input JSON exceeds maximum size of 10MB.`,
        },
      };
    }
  } catch {
    // If we can't serialize, it's not valid JSON
    return {
      success: false,
      error: {
        code: 'E002',
        message: 'Input is not valid JSON. Cannot apply filter.',
      },
    };
  }

  return null;
}
