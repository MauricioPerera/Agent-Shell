# Contrato: CORE (Orquestador Principal)

> **Version**: 1.0
> **Fecha**: 2026-01-22
> **Estado**: Draft
> **Modulo**: core
> **Dependencias**: parser, executor, search, registry, context, jq-filter

## Resumen Ejecutivo

El Core es el orquestador central de Agent Shell. Recibe las dos unicas llamadas posibles del agente LLM (`cli_help` y `cli_exec`), coordina el ciclo de vida completo de cada request delegando a los modulos especializados (parser, executor, search, etc.), y retorna una respuesta estructurada. Es el unico punto de entrada al sistema y define la interfaz publica del framework.

---

## 1. Que debe hacer (MUST DO)

### 1.1 Objetivo Principal

Actuar como gateway unico entre el agente LLM y todos los subsistemas de Agent Shell, orquestando el flujo completo desde la recepcion del input hasta la entrega del output formateado.

### 1.2 Responsabilidades

- [ ] Exponer exactamente 2 entry points: `cli_help()` y `cli_exec(cmd: string)`
- [ ] Delegar el parsing del comando al modulo Parser
- [ ] Rutear el comando parseado al subsistema correcto (search, executor, context, history)
- [ ] Gestionar el ciclo de vida completo de un request (recepcion, validacion, ejecucion, respuesta)
- [ ] Aplicar middleware transversal (logging, rate limiting, timing)
- [ ] Normalizar todas las respuestas al formato estandar de salida
- [ ] Propagar errores de subsistemas en formato consistente
- [ ] Gestionar el modo batch (multiples comandos en una llamada)
- [ ] Gestionar la composicion de comandos (pipe `>>`)

### 1.3 Entry Points

#### cli_help()

```
Input:  (sin parametros)
Output: string con el protocolo de interaccion completo
```

Retorna el texto del protocolo de interaccion tal como se define en el PRD (seccion "Especificacion del Protocolo de Interaccion"). Este texto es estatico y no cambia entre llamadas.

#### cli_exec(cmd: string)

```
Input:  cmd - string con el comando a ejecutar
Output: Response (ver seccion 1.5)
```

Punto de entrada para toda interaccion activa con el sistema. El string `cmd` puede contener:
- Un comando simple: `namespace:comando --arg valor`
- Un comando con filtro jq: `namespace:comando --arg valor | .campo`
- Una composicion: `cmd1 >> cmd2`
- Un batch: `batch [cmd1, cmd2, cmd3]`
- Un comando de sistema: `search`, `describe`, `context`, `history`, `undo`

### 1.4 Flujo de Procesamiento Principal

```
cli_exec(cmd) recibido
        |
        v
+--[1. Middleware PRE]--+
|  - Logging entrada    |
|  - Rate limit check   |
|  - Timestamp inicio   |
+-----------+-----------+
            |
            v
+--[2. PARSER]----------+
|  Delegar a Parser     |
|  Recibir ParsedCmd    |
+-----------+-----------+
            |
            v
+--[3. ROUTER]----------+
|  Determinar destino   |
|  segun tipo de cmd    |
+-----------+-----------+
            |
    +-------+-------+-------+-------+
    |       |       |       |       |
    v       v       v       v       v
 SEARCH  EXECUTOR CONTEXT HISTORY DESCRIBE
    |       |       |       |       |
    +-------+-------+-------+-------+
            |
            v
+--[4. JQ FILTER]-------+
|  Aplicar filtro si    |
|  existe en ParsedCmd  |
+-----------+-----------+
            |
            v
+--[5. FORMATTER]-------+
|  Aplicar --format     |
|  (json|table|csv)     |
+-----------+-----------+
            |
            v
+--[6. Middleware POST]-+
|  - Logging salida     |
|  - Timing registro    |
|  - History append     |
+-----------+-----------+
            |
            v
      Response final
```

### 1.5 Inputs y Outputs

#### Input de cli_exec

| Campo | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| cmd | string | Si | Comando completo en formato texto |

#### Output estandar (Response)

