/**
 * @module jq-filter/resolver
 * @description Resuelve un path de segmentos sobre datos JSON.
 *
 * Recorre la estructura JSON aplicando cada segmento (field access,
 * array index, iteration) y retorna el valor resultante o un error
 * estructurado si el path no es valido.
 */

import type { PathSegment, ParsedExpression, FilterResult, FilterSuccess, FilterError } from './types.js';
import { MAX_ITERATION_ELEMENTS } from './types.js';

/**
 * Resuelve una expresion parseada sobre datos JSON.
 *
 * @param data - Datos JSON sobre los cuales aplicar la expresion
 * @param parsed - Expresion ya parseada en segmentos
 * @param originalExpression - Expresion original (para mensajes de error)
 * @returns FilterResult (exito con el valor, o error)
 */
export function resolve(
  data: any,
  parsed: ParsedExpression,
  originalExpression: string,
  // Regresion (ronda 64 del audit, CRITICAL): antes cada sub-expresion de un
  // multi_select (ej. "[.a.[],.a.[],...]") reentraba resolve() y recibia su
  // PROPIO counter fresco ({ count: 0 } por defecto), asi que el cap
  // acumulativo de MAX_ITERATION_ELEMENTS (agregado en ronda 57 justamente
  // para sumar iteraciones a traves de niveles anidados de UN SOLO path) se
  // reseteaba en cada sub-expresion en vez de acumular entre TODAS. Un
  // filtro con 20 repeticiones de ".a.[]" (dentro de los limites
  // MAX_MULTI_SELECT_FIELDS/MAX_EXPRESSION_LENGTH) sobre un array de ~9999
  // elementos producia ~200k elementos de salida sin disparar nunca
  // iterationLimitError, ya que cada sub-expresion individualmente se
  // quedaba bajo el cap. Ahora `counter` se comparte via parametro entre
  // resolve() y resolveMultiSelect(), asi que TODAS las sub-expresiones de
  // un mismo multi_select (y cualquier multi_select anidado dentro de
  // ellas) acumulan sobre el mismo total.
  counter: { count: number } = { count: 0 }
): FilterResult {
  const inputType = getInputType(data);

  if (parsed.type === 'identity') {
    return success(data, originalExpression, inputType);
  }

  if (parsed.type === 'multi_select') {
    return resolveMultiSelect(data, parsed, originalExpression, inputType, counter);
  }

  // Path resolution
  const result = resolvePath(data, parsed.segments, originalExpression, counter);
  if (!result.success) return result;
  return success(result.result, originalExpression, inputType);
}

/** Resuelve un multi-select evaluando cada sub-expresion, compartiendo el counter acumulativo entre todas (ver comentario de resolve() arriba). */
function resolveMultiSelect(
  data: any,
  parsed: ParsedExpression,
  originalExpression: string,
  inputType: string,
  counter: { count: number }
): FilterResult {
  const results: any[] = [];

  for (const subExpr of parsed.subExpressions) {
    const result = resolve(data, subExpr, originalExpression, counter);
    if (!result.success) return result;
    results.push((result as FilterSuccess).result);
  }

  return success(results, originalExpression, inputType);
}

