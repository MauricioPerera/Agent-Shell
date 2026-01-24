# Contrato: COMMAND REGISTRY

> **Version**: 1.0
> **Fecha**: 2026-01-22
> **Estado**: Draft
> **Sistema**: Agent Shell
> **Modulo**: Command Registry

## Resumen Ejecutivo

El Command Registry es el almacen central de definiciones y handlers de comandos del sistema Agent Shell. Permite registrar comandos con su metadata completa (nombre, namespace, parametros, output shape, ejemplos), asociar handlers de ejecucion, realizar lookups eficientes por `namespace:comando`, y generar la representacion compacta AI-optimizada que se entrega al LLM durante el discovery.

---

## 1. Que debe hacer (MUST DO)

### 1.1 Objetivo Principal

Actuar como fuente de verdad de todos los comandos disponibles en el sistema, almacenando sus definiciones estructuradas y handlers, y proveyendo acceso eficiente por namespace, nombre, o listado completo para alimentar tanto al Vector Index (discovery) como al Executor (ejecucion).

### 1.2 Funcionalidades Requeridas

- [ ] **Registro de comandos**: Permitir registrar un comando con toda su metadata y handler asociado
- [ ] **Lookup por identificador**: Resolver `namespace:comando` a su definicion + handler en O(1)
- [ ] **Listado por namespace**: Retornar todos los comandos de un namespace dado
- [ ] **Listado completo**: Retornar todas las definiciones registradas (para indexacion vectorial)
- [ ] **Versionado de comandos**: Soportar multiples versiones de un mismo comando
- [ ] **Generacion de texto compacto**: Producir la representacion AI-optimizada de un comando
- [ ] **Validacion de definiciones**: Rechazar registros invalidos o duplicados
- [ ] **Deregistro**: Permitir eliminar un comando del registry

### 1.3 Estructura de Datos: CommandDefinition

```
CommandDefinition {
  // Identidad
  namespace: string              // Agrupacion logica (ej: "users", "orders")
  name: string                   // Nombre del comando (ej: "create", "list")
  version: string                // Semver del comando (ej: "1.0.0")

  // Descripcion
  description: string            // Una linea concisa para el LLM
  longDescription?: string       // Descripcion extendida (para help detallado)

  // Parametros
  params: CommandParam[]         // Lista de parametros aceptados

  // Output
  output: OutputShape            // Forma del output del comando

  // Ejemplo
  example: string                // Uso real con filtro jq incluido

  // Metadata
  tags: string[]                 // Tags para busqueda semantica adicional
  reversible: bool               // Si soporta undo
  requiresConfirmation: bool     // Si requiere --confirm por defecto
  deprecated: bool               // Si esta marcado como deprecado
  deprecatedMessage?: string     // Mensaje de migracion si deprecated
}

CommandParam {
  name: string                   // Nombre del parametro (sin --)
  type: ParamType                // Tipo del valor
  required: bool                 // Si es obligatorio
  default?: any                  // Valor por defecto (si no required)
  constraints?: string           // Restricciones inline (ej: ">0", "min:2,max:100")
  description?: string           // Descripcion corta del param
}

ParamType = "int" | "float" | "string" | "bool" | "date" | "json"
          | "enum(valores)" | "array<tipo>"

OutputShape {
  type: string                   // Tipo del output (ej: "{id,name}", "array<{id,name}>")
  description?: string           // Descripcion del output
}

RegisteredCommand {
  definition: CommandDefinition  // La definicion del comando
  handler: Function              // La funcion que ejecuta el comando
  registeredAt: datetime         // Momento del registro
}
```

### 1.4 API del Command Registry

#### Registro

```
register(definition: CommandDefinition, handler: Function): Result<void, RegistryError>
```

- Registra un comando con su handler
- Falla si ya existe `namespace:name` con la misma version
- Valida la estructura de la definicion antes de registrar

#### Deregistro

```
unregister(namespace: string, name: string, version?: string): Result<void, RegistryError>
```

- Elimina un comando del registry
- Si no se especifica version, elimina todas las versiones
- Falla si el comando no existe

#### Lookup