```
{
  "code": int,          // 0=exito, 1=sintaxis, 2=no encontrado, 3=permisos, 4=confirmacion
  "data": any,          // Resultado de la ejecucion (null si error)
  "error": string|null, // Mensaje de error (null si exito)
  "meta": {
    "duration_ms": int,      // Tiempo de procesamiento
    "command": string,       // Comando original recibido
    "mode": string,          // "execute"|"dry-run"|"validate"|"confirm"
    "timestamp": string      // ISO 8601
  }
}
```

#### Estructura interna: ParsedCommand (recibido del Parser)

```
{
  "type": enum("command"|"search"|"describe"|"context"|"history"|"undo"|"batch"|"pipe"),
  "namespace": string|null,
  "command": string,
  "args": Record<string, any>,
  "flags": {
    "dry_run": bool,
    "validate": bool,
    "confirm": bool,
    "format": "json"|"table"|"csv",
    "limit": int|null,
    "offset": int|null
  },
  "jq_filter": string|null,
  "pipe_target": ParsedCommand|null,
  "batch_commands": ParsedCommand[]|null
}
```

### 1.6 Tabla de Ruteo

| ParsedCommand.type | Destino | Descripcion |
|--------------------|---------|-------------|
| `search` | Search Module | Busqueda semantica vectorial |
| `describe` | Registry Module | Obtener definicion de comando |
| `command` | Executor Module | Ejecucion de comando registrado |
| `context` | Context Store | Leer/escribir estado de sesion |
| `history` | History Module | Consultar historial |
| `undo` | Executor Module (rollback) | Revertir comando previo |
| `batch` | Core (loop interno) | Ejecutar N comandos secuencialmente |
| `pipe` | Core (encadenamiento) | Output de cmd1 como input de cmd2 |

---

## 2. Que NO debe hacer (MUST NOT)

### 2.1 Fuera de Alcance

- NO parsear comandos directamente (delegar al Parser)
- NO ejecutar logica de negocio de comandos (delegar al Executor)
- NO realizar busquedas vectoriales (delegar al Search)
- NO almacenar estado de sesion (delegar al Context Store)
- NO aplicar logica de filtrado jq internamente (delegar al JQ Filter)
- NO exponer mas de 2 entry points publicos
- NO ejecutar comandos del sistema operativo
- NO incluir logica de LLM o procesamiento de lenguaje natural

### 2.2 Anti-patterns Prohibidos

- NO acoplar la implementacion a un transporte especifico (stdio, HTTP, MCP) --> El Core recibe strings y retorna objetos Response, el transporte es responsabilidad de una capa superior
- NO manejar estado mutable global --> Todo estado debe fluir a traves de los modulos apropiados (Context Store)
- NO hacer catch silencioso de errores --> Todo error debe propagarse como Response con code != 0
- NO realizar logica condicional basada en el contenido semantico del comando --> El ruteo se basa en el tipo del ParsedCommand, no en heuristicas
- NO retornar respuestas sin envolver en el formato Response estandar

### 2.3 Restricciones de Implementacion

- No importar dependencias de vector DB directamente (usar interface del Search module)
- No asumir formato de transporte (no print, no HTTP response, solo retornar Response)
- No bloquear indefinidamente en ningun subsistema (aplicar timeout por operacion)
- No modificar el ParsedCommand despues de recibirlo del Parser (inmutabilidad)

---

## 3. Como se que esta bien (ACCEPTANCE)

### 3.1 Criterios de Aceptacion

#### Entry Points

```gherkin
DADO que el sistema esta inicializado
CUANDO el agente llama cli_help()
ENTONCES recibe un string con el protocolo de interaccion completo
Y el string contiene las secciones: Descubrimiento, Ejecucion, Filtrado, Paginacion, Composicion, Batch, Estado, Historial, Output, Errores

DADO que el sistema esta inicializado
CUANDO el agente llama cli_exec("search crear usuario")
ENTONCES el Core delega al Parser, recibe un ParsedCommand de tipo "search"
Y rutea al Search Module
Y retorna un Response con code=0 y data con resultados

DADO que el sistema esta inicializado
CUANDO el agente llama cli_exec("users:create --name Juan --email juan@test.com --dry-run")
ENTONCES el Core delega al Parser
Y recibe un ParsedCommand de tipo "command" con flag dry_run=true
Y rutea al Executor en modo dry-run
Y retorna Response con code=0 y meta.mode="dry-run"
```

