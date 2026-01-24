# Contrato: PARSER

> **Version**: 1.0
> **Fecha**: 2026-01-22
> **Estado**: Draft
> **Autor**: Specification Architect
> **Modulo**: Parser (Agent Shell)

## Resumen Ejecutivo

El Parser es el modulo responsable de interpretar el string crudo recibido via `cli_exec(cmd)` y transformarlo en una estructura de datos (AST) que el Router y Executor puedan consumir. Maneja la gramatica completa del protocolo: namespaces, comandos, argumentos, flags globales, filtros jq, composicion con pipes y ejecucion batch.

---

## 1. Que debe hacer (MUST DO)

### 1.1 Objetivo Principal

Recibir un string de comando y producir un objeto estructurado (ParsedCommand) que represente de forma univoca la intencion del agente, incluyendo el comando a ejecutar, sus parametros, modos de ejecucion, filtros de salida y relaciones de composicion.

### 1.2 Funcionalidades Requeridas

- [ ] **Parsing de comando simple**: Extraer namespace, comando y argumentos
- [ ] **Flags globales**: Detectar y extraer --dry-run, --validate, --confirm, --format, --limit, --offset
- [ ] **Filtros jq**: Detectar pipe jq (`| .campo`, `| [.campo1, .campo2]`)
- [ ] **Composicion**: Detectar y descomponer pipes de composicion (`cmd1 >> cmd2`)
- [ ] **Batch**: Detectar y descomponer comandos batch (`batch [cmd1, cmd2]`)
- [ ] **Validacion de sintaxis**: Detectar errores sintacticos y reportarlos con codigo 1
- [ ] **Argumentos posicionales**: Soportar argumentos sin flag (ej: `search <query>`)
- [ ] **Valores con espacios**: Soportar valores entre comillas simples o dobles

### 1.3 Gramatica Soportada (BNF simplificado)

```
<input>          ::= <batch> | <pipeline> | <single_command>

<batch>          ::= "batch" "[" <command_list> "]"
<command_list>   ::= <single_command> ("," <single_command>)*

<pipeline>       ::= <single_command> (">>" <single_command>)+

<single_command> ::= <command_expr> <jq_filter>?
<command_expr>   ::= <command_id> <arguments>* <global_flags>*

<command_id>     ::= <namespace> ":" <command_name>
                   | <builtin_command>

<namespace>      ::= [a-zA-Z][a-zA-Z0-9_-]*
<command_name>   ::= [a-zA-Z][a-zA-Z0-9_-]*
<builtin_command>::= "search" | "describe" | "help" | "context" | "history" | "undo"

<arguments>      ::= <named_arg> | <positional_arg>
<named_arg>      ::= "--" <arg_name> <arg_value>?
<arg_name>       ::= [a-zA-Z][a-zA-Z0-9_-]*
<arg_value>      ::= <quoted_string> | <unquoted_value>
<positional_arg> ::= <quoted_string> | <unquoted_value>

<quoted_string>  ::= '"' <any_char>* '"' | "'" <any_char>* "'"
<unquoted_value> ::= [^\s|>\[\],]+

<global_flags>   ::= <flag_dry_run> | <flag_validate> | <flag_confirm>
                   | <flag_format> | <flag_limit> | <flag_offset>
<flag_dry_run>   ::= "--dry-run"
<flag_validate>  ::= "--validate"
<flag_confirm>   ::= "--confirm"
<flag_format>    ::= "--format" ("json" | "table" | "csv")
<flag_limit>     ::= "--limit" <integer>
<flag_offset>    ::= "--offset" <integer>

<jq_filter>      ::= "|" <jq_expr>
<jq_expr>        ::= "." <field_path>
                   | "[" <field_list> "]"
<field_path>     ::= <field_name> ("." <field_name>)*
<field_name>     ::= [a-zA-Z_][a-zA-Z0-9_]*
<field_list>     ::= "." <field_path> ("," "." <field_path>)*

<integer>        ::= [0-9]+
```

### 1.4 Estructura del AST (ParsedCommand)