```
get(namespace: string, name: string, version?: string): Result<RegisteredCommand, RegistryError>
```

- Retorna el comando registrado por su identificador
- Si no se especifica version, retorna la mas reciente
- Falla si no existe

#### Lookup por ID compuesto

```
resolve(fullName: string): Result<RegisteredCommand, RegistryError>
```

- Acepta formato `namespace:name` o `namespace:name@version`
- Parsea y delega a `get()`

#### Listado por namespace

```
listByNamespace(namespace: string): Result<CommandDefinition[], RegistryError>
```

- Retorna todas las definiciones de un namespace
- Retorna array vacio si el namespace no existe (no error)

#### Listado completo

```
listAll(): CommandDefinition[]
```

- Retorna todas las definiciones registradas
- Usado por el Vector Index para construir embeddings

#### Listado de namespaces

```
getNamespaces(): string[]
```

- Retorna todos los namespaces que tienen al menos un comando registrado

#### Generacion de texto compacto

```
toCompactText(definition: CommandDefinition): string
```

- Genera la representacion AI-optimizada de un comando
- Formato definido en seccion 1.5

#### Generacion batch

```
toCompactTextBatch(definitions: CommandDefinition[]): string
```

- Genera multiples definiciones separadas por linea en blanco
- Optimizado para enviar al LLM como bloque

### 1.5 Formato Compacto AI-Optimizado

El formato de salida para consumo del LLM es:

```
namespace:comando | Descripcion concisa en una linea
  --param1: tipo (restricciones) [REQUIRED]
  --param2: tipo = default (restricciones)
  -> output: tipo<shape> | descripcion del retorno
  Ejemplo: namespace:comando --param1 valor | .campo_esperado
```

#### Reglas del formato

1. Primera linea: `namespace:nombre | descripcion` separados por pipe
2. Parametros: indentados con 2 espacios, prefijo `--`, tipo despues de `:`
3. Parametros required: sufijo `[REQUIRED]`
4. Parametros con default: `= valor` despues del tipo
5. Restricciones: entre parentesis despues del tipo
6. Output: indentado con 2 espacios, prefijo `->`, tipo y shape
7. Ejemplo: indentado con 2 espacios, prefijo `Ejemplo:`, uso real con jq
8. Si un comando esta deprecated: agregar linea `  [DEPRECATED: mensaje]`
9. No incluir longDescription en formato compacto
10. No incluir metadata interna (registeredAt, handler, etc)

#### Ejemplo concreto

Dado:
```
{
  namespace: "users",
  name: "create",
  version: "1.0.0",
  description: "Crea un nuevo usuario en el sistema",
  params: [
    { name: "name", type: "string", required: true, constraints: "min:2,max:100" },
    { name: "email", type: "string", required: true, constraints: "email" },
    { name: "role", type: "enum(admin,user,viewer)", required: false, default: "user" }
  ],
  output: { type: "{id, name, email, role, createdAt}" },
  example: "users:create --name \"John\" --email john@test.com | .id"
}
```

Produce:
```
users:create | Crea un nuevo usuario en el sistema
  --name: string (min:2,max:100) [REQUIRED]
  --email: string (email) [REQUIRED]
  --role: enum(admin,user,viewer) = user
  -> output: {id, name, email, role, createdAt}
  Ejemplo: users:create --name "John" --email john@test.com | .id
```

### 1.6 Flujos Principales

```
Registro:
  Developer -> define CommandDefinition + handler
            -> llama registry.register(def, handler)
            -> registry valida definicion
            -> registry almacena en mapa interno
            -> registry notifica al Vector Index (si conectado) para re-indexar

Lookup (desde Router):
  Router -> parsea "namespace:comando" del input
         -> llama registry.resolve("namespace:comando")
         -> recibe RegisteredCommand con handler
         -> pasa handler al Executor

Discovery (desde Vector Index):
  Vector Index -> llama registry.listAll()
              -> recibe todas las definiciones
              -> genera embeddings de description + tags
              -> almacena en DB vectorial

Generacion para LLM (desde search results):
  Search -> encuentra definiciones relevantes
         -> llama registry.toCompactTextBatch(definiciones)
         -> recibe texto compacto
         -> retorna al agente
```

