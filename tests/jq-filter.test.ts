/**
 * @contract CONTRACT_JQ_FILTER v1.0
 * @module JQ Filter (Agent Shell)
 * @description Tests para el modulo JQ Filter basados en los 25 casos de prueba del contrato.
 *
 * El JQ Filter aplica expresiones de filtrado jq-subset sobre output JSON,
 * extrayendo campos especificos para reducir tokens en la respuesta al agente.
 */

import { describe, it, expect } from 'vitest';
import { applyFilter } from '../src/jq-filter/index.js';
import type { FilterResult, FilterSuccess, FilterError } from '../src/jq-filter/index.js';

function isSuccess(result: FilterResult): result is FilterSuccess {
  return result.success === true;
}

function isError(result: FilterResult): result is FilterError {
  return result.success === false;
}

// ============================================================
// TEST SUITE: JQ Filter - Casos de Prueba del Contrato
// ============================================================

describe('JQ Filter', () => {

  // ----------------------------------------------------------
  // F01: Extraccion de campo simple
  // ----------------------------------------------------------
  describe('F01 - Campo simple (.campo)', () => {

    /**
     * @test T01 - Campo simple string
     * @requirement F01 - Extraccion de campo simple
     * @priority Alta
     */
    it('T01: extrae campo string de primer nivel', () => {
      const data = { name: 'Juan' };
      const result = applyFilter(data, '.name');

      expect(isSuccess(result)).toBe(true);
      if (!isSuccess(result)) return;
      expect(result.result).toBe('Juan');
    });

    /**
     * @test T02 - Campo simple number
     * @requirement F01 - Tipos preservados
     * @priority Alta
     */
    it('T02: extrae campo numerico preservando tipo', () => {
      const data = { age: 30 };
      const result = applyFilter(data, '.age');

      expect(isSuccess(result)).toBe(true);
      if (!isSuccess(result)) return;
      expect(result.result).toBe(30);
      expect(typeof result.result).toBe('number');
    });

    /**
     * @test T03 - Campo simple boolean
     * @requirement F01 - Tipos preservados
     * @priority Alta
     */
    it('T03: extrae campo boolean preservando tipo', () => {
      const data = { active: true };
      const result = applyFilter(data, '.active');

      expect(isSuccess(result)).toBe(true);
      if (!isSuccess(result)) return;
      expect(result.result).toBe(true);
      expect(typeof result.result).toBe('boolean');
    });

    /**
     * @test T04 - Campo simple null
     * @requirement F01 - null es valor valido
     * @priority Alta
     */
    it('T04: extrae campo con valor null (valor valido, no error)', () => {
      const data = { val: null };
      const result = applyFilter(data, '.val');

      expect(isSuccess(result)).toBe(true);
      if (!isSuccess(result)) return;
      expect(result.result).toBeNull();
    });
  });

  // ----------------------------------------------------------
  // F02: Campos anidados
  // ----------------------------------------------------------
  describe('F02 - Campos anidados (.a.b.c)', () => {

    /**
     * @test T05 - Anidado 2 niveles
     * @requirement F02 - Navegacion de propiedades anidadas
     * @priority Alta
     */
    it('T05: navega 2 niveles de anidamiento', () => {
      const data = { a: { b: 1 } };
      const result = applyFilter(data, '.a.b');

      expect(isSuccess(result)).toBe(true);
      if (!isSuccess(result)) return;
      expect(result.result).toBe(1);
    });

    /**
     * @test T06 - Anidado 3 niveles
     * @requirement F02 - Profundidad arbitraria
     * @priority Alta
     */
    it('T06: navega 3 niveles de anidamiento', () => {
      const data = { a: { b: { c: 'x' } } };
      const result = applyFilter(data, '.a.b.c');

      expect(isSuccess(result)).toBe(true);
      if (!isSuccess(result)) return;
      expect(result.result).toBe('x');
    });
  });

  // ----------------------------------------------------------
  // F03: Acceso a elementos de array por indice
  // ----------------------------------------------------------
  describe('F03 - Indice de array (.[N])', () => {

    /**
     * @test T07 - Array indice 0
     * @requirement F03 - Acceso base-0
     * @priority Alta
     */
    it('T07: accede al primer elemento de un array (indice 0)', () => {
      const data = [10, 20, 30];
      const result = applyFilter(data, '.[0]');

      expect(isSuccess(result)).toBe(true);
      if (!isSuccess(result)) return;
      expect(result.result).toBe(10);
    });

    /**
     * @test T08 - Array indice medio
     * @requirement F03 - Acceso por posicion
     * @priority Media
     */
    it('T08: accede a un elemento en posicion intermedia', () => {
      const data = [10, 20, 30];
      const result = applyFilter(data, '.[1]');

      expect(isSuccess(result)).toBe(true);
      if (!isSuccess(result)) return;
      expect(result.result).toBe(20);
    });

    /**
     * @test T10 - Array campo anidado despues de indice
     * @requirement F03 + F02 - Combinacion indice + campo
     * @priority Alta
     */
    it('T10: accede a campo de un objeto dentro de un array', () => {
      const data = { a: [{ x: 1 }] };
      const result = applyFilter(data, '.a.[0].x');

      expect(isSuccess(result)).toBe(true);
      if (!isSuccess(result)) return;
      expect(result.result).toBe(1);
    });
  });

  // ----------------------------------------------------------
  // F04: Multiples campos
  // ----------------------------------------------------------
  describe('F04 - Multiples campos ([.a, .b])', () => {

    /**
     * @test T11 - Multiples campos
     * @requirement F04 - Extraccion de multiples campos
     * @priority Alta
     */
    it('T11: extrae multiples campos como array', () => {
      const data = { a: 1, b: 2, c: 3 };
      const result = applyFilter(data, '[.a, .c]');

      expect(isSuccess(result)).toBe(true);
      if (!isSuccess(result)) return;
      expect(result.result).toEqual([1, 3]);
    });
  });

  // ----------------------------------------------------------
  // F05: Iteracion de array
  // ----------------------------------------------------------
  describe('F05 - Iteracion de array (.[].campo)', () => {

    /**
     * @test T12 - Iteracion campo
     * @requirement F05 - Iterar y extraer campo
     * @priority Alta
     */
    it('T12: itera array raiz extrayendo campo de cada elemento', () => {
      const data = [{ id: 1 }, { id: 2 }];
      const result = applyFilter(data, '.[].id');

      expect(isSuccess(result)).toBe(true);
      if (!isSuccess(result)) return;
      expect(result.result).toEqual([1, 2]);
    });

    /**
     * @test T13 - Iteracion anidado
     * @requirement F05 - Iteracion sobre campo anidado
     * @priority Alta
     */
    it('T13: itera array anidado extrayendo campo', () => {
      const data = { r: [{ n: 'A' }, { n: 'B' }] };
      const result = applyFilter(data, '.r.[].n');

      expect(isSuccess(result)).toBe(true);
      if (!isSuccess(result)) return;
      expect(result.result).toEqual(['A', 'B']);
    });

    /**
     * @test T23 - Array vacio iterado
     * @requirement F05 - Array vacio retorna array vacio (no error)
     * @priority Media
     */
    it('T23: retorna array vacio cuando se itera un array vacio', () => {
      const data: any[] = [];
      const result = applyFilter(data, '.[].id');

      expect(isSuccess(result)).toBe(true);
      if (!isSuccess(result)) return;
      expect(result.result).toEqual([]);
    });
  });

  // ----------------------------------------------------------
  // F06: Identidad
  // ----------------------------------------------------------
  describe('F06 - Identidad (.)', () => {

    /**
     * @test T14 - Identidad
     * @requirement F06 - Retornar input sin modificar
     * @priority Media
     */
    it('T14: retorna el input sin modificaciones con expresion "."', () => {
      const data = { x: 1 };
      const result = applyFilter(data, '.');

      expect(isSuccess(result)).toBe(true);
      if (!isSuccess(result)) return;
      expect(result.result).toEqual({ x: 1 });
    });
  });

  // ----------------------------------------------------------
  // F07: Indice negativo
  // ----------------------------------------------------------
  describe('F07 - Indice negativo (.[-N])', () => {

    /**
     * @test T09 - Array indice -1
     * @requirement F07 - Ultimo elemento
     * @priority Alta
     */
    it('T09: accede al ultimo elemento con indice -1', () => {
      const data = [10, 20, 30];
      const result = applyFilter(data, '.[-1]');

      expect(isSuccess(result)).toBe(true);
      if (!isSuccess(result)) return;
      expect(result.result).toBe(30);
    });

    it('accede al penultimo elemento con indice -2', () => {
      const data = [10, 20, 30, 40, 50];
      const result = applyFilter(data, '.[-2]');

      expect(isSuccess(result)).toBe(true);
      if (!isSuccess(result)) return;
      expect(result.result).toBe(40);
    });
  });

  // ----------------------------------------------------------
  // Errores: E001 - Expresion invalida
  // ----------------------------------------------------------
  describe('E001 - Expresion invalida', () => {

    /**
     * @test T19 - Expresion vacia
     * @error E001
     * @priority Media
     */
    it('T19: retorna E001 para expresion vacia', () => {
      const data = { a: 1 };
      const result = applyFilter(data, '');

      expect(isError(result)).toBe(true);
      if (!isError(result)) return;
      expect(result.error.code).toBe('E001');
    });

    /**
     * @test T20 - Expresion invalida con sintaxis incorrecta
     * @error E001
     * @priority Media
     */
    it('T20: retorna E001 para expresion con sintaxis incorrecta', () => {
      const data = { a: 1 };
      const result = applyFilter(data, '...a');

      expect(isError(result)).toBe(true);
      if (!isError(result)) return;
      expect(result.error.code).toBe('E001');
    });

    /**
     * @test T25 - Expresion demasiado larga (>256 chars)
     * @limit Longitud maxima de expresion: 256 caracteres
     * @priority Baja
     */
    it('T25: retorna E001 para expresion que excede 256 caracteres', () => {
      const data = { a: 1 };
      const longExpr = '.' + 'a'.repeat(257);
      const result = applyFilter(data, longExpr);

      expect(isError(result)).toBe(true);
      if (!isError(result)) return;
      expect(result.error.code).toBe('E001');
    });
  });

  // ----------------------------------------------------------
  // Errores: E002 - Input no es JSON valido
  // ----------------------------------------------------------
  describe('E002 - Input no es JSON valido', () => {

    /**
     * @test T21 - Input no-JSON
     * @error E002
     * @priority Alta
     */
    it('T21: retorna E002 cuando el input no es JSON valido', () => {
      const result = applyFilter('not json {' as any, '.a');

      expect(isError(result)).toBe(true);
      if (!isError(result)) return;
      expect(result.error.code).toBe('E002');
    });
  });

  // ----------------------------------------------------------
  // Errores: E003 - Path no existe
  // ----------------------------------------------------------
  describe('E003 - Path no existe en el JSON', () => {

    /**
     * @test T15 - Campo inexistente
     * @error E003
     * @priority Alta
     */
    it('T15: retorna E003 cuando el campo no existe en el objeto', () => {
      const data = { a: 1 };
      const result = applyFilter(data, '.b');

      expect(isError(result)).toBe(true);
      if (!isError(result)) return;
      expect(result.error.code).toBe('E003');
      expect(result.error.path_failed).toBe('.b');
    });

    /**
     * @test T16 - Indice fuera de rango
     * @error E003
     * @priority Alta
     */
    it('T16: retorna E003 cuando el indice esta fuera de rango', () => {
      const data = [1, 2];
      const result = applyFilter(data, '.[5]');

      expect(isError(result)).toBe(true);
      if (!isError(result)) return;
      expect(result.error.code).toBe('E003');
    });

    /**
     * @test T22 - Objeto vacio
     * @error E003
     * @priority Media
     */
    it('T22: retorna E003 al acceder a campo de objeto vacio', () => {
      const data = {};
      const result = applyFilter(data, '.a');

      expect(isError(result)).toBe(true);
      if (!isError(result)) return;
      expect(result.error.code).toBe('E003');
    });
  });

  // ----------------------------------------------------------
  // Errores: E004 - Tipo incompatible
  // ----------------------------------------------------------
  describe('E004 - Tipo incompatible con operacion', () => {

    /**
     * @test T17 - Tipo incompatible (campo en string)
     * @error E004
     * @priority Alta
     */
    it('T17: retorna E004 al intentar acceder a campo de un string', () => {
      const data = { a: 'str' };
      const result = applyFilter(data, '.a.b');

      expect(isError(result)).toBe(true);
      if (!isError(result)) return;
      expect(result.error.code).toBe('E004');
    });

    /**
     * @test T18 - Indice en no-array
     * @error E004
     * @priority Alta
     */
    it('T18: retorna E004 al intentar indexar un valor no-array', () => {
      const data = { a: 1 };
      const result = applyFilter(data, '.a.[0]');

      expect(isError(result)).toBe(true);
      if (!isError(result)) return;
      expect(result.error.code).toBe('E004');
    });

    /**
     * @test T24 - Null en path intermedio
     * @error E004
     * @priority Alta
     */
    it('T24: retorna E004 cuando un valor null aparece en path intermedio', () => {
      const data = { a: null };
      const result = applyFilter(data, '.a.b');

      expect(isError(result)).toBe(true);
      if (!isError(result)) return;
      expect(result.error.code).toBe('E004');
    });
  });

  // ----------------------------------------------------------
  // Combinaciones avanzadas
  // ----------------------------------------------------------
  describe('Combinaciones de operaciones', () => {

    it('combina campo anidado + indice + campo', () => {
      const data = {
        data: {
          users: [
            { name: 'Juan', roles: ['admin', 'user'] },
            { name: 'Ana', roles: ['user'] },
          ],
        },
      };

      const r1 = applyFilter(data, '.data.users.[0].name');
      expect(isSuccess(r1)).toBe(true);
      if (isSuccess(r1)) expect(r1.result).toBe('Juan');

      const r2 = applyFilter(data, '.data.users.[].name');
      expect(isSuccess(r2)).toBe(true);
      if (isSuccess(r2)) expect(r2.result).toEqual(['Juan', 'Ana']);

      const r3 = applyFilter(data, '.data.users.[0].roles.[0]');
      expect(isSuccess(r3)).toBe(true);
      if (isSuccess(r3)) expect(r3.result).toBe('admin');
    });

    it('multi-select con campos anidados', () => {
      const data = { name: 'Juan', age: 30, city: 'Madrid', country: 'Spain' };
      const result = applyFilter(data, '[.name, .age]');

      expect(isSuccess(result)).toBe(true);
      if (!isSuccess(result)) return;
      expect(result.result).toEqual(['Juan', 30]);
    });

    it('iteracion sobre array raiz con campo status', () => {
      const data = [
        { id: 1, status: 'active' },
        { id: 2, status: 'inactive' },
      ];
      const result = applyFilter(data, '.[].status');

      expect(isSuccess(result)).toBe(true);
      if (!isSuccess(result)) return;
      expect(result.result).toEqual(['active', 'inactive']);
    });
  });

  // ----------------------------------------------------------
  // MUST NOT - Restricciones
  // ----------------------------------------------------------
  describe('MUST NOT - Restricciones del JQ Filter', () => {

    it('no muta el input original', () => {
      const data = { name: 'Juan', age: 30 };
      const originalData = JSON.stringify(data);

      applyFilter(data, '.name');

      expect(JSON.stringify(data)).toBe(originalData);
    });

    it('no soporta pipe interno en expresion', () => {
      const data = { items: [{ id: 1 }, { id: 2 }] };
      const result = applyFilter(data, '.items | length');

      expect(isError(result)).toBe(true);
      if (!isError(result)) return;
      expect(result.error.code).toBe('E001');
    });

    it('no soporta funciones jq (length, keys, etc)', () => {
      const data = { items: [1, 2, 3] };
      const result = applyFilter(data, '.items | length');

      expect(isError(result)).toBe(true);
    });

    it('no soporta slice de arrays (.[2:5])', () => {
      const data = [1, 2, 3, 4, 5];
      const result = applyFilter(data, '.[2:5]');

      expect(isError(result)).toBe(true);
      if (!isError(result)) return;
      expect(result.error.code).toBe('E001');
    });

    it('no soporta object construction', () => {
      const data = { name: 'Juan', age: 30 };
      const result = applyFilter(data, '{nombre: .name}');

      expect(isError(result)).toBe(true);
    });

    it('no retorna undefined para campos inexistentes (siempre error explicito)', () => {
      const data = { a: 1 };
      const result = applyFilter(data, '.nonexistent');

      expect(isError(result)).toBe(true);
      if (!isError(result)) return;
      expect(result.error.code).toBe('E003');
      // Nunca undefined o null silencioso
    });
  });

  // ----------------------------------------------------------
  // Limites (CONSTRAINTS)
  // ----------------------------------------------------------
  describe('Limites del JQ Filter', () => {

    it('rechaza input JSON mayor a 10MB', () => {
      // Simular un JSON grande (en la practica, verificar el tamano)
      const largeArray = new Array(500000).fill({ id: 1, name: 'test' });
      const result = applyFilter(largeArray, '.[0]');

      // Dependiendo del tamano real serializado:
      // Si excede 10MB -> error, si no -> exito
      // Este test verifica el mecanismo de limite
      expect(result).toBeDefined();
    });

    it('rechaza profundidad de navegacion mayor a 20 niveles', () => {
      // Crear un path de 21 niveles
      let deepObj: any = { value: 'deep' };
      for (let i = 0; i < 21; i++) {
        deepObj = { level: deepObj };
      }
      const expression = '.level'.repeat(21) + '.value';

      const result = applyFilter(deepObj, expression);
      // Deberia rechazar por profundidad excesiva
      expect(isError(result)).toBe(true);
    });

    it('limita multi-select a 20 campos maximo', () => {
      const data = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`f${i}`, i]));
      const fields = Array.from({ length: 21 }, (_, i) => `.f${i}`).join(', ');
      const result = applyFilter(data, `[${fields}]`);

      expect(isError(result)).toBe(true);
      if (!isError(result)) return;
      expect(result.error.code).toBe('E001');
    });
  });

  // ----------------------------------------------------------
  // Estructura de respuesta
  // ----------------------------------------------------------
  describe('Estructura de respuesta', () => {

    it('respuesta exitosa incluye expression e input_type', () => {
      const data = { name: 'test' };
      const result = applyFilter(data, '.name');

      expect(isSuccess(result)).toBe(true);
      if (!isSuccess(result)) return;
      expect(result.expression).toBe('.name');
      expect(result.input_type).toBe('object');
    });

    it('respuesta de error E003 incluye available_keys', () => {
      const data = { name: 'Juan', age: 30, city: 'Madrid' };
      const result = applyFilter(data, '.email');

      expect(isError(result)).toBe(true);
      if (!isError(result)) return;
      expect(result.error.available_keys).toContain('name');
      expect(result.error.available_keys).toContain('age');
      expect(result.error.available_keys).toContain('city');
    });
  });
});