```typescript
// Resultado principal del parser
interface ParseResult {
  type: "single" | "pipeline" | "batch";
  commands: ParsedCommand[];      // 1 para single, N para pipeline/batch
  raw: string;                    // Input original sin modificar
}

interface ParsedCommand {
  // Identificacion del comando
  namespace: string | null;       // null para builtins (search, help, etc.)
  command: string;                // Nombre del comando

  // Argumentos del comando
  args: CommandArgs;

  // Flags globales (modos de ejecucion)
  flags: GlobalFlags;

  // Filtro jq (si existe)
  jqFilter: JqFilter | null;

  // Metadata de parsing
  meta: ParseMeta;
}

interface CommandArgs {
  positional: string[];           // Argumentos sin nombre, en orden
  named: Record<string, string | boolean>;  // --key value o --flag (boolean)
}

interface GlobalFlags {
  dryRun: boolean;                // --dry-run
  validate: boolean;              // --validate
  confirm: boolean;               // --confirm
  format: "json" | "table" | "csv" | null;  // --format valor
  limit: number | null;           // --limit N
  offset: number | null;          // --offset N
}

interface JqFilter {
  raw: string;                    // Expresion jq tal cual fue escrita
  type: "field" | "multi_field";  // .campo vs [.campo1, .campo2]
  fields: string[];               // Lista de campos extraidos
}

interface ParseMeta {
  startPos: number;               // Posicion inicial en el input original
  endPos: number;                 // Posicion final en el input original
  rawSegment: string;             // Substring del input para este comando
}
```

### 1.5 Flujo Principal (Happy Path)

```
Input string
    |
    v
[Detectar tipo] --> batch?    --> Extraer lista de comandos --> Parsear cada uno
    |                pipeline? --> Separar por ">>"          --> Parsear cada uno
    |                single?   --> Continuar
    v
[Separar jq filter] --> Detectar "| ." --> Extraer expresion jq
    |
    v
[Extraer command_id] --> namespace:comando o builtin
    |
    v
[Extraer global_flags] --> --dry-run, --validate, --confirm, --format, --limit, --offset
    |
    v
[Extraer arguments] --> Posicionales y nombrados restantes
    |
    v
[Construir ParseResult]
    |
    v
Output: ParseResult
```

### 1.6 Inputs y Outputs

| Input | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| input | string | Si | El string completo del comando a parsear |

| Output | Tipo | Descripcion |
|--------|------|-------------|
| result | ParseResult | Estructura parseada del comando |
| error | ParseError | Error de sintaxis si el input es invalido |

### 1.7 Ejemplos de Parsing

#### Comando simple con namespace
```
Input:  "users:create --name 'John Doe' --email john@test.com --role admin"
Output: {
  type: "single",
  commands: [{
    namespace: "users",
    command: "create",
    args: {
      positional: [],
      named: { name: "John Doe", email: "john@test.com", role: "admin" }
    },
    flags: { dryRun: false, validate: false, confirm: false, format: null, limit: null, offset: null },
    jqFilter: null
  }]
}
```

#### Builtin con argumento posicional
```
Input:  "search crear usuarios con email"
Output: {
  type: "single",
  commands: [{
    namespace: null,
    command: "search",
    args: {
      positional: ["crear usuarios con email"],
      named: {}
    },
    flags: { dryRun: false, validate: false, confirm: false, format: null, limit: null, offset: null },
    jqFilter: null
  }]
}
```

#### Comando con flags globales y filtro jq
```
Input:  "orders:list --status pending --limit 5 --dry-run | .items"
Output: {
  type: "single",
  commands: [{
    namespace: "orders",
    command: "list",
    args: {
      positional: [],
      named: { status: "pending" }
    },
    flags: { dryRun: true, validate: false, confirm: false, format: null, limit: 5, offset: null },
    jqFilter: { raw: ".items", type: "field", fields: ["items"] }
  }]
}
```

#### Composicion (pipeline)
```
Input:  "users:get --id 123 >> orders:list --user-id $input.id"
Output: {
  type: "pipeline",
  commands: [
    {
      namespace: "users",
      command: "get",
      args: { positional: [], named: { id: "123" } },
      flags: { dryRun: false, validate: false, confirm: false, format: null, limit: null, offset: null },
      jqFilter: null
    },
    {
      namespace: "orders",
      command: "list",
      args: { positional: [], named: { "user-id": "$input.id" } },
      flags: { dryRun: false, validate: false, confirm: false, format: null, limit: null, offset: null },
      jqFilter: null
    }
  ]
}
```