### 1.7 Inputs y Outputs

| Operacion | Input | Output |
|-----------|-------|--------|
| register | CommandDefinition + handler | Result<void, Error> |
| unregister | namespace, name, version? | Result<void, Error> |
| get | namespace, name, version? | Result<RegisteredCommand, Error> |
| resolve | "namespace:name[@version]" | Result<RegisteredCommand, Error> |
| listByNamespace | namespace | CommandDefinition[] |
| listAll | (ninguno) | CommandDefinition[] |
| getNamespaces | (ninguno) | string[] |
| toCompactText | CommandDefinition | string |
| toCompactTextBatch | CommandDefinition[] | string |

---

## 2. Que NO debe hacer (MUST NOT)

### 2.1 Fuera de Alcance

- No ejecuta comandos (eso es responsabilidad del Executor)
- No parsea input del usuario (eso es responsabilidad del Parser)
- No realiza busqueda semantica (eso es responsabilidad del Vector Index)
- No aplica politicas de seguridad o permisos
- No maneja el estado de sesion o contexto
- No realiza validacion de los argumentos en runtime (solo valida la definicion al registrar)

### 2.2 Anti-patterns Prohibidos

- No almacenar estado mutable en las definiciones despues del registro
- No permitir modificar una definicion registrada in-place (debe deregistrar y re-registrar o usar nueva version)
- No acoplar el registry a una implementacion especifica de storage (debe ser in-memory con interface extensible)
- No incluir logica de negocio dentro del registry
- No hacer I/O de red dentro del registry (es un componente in-memory)
- No cachear representaciones compactas (generarlas siempre frescas para reflejar estado actual)

### 2.3 Restricciones de Implementacion

- No usar globals o singletons forzados (permitir multiples instancias para testing)
- No depender de un framework especifico
- No lanzar excepciones no tipadas (usar Result types o equivalente)
- No modificar el handler recibido (almacenarlo tal cual)
- No imponer un patron async/sync especifico en los handlers

---

## 3. Como se que esta bien (ACCEPTANCE)

### 3.1 Criterios de Aceptacion