#### Composicion (Pipe)

```gherkin
DADO un comando compuesto "users:list --limit 5 >> users:export --format csv"
CUANDO el agente llama cli_exec con ese comando
ENTONCES el Core ejecuta users:list primero
Y pasa el data del Response como input implicito de users:export
Y retorna solo el Response final de users:export

DADO un comando compuesto donde el primer comando falla
CUANDO el agente llama cli_exec("cmd_invalido >> cmd2")
ENTONCES el Core detiene la cadena en el primer error
Y retorna el Response de error del primer comando
Y NO ejecuta cmd2
```

#### Batch

```gherkin
DADO un batch "batch [cmd1, cmd2, cmd3]"
CUANDO el agente llama cli_exec con ese batch
ENTONCES el Core ejecuta cada comando independientemente
Y retorna un Response con data como array de Responses individuales
Y code=0 solo si TODOS los comandos fueron exitosos

DADO un batch donde el segundo comando falla
CUANDO el agente llama cli_exec("batch [cmd1, cmd_invalido, cmd3]")
ENTONCES el Core ejecuta todos los comandos (no detiene en error)
Y retorna Response con code=1
Y data contiene los 3 Responses individuales (2 exitosos, 1 error)
```

#### Filtro JQ

```gherkin
DADO un comando con filtro "users:get --id 1 | .nombre"
CUANDO el Core recibe el Response del Executor con data={id:1, nombre:"Juan", email:"j@t.com"}
ENTONCES aplica el filtro jq ".nombre" sobre data
Y retorna Response con data="Juan"

DADO un filtro jq invalido
CUANDO el Core intenta aplicar "| .campo_inexistente"
ENTONCES retorna Response con code=0 y data=null (campo no encontrado no es error)
```

#### Formato

```gherkin
DADO un comando con --format table
CUANDO el Core recibe el Response del Executor
ENTONCES formatea data como tabla legible antes de retornar
Y el campo data contiene el string formateado

DADO un comando sin --format especificado
CUANDO el Core retorna
ENTONCES el formato por defecto es json
```

### 3.2 Casos de Prueba Requeridos

| ID | Escenario | Input | Output Esperado | Prioridad |
|----|-----------|-------|-----------------|-----------|
| T01 | cli_help basico | cli_help() | String con protocolo completo | Alta |
| T02 | Comando simple exitoso | cli_exec("search test") | Response code=0, data con resultados | Alta |
| T03 | Comando con namespace | cli_exec("users:list") | Ruteo a Executor, Response code=0 | Alta |
| T04 | Comando no encontrado | cli_exec("xyz:nope") | Response code=2, error descriptivo | Alta |
| T05 | Comando dry-run | cli_exec("users:delete --id 1 --dry-run") | Response code=0, mode=dry-run, sin efecto real | Alta |
| T06 | Comando validate | cli_exec("users:create --validate") | Response code=1 (falta args requeridos) | Alta |
| T07 | Pipe exitoso | cli_exec("a >> b") | Ejecuta a, pasa data a b, retorna b | Alta |
| T08 | Pipe con error | cli_exec("invalido >> b") | Response error del primer cmd | Alta |
| T09 | Batch todos ok | cli_exec("batch [a, b]") | Response code=0, data=[resp_a, resp_b] | Alta |
| T10 | Batch parcial | cli_exec("batch [a, err, b]") | Response code=1, data con 3 responses | Media |
| T11 | Filtro jq simple | cli_exec("cmd | .field") | Response con data=valor_del_campo | Alta |
| T12 | Filtro jq array | cli_exec("cmd | [.a, .b]") | Response con data=[val_a, val_b] | Media |
| T13 | Formato table | cli_exec("cmd --format table") | data como string tabla | Media |
| T14 | Formato csv | cli_exec("cmd --format csv") | data como string csv | Media |
| T15 | Rate limit excedido | 100+ llamadas/segundo | Response code=3, error rate limit | Media |
| T16 | Timeout de subsistema | Executor tarda >timeout | Response code=1, error timeout | Media |
| T17 | Comando vacio | cli_exec("") | Response code=1, error sintaxis | Alta |
| T18 | Comando solo espacios | cli_exec("   ") | Response code=1, error sintaxis | Media |
| T19 | Context set | cli_exec("context:set key val") | Response code=0, valor persistido | Media |
| T20 | Context get | cli_exec("context") | Response code=0, data con contexto actual | Media |
| T21 | History | cli_exec("history") | Response code=0, data con ultimos cmds | Media |
| T22 | Undo | cli_exec("undo <id>") | Delegado a Executor rollback | Baja |
| T23 | Paginacion | cli_exec("cmd --limit 5 --offset 10") | Flags pasados correctamente al Executor | Media |
| T24 | Describe comando | cli_exec("describe users:create") | Response con definicion del comando | Alta |