#### Batch
```
Input:  'batch [users:count, orders:count --status pending, products:count]'
Output: {
  type: "batch",
  commands: [
    { namespace: "users", command: "count", args: { positional: [], named: {} }, ... },
    { namespace: "orders", command: "count", args: { positional: [], named: { status: "pending" } }, ... },
    { namespace: "products", command: "count", args: { positional: [], named: {} }, ... }
  ]
}
```

#### Filtro jq multi-campo
```
Input:  "users:get --id 42 | [.name, .email, .created_at]"
Output: {
  type: "single",
  commands: [{
    namespace: "users",
    command: "get",
    args: { positional: [], named: { id: "42" } },
    flags: { dryRun: false, validate: false, confirm: false, format: null, limit: null, offset: null },
    jqFilter: { raw: "[.name, .email, .created_at]", type: "multi_field", fields: ["name", "email", "created_at"] }
  }]
}
```

---

## 2. Que NO debe hacer (MUST NOT)

### 2.1 Fuera de Alcance

- No ejecutar comandos; solo parsear
- No validar que el namespace o comando existan en el registry
- No validar tipos de argumentos contra la definicion del comando
- No resolver referencias `$input.x` en pipelines (eso es del Executor)
- No evaluar expresiones jq complejas (solo extraer la expresion como string)
- No implementar un parser jq completo (solo field access simple y multi-field)
- No manejar autenticacion, permisos ni estado de sesion
- No realizar I/O (red, disco, base de datos)

### 2.2 Anti-patterns Prohibidos

- No usar `eval()` ni ejecucion dinamica de codigo sobre el input
- No usar expresiones regulares monoliticas para parsear toda la gramatica (usar tokenizacion + parsing recursivo)
- No mutar el input original (trabajar sobre copias)
- No lanzar excepciones no tipadas; siempre retornar ParseError estructurado
- No asumir encoding; normalizar a UTF-8 al inicio
- No hacer el parser stateful (cada llamada es independiente, sin memoria de comandos anteriores)

### 2.3 Restricciones de Implementacion

- No depender de librerias externas de parsing (implementar parser propio y liviano)
- No soportar sintaxis jq avanzada (pipes dentro del jq, funciones jq, etc.)
- No soportar escape de caracteres con backslash dentro de strings sin comillas
- No soportar anidamiento de batch (batch dentro de batch)
- No soportar composicion dentro de batch (>> dentro de batch)

---

## 3. Como se que esta bien (ACCEPTANCE)

### 3.1 Criterios de Aceptacion

```gherkin
Feature: Parsing de comandos simples con namespace

  DADO un string con formato "namespace:comando"
  CUANDO se parsea el input
  ENTONCES el resultado contiene namespace y command correctamente separados
  Y el type es "single"

Feature: Parsing de comandos builtin

  DADO un string que inicia con un builtin (search, describe, help, context, history, undo)
  CUANDO se parsea el input
  ENTONCES namespace es null
  Y command es el nombre del builtin
  Y el resto del string son argumentos posicionales

Feature: Extraccion de flags globales

  DADO un comando con flags globales (--dry-run, --validate, --confirm)
  CUANDO se parsea el input
  ENTONCES las flags se extraen al objeto GlobalFlags
  Y NO aparecen en args.named

Feature: Extraccion de --limit y --offset

  DADO un comando con --limit 10 --offset 5
  CUANDO se parsea el input
  ENTONCES flags.limit es 10 (numerico)
  Y flags.offset es 5 (numerico)
  Y NO aparecen en args.named

Feature: Deteccion de filtro jq simple

  DADO un comando seguido de "| .campo"
  CUANDO se parsea el input
  ENTONCES jqFilter no es null
  Y jqFilter.type es "field"
  Y jqFilter.fields contiene "campo"

Feature: Deteccion de filtro jq multi-campo

  DADO un comando seguido de "| [.campo1, .campo2]"
  CUANDO se parsea el input
  ENTONCES jqFilter.type es "multi_field"
  Y jqFilter.fields contiene ["campo1", "campo2"]

Feature: Deteccion de composicion

  DADO un input con ">>" separando dos comandos
  CUANDO se parsea el input
  ENTONCES type es "pipeline"
  Y commands contiene 2 ParsedCommand en orden

Feature: Deteccion de batch

  DADO un input que inicia con "batch [" y contiene comandos separados por coma
  CUANDO se parsea el input
  ENTONCES type es "batch"
  Y commands contiene N ParsedCommand (uno por cada comando en la lista)

Feature: Manejo de strings con comillas

  DADO un argumento cuyo valor contiene espacios entre comillas
  CUANDO se parsea el input
  ENTONCES el valor se extrae completo sin las comillas

Feature: Error de sintaxis

  DADO un input con sintaxis invalida
  CUANDO se parsea el input
  ENTONCES retorna un ParseError con code 1
  Y el mensaje indica la posicion y naturaleza del error
```