```gherkin
Feature: Registro de comandos

  Scenario: Registro exitoso de comando completo
    DADO un registry vacio
    CUANDO registro un comando con namespace "users", name "create", version "1.0.0" y handler valido
    ENTONCES el registro es exitoso
    Y get("users", "create") retorna el comando registrado
    Y el handler retornado es exactamente el mismo que se registro

  Scenario: Registro duplicado rechazado
    DADO un registry con comando "users:create@1.0.0" registrado
    CUANDO intento registrar otro "users:create@1.0.0"
    ENTONCES recibo error COMMAND_ALREADY_EXISTS
    Y el comando original no se modifica

  Scenario: Registro con definicion invalida
    DADO un registry vacio
    CUANDO intento registrar un comando sin namespace
    ENTONCES recibo error INVALID_DEFINITION
    Y el registry permanece vacio

  Scenario: Multiples versiones del mismo comando
    DADO un registry con "users:create@1.0.0"
    CUANDO registro "users:create@2.0.0" con handler diferente
    ENTONCES ambas versiones coexisten
    Y get("users", "create") retorna la version "2.0.0" (mas reciente)
    Y get("users", "create", "1.0.0") retorna la version "1.0.0"

Feature: Lookup de comandos

  Scenario: Lookup exitoso por namespace:name
    DADO un registry con "orders:list" registrado
    CUANDO llamo resolve("orders:list")
    ENTONCES recibo el RegisteredCommand completo

  Scenario: Lookup con version explicita
    DADO un registry con "orders:list@1.0.0" y "orders:list@2.0.0"
    CUANDO llamo resolve("orders:list@1.0.0")
    ENTONCES recibo la version 1.0.0 especificamente

  Scenario: Lookup de comando inexistente
    DADO un registry vacio
    CUANDO llamo resolve("ghost:command")
    ENTONCES recibo error COMMAND_NOT_FOUND

Feature: Listado

  Scenario: Listado por namespace
    DADO un registry con "users:create", "users:list", "orders:create"
    CUANDO llamo listByNamespace("users")
    ENTONCES recibo exactamente 2 definiciones
    Y ambas tienen namespace "users"

  Scenario: Listado de namespace vacio
    DADO un registry con "users:create"
    CUANDO llamo listByNamespace("nonexistent")
    ENTONCES recibo array vacio (no error)

  Scenario: Listado completo
    DADO un registry con 5 comandos en 3 namespaces
    CUANDO llamo listAll()
    ENTONCES recibo las 5 definiciones

  Scenario: Listado de namespaces
    DADO un registry con comandos en namespaces "users", "orders", "products"
    CUANDO llamo getNamespaces()
    ENTONCES recibo ["orders", "products", "users"] (ordenados alfabeticamente)

Feature: Generacion de texto compacto

  Scenario: Generacion basica
    DADO un comando con namespace "users", name "list", description "Lista usuarios"
      Y parametro --limit tipo int, no required, default 10, constraints ">0"
      Y output array<{id,name,email}>
      Y ejemplo "users:list --limit 5 | .[0].name"
    CUANDO llamo toCompactText(definicion)
    ENTONCES el resultado es exactamente:
      """
      users:list | Lista usuarios
        --limit: int (>0) = 10
        -> output: array<{id,name,email}>
        Ejemplo: users:list --limit 5 | .[0].name
      """

  Scenario: Comando con parametros required
    DADO un comando con parametro --email tipo string, required, constraints "email"
    CUANDO genero texto compacto
    ENTONCES la linea del parametro contiene "[REQUIRED]" al final

  Scenario: Comando deprecated
    DADO un comando con deprecated=true y deprecatedMessage="Usar users:create-v2"
    CUANDO genero texto compacto
    ENTONCES incluye linea "  [DEPRECATED: Usar users:create-v2]"

  Scenario: Generacion batch
    DADO 3 definiciones de comandos
    CUANDO llamo toCompactTextBatch(definiciones)
    ENTONCES el resultado contiene los 3 bloques separados por una linea en blanco

Feature: Deregistro

  Scenario: Deregistro exitoso
    DADO un registry con "users:create@1.0.0"
    CUANDO llamo unregister("users", "create", "1.0.0")
    ENTONCES es exitoso
    Y get("users", "create", "1.0.0") retorna COMMAND_NOT_FOUND

  Scenario: Deregistro sin version elimina todas
    DADO un registry con "users:create@1.0.0" y "users:create@2.0.0"
    CUANDO llamo unregister("users", "create")
    ENTONCES ambas versiones son eliminadas

  Scenario: Deregistro de comando inexistente
    DADO un registry vacio
    CUANDO llamo unregister("ghost", "cmd")
    ENTONCES recibo error COMMAND_NOT_FOUND
```

### 3.2 Casos de Prueba Requeridos

| ID | Escenario | Input | Output Esperado | Prioridad |
|----|-----------|-------|-----------------|-----------|
| T01 | Registro y lookup basico | def + handler | Mismo handler | Alta |
| T02 | Rechazo de duplicados | Mismo namespace:name:version | Error ALREADY_EXISTS | Alta |
| T03 | Validacion de definicion sin namespace | def sin namespace | Error INVALID_DEFINITION | Alta |
| T04 | Validacion de definicion sin name | def sin name | Error INVALID_DEFINITION | Alta |
| T05 | Validacion de definicion sin version | def sin version | Error INVALID_DEFINITION | Alta |
| T06 | Validacion de param type invalido | type: "invalid" | Error INVALID_DEFINITION | Media |
| T07 | Multiples versiones coexisten | 2 versiones mismo cmd | Ambas accesibles | Alta |
| T08 | Version mas reciente por defecto | get sin version | Ultima registrada | Alta |
| T09 | Listado por namespace correcto | namespace con 3 cmds | 3 resultados | Alta |
| T10 | Listado namespace inexistente | namespace vacio | Array vacio | Media |
| T11 | getNamespaces ordenado | 3 namespaces | Ordenados alfa | Media |
| T12 | Formato compacto sin params | cmd sin params | Solo linea 1 + output + ejemplo | Alta |
| T13 | Formato compacto con required | param required | Contiene [REQUIRED] | Alta |
| T14 | Formato compacto con default | param con default | Contiene = valor | Alta |
| T15 | Formato compacto con constraints | param con constraints | Contiene (constraints) | Media |
| T16 | Formato compacto deprecated | deprecated=true | Contiene [DEPRECATED] | Media |
| T17 | Batch separado por linea vacia | 3 defs | 2 lineas vacias separadoras | Alta |
| T18 | Deregistro exitoso | cmd existente | Eliminado del registry | Alta |
| T19 | Resolve con version "@1.0.0" | "ns:cmd@1.0.0" | Version especifica | Alta |
| T20 | Resolve formato invalido | "invalido" | Error INVALID_FORMAT | Media |
| T21 | Handler no es modificado | handler original | Referencia identica | Alta |
| T22 | Registry multiples instancias | 2 registries | Independientes | Media |

