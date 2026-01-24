# Definiendo Comandos en Agent Shell

Guia paso a paso para definir, registrar y probar comandos en Agent Shell.

## Conceptos Clave

Un comando en Agent Shell se compone de:

| Concepto | Descripcion |
|----------|-------------|
| **Namespace** | Agrupacion logica (ej: `users`, `orders`, `system`) |
| **Name** | Nombre del comando dentro del namespace (ej: `create`, `list`) |
| **ID completo** | `namespace:name` (ej: `users:create`) |
| **Params** | Parametros tipados con validacion |
| **Handler** | Funcion async que ejecuta la logica |
| **Tags** | Etiquetas para busqueda semantica |

## Paso 1: Definir el Comando

Existen dos formas de definir un comando. Ambas producen un objeto `CommandDefinition`.

### Opcion A: Command Builder (recomendado)

API fluida con validacion en build-time:

```typescript
import { command } from 'agent-shell';

const definition = command('orders', 'create')
  .version('1.0.0')
  .description('Crea una nueva orden de compra')
  .longDescription('Registra una orden asociada a un usuario con items y monto total')
  .requiredParam('userId', 'int', 'ID del usuario comprador')
  .requiredParam('total', 'float', 'Monto total de la orden')
  .optionalParam('status', 'enum(pending,paid,shipped)', 'pending', 'Estado inicial')
  .param('notes', 'string', p => p.description('Notas adicionales'))
  .param('priority', 'int', p => p.default(0).constraints('min:0,max:10'))
  .output('object', 'La orden creada con ID asignado')
  .example('orders:create --userId 5 --total 99.90 --status paid')
  .tags('orders', 'ecommerce', 'crud')
  .reversible()
  .requiresConfirmation()
  .permissions('orders:write')
  .build();
```

#### Metodos del Builder

| Metodo | Requerido | Descripcion |
|--------|-----------|-------------|
| `version(v)` | No | Version semver (default: `'1.0.0'`) |
| `description(d)` | Si | Descripcion corta para el LLM (~200 chars max) |
| `longDescription(d)` | No | Descripcion extendida para help detallado |
| `param(name, type, configure?)` | No | Parametro con configuracion via callback |
| `requiredParam(name, type, desc?)` | No | Shorthand para parametro requerido |
| `optionalParam(name, type, default, desc?)` | No | Shorthand para parametro con default |
| `output(type, desc?)` | No | Forma del output (default: `'object'`) |
| `example(e)` | No | Ejemplo de uso real |
| `tags(...t)` | No | Tags para busqueda semantica |
| `reversible()` | No | Marca como reversible (soporta undo) |
| `requiresConfirmation()` | No | Requiere `--confirm` antes de ejecutar |
| `deprecated(msg?)` | No | Marca como deprecado con mensaje opcional |
| `permissions(...p)` | No | Permisos RBAC requeridos |

### Opcion B: Objeto Directo

Definicion inline sin builder:

```typescript
const definition = {
  namespace: 'orders',
  name: 'create',
  version: '1.0.0',
  description: 'Crea una nueva orden de compra',
  params: [
    { name: 'userId', type: 'int', required: true, description: 'ID del usuario' },
    { name: 'total', type: 'float', required: true, description: 'Monto total' },
    { name: 'status', type: 'enum(pending,paid,shipped)', required: false, default: 'pending' },
  ],
  output: { type: 'object', description: 'La orden creada' },
  tags: ['orders', 'ecommerce'],
  example: 'orders:create --userId 5 --total 99.90',
  reversible: true,
  requiresConfirmation: true,
  deprecated: false,
};
```

### Tipos de Parametro Soportados

| Tipo | Ejemplo | Descripcion |
|------|---------|-------------|
| `string` | `--name "Juan"` | Texto libre |
| `int` | `--id 42` | Entero |
| `float` | `--price 9.99` | Numero decimal |
| `bool` | `--active true` | Booleano |
| `date` | `--since 2024-01-01` | Fecha ISO |
| `json` | `--data '{"k":"v"}'` | JSON arbitrario |
| `enum(a,b,c)` | `--role admin` | Valor de un set fijo |
| `array<string>` | `--tags a,b,c` | Lista tipada |