/** Resuelve un path de segmentos sobre los datos. */
function resolvePath(
  data: any,
  segments: PathSegment[],
  originalExpression: string,
  counter: { count: number }
): FilterResult {
  let current = data;
  let resolvedPath = '';

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];

    if (segment.type === 'field') {
      // Check that current is an object
      if (current === null) {
        return typeError(originalExpression, resolvedPath, `.${segment.name}`, 'null', 'object');
      }
      if (typeof current !== 'object' || Array.isArray(current)) {
        const actualType = Array.isArray(current) ? 'array' : typeof current;
        return typeError(originalExpression, resolvedPath, `.${segment.name}`, actualType, 'object');
      }

      // Check field exists
      if (!(segment.name in current)) {
        const availableKeys = Object.keys(current);
        return pathNotFoundError(
          originalExpression,
          resolvedPath,
          `${resolvedPath}.${segment.name}`,
          availableKeys
        );
      }

      current = current[segment.name];
      resolvedPath += `.${segment.name}`;
    } else if (segment.type === 'index') {
      // Check that current is an array
      if (!Array.isArray(current)) {
        const actualType = current === null ? 'null' : typeof current;
        return typeError(originalExpression, resolvedPath, `[${segment.index}]`, actualType, 'array');
      }

      // Resolve negative index
      let idx = segment.index;
      if (idx < 0) {
        idx = current.length + idx;
      }

      // Check bounds
      if (idx < 0 || idx >= current.length) {
        return pathNotFoundError(
          originalExpression,
          resolvedPath,
          `${resolvedPath}.[${segment.index}]`,
          [`length: ${current.length}`]
        );
      }

      current = current[idx];
      resolvedPath += `.[${segment.index}]`;
    } else if (segment.type === 'iteration') {
      // Check that current is an array
      if (!Array.isArray(current)) {
        const actualType = current === null ? 'null' : typeof current;
        return typeError(originalExpression, resolvedPath, '[]', actualType, 'array');
      }

      // Empty array → return empty array
      if (current.length === 0) {
        return { success: true, result: [], expression: originalExpression, input_type: getInputType(data) };
      }

      // Regresion (ronda 57 del audit, HIGH): MAX_ITERATION_ELEMENTS antes
      // se chequeaba solo POR NIVEL de iteracion (`current.length` de ESTE
      // nivel nada mas) — un filtro con iteraciones anidadas (ej.
      // ".a.[].b.[]") podia producir una salida total que es el PRODUCTO
      // de los tamanos de cada nivel, cada uno individualmente bajo el
      // cap, sin que ningun chequeo lo detectara. `counter` es el MISMO
      // objeto compartido entre todas las llamadas recursivas de
      // resolvePath para esta expresion (ver la llamada inicial en
      // resolve()), asi que acumula el total de elementos iterados en
      // CUALQUIER nivel de anidamiento.
      counter.count += current.length;
      if (counter.count > MAX_ITERATION_ELEMENTS) {
        return iterationLimitError(originalExpression, resolvedPath, counter.count);
      }

      // Apply remaining segments to each element
      const remainingSegments = segments.slice(i + 1);
      if (remainingSegments.length === 0) {
        // Just iterate, return all elements
        return { success: true, result: [...current], expression: originalExpression, input_type: getInputType(data) };
      }

      // Map each element through remaining segments
      const results: any[] = [];
      for (const item of current) {
        const itemResult = resolvePath(item, remainingSegments, originalExpression, counter);
        if (!itemResult.success) return itemResult;
        results.push((itemResult as FilterSuccess).result);
      }

      return { success: true, result: results, expression: originalExpression, input_type: getInputType(data) };
    }
  }

  return { success: true, result: current, expression: originalExpression, input_type: getInputType(data) };
}

// --- Helper functions ---

function success(result: any, expression: string, inputType: string): FilterSuccess {
  return { success: true, result, expression, input_type: inputType };
}

function getInputType(data: any): string {
  if (data === null) return 'null';
  if (Array.isArray(data)) return 'array';
  return typeof data;
}

function pathNotFoundError(
  expression: string,
  pathResolved: string,
  pathFailed: string,
  availableKeys: string[]
): FilterError {
  return {
    success: false,
    error: {
      code: 'E003',
      message: `Path '${pathFailed}' not found in input. Available keys: [${availableKeys.join(', ')}]`,
      expression,
      path_resolved: pathResolved || '.',
      path_failed: pathFailed,
      available_keys: availableKeys,
    },
  };
}

function iterationLimitError(expression: string, pathResolved: string, count: number): FilterError {
  return {
    success: false,
    error: {
      code: 'E005',
      message: `Iteration exceeds maximum of ${MAX_ITERATION_ELEMENTS} elements (got ${count}) at path '${pathResolved || '.'}'.`,
      expression,
      path_resolved: pathResolved || '.',
    },
  };
}

function typeError(
  expression: string,
  pathResolved: string,
  operation: string,
  actualType: string,
  expectedType: string
): FilterError {
  return {
    success: false,
    error: {
      code: 'E004',
      message: `Cannot apply '${operation}' on type '${actualType}' at path '${pathResolved || '.'}'. Expected '${expectedType}'.`,
      expression,
      path_resolved: pathResolved || '.',
      path_failed: `${pathResolved}${operation}`,
    },
  };
}