### 3.3 Metricas de Exito

- [ ] Lookup por namespace:name en O(1) (HashMap o equivalente)
- [ ] Registro en O(1) amortizado
- [ ] Listado por namespace en O(k) donde k = comandos en ese namespace
- [ ] toCompactText genera output determinista (mismo input = mismo output)
- [ ] Cobertura de tests >= 95% de las lineas del modulo
- [ ] Zero dependencias externas (solo standard library)

### 3.4 Definition of Done

- [ ] Todas las operaciones de la API implementadas
- [ ] Todos los tests de la seccion 3.2 pasando
- [ ] Validacion de definiciones robusta (rechaza inputs malformados)
- [ ] Formato compacto produce output identico a los ejemplos del PRD
- [ ] El modulo es instanciable sin dependencias externas
- [ ] Documentacion inline en el codigo (JSDoc/PHPDoc/docstrings segun lenguaje)
- [ ] Tipo Result o equivalente para manejo de errores (no excepciones raw)
- [ ] Interface/trait extraido para permitir implementaciones alternativas de storage

---

## 4. Que pasa si falla (ERROR HANDLING)

### 4.1 Errores del Registry

| Codigo | Nombre | Condicion | Respuesta |
|--------|--------|-----------|-----------|
| R001 | COMMAND_ALREADY_EXISTS | register() con namespace:name:version existente | "Command {ns}:{name}@{ver} already registered" |
| R002 | COMMAND_NOT_FOUND | get/resolve/unregister de comando inexistente | "Command {ns}:{name} not found" |
| R003 | INVALID_DEFINITION | Definicion falta campos requeridos o tiene tipos invalidos | "Invalid definition: {detalle especifico}" |
| R004 | INVALID_FORMAT | resolve() con string que no matchea patron | "Invalid command format: expected namespace:name[@version]" |
| R005 | INVALID_PARAM_TYPE | Tipo de parametro no reconocido | "Unknown param type: {type}. Valid: int,float,string,bool,date,json,enum(),array<>" |
| R006 | INVALID_VERSION | Version no cumple semver basico | "Invalid version format: {version}. Expected: major.minor.patch" |

### 4.2 Validaciones en register()

La funcion register() debe validar en este orden:

1. `definition` no es null/undefined
2. `definition.namespace` es string no vacio, solo caracteres [a-z0-9-]
3. `definition.name` es string no vacio, solo caracteres [a-z0-9-]
4. `definition.version` cumple formato semver basico (X.Y.Z)
5. `definition.description` es string no vacio
6. `definition.params` es array (puede estar vacio)
7. Cada param tiene `name` (string no vacio) y `type` (ParamType valido)
8. Si param no es required, debe tener default o ser nullable
9. `definition.output` tiene al menos `type` definido
10. `definition.example` es string no vacio
11. `handler` es funcion/callable
12. No existe registro previo con mismo namespace:name:version

Si cualquier validacion falla, retornar el error correspondiente SIN registrar nada.

### 4.3 Estrategia de Errores