### Constraints de Parametro

Se definen como string en formato `key:value` separados por coma:

```typescript
.param('age', 'int', p => p.constraints('min:0,max:150'))
.param('name', 'string', p => p.constraints('minLength:2,maxLength:100'))
```

## Paso 2: Implementar el Handler

El handler es una funcion async que recibe los argumentos parseados y retorna un resultado:

```typescript
const handler = async (args: Record<string, any>) => {
  // args contiene los parametros ya parseados y tipados
  const order = await db.orders.create({
    userId: args.userId,
    total: args.total,
    status: args.status || 'pending',
    notes: args.notes,
  });

  // Retornar resultado
  return {
    success: true,
    data: order,
  };
};
```

**Convencion de retorno:**

```typescript
// Exito
{ success: true, data: { /* resultado */ } }

// Error
{ success: false, data: null, error: 'Mensaje descriptivo del error' }
```

## Paso 3: Registrar en CommandRegistry

```typescript
import { CommandRegistry } from 'agent-shell';

const registry = new CommandRegistry();

// Registrar comando con su handler
const result = registry.register(definition, handler);

if (!result.ok) {
  console.error('Error al registrar:', result.error.message);
}
```

### Registrar Multiples Comandos

Patron comun para registrar un array de comandos (como en `demo/commands.ts`):

```typescript
import { CommandRegistry } from 'agent-shell';

const commands = [
  { definition: orderCreateDef, handler: orderCreateHandler },
  { definition: orderListDef, handler: orderListHandler },
  // ...
];

const registry = new CommandRegistry();

for (const { definition, handler } of commands) {
  registry.register(definition, handler);
}
```

O con definiciones que incluyen handler inline:

```typescript
const demoCommands = [
  {
    namespace: 'orders',
    name: 'list',
    version: '1.0.0',
    description: 'Lista ordenes',
    params: [],
    tags: ['orders'],
    example: 'orders:list',
    handler: async () => ({ success: true, data: [] }),
    undoable: false,
  },
  // ...mas comandos
];

for (const cmd of demoCommands) {
  const { handler, ...definition } = cmd;
  registry.register(definition, handler);
}
```

### Versionado

El registry soporta multiples versiones del mismo comando:

```typescript
registry.register(defV1, handlerV1);  // orders:create@1.0.0
registry.register(defV2, handlerV2);  // orders:create@2.0.0

// Resolve sin version retorna la mas reciente
registry.resolve('orders:create');         // → v2.0.0
registry.resolve('orders:create@1.0.0');   // → v1.0.0
```

## Paso 4: Conectar con Core

Una vez registrados los comandos, conectar el registry con Core para uso completo:

```typescript
import { Core, CommandRegistry, VectorIndex, ContextStore } from 'agent-shell';

const core = new Core({
  registry,
  vectorIndex,    // Para busqueda semantica
  contextStore,   // Para estado de sesion
});

// Listo para usar
const result = await core.exec('orders:create --userId 5 --total 99.90');
```

## Paso 5: Escribir Tests

Ejemplo de test con Vitest para un comando:

```typescript
import { describe, it, expect } from 'vitest';
import { CommandRegistry } from 'agent-shell';
import { command } from 'agent-shell';

describe('orders:create', () => {
  const registry = new CommandRegistry();

  const definition = command('orders', 'create')
    .description('Crea una orden')
    .requiredParam('userId', 'int', 'ID del usuario')
    .requiredParam('total', 'float', 'Monto')
    .build();

  const handler = async (args: any) => ({
    success: true,
    data: { id: 1, userId: args.userId, total: args.total },
  });

  it('should register successfully', () => {
    const result = registry.register(definition, handler);
    expect(result.ok).toBe(true);
  });

  it('should resolve the command', () => {
    const cmd = registry.resolve('orders:create');
    expect(cmd).toBeDefined();
    expect(cmd!.definition.namespace).toBe('orders');
  });

  it('should execute handler with correct args', async () => {
    const cmd = registry.resolve('orders:create');
    const result = await cmd!.handler({ userId: 5, total: 99.90 });
    expect(result.success).toBe(true);
    expect(result.data.userId).toBe(5);
  });

  it('should reject duplicate registration', () => {
    const result = registry.register(definition, handler);
    expect(result.ok).toBe(false);
  });
});
```

Ejecutar tests:

```bash
bun run test
```

## Ejemplo Completo: Agregar un Namespace Nuevo

Archivo `src/commands/products.ts`:

```typescript
import { command } from 'agent-shell';

// --- Definiciones ---

export const productCreate = command('products', 'create')
  .version('1.0.0')
  .description('Registra un nuevo producto en el catalogo')
  .requiredParam('name', 'string', 'Nombre del producto')
  .requiredParam('price', 'float', 'Precio unitario')
  .optionalParam('category', 'string', 'general', 'Categoria')
  .optionalParam('stock', 'int', 0, 'Stock inicial')
  .output('object', 'Producto creado con ID')
  .example('products:create --name "Widget" --price 29.99 --stock 100')
  .tags('products', 'catalog', 'crud')
  .reversible()
  .permissions('products:write')
  .build();

export const productSearch = command('products', 'search')
  .version('1.0.0')
  .description('Busca productos por nombre o categoria')
  .requiredParam('query', 'string', 'Texto de busqueda')
  .optionalParam('category', 'string', '', 'Filtrar por categoria')
  .param('limit', 'int', p => p.default(10).constraints('min:1,max:100'))
  .output('array', 'Lista de productos encontrados')
  .example('products:search --query "widget" --limit 5')
  .tags('products', 'search', 'catalog')
  .build();

// --- Handlers ---

const products = new Map<number, any>();
let nextId = 1;

export const productCreateHandler = async (args: any) => {
  const product = {
    id: nextId++,
    name: args.name,
    price: args.price,
    category: args.category || 'general',
    stock: args.stock || 0,
    created_at: new Date().toISOString(),
  };
  products.set(product.id, product);
  return { success: true, data: product };
};

export const productSearchHandler = async (args: any) => {
  const query = args.query.toLowerCase();
  const results = Array.from(products.values())
    .filter(p =>
      p.name.toLowerCase().includes(query) ||
      p.category.toLowerCase().includes(query)
    )
    .slice(0, args.limit || 10);
  return { success: true, data: results };
};
```

Registrar en el sistema:

```typescript
import { CommandRegistry } from 'agent-shell';
import {
  productCreate, productCreateHandler,
  productSearch, productSearchHandler,
} from './commands/products.js';

const registry = new CommandRegistry();
registry.register(productCreate, productCreateHandler);
registry.register(productSearch, productSearchHandler);
```

## Referencia Rapida

```
1. Definir    →  command('ns', 'name').description(...).params(...).build()
2. Handler    →  async (args) => ({ success: true, data: {...} })
3. Registrar  →  registry.register(definition, handler)
4. Conectar   →  new Core({ registry, vectorIndex, contextStore })
5. Testear    →  bun run test
```

## Archivos de Referencia

| Archivo | Descripcion |
|---------|-------------|
| `src/command-builder/index.ts` | Implementacion del builder fluido |
| `src/command-registry/types.ts` | Interfaces `CommandDefinition`, `CommandParam` |
| `src/command-registry/index.ts` | Clase `CommandRegistry` |
| `demo/commands.ts` | 14 comandos de ejemplo funcionales |
| `contracts/command-registry.md` | Especificacion formal del registry |
| `tests/command-builder.test.ts` | Tests del builder pattern |
| `tests/command-registry.test.ts` | Tests del registry |