### 3.3 Metricas de Exito

- [ ] Latencia overhead del Core < 5ms (sin contar subsistemas)
- [ ] 100% de requests retornan formato Response estandar
- [ ] 0% de excepciones no capturadas (todo se convierte en Response con code de error)
- [ ] cli_help() retorna en < 1ms (es estatico)
- [ ] Batch de 10 comandos no excede 10x el tiempo de un comando individual + 10ms overhead

### 3.4 Definition of Done

- [ ] Los 2 entry points estan implementados y funcionales
- [ ] Todos los tipos de ParsedCommand son ruteados correctamente
- [ ] Pipe y Batch funcionan segun especificacion
- [ ] Filtro JQ se aplica post-ejecucion
- [ ] Formato de output respeta el flag --format
- [ ] Middleware de logging registra entrada/salida de cada request
- [ ] Timeout configurable por operacion
- [ ] Tests unitarios con cobertura minima: 90%
- [ ] Tests de integracion con mocks de subsistemas
- [ ] Sin dependencias directas a implementaciones concretas de subsistemas (solo interfaces)

---

## 4. Que pasa si falla (ERROR HANDLING)

### 4.1 Errores Esperados

| Codigo | Condicion | Response.error | Accion Recomendada al Agente |
|--------|-----------|----------------|------------------------------|
| 1 | Comando vacio o mal formado | "Syntax error: [detalle del parser]" | Revisar formato del comando |
| 1 | Timeout de subsistema | "Timeout: [subsistema] exceeded [N]ms" | Reintentar o simplificar |
| 2 | Comando no encontrado en registry | "Command not found: [namespace:cmd]" | Usar search para descubrir |
| 2 | Namespace no registrado | "Namespace not found: [namespace]" | Usar search para descubrir |
| 3 | Rate limit excedido | "Rate limit exceeded: [N] req/min max" | Esperar y reintentar |
| 3 | Permiso denegado por politica | "Permission denied: [detalle]" | Verificar permisos |
| 4 | Requiere confirmacion (--confirm) | "Confirmation required: [preview data]" | Re-ejecutar confirmando |

### 4.2 Estrategia de Propagacion de Errores

```
Subsistema lanza error
        |
        v
Core lo captura
        |
        v
Mapear a codigo de error estandar (1-4)
        |
        v
Construir Response con:
  - code: codigo mapeado
  - data: null
  - error: mensaje descriptivo
  - meta: informacion de contexto
        |
        v
Pasar por middleware POST (logging)
        |
        v
Retornar Response
```

**Regla fundamental**: Ningun error escapa del Core sin ser envuelto en un Response. Si un subsistema lanza una excepcion inesperada, se captura como code=1 con error generico.

### 4.3 Errores en Pipe

- Si el comando N de una cadena falla, se retorna el error del comando N
- Los comandos anteriores exitosos ya se ejecutaron (no hay rollback automatico de pipe)
- El campo meta.command contiene el comando especifico que fallo