### 3.2 Casos de Prueba Requeridos

| ID | Escenario | Input | Output Esperado | Prioridad |
|----|-----------|-------|-----------------|-----------|
| T01 | Comando simple | `"users:list"` | namespace="users", command="list" | Alta |
| T02 | Comando con arg nombrado | `"users:get --id 42"` | named={id:"42"} | Alta |
| T03 | Comando con flag boolean | `"users:get --id 42 --verbose"` | named={id:"42", verbose:true} | Alta |
| T04 | Builtin search | `"search crear usuario"` | namespace=null, command="search", positional=["crear usuario"] | Alta |
| T05 | Flag --dry-run | `"users:delete --id 5 --dry-run"` | flags.dryRun=true, named={id:"5"} | Alta |
| T06 | Flag --format | `"users:list --format csv"` | flags.format="csv" | Alta |
| T07 | Flag --limit --offset | `"users:list --limit 10 --offset 20"` | flags.limit=10, flags.offset=20 | Alta |
| T08 | Filtro jq simple | `"users:get --id 1 \| .name"` | jqFilter.fields=["name"] | Alta |
| T09 | Filtro jq anidado | `"users:get --id 1 \| .address.city"` | jqFilter.fields=["address.city"] | Media |
| T10 | Filtro jq multi | `"users:get --id 1 \| [.name, .email]"` | jqFilter.fields=["name","email"] | Alta |
| T11 | Pipeline simple | `"users:get --id 1 >> orders:list"` | type="pipeline", 2 commands | Alta |
| T12 | Pipeline triple | `"a:b >> c:d >> e:f"` | type="pipeline", 3 commands | Media |
| T13 | Batch simple | `"batch [users:count, orders:count]"` | type="batch", 2 commands | Alta |
| T14 | Batch con args | `"batch [users:get --id 1, users:get --id 2]"` | type="batch", 2 commands con args | Alta |
| T15 | Comillas dobles | `'users:create --name "John Doe"'` | named={name:"John Doe"} | Alta |
| T16 | Comillas simples | `"users:create --name 'Jane Doe'"` | named={name:"Jane Doe"} | Alta |
| T17 | Multiples flags globales | `"x:y --dry-run --confirm --format json"` | dryRun=true, confirm=true, format="json" | Media |
| T18 | Input vacio | `""` | ParseError code=1 | Alta |
| T19 | Solo espacios | `"   "` | ParseError code=1 | Alta |
| T20 | Namespace invalido | `":comando"` | ParseError code=1 | Alta |
| T21 | Comando invalido | `"namespace:"` | ParseError code=1 | Alta |
| T22 | Formato invalido para --format | `"x:y --format xml"` | ParseError code=1 (format no soportado) | Media |
| T23 | --limit no numerico | `"x:y --limit abc"` | ParseError code=1 | Media |
| T24 | Batch sin cerrar | `"batch [a:b, c:d"` | ParseError code=1 | Media |
| T25 | Pipeline con jq | `"a:b >> c:d \| .result"` | pipeline, ultimo cmd tiene jqFilter | Media |
| T26 | Describe builtin | `"describe users:create"` | namespace=null, command="describe", positional=["users:create"] | Alta |
| T27 | Context set | `"context:set api_key sk-123"` | namespace="context", command="set", positional=["api_key","sk-123"] | Media |
| T28 | Argumento con guion | `"x:y --user-id 5"` | named={"user-id":"5"} | Media |
| T29 | Filtro jq sin espacio | `"x:y --id 1 |.name"` | jqFilter.fields=["name"] (tolerante a espacio) | Media |
| T30 | Comilla sin cerrar | `'x:y --name "John'` | ParseError code=1 | Alta |

### 3.3 Metricas de Exito

