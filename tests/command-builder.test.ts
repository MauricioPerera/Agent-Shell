/**
 * Tests para el Command Builder SDK.
 *
 * Cubre: command(), CommandBuilder, ParamBuilder.
 * Valida el fluent API y la generacion correcta de CommandDefinitions.
 */

import { describe, it, expect } from 'vitest';
import { command, CommandBuilder, ParamBuilder } from '../src/command-builder/index.js';

describe('CommandBuilder', () => {
  it('T01: command() retorna un CommandBuilder', () => {
    const builder = command('users', 'create');
    expect(builder).toBeInstanceOf(CommandBuilder);
  });

  it('T02: build() genera un CommandDefinition valido', () => {
    const def = command('users', 'create')
      .description('Creates a user')
      .build();

    expect(def.namespace).toBe('users');
    expect(def.name).toBe('create');
    expect(def.description).toBe('Creates a user');
    expect(def.version).toBe('1.0.0');
    expect(def.params).toEqual([]);
    expect(def.tags).toEqual([]);
    expect(def.reversible).toBe(false);
    expect(def.requiresConfirmation).toBe(false);
    expect(def.deprecated).toBe(false);
  });

  it('T03: version() establece la version', () => {
    const def = command('ns', 'cmd')
      .description('test')
      .version('2.1.0')
      .build();

    expect(def.version).toBe('2.1.0');
  });

  it('T04: param() con callback agrega parametro configurado', () => {
    const def = command('users', 'create')
      .description('test')
      .param('name', 'string', p => p.required().description('User name'))
      .build();

    expect(def.params).toHaveLength(1);
    expect(def.params[0].name).toBe('name');
    expect(def.params[0].type).toBe('string');
    expect(def.params[0].required).toBe(true);
    expect(def.params[0].description).toBe('User name');
  });

  it('T05: param() sin callback agrega parametro con defaults', () => {
    const def = command('ns', 'cmd')
      .description('test')
      .param('limit', 'int')
      .build();

    expect(def.params[0].required).toBe(false);
    expect(def.params[0].default).toBeUndefined();
  });

  it('T06: requiredParam() shorthand', () => {
    const def = command('ns', 'cmd')
      .description('test')
      .requiredParam('email', 'string', 'User email')
      .build();

    expect(def.params[0].name).toBe('email');
    expect(def.params[0].required).toBe(true);
    expect(def.params[0].description).toBe('User email');
  });

  it('T07: optionalParam() shorthand con default', () => {
    const def = command('ns', 'cmd')
      .description('test')
      .optionalParam('limit', 'int', 10, 'Max results')
      .build();

    expect(def.params[0].name).toBe('limit');
    expect(def.params[0].required).toBe(false);
    expect(def.params[0].default).toBe(10);
    expect(def.params[0].description).toBe('Max results');
  });

  it('T08: multiples parametros se acumulan', () => {
    const def = command('users', 'create')
      .description('test')
      .requiredParam('name', 'string')
      .requiredParam('email', 'string')
      .optionalParam('role', 'enum(admin,user)', 'user')
      .optionalParam('age', 'int', 18)
      .build();

    expect(def.params).toHaveLength(4);
    expect(def.params.map(p => p.name)).toEqual(['name', 'email', 'role', 'age']);
  });

  it('T09: output() establece shape', () => {
    const def = command('ns', 'cmd')
      .description('test')
      .output('array', 'List of items')
      .build();

    expect(def.output.type).toBe('array');
    expect(def.output.description).toBe('List of items');
  });

  it('T10: example() establece ejemplo de uso', () => {
    const def = command('ns', 'cmd')
      .description('test')
      .example('ns:cmd --flag value | .result')
      .build();

    expect(def.example).toBe('ns:cmd --flag value | .result');
  });

  it('T11: tags() establece etiquetas', () => {
    const def = command('ns', 'cmd')
      .description('test')
      .tags('crud', 'admin', 'user-management')
      .build();

    expect(def.tags).toEqual(['crud', 'admin', 'user-management']);
  });

  it('T12: reversible() marca como reversible', () => {
    const def = command('ns', 'cmd')
      .description('test')
      .reversible()
      .build();

    expect(def.reversible).toBe(true);
  });

  it('T13: requiresConfirmation() marca para confirmacion', () => {
    const def = command('ns', 'cmd')
      .description('test')
      .requiresConfirmation()
      .build();

    expect(def.requiresConfirmation).toBe(true);
  });

  it('T14: deprecated() marca como obsoleto', () => {
    const def = command('ns', 'cmd')
      .description('test')
      .deprecated('Use ns:cmd-v2 instead')
      .build();

    expect(def.deprecated).toBe(true);
    expect(def.deprecatedMessage).toBe('Use ns:cmd-v2 instead');
  });

  it('T15: permissions() establece permisos requeridos', () => {
    const def = command('ns', 'cmd')
      .description('test')
      .permissions('ns:write', 'admin:access')
      .build();

    expect(def.requiredPermissions).toEqual(['ns:write', 'admin:access']);
  });

  it('T16: longDescription() establece descripcion extendida', () => {
    const def = command('ns', 'cmd')
      .description('Short')
      .longDescription('This is a much longer description with details')
      .build();

    expect(def.longDescription).toBe('This is a much longer description with details');
  });

  it('T17: build() lanza si falta namespace', () => {
    expect(() => {
      new CommandBuilder('', 'cmd').description('test').build();
    }).toThrow('namespace');
  });

  it('T18: build() lanza si falta name', () => {
    expect(() => {
      new CommandBuilder('ns', '').description('test').build();
    }).toThrow('name');
  });

  it('T19: build() lanza si falta description', () => {
    expect(() => {
      command('ns', 'cmd').build();
    }).toThrow('description');
  });

  it('T20: fluent chain completo produce definicion correcta', () => {
    const def = command('users', 'create')
      .version('2.0.0')
      .description('Creates a new user in the system')
      .longDescription('Extended description for help pages')
      .requiredParam('name', 'string', 'Full name')
      .requiredParam('email', 'string', 'Email address')
      .optionalParam('role', 'enum(admin,user)', 'user', 'User role')
      .param('age', 'int', p => p.constraints('min:0,max:150'))
      .output('object', 'Created user object')
      .example('users:create --name "John" --email "j@t.com" --role admin')
      .tags('users', 'crud', 'admin')
      .reversible()
      .requiresConfirmation()
      .permissions('users:write')
      .build();

    expect(def.namespace).toBe('users');
    expect(def.name).toBe('create');
    expect(def.version).toBe('2.0.0');
    expect(def.description).toBe('Creates a new user in the system');
    expect(def.longDescription).toBe('Extended description for help pages');
    expect(def.params).toHaveLength(4);
    expect(def.params[0]).toEqual({ name: 'name', type: 'string', required: true, description: 'Full name' });
    expect(def.params[3]).toEqual({ name: 'age', type: 'int', required: false, constraints: 'min:0,max:150' });
    expect(def.output).toEqual({ type: 'object', description: 'Created user object' });
    expect(def.tags).toEqual(['users', 'crud', 'admin']);
    expect(def.reversible).toBe(true);
    expect(def.requiresConfirmation).toBe(true);
    expect(def.requiredPermissions).toEqual(['users:write']);
  });

  it('T21: sin permissions, requiredPermissions es undefined', () => {
    const def = command('ns', 'cmd')
      .description('test')
      .build();

    expect(def.requiredPermissions).toBeUndefined();
  });

  it('T22: deprecated() sin mensaje solo marca deprecated=true', () => {
    const def = command('ns', 'cmd')
      .description('test')
      .deprecated()
      .build();

    expect(def.deprecated).toBe(true);
    expect(def.deprecatedMessage).toBeUndefined();
  });
});

describe('ParamBuilder', () => {
  it('T23: required() marca el param como requerido', () => {
    const p = new ParamBuilder('x', 'string');
    p.required();
    expect(p._build().required).toBe(true);
  });

  it('T24: default() establece valor por defecto', () => {
    const p = new ParamBuilder('x', 'int');
    p.default(42);
    expect(p._build().default).toBe(42);
  });

  it('T25: constraints() establece constraints', () => {
    const p = new ParamBuilder('x', 'float');
    p.constraints('min:0,max:1');
    expect(p._build().constraints).toBe('min:0,max:1');
  });

  it('T26: chaining multiple config methods', () => {
    const p = new ParamBuilder('age', 'int');
    const built = p.required().default(18).constraints('min:0').description('Age')._build();

    expect(built.name).toBe('age');
    expect(built.type).toBe('int');
    expect(built.required).toBe(true);
    expect(built.default).toBe(18);
    expect(built.constraints).toBe('min:0');
    expect(built.description).toBe('Age');
  });
});