### 4.4 Errores en Batch

- Los errores individuales NO detienen el batch
- El Response final tiene code=0 solo si todos fueron exitosos
- Cada Response individual en data[] tiene su propio code/error

### 4.5 Logging y Monitoreo

- **Nivel INFO**: Cada request recibido (cmd, timestamp)
- **Nivel INFO**: Cada response enviado (code, duration_ms)
- **Nivel WARN**: Timeouts, rate limits alcanzados
- **Nivel ERROR**: Excepciones inesperadas de subsistemas
- **Metricas**: requests/min, latencia p50/p95/p99, tasa de errores por codigo

### 4.6 Timeout por Subsistema

| Subsistema | Timeout Default | Configurable |
|------------|----------------|--------------|
| Parser | 100ms | Si |
| Search | 2000ms | Si |
| Executor | 5000ms | Si |
| JQ Filter | 500ms | Si |
| Context | 200ms | Si |
| Registry | 200ms | Si |

---

## 5. Que supuestos tiene (ASSUMPTIONS)

### 5.1 Precondiciones

- [ ] El modulo Parser esta implementado y cumple su contrato (retorna ParsedCommand)
- [ ] El modulo Search esta disponible y conectado a un indice vectorial funcional
- [ ] El Command Registry tiene al menos los comandos de sistema registrados (search, describe, context, history, undo)
- [ ] El Executor puede recibir y procesar ParsedCommands
- [ ] El JQ Filter puede procesar expresiones jq basicas sobre objetos JSON
- [ ] El Context Store esta inicializado (puede estar vacio)

### 5.2 Dependencias entre Modulos

```
                    +--------+
                    |  CORE  |
                    +---+----+
                        |
          +-------------+-------------+
          |             |             |
     +----v----+   +----v----+   +----v----+
     | Parser  |   |  Search |   | Registry|
     +---------+   +----+----+   +----+----+
                        |             |
                   +----v----+        |
                   |Vector DB|        |
                   +---------+   +----v----+
                                 |Executor |
                                 +----+----+
                                      |
                                 +----v----+
                                 |Handlers |
                                 +---------+

     +----------+   +----------+   +----------+
     | JQ Filter|   | Context  |   | History  |
     +----------+   +----------+   +----------+
```

| Dependencia | Tipo | Interface Requerida | Critica |
|-------------|------|---------------------|---------|
| Parser | Modulo interno | `parse(cmd: string): ParsedCommand` | Si |
| Search | Modulo interno | `search(query: string, limit: int): SearchResult[]` | Si |
| Registry | Modulo interno | `describe(namespace: string, command: string): CommandDef` | Si |
| Executor | Modulo interno | `execute(parsed: ParsedCommand, context: Context): ExecResult` | Si |
| JQ Filter | Modulo interno | `apply(data: any, filter: string): any` | No (degradacion: retornar data sin filtrar) |
| Context Store | Modulo interno | `get(key?: string): any`, `set(key: string, value: any): void` | No (degradacion: contexto vacio) |
| History | Modulo interno | `append(entry: HistoryEntry): void`, `list(limit: int): HistoryEntry[]` | No (degradacion: historial vacio) |

### 5.3 Interfaces de Subsistemas (Contratos esperados)

#### Parser

```
parse(cmd: string): ParsedCommand | ParseError

ParseError {
  message: string,
  position: int,      // caracter donde fallo el parsing
  suggestion: string  // sugerencia de correccion
}
```

#### Search

```
search(query: string, options?: { limit: int, offset: int }): SearchResult[]

SearchResult {
  command: string,       // namespace:comando
  description: string,   // descripcion del comando
  score: float,          // relevancia 0.0-1.0
  signature: string      // firma compacta del comando
}
```

#### Executor

```
execute(parsed: ParsedCommand, context?: Context): ExecResult

ExecResult {
  success: bool,
  data: any,
  reversible: bool,
  undo_id: string|null
}
```

#### JQ Filter

```
apply(data: any, expression: string): any | FilterError

FilterError {
  message: string,
  expression: string
}
```