- [ ] Tiempo de parsing < 1ms para comandos simples (single command)
- [ ] Tiempo de parsing < 5ms para batch de 10 comandos
- [ ] 100% de cobertura en los casos de prueba listados
- [ ] 0 falsos positivos (input valido reportado como error)
- [ ] 0 falsos negativos (input invalido parseado sin error)

### 3.4 Definition of Done

- [ ] Implementacion completa del parser segun la gramatica definida
- [ ] Todos los tests de T01-T30 pasando
- [ ] Cobertura minima de tests: 95%
- [ ] Funcion pura: sin side effects, sin I/O, sin estado mutable compartido
- [ ] Tipos exportados (ParseResult, ParsedCommand, etc.) disponibles para otros modulos
- [ ] Documentacion inline de la API publica
- [ ] Benchmark de performance incluido en test suite

---

## 4. Que pasa si falla (ERROR HANDLING)

### 4.1 Errores Esperados

| Codigo | Condicion | Mensaje (template) | Posicion |
|--------|-----------|---------------------|----------|
| E_EMPTY_INPUT | Input vacio o solo whitespace | "Empty input: expected a command" | 0 |
| E_INVALID_NAMESPACE | Namespace no cumple regex valida | "Invalid namespace '{value}' at position {pos}" | pos del caracter invalido |
| E_MISSING_COMMAND | Namespace presente pero sin comando despues de ":" | "Expected command name after '{ns}:' at position {pos}" | pos despues de ":" |
| E_UNCLOSED_QUOTE | Comilla abierta sin cerrar | "Unclosed {type} quote starting at position {pos}" | pos de la comilla abierta |
| E_INVALID_FLAG_VALUE | --limit o --offset con valor no numerico | "Expected integer value for --{flag}, got '{value}' at position {pos}" | pos del valor |
| E_INVALID_FORMAT | --format con valor no soportado | "Invalid format '{value}'. Expected: json, table, csv" | pos del valor |
| E_UNCLOSED_BATCH | "batch [" sin "]" de cierre | "Unclosed batch: expected ']' to close batch started at position {pos}" | pos del "[" |
| E_EMPTY_BATCH | "batch []" sin comandos | "Empty batch: at least one command required" | pos del "[]" |
| E_INVALID_JQ | Filtro jq con sintaxis no reconocida | "Invalid jq filter syntax: '{expr}' at position {pos}" | pos del "|" |
| E_UNEXPECTED_TOKEN | Token no reconocido en contexto | "Unexpected token '{token}' at position {pos}" | pos del token |
| E_NESTED_BATCH | Batch dentro de batch | "Nested batch is not supported" | pos del batch interno |
| E_PIPELINE_IN_BATCH | ">>" dentro de batch | "Pipeline composition inside batch is not supported" | pos del ">>" |

### 4.2 Estructura de Error

```typescript
interface ParseError {
  code: number;             // Siempre 1 (error de sintaxis segun protocolo)
  errorType: string;        // Codigo de error especifico (E_EMPTY_INPUT, etc.)
  message: string;          // Mensaje legible
  position: number;         // Posicion en el input original
  length: number;           // Longitud del token problematico
  raw: string;              // Input original completo
  suggestion?: string;      // Sugerencia de correccion (opcional)
}
```

### 4.3 Estrategia de Errores

- **Fail fast**: Reportar el primer error encontrado (no intentar recuperarse)
- **Posicion precisa**: Siempre indicar donde esta el error en el input
- **Sin excepciones**: Usar Result type (union de ParseResult | ParseError)
- **Determinista**: El mismo input siempre produce el mismo error

### 4.4 Logging y Monitoreo

- Nivel de log: DEBUG para cada token consumido durante parsing
- Nivel de log: WARN para inputs que parsean pero son sospechosos (ej: argumentos nombrados sin valor seguidos de otro flag)
- No hay alertas (modulo sin side effects)
- Metrica a exponer: parse_duration_ms, parse_error_count (por tipo de error)

---

## 5. Que supuestos tiene (ASSUMPTIONS)

### 5.1 Precondiciones

- [ ] El input es un string no-null
- [ ] El input viene de `cli_exec(cmd)` ya trimmeado de whitespace exterior por la capa de transporte
- [ ] El encoding del input es UTF-8 valido
- [ ] El caller (Router/Executor) sabe manejar tanto ParseResult como ParseError