- El registry NUNCA lanza excepciones al exterior
- Todas las operaciones retornan `Result<T, RegistryError>`
- RegistryError contiene: codigo, mensaje, contexto (datos que causaron el error)
- El caller decide como manejar el error (log, retry, abort)

### 4.4 Consistencia

- Las operaciones son atomicas: register() o se completa o no modifica estado
- unregister() es idempotente en su efecto (eliminar algo inexistente da error pero no corrompe)
- No hay operaciones parciales (no se registra "medio comando")

---

## 5. Que supuestos tiene (ASSUMPTIONS)

### 5.1 Precondiciones

- [ ] El lenguaje de implementacion soporta tipos genericos o equivalente para Result<T,E>
- [ ] Los handlers son funciones/callables que se pueden almacenar por referencia
- [ ] El sistema corre en un solo proceso (no se requiere registry distribuido)
- [ ] La cantidad de comandos registrados es manejable en memoria (< 10,000)

### 5.2 Dependencias

| Dependencia | Tipo | Version | Critica |
|-------------|------|---------|---------|
| Standard library (HashMap/Dict) | Runtime | N/A | Si |
| Semver parser (basico) | Lib o implementacion propia | N/A | No (puede ser regex simple) |
| Result/Either type | Lib o implementacion propia | N/A | Si |

### 5.3 Datos de Entrada Esperados

- Namespaces: strings lowercase, kebab-case, 1-50 caracteres
- Names: strings lowercase, kebab-case, 1-50 caracteres
- Versions: formato "X.Y.Z" donde X,Y,Z son enteros >= 0
- Descriptions: strings UTF-8, 1-200 caracteres
- Params: 0-20 parametros por comando
- Handlers: funciones que aceptan argumentos parseados y retornan resultado

### 5.4 Estado del Sistema

- El registry se inicializa vacio
- Los comandos se registran durante la fase de bootstrap de la aplicacion
- El registry esta listo para consultas inmediatamente despues de cada register()
- No requiere "fase de compilacion" o "freeze" del estado

---

## 6. Que limites tiene (CONSTRAINTS)

### 6.1 Limites Tecnicos

- Memoria: proporcional a la cantidad de comandos registrados (estimado ~1KB por comando)
- Lookup: O(1) amortizado (HashMap)
- No thread-safe por defecto (el caller debe sincronizar si es multi-threaded)
- No persistencia a disco (in-memory only, se reconstruye en cada boot)

### 6.2 Limites de Negocio

- Un namespace:name:version es unico globalmente en la instancia
- Las versiones no se auto-incrementan (el developer las gestiona)
- No hay herencia ni composicion de comandos (cada definicion es independiente)
- El formato compacto es de solo lectura (no se puede parsear de vuelta a CommandDefinition desde el texto compacto)

### 6.3 Limites de Nombres

- Namespace: regex `^[a-z][a-z0-9-]{0,49}$`
- Name: regex `^[a-z][a-z0-9-]{0,49}$`
- El separador namespace:name es siempre `:`
- El separador de version es siempre `@`
- No se permiten namespaces anidados (no "a:b:c", solo "a:b")

### 6.4 Limites de Alcance - Version 1.0

Esta version NO incluye:
- Persistencia a disco o base de datos
- Eventos/hooks de lifecycle (onRegister, onUnregister)
- Dependencias entre comandos
- Aliases de comandos
- Middleware o interceptors por comando
- Hot-reload de handlers
- Registry distribuido o sincronizado entre procesos
- Internacionalizacion de descripciones

Consideraciones para versiones futuras:
- Event system para notificar al Vector Index de cambios
- Plugin system para cargar comandos desde archivos
- Aliases: mapear "u:c" a "users:create"
- Tags jerarquicos para busqueda mas precisa
- Serializar/deserializar el registry para cold start rapido

---

## Anexos

### A. Glosario

| Termino | Definicion |
|---------|------------|
| Namespace | Agrupacion logica de comandos (ej: "users", "orders") |
| Handler | Funcion que ejecuta la logica del comando |
| Compact Text | Representacion token-eficiente de un comando para consumo LLM |
| Output Shape | Descripcion de la estructura del resultado de un comando |
| Discovery | Proceso por el cual el LLM encuentra comandos relevantes |
| Semver | Versionado semantico: MAJOR.MINOR.PATCH |
| Registry | Almacen en memoria de definiciones + handlers |

