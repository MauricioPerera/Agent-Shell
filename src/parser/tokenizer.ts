/**
 * @module parser/tokenizer
 * @description Tokenizador de bajo nivel para el parser de Agent Shell.
 *
 * Divide un string de comando en tokens a nivel de palabra, manejando
 * correctamente strings entre comillas (simples y dobles). Los operadores
 * estructurales (`|`, `>>`, `[`, `]`, `,`) se resuelven en capas superiores
 * antes de pasar el segmento al tokenizador.
 *
 * Garantias:
 * - Las comillas se consumen y el valor resultante no las incluye
 * - Los espacios dentro de comillas se preservan como parte del valor
 * - Los espacios multiples entre tokens se colapsan (equivalentes a uno)
 * - Si una comilla queda sin cerrar, retorna ParseError (no lanza excepcion)
 * - Cada token incluye su posicion absoluta en el input para diagnosticos
 */

import type { ParseError } from './types.js';
import { unclosedQuoteError } from './errors.js';

/**
 * Token producido por el tokenizador.
 *
 * @property value - Contenido del token (sin comillas si era quoted)
 * @property position - Posicion absoluta (0-indexed) del inicio del token en el input original
 * @property quoted - `true` si el token estaba entre comillas (simples o dobles)
 */
export interface Token {
  value: string;
  position: number;
  quoted: boolean;
}

/**
 * Tokeniza un segmento de comando en tokens a nivel de palabra.
 *
 * No interpreta semantica de los tokens (eso lo hace el parser).
 * Solo separa por whitespace y maneja comillas.
 *
 * @param input - String del segmento a tokenizar (ya limpio de operadores estructurales)
 * @param baseOffset - Offset base para calcular posiciones absolutas cuando el input
 *   es un sub-string del comando completo (ej: un segmento de pipeline)
 * @returns Array de tokens ordenados por posicion, o ParseError si hay comilla sin cerrar
 *
 * @example
 * ```ts
 * tokenize('--name "John Doe" --age 30');
 * // [
 * //   { value: "--name", position: 0, quoted: false },
 * //   { value: "John Doe", position: 7, quoted: true },
 * //   { value: "--age", position: 18, quoted: false },
 * //   { value: "30", position: 24, quoted: false },
 * // ]
 * ```
 */
export function tokenize(input: string, baseOffset: number = 0): Token[] | ParseError {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    // Skip whitespace
    if (input[i] === ' ' || input[i] === '\t') {
      i++;
      continue;
    }

    // Quoted string
    if (input[i] === '"' || input[i] === "'") {
      const quoteChar = input[i];
      const startPos = i;
      i++; // skip opening quote
      let value = '';

      while (i < input.length && input[i] !== quoteChar) {
        value += input[i];
        i++;
      }

      if (i >= input.length) {
        const quoteType = quoteChar === '"' ? 'double' : 'single';
        return unclosedQuoteError(quoteType, baseOffset + startPos, input);
      }

      i++; // skip closing quote
      tokens.push({ value, position: baseOffset + startPos, quoted: true });
      continue;
    }

    // Regular word (until whitespace or quote)
    const startPos = i;
    let value = '';
    while (i < input.length && input[i] !== ' ' && input[i] !== '\t' && input[i] !== '"' && input[i] !== "'") {
      value += input[i];
      i++;
    }

    if (value.length > 0) {
      tokens.push({ value, position: baseOffset + startPos, quoted: false });
    }
  }

  return tokens;
}
