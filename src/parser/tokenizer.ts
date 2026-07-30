/**
 * @module parser/tokenizer
 * @description Tokenizador de bajo nivel para el parser de Agent Shell.
 *
 * Divide un string de comando en tokens a nivel de palabra, manejando
 * correctamente strings entre comillas (simples y dobles). Los operadores
 * estructurales (`|`, `>>`, `[`, `]`, `,`) se resuelven en capas superiores
 * antes de pasar el segmento al tokenizador — esas capas (ver parser/index.ts)
 * usan `scanQuoteChar` para rastrear comillas de forma identica a como lo
 * hace este modulo, evitando que se abra/cierre una region "quoted" en un
 * lugar distinto para el segmentador que para el tokenizador.
 *
 * Garantias:
 * - Las comillas se consumen y el valor resultante no las incluye
 * - Los espacios dentro de comillas se preservan como parte del valor
 * - Los espacios multiples entre tokens se colapsan (equivalentes a uno)
 * - Si una comilla queda sin cerrar, retorna ParseError (no lanza excepcion)
 * - Cada token incluye su posicion absoluta en el input para diagnosticos
 * - `\"` dentro de un string entre comillas dobles (o `\'` entre comillas
 *   simples) es una comilla literal escapada: no cierra el string. Ver
 *   `scanQuoteChar` para el detalle exacto de la regla.
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
 * Avanza el estado de rastreo de comillas un paso, aplicando la MISMA regla
 * de escape en todo el modulo `parser/`: un backslash inmediatamente
 * seguido de la comilla delimitadora ACTUAL es una comilla literal
 * escapada — se consume junto con el backslash y el string sigue abierto,
 * en vez de que el backslash sea dato comun y la comilla cierre el string.
 *
 * Deliberadamente NO es un escape general de backslash: cualquier OTRO
 * backslash (`\\`, `\n`, `\Users`, ...) se deja intacto como caracter
 * literal comun. Antes de este cambio no existia forma de incluir una
 * comilla literal dentro de un valor entre comillas — un solo caracter de
 * comilla sin escapar en el VALOR terminaba el string ahi mismo, y el
 * resto del input se re-tokenizaba como comandos/flags nuevos (ver
 * `quoteArg` para la forma segura de embeber un valor arbitrario). Tratar
 * TODO backslash como introductor de escape (estilo C) hubiera roto rutas
 * de Windows (`C:\Users\name`) y UNC (`\\server\share`), que son el uso
 * mas comun de comillas en este dominio — por eso el escape se limita
 * estrictamente al caso backslash-antes-de-la-propia-comilla.
 *
 * Limitacion conocida y documentada (no un caso nuevo — los shells reales
 * comparten esta ambiguedad, ej. cmd.exe): un valor que deba terminar en
 * un backslash literal justo antes de la comilla de cierre no se puede
 * representar sin ambiguedad, porque ese backslash se interpreta como el
 * inicio de una comilla escapada.
 *
 * Cada loop de rastreo de comillas caracter-por-caracter en este modulo Y
 * en parser/index.ts (segmentacion de pipeline/batch/coma/jq) DEBE usar
 * esta funcion en vez de un chequeo `ch === quote` a mano — si no,
 * un valor con una comilla escapada queda "cerrado" para el segmentador de
 * nivel superior pero sigue abierto para el tokenizador (o al reves),
 * dejando que el propio contenido del valor reabra estructura de
 * pipe/batch/jq que deberia ser dato inerte y citado.
 *
 * @returns el nuevo estado de comillas y cuantos caracteres consumio este paso (1 o 2)
 */
export function scanQuoteChar(input: string, i: number, inQuote: string | null): { inQuote: string | null; length: number } {
  const ch = input[i];
  if (inQuote !== null && ch === '\\' && input[i + 1] === inQuote) {
    return { inQuote, length: 2 };
  }
  if (inQuote === null && (ch === '"' || ch === "'")) {
    return { inQuote: ch, length: 1 };
  }
  if (ch === inQuote) {
    return { inQuote: null, length: 1 };
  }
  return { inQuote, length: 1 };
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
 *
 * tokenize('--note "she said \\"hi\\""');
 * // [
 * //   { value: "--note", position: 0, quoted: false },
 * //   { value: 'she said "hi"', position: 7, quoted: true },
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
        const step = scanQuoteChar(input, i, quoteChar);
        if (step.length === 2) {
          // Escaped quote: append the literal quote character, not the backslash.
          value += quoteChar;
        } else {
          value += input[i];
        }
        i += step.length;
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

/**
 * Envuelve `value` entre comillas, escapando cualquier ocurrencia de la
 * comilla delimitadora para que el resultado sea seguro de embeber
 * directamente en un string de comando pasado a `parse()`/`Core.exec()`.
 *
 * Usar SIEMPRE que `value` venga de afuera del control del caller (input
 * de usuario, contenido de un documento, etc.) y se este interpolando en
 * un string de comando — interpolar el valor crudo sin pasar por esta
 * funcion es exactamente el patron que permite que el propio contenido del
 * valor inyecte un flag/argumento sintetico si contiene una comilla sin
 * escapar (ver el docblock de `scanQuoteChar`). Es el equivalente, para la
 * gramatica propia de agent-shell, de `shellQuoteSingle` en
 * just-bash/adapter.ts para POSIX shell.
 *
 * Limitacion: un `value` que termine en un backslash literal justo antes
 * de donde se agrega la comilla de cierre no se puede representar sin
 * ambiguedad — ver la limitacion documentada en `scanQuoteChar`.
 *
 * @example
 * ```ts
 * quoteArg('she said "hi"'); // '"she said \\"hi\\""'
 * `--note ${quoteArg(untrustedValue)}` // seguro de interpolar
 * ```
 */
export function quoteArg(value: string, quoteChar: '"' | "'" = '"'): string {
  const escaped = value.split(quoteChar).join(`\\${quoteChar}`);
  return `${quoteChar}${escaped}${quoteChar}`;
}