### B. Referencias

- PRD del sistema: `d:/repos/agent-shell/docs/prd.md`
- Formato de comandos: Seccion "Especificacion del Formato de Comandos" del PRD
- Arquitectura: Seccion "Arquitectura de Alto Nivel" del PRD

### C. Relacion con Otros Modulos

| Modulo | Relacion con Command Registry |
|--------|-------------------------------|
| Parser | No tiene relacion directa; el Parser opera sobre el input string |
| Router | Consume registry.resolve() para encontrar el handler |
| Executor | Recibe el handler del Router, no accede al registry directamente |
| Vector Index | Consume registry.listAll() para construir indice de busqueda |
| Search | Consume registry.toCompactTextBatch() para formatear resultados |

### D. Ejemplo Completo de Uso

```
// Bootstrap
const registry = new CommandRegistry();

// Registro
registry.register({
  namespace: "users",
  name: "create",
  version: "1.0.0",
  description: "Crea un nuevo usuario en el sistema",
  params: [
    { name: "name", type: "string", required: true, constraints: "min:2,max:100" },
    { name: "email", type: "string", required: true, constraints: "email" },
    { name: "role", type: "enum(admin,user,viewer)", required: false, default: "user" }
  ],
  output: { type: "{id, name, email, role, createdAt}" },
  example: 'users:create --name "John" --email john@test.com | .id',
  tags: ["user", "creation", "onboarding"],
  reversible: true,
  requiresConfirmation: false,
  deprecated: false
}, async (args) => {
  // Logica de creacion de usuario
  return { id: 1, name: args.name, email: args.email, role: args.role, createdAt: "2026-01-22" };
});

// Lookup
const result = registry.resolve("users:create");
// result.value.definition.description -> "Crea un nuevo usuario en el sistema"
// result.value.handler -> la funcion registrada

// Formato compacto
const text = registry.toCompactText(result.value.definition);
// text ->
// users:create | Crea un nuevo usuario en el sistema
//   --name: string (min:2,max:100) [REQUIRED]
//   --email: string (email) [REQUIRED]
//   --role: enum(admin,user,viewer) = user
//   -> output: {id, name, email, role, createdAt}
//   Ejemplo: users:create --name "John" --email john@test.com | .id

// Listado
const userCmds = registry.listByNamespace("users");
// userCmds -> [CommandDefinition de users:create]

const allCmds = registry.listAll();
// allCmds -> todas las definiciones para indexacion vectorial
```

### E. Historial de Cambios

| Version | Fecha | Autor | Cambios |
|---------|-------|-------|---------|
| 1.0 | 2026-01-22 | Spec Architect | Version inicial del contrato |

---

## 9. Estado de Implementación v1.0

### Implementado
- CommandRegistry con register(), get(), resolve(), list(), toCompactText()
- Versionado semver con comparacion y resolucion de "latest"
- Tipos Result<T> (con error siempre RegistryError)
- Texto compacto AI-optimizado con parametros formateados
- Deprecated message support
- **SQLiteRegistryAdapter** (fuera de scope del contrato pero implementado): save(), saveBatch(), loadAll(), loadByNamespace(), loadOne(), delete(), getNamespaces(), count()
- Campo `requiredPermissions?: string[]` en CommandDefinition (no en contrato)

### Implementado (v1.1)
- Validacion regex de namespace: `^[a-z][a-z0-9-]{0,49}$`
- Validacion regex de name: `^[a-z][a-z0-9-]{0,49}$`
- Validacion estricta de formato semver (`^\d+\.\d+\.\d+$`)
- Validacion de description no-empty
- Validacion de example no-empty
- Validacion de handler como funcion callable

### Pendiente
- Validacion de output shape con campo `type`
- Validacion de nombres de parametros no-empty
- Validacion de defaults para parametros no-required
- Tags no incluidos en formato compacto
