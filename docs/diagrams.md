# Diagramas: Agent Shell v1.0

> Generados a partir de los contratos de especificacion del sistema.
> Fecha: 2026-01-22

## Indice

1. [Diagrama de Componentes](#1-diagrama-de-componentes)
2. [Flujo del Pipeline (cli_exec)](#2-flujo-del-pipeline-cli_exec)
3. [Secuencia: Flujo Tipico de Agente](#3-secuencia-flujo-tipico-de-agente)
4. [Secuencia: Composicion (cmd1 >> cmd2)](#4-secuencia-composicion-cmd1--cmd2)
5. [Secuencia: Flujo Batch](#5-secuencia-flujo-batch)
6. [Diagrama de Estados: Ejecucion de Comando](#6-diagrama-de-estados-ejecucion-de-comando)
7. [ERD: Entidades del Sistema](#7-erd-entidades-del-sistema)

---

## 1. Diagrama de Componentes

Muestra todos los modulos del sistema y sus relaciones de dependencia segun los contratos.

```mermaid
---
title: Arquitectura de Componentes - Agent Shell
---
flowchart TB
    subgraph Agent["Agente LLM (2 tools)"]
        T1["cli_help()"]
        T2["cli_exec(cmd)"]
    end

    subgraph Core["Core (Orquestador)"]
        direction TB
        EP["Entry Points"]
        MW_PRE["Middleware PRE\n- Logging\n- Rate Limit\n- Timestamp"]
        ROUTER["Router\n(Tabla de Ruteo)"]
        MW_POST["Middleware POST\n- Logging salida\n- Timing\n- History append"]
        FORMATTER["Formatter\n(json|table|csv)"]
    end

    subgraph Modules["Modulos Especializados"]
        PARSER["Parser\n(Zero-dependency)\nparse(cmd) -> ParseResult"]
        EXECUTOR["Executor\n(Motor de Ejecucion)\nexecute(parsed, ctx) -> ExecResult"]
        SEARCH["Vector Index\n(Discovery Semantico)\nsearch(query) -> SearchResult[]"]
        REGISTRY["Command Registry\n(Almacen de Definiciones)\nresolve(id) -> RegisteredCommand"]
        JQ["JQ Filter\n(Subset jq)\napply(data, expr) -> filtered"]
        CONTEXT["Context Store\n(Estado de Sesion)\nget/set/history/undo"]
        SECURITY["Security\n(Transversal)\naudit/rbac/secrets/encrypt"]
    end

    subgraph Adapters["Adapters (Interfaces)"]
        EMB_ADAPTER["EmbeddingAdapter\n(OpenAI|Cohere|Ollama|Cloudflare)"]
        VEC_ADAPTER["VectorStorageAdapter\n(Memory|SQLite|pgvector|Qdrant)"]
        STORE_ADAPTER["StorageAdapter\n(Memory|Disk|Redis)"]
        ENC_ADAPTER["EncryptedStorageAdapter\n(AES-256-GCM wrapper)"]
    end

    subgraph Handlers["Command Handlers"]
        H1["Handler A"]
        H2["Handler B"]
        H3["Handler N..."]
    end

    T1 --> EP
    T2 --> EP
    EP --> MW_PRE
    MW_PRE --> PARSER
    PARSER --> ROUTER

    ROUTER -->|"type=search"| SEARCH
    ROUTER -->|"type=command"| EXECUTOR
    ROUTER -->|"type=describe"| REGISTRY
    ROUTER -->|"type=context\ntype=history\ntype=undo"| CONTEXT
    ROUTER -->|"type=batch\ntype=pipe"| Core

    EXECUTOR --> REGISTRY
    EXECUTOR --> CONTEXT

    SEARCH --> EMB_ADAPTER
    SEARCH --> VEC_ADAPTER
    SEARCH --> REGISTRY

    CONTEXT --> STORE_ADAPTER
    CONTEXT --> ENC_ADAPTER
    ENC_ADAPTER --> STORE_ADAPTER

    EXECUTOR --> SECURITY
    CONTEXT --> SECURITY

    REGISTRY --> H1
    REGISTRY --> H2
    REGISTRY --> H3

    EXECUTOR -.->|"post-ejecucion"| JQ
    JQ --> FORMATTER
    FORMATTER --> MW_POST

    style Core fill:#cce5ff
    style PARSER fill:#e8f5e9
    style EXECUTOR fill:#e8f5e9
    style SEARCH fill:#e8f5e9
    style REGISTRY fill:#e8f5e9
    style JQ fill:#e8f5e9
    style CONTEXT fill:#e8f5e9
    style SECURITY fill:#fff9c4
    style Agent fill:#fff3e0
    style Adapters fill:#fce4ec
```

**Notas:**
- Core es el unico punto de entrada (2 entry points: `cli_help`, `cli_exec`)
- Parser es zero-dependency y stateless
- Vector Index depende de EmbeddingAdapter y VectorStorageAdapter (patron Strategy)
- Context Store es agnostico al backend via StorageAdapter
- El Executor consulta al Registry para resolver handlers y al Context Store para permisos/estado
- Security es transversal: el Executor usa audit logging y el Context Store usa secret detection
- EncryptedStorageAdapter envuelve cualquier StorageAdapter para encriptacion transparente
- JQ Filter opera post-ejecucion, antes del Formatter

---

## 2. Flujo del Pipeline (cli_exec)

Pipeline completo desde que el Core recibe `cli_exec("comando")` hasta la respuesta final.

```mermaid
---
title: Pipeline de Procesamiento - cli_exec(cmd)
---
flowchart TD
    START(["cli_exec(cmd)"]) --> CHK_EMPTY{cmd vacio\no > 4096 chars?}

    CHK_EMPTY -->|Si| ERR_SYNTAX["Response\ncode=1\nerror: Syntax error"]
    CHK_EMPTY -->|No| MW_PRE["Middleware PRE\n- Log entrada\n- Rate limit check\n- Timestamp inicio"]

    MW_PRE --> RATE{Rate limit\nexcedido?}
    RATE -->|Si| ERR_RATE["Response\ncode=3\nerror: Rate limit exceeded"]
    RATE -->|No| PARSE["Parser.parse(cmd)"]

    PARSE --> PARSE_OK{Parse\nexitoso?}
    PARSE_OK -->|No| ERR_PARSE["Response\ncode=1\nerror: Syntax error + position"]
    PARSE_OK -->|Si| ROUTE{"Router:\nParseResult.type?"}

    ROUTE -->|search| SEARCH_MOD["Vector Index\nsearch(query, options)"]
    ROUTE -->|describe| REGISTRY_MOD["Registry\ndescribe(ns, cmd)"]
    ROUTE -->|context/history/undo| CONTEXT_MOD["Context Store\nget/set/list/undo"]
    ROUTE -->|command| EXEC_PIPELINE["Executor Pipeline"]
    ROUTE -->|batch| BATCH_LOOP["Core: Batch Loop\n(ejecutar cada cmd\nindependientemente)"]
    ROUTE -->|pipe| PIPE_CHAIN["Core: Pipe Chain\n(output N -> input N+1)"]

    subgraph ExecutorPipeline["Executor Pipeline (7 pasos)"]
        direction TB
        E1["1. RESOLVE\nBuscar handler en Registry"] --> E1_CHK{Existe?}
        E1_CHK -->|No| E_NF["code=2: Not Found"]
        E1_CHK -->|Si| E2["2. VALIDATE ARGS\nTipos, requeridos, constraints"]
        E2 --> E2_CHK{Valido?}
        E2_CHK -->|No| E_INV["code=1: Invalid Args"]
        E2_CHK -->|Si| E3["3. CHECK PERMISSIONS\nPermisos del contexto"]
        E3 --> E3_CHK{Permitido?}
        E3_CHK -->|No| E_FORB["code=3: Forbidden"]
        E3_CHK -->|Si| E4{"4. APPLY MODE\nflags?"}
        E4 -->|--validate| E_VAL["code=0\ndata: {valid: true}"]
        E4 -->|--dry-run| E_DRY["code=0\ndata: {wouldExecute, args, effect}"]
        E4 -->|--confirm| E_CONF["code=4\ndata: {preview, confirmToken}"]
        E4 -->|normal| E5["5. EXECUTE\nInvocar handler + timeout"]
        E5 --> E5_CHK{Exito?}
        E5_CHK -->|No/Timeout| E_FAIL["code=1: Handler error"]
        E5_CHK -->|Si| E6["6. RECORD HISTORY\nPersistir en historial"]
        E6 --> E7["7. RETURN\ncode=0, data=resultado"]
    end

    EXEC_PIPELINE --> E1

    SEARCH_MOD --> JQ_CHECK
    REGISTRY_MOD --> JQ_CHECK
    CONTEXT_MOD --> JQ_CHECK
    E7 --> JQ_CHECK
    E_VAL --> JQ_CHECK
    E_DRY --> JQ_CHECK
    BATCH_LOOP --> JQ_CHECK
    PIPE_CHAIN --> JQ_CHECK

    JQ_CHECK{"jqFilter\nen ParseResult?"}
    JQ_CHECK -->|Si| JQ_APPLY["JQ Filter\napply(data, expression)"]
    JQ_CHECK -->|No| FORMAT

    JQ_APPLY --> FORMAT["Formatter\n--format (json|table|csv)"]
    FORMAT --> MW_POST["Middleware POST\n- Log salida\n- Duration calc\n- History append"]
    MW_POST --> RESPONSE(["Response\n{code, data, error, meta}"])

    style ERR_SYNTAX fill:#ffcccc
    style ERR_RATE fill:#ffcccc
    style ERR_PARSE fill:#ffcccc
    style E_NF fill:#ffcccc
    style E_INV fill:#ffcccc
    style E_FORB fill:#ffcccc
    style E_FAIL fill:#ffcccc
    style E_CONF fill:#ffffcc
    style RESPONSE fill:#ccffcc
    style E7 fill:#ccffcc
    style E_VAL fill:#cce5ff
    style E_DRY fill:#cce5ff
```

**Notas:**
- Corresponde a la seccion 1.4 del contrato Core
- Los errores siempre se envuelven en Response estandar (nunca escapan sin formato)
- El JQ Filter se aplica sobre el data de cualquier subsistema, no solo del Executor
- Timeouts configurables por subsistema (Parser: 100ms, Search: 2000ms, Executor: 5000ms, JQ: 500ms)

---

## 3. Secuencia: Flujo Tipico de Agente

Flujo completo: help -> search -> dry-run -> exec con jq. Corresponde a la seccion "Flujo de Interaccion Tipico" del PRD.

```mermaid
---
title: Secuencia - Flujo Tipico de Agente LLM
---
sequenceDiagram
    autonumber

    actor A as Agente LLM
    participant C as Core
    participant P as Parser
    participant R as Router
    participant VI as Vector Index
    participant REG as Registry
    participant EX as Executor
    participant JQ as JQ Filter
    participant CTX as Context Store

    Note over A: 1. Agente recibe tarea del usuario

    A->>C: cli_help()
    C-->>A: Protocolo de interaccion completo<br/>(Descubrimiento, Ejecucion, Filtrado,<br/>Composicion, Batch, Estado, Errores)

    Note over A: 2. Agente busca comandos relevantes

    A->>C: cli_exec("search crear usuario con email")
    C->>P: parse("search crear usuario con email")
    P-->>C: ParseResult {type: "single", command: "search",<br/>positional: ["crear usuario con email"]}
    C->>R: route(ParseResult)
    R->>VI: search("crear usuario con email", {limit: 5})
    VI->>VI: embed(query) -> vector
    VI->>VI: similarity_search(vector, topK=5)
    VI-->>R: SearchResponse {results: [{score: 0.94,<br/>commandId: "users:create", signature: "..."}]}
    R-->>C: Response {code: 0, data: results}
    C-->>A: Response con comandos relevantes

    Note over A: 3. Agente simula ejecucion (dry-run)

    A->>C: cli_exec("users:create --name Juan --email j@t.com --dry-run")
    C->>P: parse("users:create --name Juan ...")
    P-->>C: ParseResult {type: "single", ns: "users",<br/>cmd: "create", flags: {dryRun: true}}
    C->>R: route(ParseResult)
    R->>EX: execute(parsed, context)
    EX->>REG: resolve("users:create")
    REG-->>EX: RegisteredCommand {definition, handler}
    EX->>EX: validateArgs(args, definition)
    EX->>EX: checkPermissions(context)
    EX->>EX: mode=dry-run -> simular
    EX-->>R: ExecResult {code: 0, data: {wouldExecute:<br/>"users:create", withArgs: {...}}}
    R-->>C: Response {code: 0, meta.mode: "dry-run"}
    C-->>A: Preview de lo que haria

    Note over A: 4. Agente ejecuta con filtro jq

    A->>C: cli_exec("users:create --name Juan --email j@t.com | .id")
    C->>P: parse("users:create ... | .id")
    P-->>C: ParseResult {type: "single", ns: "users",<br/>cmd: "create", jqFilter: {fields: ["id"]}}
    C->>R: route(ParseResult)
    R->>EX: execute(parsed, context)
    EX->>REG: resolve("users:create")
    REG-->>EX: RegisteredCommand
    EX->>EX: validateArgs + checkPermissions
    EX->>EX: handler(args) -> {id: 42, name: "Juan", email: "j@t.com"}
    EX->>CTX: recordCommand(historyEntry)
    EX-->>R: ExecResult {code: 0, data: {id: 42, name: "Juan", ...}}
    R-->>C: data = {id: 42, name: "Juan", ...}
    C->>JQ: apply({id: 42, ...}, ".id")
    JQ-->>C: 42
    C-->>A: Response {code: 0, data: 42}

    Note over A: 5. Agente responde al usuario con el dato obtenido
```

**Notas:**
- El agente solo consume ~600 tokens constantes de definicion de tools
- El search vectorial permite descubrir cualquier comando sin listado previo
- El dry-run no registra en historial ni ejecuta el handler real
- El JQ Filter reduce los tokens de respuesta extrayendo solo el campo necesario

---

## 4. Secuencia: Composicion (cmd1 >> cmd2)

Flujo de composicion donde el output de un comando es input del siguiente. Definido en seccion 1.6 del contrato Executor.

```mermaid
---
title: Secuencia - Composicion Pipeline (cmd1 >> cmd2)
---
sequenceDiagram
    autonumber

    actor A as Agente LLM
    participant C as Core
    participant P as Parser
    participant EX as Executor
    participant REG as Registry
    participant CTX as Context Store

    A->>C: cli_exec("users:get --id 123 >> orders:list --user-id $input.id")

    C->>P: parse("users:get --id 123 >> orders:list --user-id $input.id")
    P-->>C: ParseResult {type: "pipeline",<br/>commands: [cmd1, cmd2]}

    Note over C: Core detecta type=pipeline<br/>Ejecuta secuencialmente

    rect rgb(230, 245, 255)
        Note over C,CTX: Paso 1: Ejecutar cmd1 (users:get --id 123)
        C->>EX: execute(cmd1, context)
        EX->>REG: resolve("users:get")
        REG-->>EX: RegisteredCommand
        EX->>EX: validateArgs({id: "123"})
        EX->>EX: checkPermissions
        EX->>EX: handler({id: 123})
        EX->>CTX: recordCommand(entry)
        EX-->>C: ExecResult {code: 0,<br/>data: {id: 123, name: "Juan", email: "j@t.com"}}
    end

    C->>C: Verificar code=0 (exito)
    C->>C: $input = cmd1.data

    rect rgb(230, 255, 230)
        Note over C,CTX: Paso 2: Ejecutar cmd2 con $input resuelto
        C->>C: Resolver $input.id -> 123
        Note over C: args: {user-id: "123"}<br/>(resuelto desde cmd1.data.id)
        C->>EX: execute(cmd2_resuelto, context)
        EX->>REG: resolve("orders:list")
        REG-->>EX: RegisteredCommand
        EX->>EX: validateArgs({user-id: "123"})
        EX->>EX: checkPermissions
        EX->>EX: handler({userId: 123})
        EX->>CTX: recordCommand(entry)
        EX-->>C: ExecResult {code: 0,<br/>data: [{orderId: 1, total: 50}, {orderId: 2, total: 30}]}
    end

    C-->>A: PipelineResult {code: 0,<br/>data: [{orderId: 1}, {orderId: 2}],<br/>meta: {steps: [step1, step2], failedAt: null}}

    Note over A: Si cmd1 hubiera fallado:<br/>Pipeline aborta, retorna error de cmd1,<br/>cmd2 NO se ejecuta
```

**Notas:**
- Las referencias `$input.campo` se resuelven al valor del output del paso anterior
- Si un paso falla, el pipeline aborta inmediatamente (no hay rollback)
- Los flags globales del primer comando aplican a todo el pipeline (ej: --dry-run)
- Cada paso se registra en historial de forma independiente
- Profundidad maxima: 10 comandos encadenados

---

## 5. Secuencia: Flujo Batch

Ejecucion de multiples comandos independientes. Definido en seccion 1.7 del contrato Executor.

```mermaid
---
title: Secuencia - Ejecucion Batch
---
sequenceDiagram
    autonumber

    actor A as Agente LLM
    participant C as Core
    participant P as Parser
    participant EX as Executor
    participant REG as Registry
    participant CTX as Context Store

    A->>C: cli_exec("batch [users:count, orders:count --status pending, products:count]")

    C->>P: parse("batch [users:count, orders:count ...]")
    P-->>C: ParseResult {type: "batch",<br/>commands: [cmd1, cmd2, cmd3]}

    Note over C: Core detecta type=batch<br/>Ejecuta cada cmd independientemente<br/>Un fallo NO detiene los demas

    rect rgb(230, 245, 255)
        Note over C,CTX: Comando 1: users:count
        C->>EX: execute(cmd1, context)
        EX->>REG: resolve("users:count")
        REG-->>EX: RegisteredCommand
        EX->>EX: pipeline completo (resolve->validate->perms->execute)
        EX->>CTX: recordCommand
        EX-->>C: ExecResult {code: 0, data: {count: 150}}
    end

    rect rgb(255, 235, 235)
        Note over C,CTX: Comando 2: orders:count --status pending (FALLA)
        C->>EX: execute(cmd2, context)
        EX->>REG: resolve("orders:count")
        REG-->>EX: Error: COMMAND_NOT_FOUND
        EX-->>C: ExecResult {code: 2, error: "Command 'orders:count' not found"}
    end

    Note over C: Error en cmd2 NO detiene el batch

    rect rgb(230, 255, 230)
        Note over C,CTX: Comando 3: products:count
        C->>EX: execute(cmd3, context)
        EX->>REG: resolve("products:count")
        REG-->>EX: RegisteredCommand
        EX->>EX: pipeline completo
        EX->>CTX: recordCommand
        EX-->>C: ExecResult {code: 0, data: {count: 75}}
    end

    C->>C: Agregar resultados<br/>succeeded=2, failed=1<br/>code = 1 (alguno fallo)

    C-->>A: BatchResult {<br/>  code: 1,<br/>  results: [<br/>    {code: 0, data: {count: 150}},<br/>    {code: 2, error: "not found"},<br/>    {code: 0, data: {count: 75}}<br/>  ],<br/>  meta: {total: 3, succeeded: 2, failed: 1}<br/>}
```

**Notas:**
- Los comandos batch son independientes (no comparten estado entre ellos)
- Un fallo en un comando NO aborta los demas (a diferencia del pipeline)
- El code final del BatchResult es 0 solo si TODOS fueron exitosos
- Cada comando se registra en historial individualmente
- Tamano maximo de batch: 50 comandos (contrato Core) / 20 (contrato Executor)
- Ejecucion secuencial en v1 (no paralelo)

---

## 6. Diagrama de Estados: Ejecucion de Comando

Ciclo de vida de un comando desde su ingreso hasta la respuesta. Basado en el pipeline de 7 pasos del contrato Executor.

```mermaid
---
title: Estados de Ejecucion de un Comando
---
stateDiagram-v2
    [*] --> Received: cli_exec(cmd)

    Received --> Parsing: Middleware PRE ok
    Received --> Rejected: Rate limit excedido (code=3)

    Parsing --> Parsed: Parser.parse() exitoso
    Parsing --> SyntaxError: Parser retorna ParseError (code=1)

    Parsed --> Routing: ParseResult valido

    Routing --> Resolving: type=command
    Routing --> Searching: type=search
    Routing --> ContextOp: type=context/history/undo
    Routing --> BatchProcessing: type=batch
    Routing --> PipeProcessing: type=pipe

    state ExecutorPipeline {
        Resolving --> Validating: Handler encontrado
        Resolving --> NotFound: Comando no existe (code=2)

        Validating --> CheckingPerms: Args validos
        Validating --> InvalidArgs: Args invalidos (code=1)

        CheckingPerms --> ApplyingMode: Permisos OK
        CheckingPerms --> Forbidden: Sin permisos (code=3)

        ApplyingMode --> ValidateMode: --validate
        ApplyingMode --> DryRunMode: --dry-run
        ApplyingMode --> ConfirmMode: --confirm
        ApplyingMode --> Executing: modo normal

        ValidateMode --> Success: data={valid: true}
        DryRunMode --> Success: data={wouldExecute, effect}
        ConfirmMode --> AwaitingConfirm: code=4, confirmToken

        Executing --> ExecutionSuccess: Handler retorna data
        Executing --> ExecutionTimeout: Timeout excedido (code=1)
        Executing --> HandlerError: Handler lanza error (code=1)

        ExecutionSuccess --> RecordingHistory: Persistir en historial
    end

    RecordingHistory --> Filtering: historyId asignado
    Searching --> Filtering: SearchResult[]
    ContextOp --> Filtering: ContextData
    BatchProcessing --> Filtering: BatchResult
    PipeProcessing --> Filtering: PipelineResult

    Filtering --> Formatting: jqFilter? apply()
    Filtering --> Formatting: sin filtro

    Formatting --> PostMiddleware: format aplicado

    PostMiddleware --> Success: Response construida

    AwaitingConfirm --> [*]: Agente decide confirmar o cancelar

    Success --> [*]: Response {code: 0, data, meta}
    Rejected --> [*]: Response {code: 3, error}
    SyntaxError --> [*]: Response {code: 1, error}
    NotFound --> [*]: Response {code: 2, error}
    InvalidArgs --> [*]: Response {code: 1, error}
    Forbidden --> [*]: Response {code: 3, error}
    ExecutionTimeout --> [*]: Response {code: 1, error}
    HandlerError --> [*]: Response {code: 1, error}

    note right of Received
        Cmd max: 4096 chars
        Rate limit: 120 req/min
    end note

    note right of Executing
        Timeout configurable
        Default: 30s (Executor)
    end note

    note right of RecordingHistory
        Solo en modo normal
        No en dry-run/validate/confirm
    end note

    note right of AwaitingConfirm
        Token TTL: 5 minutos
        Si expira -> code=2
    end note
```

**Notas:**
- Solo el modo "normal" registra en historial
- El estado AwaitingConfirm requiere una nueva llamada `cli_exec("confirm <token>")` para continuar
- Todos los estados terminales producen un Response estandar con codigo 0-4
- El timeout es configurable por subsistema

---

## 7. ERD: Entidades del Sistema

Entidades principales definidas en los contratos: CommandDefinition, HistoryEntry, ContextEntry, UndoSnapshot, SearchResult.

```mermaid
---
title: ERD - Entidades del Sistema Agent Shell
---
erDiagram
    CommandDefinition {
        string namespace "Agrupacion logica (ej: users)"
        string name "Nombre del comando (ej: create)"
        string version "Semver X.Y.Z"
        string description "Descripcion concisa para LLM"
        string longDescription "Descripcion extendida (opcional)"
        string example "Uso real con filtro jq"
        string_array tags "Tags para busqueda semantica"
        boolean reversible "Soporta undo"
        boolean requiresConfirmation "Requiere --confirm"
        boolean deprecated "Marcado como deprecado"
        string deprecatedMessage "Mensaje de migracion (opcional)"
    }

    CommandParam {
        string name "Nombre del parametro (sin --)"
        string type "int|float|string|bool|date|json|enum|array"
        boolean required "Si es obligatorio"
        any default_value "Valor por defecto (si no required)"
        string constraints "Restricciones inline (>0, min:2, etc)"
        string description "Descripcion corta"
    }

    OutputShape {
        string type "Forma del output (ej: {id, name})"
        string description "Descripcion del output"
    }

    RegisteredCommand {
        string id "namespace:name (PK compuesto)"
        datetime registeredAt "Momento del registro"
        function handler "Funcion que ejecuta el comando"
        function undoHandler "Funcion de reversion (opcional)"
        function dryRunHandler "Simulador (opcional)"
    }

    HistoryEntry {
        string id PK "ID unico (ej: cmd_001)"
        string command "Comando completo ejecutado"
        string namespace "Namespace del comando"
        json args "Argumentos parseados"
        datetime executed_at "Timestamp de ejecucion"
        int duration_ms "Duracion en ms"
        int exit_code "Codigo de salida (0-4)"
        string result_summary "Resumen truncado (256 chars)"
        boolean undoable "Si es reversible"
        string undo_status "available|applied|expired|null"
        string snapshot_id FK "Ref al UndoSnapshot"
    }

    ContextEntry {
        string key PK "Nombre de la clave"
        any value "Valor almacenado (JSON-serializable)"
        string type "string|number|boolean|object|array"
        datetime set_at "Timestamp de creacion"
        datetime updated_at "Timestamp de actualizacion"
        int version "Incrementa en cada update"
    }

    UndoSnapshot {
        string id PK "ID unico del snapshot"
        string command_id FK "ID del comando asociado"
        datetime created_at "Timestamp de creacion"
        json state_before "Estado previo relevante"
        string rollback_command "Comando inverso (opcional)"
        json metadata "Info adicional del handler"
    }

    SearchResultItem {
        string commandId "namespace:command"
        float score "Similaridad 0.0-1.0"
        string command "Nombre del comando"
        string namespace "Namespace"
        string description "Descripcion corta"
        string signature "Firma compacta AI-optimizada"
        string example "Ejemplo de uso"
    }

    VectorEntry {
        string id PK "namespace:command"
        float_array vector "Embedding (N dimensiones)"
        datetime indexedAt "Timestamp de indexacion"
        string version "Version del comando indexado"
    }

    SessionStore {
        string session_id PK "UUID de la sesion"
        string adapter "Nombre del adaptador activo"
        boolean degraded "Si esta en modo fallback"
        string_array warnings "Warnings activos"
    }

    ExecutionResult {
        int code "0|1|2|3|4"
        boolean success "Si fue exitoso"
        any data "Resultado (null si error)"
        string mode "normal|dry-run|validate|confirm"
        int duration_ms "Tiempo de ejecucion"
        string historyId "ID en historial (nullable)"
        boolean reversible "Si soporta undo"
    }

    ParseResult {
        string type "single|pipeline|batch"
        string raw "Input original sin modificar"
    }

    ParsedCommand {
        string namespace "null para builtins"
        string command "Nombre del comando"
        json args_positional "Argumentos sin nombre"
        json args_named "Argumentos con nombre"
        boolean flag_dryRun "--dry-run"
        boolean flag_validate "--validate"
        boolean flag_confirm "--confirm"
        string flag_format "json|table|csv|null"
        int flag_limit "--limit N (nullable)"
        int flag_offset "--offset N (nullable)"
        string jqFilter_raw "Expresion jq (nullable)"
    }

    CommandDefinition ||--|{ CommandParam : "tiene params"
    CommandDefinition ||--|| OutputShape : "define output"
    CommandDefinition ||--|| RegisteredCommand : "se registra como"
    RegisteredCommand ||--o{ HistoryEntry : "genera al ejecutar"
    HistoryEntry ||--o| UndoSnapshot : "tiene snapshot si undoable"
    SessionStore ||--|{ ContextEntry : "contiene"
    SessionStore ||--|{ HistoryEntry : "almacena"
    SessionStore ||--|{ UndoSnapshot : "gestiona"
    CommandDefinition ||--o| VectorEntry : "se indexa como"
    VectorEntry ||--o{ SearchResultItem : "produce al buscar"
    ParseResult ||--|{ ParsedCommand : "contiene 1..N"
    RegisteredCommand ||--o{ ExecutionResult : "produce al ejecutar"
```

**Notas:**
- CommandDefinition es la entidad central que alimenta tanto al Vector Index (discovery) como al Executor (ejecucion)
- HistoryEntry y UndoSnapshot estan en el Context Store, gestionados por sesion
- SearchResultItem es una proyeccion de VectorEntry + CommandMetadata, no se persiste
- ExecutionResult es efimero (se retorna al agente, no se almacena directamente)
- ParseResult/ParsedCommand son estructuras transitorias del pipeline

---

## Resumen de Interfaces Clave

| Modulo | Interface Principal | Contrato |
|--------|--------------------| ---------|
| Core | `help(): string`, `exec(cmd): Response` | core.md |
| Parser | `parse(cmd): ParseResult \| ParseError` | parser.md |
| Registry | `register(def, handler)`, `resolve(id)`, `toCompactText(def)` | command-registry.md |
| Vector Index | `search()`, `indexCommand()`, `indexBatch()`, `sync()` | vector-index.md |
| Executor | `execute()`, `confirm()`, `revokeConfirm()`, `undo()` | executor.md |
| JQ Filter | `applyFilter(data, expression): FilterResult` | jq-filter.md |
| Context Store | `get()`, `set()`, `getAll()`, `recordCommand()`, `undo()` | context-store.md |
| Security | `AuditLogger`, `RBAC`, `maskSecrets()`, `containsSecret()` | security.md |

---

## Convenciones de los Diagramas

| Color | Significado |
|-------|-------------|
| Verde claro (`#ccffcc` / `#e8f5e9`) | Exito, modulos especializados |
| Rojo claro (`#ffcccc` / `rgb(255,235,235)`) | Errores, fallos |
| Azul claro (`#cce5ff` / `rgb(230,245,255)`) | Info, modos especiales |
| Amarillo claro (`#ffffcc`) | Requiere atencion (confirm) |
| Naranja claro (`#fff3e0`) | Agente externo |
| Rosa claro (`#fce4ec`) | Adapters/interfaces externas |
