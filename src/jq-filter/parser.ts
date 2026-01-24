/**
 * @module jq-filter/parser
 * @description Parser de expresiones jq-subset.
 *
 * Transforma un string de expresion (ej: `.users.[0].name`) en una
 * estructura ParsedExpression con segmentos tipados que el resolver
 * puede recorrer sobre el JSON.
 */

import type { ParsedExpression, PathSegment } from './types.js';
import { MAX_EXPRESSION_LENGTH, MAX_PATH_DEPTH, MAX_MULTI_SELECT_FIELDS } from './types.js';
import type { FilterError } from './types.js';

/**
 * Parsea una expresion jq-subset en una estructura navegable.
 *
 * @param expression - Expresion jq (ej: `.name`, `.[0]`, `[.a, .b]`)
 * @returns ParsedExpression o FilterError si la sintaxis es invalida
 */
export function parseExpression(expression: string): ParsedExpression | FilterError {
  // Validar longitud
  if (expression.length === 0) {
    return expressionError('E001', expression, 'Empty expression');
  }

  if (expression.length > MAX_EXPRESSION_LENGTH) {
    return expressionError('E001', expression, `Expression exceeds maximum length of ${MAX_EXPRESSION_LENGTH} characters`);
  }

  // Reject unsupported syntax
  if (expression.includes('|')) {
    return expressionError('E001', expression, 'Pipe operator inside expression is not supported');
  }
  if (expression.includes('{') || expression.includes('}')) {
    return expressionError('E001', expression, 'Object construction is not supported');
  }
  if (/\[\d+:\d+\]/.test(expression)) {
    return expressionError('E001', expression, 'Array slicing is not supported');
  }

  const trimmed = expression.trim();

  // Multi-select: [.a, .b, ...]
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return parseMultiSelect(trimmed);
  }

  // Identity: just "."
  if (trimmed === '.') {
    return { type: 'identity', segments: [], subExpressions: [] };
  }

  // Path expression: .field, .[0], .[].field, etc.
  if (trimmed.startsWith('.')) {
    return parsePath(trimmed);
  }

  return expressionError('E001', expression, `Expression must start with '.' or '['`);
}

/** Parsea un multi-select: `[.a, .b, .c]` */
function parseMultiSelect(expr: string): ParsedExpression | FilterError {
  const inner = expr.substring(1, expr.length - 1).trim();
  if (inner.length === 0) {
    return expressionError('E001', expr, 'Empty multi-select expression');
  }

  // Split by comma (simple split - no nested brackets in our subset)
  const parts = inner.split(',').map(p => p.trim());

  if (parts.length > MAX_MULTI_SELECT_FIELDS) {
    return expressionError('E001', expr, `Multi-select exceeds maximum of ${MAX_MULTI_SELECT_FIELDS} fields`);
  }

  const subExpressions: ParsedExpression[] = [];
  for (const part of parts) {
    const parsed = parseExpression(part);
    if ('success' in parsed && !parsed.success) return parsed as FilterError;
    subExpressions.push(parsed as ParsedExpression);
  }

  return { type: 'multi_select', segments: [], subExpressions };
}

/** Parsea un path: `.field.subfield.[0].[].name` */
function parsePath(expr: string): ParsedExpression | FilterError {
  const segments: PathSegment[] = [];
  let i = 1; // Skip initial dot

  while (i < expr.length) {
    // Array access: [N], [-N], or [] (iteration)
    if (expr[i] === '[') {
      const closeIdx = expr.indexOf(']', i);
      if (closeIdx === -1) {
        return expressionError('E001', expr, `Unclosed bracket at position ${i}`);
      }

      const content = expr.substring(i + 1, closeIdx);

      if (content === '') {
        // Iteration: .[]
        segments.push({ type: 'iteration' });
      } else {
        // Index: .[N] or .[-N]
        const index = parseInt(content, 10);
        if (isNaN(index) || String(index) !== content) {
          return expressionError('E001', expr, `Invalid array index '${content}'`);
        }
        segments.push({ type: 'index', index });
      }

      i = closeIdx + 1;
      // Skip dot after bracket if present
      if (i < expr.length && expr[i] === '.') {
        i++;
      }
      continue;
    }

    // Dot separator (between segments)
    if (expr[i] === '.') {
      // Check for consecutive dots (invalid: `..field`)
      if (i + 1 < expr.length && expr[i + 1] === '.') {
        return expressionError('E001', expr, `Unexpected '.' at position ${i + 1}`);
      }
      i++;
      continue;
    }

    // Field name
    const nameStart = i;
    while (i < expr.length && expr[i] !== '.' && expr[i] !== '[') {
      i++;
    }

    const name = expr.substring(nameStart, i);
    if (name.length === 0) {
      return expressionError('E001', expr, `Empty field name at position ${nameStart}`);
    }

    // Validate field name: [a-zA-Z_][a-zA-Z0-9_-]*
    if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(name)) {
      return expressionError('E001', expr, `Invalid field name '${name}'`);
    }

    segments.push({ type: 'field', name });
  }

  if (segments.length > MAX_PATH_DEPTH) {
    return expressionError('E001', expr, `Path exceeds maximum depth of ${MAX_PATH_DEPTH} segments`);
  }

  return { type: 'path', segments, subExpressions: [] };
}

function expressionError(code: string, expression: string, detail: string): FilterError {
  return {
    success: false,
    error: {
      code,
      message: `Invalid filter expression: '${expression}'. ${detail}. Supported syntax: .field, .a.b, .[N], .[].field, [.a, .b]`,
      expression,
    },
  };
}