### 5.4 Configuracion Esperada

```
{
  "timeouts": {
    "parser_ms": 100,
    "search_ms": 2000,
    "executor_ms": 5000,
    "jq_filter_ms": 500,
    "context_ms": 200
  },
  "rate_limit": {
    "requests_per_minute": 120,
    "burst_max": 20
  },
  "logging": {
    "level": "INFO",
    "output": "configurable"
  },
  "defaults": {
    "format": "json",
    "limit": 20,
    "offset": 0
  }
}
```

---

## 6. Que limites tiene (CONSTRAINTS)

### 6.1 Limites Tecnicos

- **Tamano maximo de cmd**: 4096 caracteres (proteccion contra input excesivo)
- **Profundidad maxima de pipe**: 10 comandos encadenados
- **Tamano maximo de batch**: 50 comandos por batch
- **Tamano maximo de Response.data**: 1MB (si excede, paginar)
- **Timeout global por request**: 30 segundos (suma de todos los subsistemas)
- **Rate limit default**: 120 requests/minuto, burst de 20

### 6.2 Limites de Negocio

- El Core NO toma decisiones de negocio; solo orquesta
- El Core NO interpreta semanticamente los comandos; solo rutea por tipo
- El Core NO persiste datos; delega al Context Store o History
- El Core NO valida argumentos de negocio; el Executor y los handlers lo hacen
- El Core NO tiene conocimiento de los namespaces disponibles; consulta al Registry

### 6.3 Limites de Seguridad

- El Core aplica rate limiting antes de cualquier procesamiento
- El Core NO ejecuta nada si el Parser retorna error (fail-fast)
- El Core NO permite inyeccion de codigo a traves del campo cmd (el Parser es responsable de sanitizar)
- El Core registra en log todo comando recibido (auditoria)
- El Core NO expone informacion interna del sistema en mensajes de error (solo mensajes user-facing)

### 6.4 Limites de Alcance - Version 1.0

**Esta version NO incluye:**
- Autenticacion/autorizacion de agentes (se asume un unico agente por instancia)
- Multiples sesiones concurrentes (una sesion a la vez)
- Streaming de responses (response completo o nada)
- Webhooks o callbacks asincrono
- Persistencia del historial entre reinicios del sistema
- Internacionalizacion de mensajes de error

**Consideraciones para versiones futuras:**
- Multi-tenancy (multiples agentes, cada uno con su contexto)
- Streaming para comandos de larga duracion
- Sistema de plugins para middleware custom
- Metricas exportables (Prometheus, OpenTelemetry)
- Modo cluster para alta disponibilidad

---

## 7. Interfaz Publica del Modulo

### 7.1 API del Core

```
// Punto de entrada principal - inicializacion
createCore(config: CoreConfig, modules: CoreModules): Core

// Interfaz del Core una vez creado
interface Core {
  help(): string
  exec(cmd: string): Response
}

// Dependencias inyectadas
interface CoreModules {
  parser: ParserInterface
  search: SearchInterface
  executor: ExecutorInterface
  registry: RegistryInterface
  jqFilter: JqFilterInterface
  context: ContextInterface
  history: HistoryInterface
}
```

### 7.2 Contrato de Inmutabilidad

- `cli_help()` siempre retorna el mismo string (determinista)
- `cli_exec(cmd)` con el mismo cmd puede retornar resultados diferentes (estado mutable en subsistemas)
- El Core NO modifica el ParsedCommand recibido del Parser
- El Core NO modifica el ExecResult recibido del Executor (solo lo envuelve en Response)

### 7.3 Concurrencia

- Version 1.0: Single-threaded, un request a la vez
- Los subsistemas pueden ser async internamente, pero el Core espera el resultado
- Batch se ejecuta secuencialmente (no en paralelo)

---

## Anexos

### A. Glosario

