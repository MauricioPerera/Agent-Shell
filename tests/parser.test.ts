/**
 * @contract CONTRACT_PARSER v1.0
 * @module Parser (Agent Shell)
 * @description Tests para el modulo Parser basados en los 30 casos de prueba del contrato.
 *
 * El Parser transforma un string de comando en un AST (ParseResult/ParsedCommand)
 * que el Router y Executor pueden consumir.
 */

import { describe, it, expect } from 'vitest';
import { parse } from '../src/parser/index.js';
import type { ParseResult, ParseError } from '../src/parser/index.js';

function isParseError(result: ParseResult | ParseError): result is ParseError {
  return 'errorType' in result;
}

function isParseResult(result: ParseResult | ParseError): result is ParseResult {
  return 'commands' in result;
}

// ============================================================
// TEST SUITE: Parser - Casos de Prueba del Contrato
// ============================================================

describe('Parser', () => {

  // ----------------------------------------------------------
  // Seccion 1: Parsing de comandos simples con namespace
  // ----------------------------------------------------------
  describe('Comandos simples con namespace', () => {

    /**
     * @test T01 - Comando simple
     * @requirement F01 - Parsing de comando simple
     * @priority Alta
     */
    it('T01: parsea comando simple namespace:command', () => {
      const result = parse('users:list');

      expect(isParseResult(result)).toBe(true);
      if (!isParseResult(result)) return;

      expect(result.type).toBe('single');
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].namespace).toBe('users');
      expect(result.commands[0].command).toBe('list');
      expect(result.commands[0].args.positional).toEqual([]);
      expect(result.commands[0].args.named).toEqual({});
    });

    /**
     * @test T02 - Comando con arg nombrado
     * @requirement F01 - Parsing de comando simple + argumentos nombrados
     * @priority Alta
     */
    it('T02: parsea comando con argumento nombrado', () => {
      const result = parse('users:get --id 42');

      expect(isParseResult(result)).toBe(true);
      if (!isParseResult(result)) return;

      expect(result.commands[0].namespace).toBe('users');
      expect(result.commands[0].command).toBe('get');
      expect(result.commands[0].args.named).toEqual({ id: '42' });
    });

    /**
     * @test T03 - Comando con flag boolean
     * @requirement F01 - Flags boolean sin valor
     * @priority Alta
     */
    it('T03: parsea comando con flag boolean (sin valor)', () => {
      const result = parse('users:get --id 42 --verbose');

      expect(isParseResult(result)).toBe(true);
      if (!isParseResult(result)) return;

      expect(result.commands[0].args.named).toEqual({ id: '42', verbose: true });
    });
  });

  // ----------------------------------------------------------
  // Seccion 2: Parsing de comandos builtin
  // ----------------------------------------------------------
  describe('Comandos builtin', () => {

    /**
     * @test T04 - Builtin search
     * @requirement F01 - Builtins con namespace null
     * @priority Alta
     */
    it('T04: parsea builtin search con argumento posicional unificado', () => {
      const result = parse('search crear usuario');

      expect(isParseResult(result)).toBe(true);
      if (!isParseResult(result)) return;

      expect(result.commands[0].namespace).toBeNull();
      expect(result.commands[0].command).toBe('search');
      expect(result.commands[0].args.positional).toEqual(['crear usuario']);
    });

    /**
     * @test T26 - Describe builtin
     * @requirement F01 - Builtin describe
     * @priority Alta
     */
    it('T26: parsea builtin describe con argumento posicional', () => {
      const result = parse('describe users:create');

      expect(isParseResult(result)).toBe(true);
      if (!isParseResult(result)) return;

      expect(result.commands[0].namespace).toBeNull();
      expect(result.commands[0].command).toBe('describe');
      expect(result.commands[0].args.positional).toEqual(['users:create']);
    });

    /**
     * @test T27 - Context set (namespace:command, no builtin)
     * @requirement F01 - Context como namespace
     * @priority Media
     */
    it('T27: parsea context:set con argumentos posicionales', () => {
      const result = parse('context:set api_key sk-123');

      expect(isParseResult(result)).toBe(true);
      if (!isParseResult(result)) return;

      expect(result.commands[0].namespace).toBe('context');
      expect(result.commands[0].command).toBe('set');
      expect(result.commands[0].args.positional).toEqual(['api_key', 'sk-123']);
    });
  });

  // ----------------------------------------------------------
  // Seccion 3: Flags globales
  // ----------------------------------------------------------
  describe('Flags globales', () => {

    /**
     * @test T05 - Flag --dry-run
     * @requirement F02 - Deteccion de flags globales
     * @priority Alta
     */
    it('T05: extrae --dry-run como flag global, no como arg nombrado', () => {
      const result = parse('users:delete --id 5 --dry-run');

      expect(isParseResult(result)).toBe(true);
      if (!isParseResult(result)) return;

      expect(result.commands[0].flags.dryRun).toBe(true);
      expect(result.commands[0].args.named).toEqual({ id: '5' });
      expect(result.commands[0].args.named).not.toHaveProperty('dry-run');
    });

    /**
     * @test T06 - Flag --format
     * @requirement F02 - Flag format con valor
     * @priority Alta
     */
    it('T06: extrae --format csv como flag global', () => {
      const result = parse('users:list --format csv');

      expect(isParseResult(result)).toBe(true);
      if (!isParseResult(result)) return;

      expect(result.commands[0].flags.format).toBe('csv');
      expect(result.commands[0].args.named).not.toHaveProperty('format');
    });

    /**
     * @test T07 - Flag --limit --offset
     * @requirement F02 - Flags limit y offset numericos
     * @priority Alta
     */
    it('T07: extrae --limit y --offset como numeros', () => {
      const result = parse('users:list --limit 10 --offset 20');

      expect(isParseResult(result)).toBe(true);
      if (!isParseResult(result)) return;

      expect(result.commands[0].flags.limit).toBe(10);
      expect(result.commands[0].flags.offset).toBe(20);
      expect(result.commands[0].args.named).not.toHaveProperty('limit');
      expect(result.commands[0].args.named).not.toHaveProperty('offset');
    });

    /**
     * @test T17 - Multiples flags globales combinadas
     * @requirement F02 - Combinacion de flags
     * @priority Media
     */
    it('T17: extrae multiples flags globales combinadas', () => {
      const result = parse('x:y --dry-run --confirm --format json');

      expect(isParseResult(result)).toBe(true);
      if (!isParseResult(result)) return;

      expect(result.commands[0].flags.dryRun).toBe(true);
      expect(result.commands[0].flags.confirm).toBe(true);
      expect(result.commands[0].flags.format).toBe('json');
    });
  });

  // ----------------------------------------------------------
  // Seccion 4: Filtros jq
  // ----------------------------------------------------------
  describe('Filtros jq', () => {

    /**
     * @test T08 - Filtro jq simple
     * @requirement F03 - Deteccion de pipe jq
     * @priority Alta
     */
    it('T08: extrae filtro jq de campo simple', () => {
      const result = parse('users:get --id 1 | .name');

      expect(isParseResult(result)).toBe(true);
      if (!isParseResult(result)) return;

      expect(result.commands[0].jqFilter).not.toBeNull();
      expect(result.commands[0].jqFilter!.type).toBe('field');
      expect(result.commands[0].jqFilter!.fields).toEqual(['name']);
    });

    /**
     * @test T09 - Filtro jq anidado
     * @requirement F03 - Campo anidado con punto
     * @priority Media
     */
    it('T09: extrae filtro jq de campo anidado', () => {
      const result = parse('users:get --id 1 | .address.city');

      expect(isParseResult(result)).toBe(true);
      if (!isParseResult(result)) return;

      expect(result.commands[0].jqFilter).not.toBeNull();
      expect(result.commands[0].jqFilter!.type).toBe('field');
      expect(result.commands[0].jqFilter!.fields).toEqual(['address.city']);
    });

    /**
     * @test T10 - Filtro jq multi-campo
     * @requirement F03 - Multi-field jq
     * @priority Alta
     */
    it('T10: extrae filtro jq multi-campo', () => {
      const result = parse('users:get --id 1 | [.name, .email]');

      expect(isParseResult(result)).toBe(true);
      if (!isParseResult(result)) return;

      expect(result.commands[0].jqFilter).not.toBeNull();
      expect(result.commands[0].jqFilter!.type).toBe('multi_field');
      expect(result.commands[0].jqFilter!.fields).toEqual(['name', 'email']);
    });

    /**
     * @test T29 - Filtro jq sin espacio despues del pipe
     * @requirement F03 - Tolerancia a espacio
     * @priority Media
     */
    it('T29: parsea filtro jq sin espacio despues del pipe', () => {
      const result = parse('x:y --id 1 |.name');

      expect(isParseResult(result)).toBe(true);
      if (!isParseResult(result)) return;

      expect(result.commands[0].jqFilter).not.toBeNull();
      expect(result.commands[0].jqFilter!.fields).toEqual(['name']);
    });
  });

  // ----------------------------------------------------------
  // Seccion 5: Composicion (Pipeline >>)
  // ----------------------------------------------------------
  describe('Composicion (Pipeline)', () => {

    /**
     * @test T11 - Pipeline simple (2 comandos)
     * @requirement F04 - Deteccion de pipeline
     * @priority Alta
     */
    it('T11: parsea pipeline de 2 comandos', () => {
      const result = parse('users:get --id 1 >> orders:list');

      expect(isParseResult(result)).toBe(true);
      if (!isParseResult(result)) return;

      expect(result.type).toBe('pipeline');
      expect(result.commands).toHaveLength(2);
      expect(result.commands[0].namespace).toBe('users');
      expect(result.commands[0].command).toBe('get');
      expect(result.commands[0].args.named).toEqual({ id: '1' });
      expect(result.commands[1].namespace).toBe('orders');
      expect(result.commands[1].command).toBe('list');
    });

    /**
     * @test T12 - Pipeline triple (3 comandos)
     * @requirement F04 - Pipeline de N comandos
     * @priority Media
     */
    it('T12: parsea pipeline de 3 comandos', () => {
      const result = parse('a:b >> c:d >> e:f');

      expect(isParseResult(result)).toBe(true);
      if (!isParseResult(result)) return;

      expect(result.type).toBe('pipeline');
      expect(result.commands).toHaveLength(3);
      expect(result.commands[0].namespace).toBe('a');
      expect(result.commands[0].command).toBe('b');
      expect(result.commands[1].namespace).toBe('c');
      expect(result.commands[1].command).toBe('d');
      expect(result.commands[2].namespace).toBe('e');
      expect(result.commands[2].command).toBe('f');
    });

    /**
     * @test T25 - Pipeline con jq en ultimo comando
     * @requirement F04 + F03 - Pipeline + filtro jq
     * @priority Media
     */
    it('T25: parsea pipeline donde el ultimo comando tiene filtro jq', () => {
      const result = parse('a:b >> c:d | .result');

      expect(isParseResult(result)).toBe(true);
      if (!isParseResult(result)) return;

      expect(result.type).toBe('pipeline');
      expect(result.commands).toHaveLength(2);
      expect(result.commands[1].jqFilter).not.toBeNull();
      expect(result.commands[1].jqFilter!.fields).toEqual(['result']);
    });
  });

  // ----------------------------------------------------------
  // Seccion 6: Batch
  // ----------------------------------------------------------
  describe('Batch', () => {

    /**
     * @test T13 - Batch simple (2 comandos)
     * @requirement F05 - Deteccion de batch
     * @priority Alta
     */
    it('T13: parsea batch de 2 comandos', () => {
      const result = parse('batch [users:count, orders:count]');

      expect(isParseResult(result)).toBe(true);
      if (!isParseResult(result)) return;

      expect(result.type).toBe('batch');
      expect(result.commands).toHaveLength(2);
      expect(result.commands[0].namespace).toBe('users');
      expect(result.commands[0].command).toBe('count');
      expect(result.commands[1].namespace).toBe('orders');
      expect(result.commands[1].command).toBe('count');
    });

    /**
     * @test T14 - Batch con argumentos
     * @requirement F05 - Batch con args por comando
     * @priority Alta
     */
    it('T14: parsea batch donde cada comando tiene argumentos', () => {
      const result = parse('batch [users:get --id 1, users:get --id 2]');

      expect(isParseResult(result)).toBe(true);
      if (!isParseResult(result)) return;

      expect(result.type).toBe('batch');
      expect(result.commands).toHaveLength(2);
      expect(result.commands[0].args.named).toEqual({ id: '1' });
      expect(result.commands[1].args.named).toEqual({ id: '2' });
    });
  });

  // ----------------------------------------------------------
  // Seccion 7: Strings con comillas
  // ----------------------------------------------------------
  describe('Valores con comillas', () => {

    /**
     * @test T15 - Comillas dobles
     * @requirement F08 - Valores con espacios
     * @priority Alta
     */
    it('T15: parsea valor con comillas dobles preservando espacios', () => {
      const result = parse('users:create --name "John Doe"');

      expect(isParseResult(result)).toBe(true);
      if (!isParseResult(result)) return;

      expect(result.commands[0].args.named).toEqual({ name: 'John Doe' });
    });

    /**
     * @test T16 - Comillas simples
     * @requirement F08 - Valores con espacios
     * @priority Alta
     */
    it('T16: parsea valor con comillas simples preservando espacios', () => {
      const result = parse("users:create --name 'Jane Doe'");

      expect(isParseResult(result)).toBe(true);
      if (!isParseResult(result)) return;

      expect(result.commands[0].args.named).toEqual({ name: 'Jane Doe' });
    });

    /**
     * @test T28 - Argumento con guion en el nombre
     * @requirement F01 - Named args con guion
     * @priority Media
     */
    it('T28: parsea argumento cuyo nombre contiene guion', () => {
      const result = parse('x:y --user-id 5');

      expect(isParseResult(result)).toBe(true);
      if (!isParseResult(result)) return;

      expect(result.commands[0].args.named).toEqual({ 'user-id': '5' });
    });
  });

  // ----------------------------------------------------------
  // Seccion 8: Errores de sintaxis
  // ----------------------------------------------------------
  describe('Errores de sintaxis', () => {

    /**
     * @test T18 - Input vacio
     * @error E_EMPTY_INPUT
     * @priority Alta
     */
    it('T18: retorna ParseError con code=1 para input vacio', () => {
      const result = parse('');

      expect(isParseError(result)).toBe(true);
      if (!isParseError(result)) return;

      expect(result.code).toBe(1);
      expect(result.errorType).toBe('E_EMPTY_INPUT');
    });

    /**
     * @test T19 - Solo espacios
     * @error E_EMPTY_INPUT
     * @priority Alta
     */
    it('T19: retorna ParseError con code=1 para input de solo espacios', () => {
      const result = parse('   ');

      expect(isParseError(result)).toBe(true);
      if (!isParseError(result)) return;

      expect(result.code).toBe(1);
      expect(result.errorType).toBe('E_EMPTY_INPUT');
    });

    /**
     * @test T20 - Namespace invalido (empieza con ":")
     * @error E_INVALID_NAMESPACE
     * @priority Alta
     */
    it('T20: retorna ParseError para namespace invalido (comienza con ":")', () => {
      const result = parse(':comando');

      expect(isParseError(result)).toBe(true);
      if (!isParseError(result)) return;

      expect(result.code).toBe(1);
      expect(result.errorType).toBe('E_INVALID_NAMESPACE');
    });

    /**
     * @test T21 - Comando invalido (namespace sin comando)
     * @error E_MISSING_COMMAND
     * @priority Alta
     */
    it('T21: retorna ParseError cuando namespace no tiene comando despues de ":"', () => {
      const result = parse('namespace:');

      expect(isParseError(result)).toBe(true);
      if (!isParseError(result)) return;

      expect(result.code).toBe(1);
      expect(result.errorType).toBe('E_MISSING_COMMAND');
    });

    /**
     * @test T22 - Formato invalido para --format
     * @error E_INVALID_FORMAT
     * @priority Media
     */
    it('T22: retorna ParseError para --format con valor no soportado', () => {
      const result = parse('x:y --format xml');

      expect(isParseError(result)).toBe(true);
      if (!isParseError(result)) return;

      expect(result.code).toBe(1);
      expect(result.errorType).toBe('E_INVALID_FORMAT');
    });

    /**
     * @test T23 - --limit no numerico
     * @error E_INVALID_FLAG_VALUE
     * @priority Media
     */
    it('T23: retorna ParseError cuando --limit tiene valor no numerico', () => {
      const result = parse('x:y --limit abc');

      expect(isParseError(result)).toBe(true);
      if (!isParseError(result)) return;

      expect(result.code).toBe(1);
      expect(result.errorType).toBe('E_INVALID_FLAG_VALUE');
    });

    /**
     * @test T24 - Batch sin cerrar corchete
     * @error E_UNCLOSED_BATCH
     * @priority Media
     */
    it('T24: retorna ParseError cuando batch no cierra corchete', () => {
      const result = parse('batch [a:b, c:d');

      expect(isParseError(result)).toBe(true);
      if (!isParseError(result)) return;

      expect(result.code).toBe(1);
      expect(result.errorType).toBe('E_UNCLOSED_BATCH');
    });

    /**
     * @test T30 - Comilla sin cerrar
     * @error E_UNCLOSED_QUOTE
     * @priority Alta
     */
    it('T30: retorna ParseError para comilla sin cerrar', () => {
      const result = parse('x:y --name "John');

      expect(isParseError(result)).toBe(true);
      if (!isParseError(result)) return;

      expect(result.code).toBe(1);
      expect(result.errorType).toBe('E_UNCLOSED_QUOTE');
    });
  });

  // ----------------------------------------------------------
  // Seccion 9: Comportamiento del campo raw y meta
  // ----------------------------------------------------------
  describe('Metadata de parsing', () => {

    it('preserva el input original en el campo raw del ParseResult', () => {
      const input = 'users:list --limit 5';
      const result = parse(input);

      expect(isParseResult(result)).toBe(true);
      if (!isParseResult(result)) return;

      expect(result.raw).toBe(input);
    });

    it('incluye rawSegment en meta de cada comando en pipeline', () => {
      const result = parse('users:get --id 1 >> orders:list');

      expect(isParseResult(result)).toBe(true);
      if (!isParseResult(result)) return;

      expect(result.commands[0].meta.rawSegment).toContain('users:get');
      expect(result.commands[1].meta.rawSegment).toContain('orders:list');
    });
  });

  // ----------------------------------------------------------
  // Seccion 10: Flags globales por defecto
  // ----------------------------------------------------------
  describe('Flags globales por defecto', () => {

    it('todas las flags son false/null cuando no se especifican', () => {
      const result = parse('users:list');

      expect(isParseResult(result)).toBe(true);
      if (!isParseResult(result)) return;

      const flags = result.commands[0].flags;
      expect(flags.dryRun).toBe(false);
      expect(flags.validate).toBe(false);
      expect(flags.confirm).toBe(false);
      expect(flags.format).toBeNull();
      expect(flags.limit).toBeNull();
      expect(flags.offset).toBeNull();
    });
  });

  // ----------------------------------------------------------
  // Seccion 11: MUST NOT - Validaciones negativas
  // ----------------------------------------------------------
  describe('MUST NOT - Restricciones del parser', () => {

    it('no modifica el input original (trabaja sobre copias)', () => {
      const input = 'users:list --limit 5';
      const originalInput = input;
      parse(input);
      expect(input).toBe(originalInput);
    });

    it('no valida que el namespace exista en el registry', () => {
      // Un namespace inventado debe parsear sin error
      const result = parse('inventado:comando --arg valor');
      expect(isParseResult(result)).toBe(true);
    });

    it('no resuelve referencias $input.x en pipelines', () => {
      const result = parse('users:get --id 1 >> orders:list --user-id $input.id');

      expect(isParseResult(result)).toBe(true);
      if (!isParseResult(result)) return;

      // El $input.id se pasa literal, no se resuelve
      expect(result.commands[1].args.named['user-id']).toBe('$input.id');
    });
  });

  // ----------------------------------------------------------
  // Seccion 12: Limites (CONSTRAINTS)
  // ----------------------------------------------------------
  describe('Limites del parser', () => {

    it('rechaza input que excede 4096 caracteres', () => {
      const longInput = 'x:y --arg ' + 'a'.repeat(4090);
      const result = parse(longInput);

      expect(isParseError(result)).toBe(true);
    });

    it('rechaza pipeline con mas de 10 comandos', () => {
      const commands = Array.from({ length: 11 }, (_, i) => `ns${i}:cmd`).join(' >> ');
      const result = parse(commands);

      expect(isParseError(result)).toBe(true);
    });

    it('rechaza batch con mas de 20 comandos', () => {
      const commands = Array.from({ length: 21 }, (_, i) => `ns${i}:cmd`).join(', ');
      const result = parse(`batch [${commands}]`);

      expect(isParseError(result)).toBe(true);
    });
  });
});
