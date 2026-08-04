/**
 * @module skills/shell-json
 * @description JSON filtering and parsing skills.
 * Reuses the existing jq-filter module for filtering.
 */

import { command } from '../command-builder/index.js';
import { applyFilter } from '../jq-filter/index.js';
import { MAX_INPUT_SIZE_BYTES } from '../jq-filter/types.js';
import type { SkillEntry } from './scaffold.js';

const filterDef = command('json', 'filter')
  .version('1.0.0')
  .description('Filter JSON data using jq-like expressions (.field, .[N], [.a, .b])')
  .requiredParam('expression', 'string')
  .optionalParam('input', 'json', null)
  .example('json:filter --expression .users.[0].name --input \'{"users":[{"name":"Alice"}]}\'')
  .tags('json', 'filter', 'transform')
  .build();

const parseDef = command('json', 'parse')
  .version('1.0.0')
  .description('Parse a JSON string into a structured object')
  .requiredParam('text', 'string')
  .example('json:parse --text \'{"key":"value"}\'')
  .tags('json', 'parse')
  .build();

filterDef.requiredPermissions = ['json:read'];
parseDef.requiredPermissions = ['json:read'];

export const jsonCommands: SkillEntry[] = [
  {
    definition: filterDef,
    handler: async (args: any, input?: any) => {
      const data = args.input || input;
      if (data === null || data === undefined) {
        return { success: false, data: null, error: 'No input data. Provide --input or pipe via pipeline.' };
      }
      // Regresion (ronda 69 del audit, HIGH): applyFilter()'s propio
      // validateInput() ya limita el tamano a MAX_INPUT_SIZE_BYTES, pero
      // recien DESPUES de que JSON.parse(data) ya pago el costo completo
      // de parsear (y, dentro de validateInput(), un JSON.stringify()
      // adicional para medir el tamano) — un payload plano grande (no
      // necesariamente anidado, asi que el chequeo de profundidad de
      // Core/convertType tampoco lo agarra) paga ese costo dos veces antes
      // de ser rechazado. Peor aun para --input via PIPELINE (el 2do
      // argumento del handler): ese path nunca pasa por Core.convertType
      // en absoluto, asi que un string proveniente de un pipeline no tenia
      // NINGUN chequeo previo. Mismo mecanismo que json:parse ya usa un
      // nivel mas abajo (chequear el tamano del INPUT crudo antes de
      // parsear), aplicado aca antes del JSON.parse en vez de despues.
      if (typeof data === 'string' && data.length > MAX_INPUT_SIZE_BYTES) {
        return { success: false, data: null, error: `Input exceeds maximum size of ${MAX_INPUT_SIZE_BYTES} bytes` };
      }
      const parsed = typeof data === 'string' ? JSON.parse(data) : data;
      const result = applyFilter(parsed, args.expression);
      if (result.success) {
        return { success: true, data: result.result };
      }
      return { success: false, data: null, error: result.error?.message || 'Filter failed' };
    },
  },
  {
    definition: parseDef,
    handler: async (args: any) => {
      let parsed: any;
      try {
        parsed = JSON.parse(args.text);
      } catch (err: any) {
        return { success: false, data: null, error: `Invalid JSON: ${err.message}` };
      }

      // Regresion (ronda 62 del audit, HIGH): a diferencia de json:filter
      // (cuyo --input es type:'json', asi que Core/Executor's convertType
      // ya le aplica un chequeo de profundidad antes de que llegue al
      // handler — y applyFilter() aplica ademas su propio limite de
      // tamano via validateInput()), json:parse's `text` es type:'string'
      // por necesidad (su trabajo ES parsear un string crudo) y no tenia
      // NINGUNA validacion de profundidad/tamano sobre el resultado. Un
      // payload de anidamiento profundo (`[[[[...]]]]`) de apenas ~10KB
      // — muy por debajo de cualquier cap de body existente — parsea
      // instantaneo, pero un JSON.stringify() posterior (al serializar la
      // respuesta hacia el caller, en mcp/server.ts o mcp/http-transport.ts)
      // revienta con "RangeError: Maximum call stack size exceeded",
      // degradando a un "Internal error" opaco. Mismo mecanismo de
      // defensa que jq-filter's propio validateInput() ya usa: intentar
      // serializar ACA (antes de que el resultado salga del handler) para
      // atrapar tanto el stack overflow por anidamiento profundo como un
      // resultado sobredimensionado, en vez de dejar que el problema
      // aparezca recien en la capa de transporte.
      try {
        const serialized = JSON.stringify(parsed);
        if (serialized && serialized.length > MAX_INPUT_SIZE_BYTES) {
          return { success: false, data: null, error: `Parsed JSON exceeds maximum size of ${MAX_INPUT_SIZE_BYTES} bytes` };
        }
      } catch {
        return { success: false, data: null, error: 'Parsed JSON is too deeply nested to serialize safely' };
      }

      return { success: true, data: parsed };
    },
  },
];