| Termino | Definicion |
|---------|------------|
| Core | Orquestador principal de Agent Shell |
| Entry Point | Punto de entrada publico (cli_help o cli_exec) |
| ParsedCommand | Estructura resultante del parsing de un comando string |
| Response | Estructura estandar de retorno de todo comando |
| Pipe | Composicion de comandos donde el output de uno es input del siguiente |
| Batch | Ejecucion de multiples comandos independientes en una sola llamada |
| Namespace | Agrupacion logica de comandos (ej: "users", "orders") |
| Handler | Funcion que implementa la logica de un comando especifico |
| Middleware | Logica transversal que se ejecuta antes/despues de cada request |
| Dry-run | Modo de ejecucion que simula sin efectos reales |

### B. Codigos de Error

| Codigo | Significado | Origen Tipico |
|--------|-------------|---------------|
| 0 | Exito | Cualquier subsistema |
| 1 | Error de sintaxis / error general | Parser, Core (timeout) |
| 2 | No encontrado | Registry, Search |
| 3 | Sin permisos / rate limit | Core (rate limit), Executor (permisos) |
| 4 | Requiere confirmacion | Executor (modo confirm) |

### C. Ejemplo Completo de Flujo

```
Agente llama: cli_exec("users:create --name Juan --email j@t.com --dry-run | .id")

1. Core recibe "users:create --name Juan --email j@t.com --dry-run | .id"
2. Middleware PRE: log entrada, check rate limit (OK), timestamp
3. Parser.parse() retorna:
   {
     type: "command",
     namespace: "users",
     command: "create",
     args: { name: "Juan", email: "j@t.com" },
     flags: { dry_run: true, format: "json" },
     jq_filter: ".id"
   }
4. Router: type="command" -> Executor
5. Executor.execute(parsed, context) retorna:
   { success: true, data: { id: 42, name: "Juan", email: "j@t.com" }, reversible: true, undo_id: "abc123" }
6. JQ Filter: apply({id:42, name:"Juan"...}, ".id") -> 42
7. Formatter: format=json, data ya es primitivo -> 42
8. Middleware POST: log salida, duration=12ms, history append
9. Response final:
   {
     code: 0,
     data: 42,
     error: null,
     meta: { duration_ms: 12, command: "users:create --name Juan...", mode: "dry-run", timestamp: "2026-01-22T..." }
   }
```

### D. Historial de Cambios

| Version | Fecha | Autor | Cambios |
|---------|-------|-------|---------|
| 1.0 | 2026-01-22 | Spec Architect | Version inicial del contrato Core |

---

## 9. Estado de Implementación v1.0

### Implementado
- Core con help() y exec(cmd) como entry points
- Orquestacion: parse → resolve → execute → jq filter → format → response
- Pipeline y batch delegation
- Builtins: search, describe, context, context:set, context:get, context:delete, history, help
- Formateo table/csv para output
- CoreResponse con {code, data, error, meta}
- Integracion con VectorIndex para search semantico
- Integracion con ContextStore para estado de sesion

### Discrepancias con contrato
- Funciones se llaman `help()` y `exec()` (contrato dice `cli_help()` y `cli_exec()`)
- Tipo de respuesta es `CoreResponse` (contrato dice `Response`)
- MAX_INPUT_LENGTH default es 10000 (contrato dice 4096)
- context:delete implementado pero no documentado en contrato
- Undo retorna error "not implemented in core standalone mode"

### Implementado (v1.1)
- Rate limiting con sliding window + burst control (120 req/min, burst 20/s configurable)
- Timeout global de 30s por request (configurable via `timeouts.global_ms`)
- Validacion de pipeline depth (max 10 comandos)
- Validacion de batch size (max 50 comandos)
- CoreConfig expandido con `timeouts`, `rateLimit`, `logging`, `defaults` sub-objects
- LogEntry interface y CoreLogger inline (INFO/WARN/ERROR)
- Logging: INFO al ejecutar, WARN si duration > 5s, ERROR en fallos
- Input size pre-check (configurable via `maxInputLength`)

### Pendiente
- Timeouts per-subsistema individuales (parser 100ms, search 2000ms, executor 5000ms, jq 500ms)
- Validacion de response size (max 1MB con paginacion)
- Metricas exportables (requests/min, latencia p50/p95/p99)