### 5.2 Dependencias

| Dependencia | Tipo | Version | Critica |
|-------------|------|---------|---------|
| Ninguna libreria externa | - | - | - |

El parser es un modulo **zero-dependency**. Solo depende del lenguaje base.

### 5.3 Datos de Entrada Esperados

- Formato: String plano UTF-8
- Longitud maxima esperada: 2048 caracteres (un comando razonable para un LLM)
- Caracteres especiales soportados: letras, numeros, guiones, guion bajo, puntos, comillas, corchetes, pipe, mayor-que, espacios, coma
- Caracteres no esperados en contexto normal: tabs, newlines, caracteres de control

### 5.4 Convenciones del Input

- Los namespaces y comandos son case-sensitive y se esperan en lowercase
- Los argumentos nombrados siempre inician con `--` (doble guion)
- No se soporta guion simple (`-f`) como shorthand de flags
- El separador de composicion es `>>` (doble mayor-que, no single `>`)
- El separador de jq es `|` (pipe simple)
- Los comandos en batch se separan con `,` (coma)
- Los espacios multiples entre tokens se colapsan (son equivalentes a uno solo)

---

## 6. Que limites tiene (CONSTRAINTS)

### 6.1 Limites Tecnicos

- Longitud maxima de input: 4096 caracteres (rechazar con error si se excede)
- Profundidad maxima de pipeline: 10 comandos encadenados con >>
- Tamano maximo de batch: 20 comandos
- Profundidad de campo jq: 5 niveles (`.a.b.c.d.e` maximo)
- Campos maximos en multi-field jq: 10 campos
- Tiempo maximo de parsing: 10ms (si se excede, hay un bug)

### 6.2 Limites de Negocio

- Solo se soportan los 6 flags globales definidos en el protocolo
- Solo se soportan los 3 formatos de output: json, table, csv
- Los builtins son un conjunto cerrado: search, describe, help, context, history, undo
- El parser NO valida si un namespace:comando existe; eso es responsabilidad del Router

### 6.3 Limites de Seguridad

- No ejecutar ni evaluar ningun contenido del input
- No expandir variables ni interpolacion (el string `$input.id` se pasa literal)
- Limitar longitud de input para prevenir ataques de complejidad
- No permitir caracteres de control (ASCII < 32 excepto espacio)
- Sanitizar el input de caracteres null (`\0`)

### 6.4 Limites de Alcance (esta version)

- Esta version NO incluye:
  - Parsing de expresiones jq complejas (solo field access)
  - Subcomandos anidados (parentesis para agrupacion)
  - Variables/interpolacion en argumentos
  - Heredocs o multi-line input
  - Argumentos con tipo validado (el parser trata todo como string)
  - Aliases de comandos
  - Wildcards en namespaces
- Consideraciones futuras:
  - Autocompletado basado en gramatica
  - Modo streaming para inputs muy largos
  - Soporte para comentarios en batch (lineas que inician con #)

---

## 7. Tabla de Precedencia y Ambiguedades

### 7.1 Reglas de Precedencia

| Situacion | Regla | Ejemplo |
|-----------|-------|---------|
| Flag global vs arg nombrado | Flags globales siempre se extraen primero | `--limit` es siempre global, nunca arg de comando |
| `|` jq vs `|` en valor | El pipe jq solo se detecta si va seguido de `.` o `[.` | `--msg "a | b"` se parsea como valor, no como jq |
| `>>` composicion vs en valor | `>>` solo es composicion si esta fuera de comillas | `--redirect ">>"` es un valor string |
| Batch vs namespace "batch" | "batch [" literal al inicio indica batch | `batch:algo` es namespace "batch", comando "algo" |
| `--flag` sin valor seguido de `--otro` | El primer flag es boolean (true) | `--verbose --id 5` -> verbose=true, id="5" |
| `--flag` al final del input | Es boolean (true) | `x:y --verbose` -> verbose=true |

### 7.2 Resolucion de Ambiguedades del Builtin `search`

El comando `search` trata TODO lo que sigue como un unico argumento posicional (la query de busqueda semantica), excepto flags globales.

```
"search crear usuario con email --limit 5"
  -> command: "search"
  -> positional: ["crear usuario con email"]
  -> flags: { limit: 5 }
```

### 7.3 Resolucion de Ambiguedades del Builtin `context:set`

`context:set` toma exactamente 2 argumentos posicionales: key y value.

```
"context:set api_key sk-12345"
  -> namespace: "context"
  -> command: "set"
  -> positional: ["api_key", "sk-12345"]
```

---

## Anexos

### A. Glosario

| Termino | Definicion |
|---------|------------|
| Namespace | Agrupador logico de comandos (ej: "users", "orders") |
| Builtin | Comando del sistema que no tiene namespace (search, help, etc.) |
| Flag global | Flag que modifica el modo de ejecucion, no es argumento del comando |
| Pipeline/Composicion | Encadenamiento de comandos donde el output de uno es input del siguiente |
| Batch | Ejecucion simultanea de multiples comandos independientes |
| jq filter | Expresion para extraer campos del output JSON |
| AST | Abstract Syntax Tree; representacion estructurada del input parseado |
| Positional arg | Argumento identificado por posicion, sin nombre explicito |
| Named arg | Argumento con nombre explicito precedido por -- |

### B. Referencias

- PRD Agent Shell: `d:/repos/agent-shell/docs/prd.md`
- jq manual (referencia de sintaxis): https://jqlang.github.io/jq/manual/
- Protocolo de interaccion: Seccion "Especificacion del Protocolo" del PRD

### C. Diagramas de Decision del Parser

```
                            Input String
                                |
                    +-----------+-----------+
                    |                       |
              starts with              does not
              "batch ["?               start with batch
                    |                       |
                    v                       v
              PARSE AS BATCH          contains ">>"
                                      outside quotes?
                                            |
                                    +-------+-------+
                                    |               |
                                   YES              NO
                                    |               |
                                    v               v
                              PARSE AS          PARSE AS
                              PIPELINE          SINGLE CMD
```

```
              Single Command Parsing
              ----------------------

              Tokens remaining
                    |
                    v
              Is "|" followed
              by "." or "[."?
                    |
              +-----+-----+
              |           |
             YES          NO
              |           |
              v           v
         Split into    Full string
         cmd + jq      is command
              |
              v
         Parse command part:
         1. Extract command_id (ns:cmd or builtin)
         2. Scan for global flags (extract and remove)
         3. Remaining tokens are args (named or positional)
```

### D. Historial de Cambios

| Version | Fecha | Autor | Cambios |
|---------|-------|-------|---------|
| 1.0 | 2026-01-22 | Specification Architect | Version inicial basada en PRD v1 |

---

## 9. Estado de Implementación v1.0

### Implementado
- Funcion `parse()` con firma exacta del contrato
- Todos los tipos exportados (ParseResult, ParsedCommand, CommandArgs, GlobalFlags, JqFilter, ParseMeta, ParseError)
- 6 builtins (search, describe, help, context, history, undo)
- 6 flags globales (dry-run, validate, confirm, format, limit, offset)
- Pipeline con validacion de profundidad (MAX_PIPELINE_DEPTH = 10)
- Batch con validacion de tamaño (MAX_BATCH_SIZE = 20)
- Input length validation (MAX_INPUT_LENGTH = 4096)
- Manejo especial de `search` (todo como argumento posicional)
- Errores adicionales no en contrato: E_PIPELINE_DEPTH, E_BATCH_SIZE, E_INVALID_JQ, E_INPUT_TOO_LONG

### Implementado (v1.1)
- Validacion de profundidad JQ (max 5 niveles) con error E_JQ_TOO_DEEP
- Validacion de cantidad de campos multi-field JQ (max 10) con error E_JQ_TOO_MANY_FIELDS
- Validacion de campo JQ contra regex `[a-zA-Z_][a-zA-Z0-9_]*` con error E_INVALID_JQ_FIELD
- Soporte de indices de array en JQ (`.[0].name`) via regex `^\[\d+\]$`
- Prevencion de batch anidado (E_NESTED_BATCH) y pipeline dentro de batch (E_PIPELINE_IN_BATCH)
- Validacion de caracteres de control (ASCII < 32 excepto tab/newline/CR) con error E_CONTROL_CHARACTER

### Pendiente
- Normalizacion UTF-8 al inicio del parse
- Logging (DEBUG por token, WARN por inputs sospechosos)
- Metricas (parse_duration_ms, parse_error_count)
