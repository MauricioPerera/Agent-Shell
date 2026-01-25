# Contrato: MINIMEMORY COMMANDS

> **Version**: 1.0
> **Fecha**: 2026-01-24
> **Estado**: Draft
> **Sistema**: Agent Shell
> **Modulo**: minimemory-commands (namespace `mm:`)
> **Dependencias**: command-registry, vector-index, minimemory (napi-rs binding)

## Resumen Ejecutivo

El modulo minimemory-commands expone las capacidades de la libreria minimemory (VectorDB + AgentMemory) como comandos del namespace `mm:` en Agent Shell. Permite al agente AI realizar busquedas vectoriales HNSW, busquedas BM25 por keywords, busquedas hibridas con fusion RRF, almacenar/recuperar experiencias de tareas, snippets de codigo y soluciones a errores, y persistir toda la memoria a disco. Los 21 comandos son descubribles via busqueda semantica gracias a sus tags descriptivos.

---

## 1. Que debe hacer (MUST DO)

### 1.1 Objetivo Principal

Actuar como puente entre Agent Shell y la libreria nativa minimemory, exponiendo sus operaciones de VectorDB y AgentMemory como comandos ejecutables dentro del sistema de namespaces. Cada comando wrappea una operacion del `MiniMemoryApiAdapter` con parseo de argumentos, manejo de errores y respuesta estandarizada.

### 1.2 Funcionalidades Requeridas

- [ ] **Registro de 21 comandos** en el namespace `mm:` con su metadata completa
- [ ] **Parseo de JSON strings** para parametros tipo `json` (vector, metadata, filter, learnings, etc.)
- [ ] **Respuesta uniforme** `{ success: boolean, data: any, error?: string }` en todos los handlers
- [ ] **Manejo de errores** con try/catch en cada handler, sin excepciones al exterior
- [ ] **Tags descriptivos** en cada comando para discovery semantico via Vector Index
- [ ] **Confirmacion** en operaciones destructivas (mm:delete requiere `confirm: true`)
- [ ] **Undoable** en operaciones reversibles (mm:insert con `undoable: true`)
- [ ] **Conversion de tipos** para top_k (string a int), vector_weight (string a float), value (coercion automatica)

### 1.3 Catalogo de Comandos

#### Grupo VectorDB (10 comandos)

| Comando | Descripcion | Params Requeridos | Flags |
|---------|-------------|-------------------|-------|
| mm:stats | Estadisticas de la DB | (ninguno) | - |
| mm:insert | Insertar documento | --id | undoable |
| mm:delete | Eliminar documento | --id | confirm |
| mm:get | Obtener documento por ID | --id | - |
| mm:search | Busqueda vectorial HNSW | --vector | - |
| mm:keywords | Busqueda BM25 full-text | --query | - |
| mm:hybrid | Busqueda hibrida RRF | (al menos uno de vector/keywords/filter) | - |
| mm:filter | Busqueda por metadata | --field, --operator, --value | - |
| mm:save | Persistir a disco | (ninguno, path opcional) | - |
| mm:load | Cargar de disco | (ninguno, path opcional) | - |

#### Grupo AgentMemory (11 comandos)

| Comando | Descripcion | Params Requeridos | Flags |
|---------|-------------|-------------------|-------|
| mm:learn | Aprender tarea completada | --task, --solution, --outcome | - |
| mm:recall | Recordar experiencias | --query | - |
| mm:learn-code | Almacenar snippet | --code, --description, --language, --use_case | - |
| mm:recall-code | Buscar snippets | --query | - |
| mm:learn-error | Registrar solucion a error | --error_message, --error_type, --root_cause, --solution, --language | - |
| mm:recall-errors | Buscar soluciones a errores | --query | - |
| mm:context | Set/get contexto de trabajo | (ninguno para get; project/task/goals para set) | - |
| mm:focus | Enfocar en proyecto | --project | - |
| mm:memory-stats | Stats de agent memory | (ninguno) | - |
| mm:save-memory | Guardar memoria | --path | - |
| mm:load-memory | Cargar memoria | --path | - |

### 1.4 Flujos Principales

```
Registro (bootstrap):
  App -> crea MiniMemoryApiAdapter con config (dimensions, distance, indexType, etc.)
      -> llama createMiniMemoryCommands(api)
      -> recibe array de 21 CommandDefinitions con handlers
      -> registra en CommandRegistry
      -> Vector Index indexa descriptions + tags para discovery

Ejecucion (runtime):
  Agent -> "mm:insert --id doc-1 --metadata '{\"title\":\"Test\"}'"
        -> Core parse + resolve -> encuentra mm:insert en registry
        -> Executor llama handler con args: { id: "doc-1", metadata: "{\"title\":\"Test\"}" }
        -> Handler parsea JSON string a objeto
        -> Handler llama api.insert({ id, metadata })
        -> Handler retorna { success: true, data: { id, hasVector, metadataKeys } }
        -> Core envuelve en Response: { code: 0, data: {...}, meta: {...} }

Discovery (semantic search):
  Agent -> "search recordar codigo similar"
        -> Vector Index busca embeddings similares a la query
        -> Encuentra mm:recall-code (tags: recall, code, snippet, search, find, pattern)
        -> Retorna definicion compacta al agente
```

### 1.5 Inputs y Outputs por Comando

#### mm:stats

| Input | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| (ninguno) | - | - | - |

| Output | Tipo | Descripcion |
|--------|------|-------------|
| data.count | int | Cantidad de documentos |
| data.dimensions | int | Dimensiones del vector |
| data.distance | string | Metrica de distancia (cosine/euclidean/dot_product) |
| data.indexType | string | Tipo de indice (flat/hnsw) |
| data.hasFulltext | boolean | Si tiene BM25 habilitado |
| data.quantization | string | Tipo de quantizacion |

#### mm:insert

| Input | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| id | string | Si | ID unico del documento |
| vector | json | No | Vector de embedding (array de floats) |
| metadata | json | No | Metadata del documento (objeto JSON) |
| content | string | No | Contenido textual para full-text search |

| Output | Tipo | Descripcion |
|--------|------|-------------|
| data.id | string | ID del documento insertado |
| data.hasVector | boolean | Si se incluyo vector |
| data.metadataKeys | string[] | Keys de la metadata |

#### mm:delete

| Input | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| id | string | Si | ID del documento a eliminar |

| Output | Tipo | Descripcion |
|--------|------|-------------|
| data.deleted | string | ID del documento eliminado |

#### mm:get

| Input | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| id | string | Si | ID del documento |

| Output | Tipo | Descripcion |
|--------|------|-------------|
| data.id | string | ID del documento |
| data.vector | number[] o null | Vector almacenado |
| data.metadata | object | Metadata del documento |

#### mm:search

| Input | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| vector | json | Si | Vector de consulta (array de floats) |
| top_k | int | No | Cantidad de resultados (default: 5) |

| Output | Tipo | Descripcion |
|--------|------|-------------|
| data.count | int | Cantidad de resultados retornados |
| data.results | SearchResult[] | Array de {id, distance, score, metadata} |

#### mm:keywords

| Input | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| query | string | Si | Terminos de busqueda |
| top_k | int | No | Cantidad de resultados (default: 10) |

| Output | Tipo | Descripcion |
|--------|------|-------------|
| data.query | string | Query original |
| data.count | int | Cantidad de resultados |
| data.results | SearchResult[] | Array de resultados |

#### mm:hybrid

| Input | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| vector | json | No | Vector de consulta |
| keywords | string | No | Terminos para BM25 |
| filter | json | No | Filtro de metadata |
| top_k | int | No | Cantidad de resultados (default: 10) |
| vector_weight | float | No | Peso vector vs keywords 0.0-1.0 (default: 0.7) |

| Output | Tipo | Descripcion |
|--------|------|-------------|
| data.keywords | string o null | Keywords usados |
| data.hasVector | boolean | Si se uso vector |
| data.hasFilter | boolean | Si se uso filtro |
| data.count | int | Cantidad de resultados |
| data.results | SearchResult[] | Array de resultados |

#### mm:filter

| Input | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| field | string | Si | Campo de metadata |
| operator | string | Si | Operador: eq, ne, gt, gte, lt, lte, contains, starts_with |
| value | string | Si | Valor a comparar (se convierte a number/boolean si aplica) |
| top_k | int | No | Cantidad de resultados (default: 20) |

| Output | Tipo | Descripcion |
|--------|------|-------------|
| data.filter | object | {field, operator, value} aplicado |
| data.count | int | Cantidad de resultados |
| data.results | SearchResult[] | Array de resultados |

#### mm:save

| Input | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| path | string | No | Ruta del archivo .mmdb (usa la ruta configurada si se omite) |

| Output | Tipo | Descripcion |
|--------|------|-------------|
| data.saved | string | Path donde se guardo |

#### mm:load

| Input | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| path | string | No | Ruta del archivo .mmdb a cargar |

| Output | Tipo | Descripcion |
|--------|------|-------------|
| data.loaded | string | Path desde donde se cargo |
| data.count | int | Cantidad de documentos cargados |

#### mm:learn

| Input | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| task | string | Si | Descripcion de la tarea realizada |
| solution | string | Si | Solucion aplicada |
| outcome | string | Si | Resultado: success, failure, o partial |
| learnings | json | No | Array de lecciones aprendidas |

| Output | Tipo | Descripcion |
|--------|------|-------------|
| data.task | string | Tarea registrada |
| data.outcome | string | Resultado |
| data.learnings | int | Cantidad de learnings |

#### mm:recall

| Input | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| query | string | Si | Descripcion de lo que se busca recordar |
| top_k | int | No | Cantidad de resultados (default: 5) |

| Output | Tipo | Descripcion |
|--------|------|-------------|
| data.query | string | Query original |
| data.count | int | Cantidad de resultados |
| data.results | RecallResult[] | Array de {id, relevance, priority, transferLevel, content} |

#### mm:learn-code

| Input | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| code | string | Si | Codigo fuente del snippet |
| description | string | Si | Descripcion de lo que hace |
| language | string | Si | Lenguaje de programacion |
| use_case | string | Si | Caso de uso tipico |
| dependencies | json | No | Array de dependencias |
| tags | json | No | Array de tags |
| quality | float | No | Score de calidad 0.0-1.0 (default: 0.8) |

| Output | Tipo | Descripcion |
|--------|------|-------------|
| data.description | string | Descripcion del snippet |
| data.language | string | Lenguaje |
| data.useCase | string | Caso de uso |

#### mm:recall-code

| Input | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| query | string | Si | Descripcion del tipo de codigo buscado |
| top_k | int | No | Cantidad de resultados (default: 5) |

| Output | Tipo | Descripcion |
|--------|------|-------------|
| data.query | string | Query original |
| data.count | int | Cantidad de resultados |
| data.results | RecallResult[] | Array de resultados |

#### mm:learn-error

| Input | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| error_message | string | Si | Mensaje de error original |
| error_type | string | Si | Tipo o codigo del error |
| root_cause | string | Si | Causa raiz |
| solution | string | Si | Descripcion de la solucion |
| fixed_code | string | No | Codigo corregido |
| language | string | Si | Lenguaje de programacion |

| Output | Tipo | Descripcion |
|--------|------|-------------|
| data.errorType | string | Tipo del error |
| data.language | string | Lenguaje |
| data.hasFix | boolean | Si incluye codigo corregido |

#### mm:recall-errors

| Input | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| query | string | Si | Mensaje de error o descripcion del problema |
| top_k | int | No | Cantidad de resultados (default: 3) |

| Output | Tipo | Descripcion |
|--------|------|-------------|
| data.query | string | Query original |
| data.count | int | Cantidad de resultados |
| data.results | RecallResult[] | Array de resultados |

#### mm:context

| Input | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| project | string | No | Nombre del proyecto actual |
| task | string | No | Tarea actual en progreso |
| goals | json | No | Array de goals activos |

| Output (modo set) | Tipo | Descripcion |
|--------|------|-------------|
| data.action | "set" | Accion realizada |
| data.project | string | Proyecto establecido |
| data.task | string | Tarea establecida |
| data.goals | string[] | Goals establecidos |

| Output (modo get) | Tipo | Descripcion |
|--------|------|-------------|
| data.action | "get" | Accion realizada |
| data.context | object | Contexto actual completo |

#### mm:focus

| Input | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| project | string | Si | Nombre del proyecto en el que enfocar |

| Output | Tipo | Descripcion |
|--------|------|-------------|
| data.focused | string | Proyecto enfocado |

#### mm:memory-stats

| Input | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| (ninguno) | - | - | - |

| Output | Tipo | Descripcion |
|--------|------|-------------|
| data.vectorDb | MiniMemoryStats | Stats de la VectorDB |
| data.agentMemory | AgentMemoryStats o null | Stats del AgentMemory (null si no disponible) |

#### mm:save-memory

| Input | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| path | string | Si | Ruta del archivo .mmdb para la memoria |

| Output | Tipo | Descripcion |
|--------|------|-------------|
| data.saved | string | Path donde se guardo |

#### mm:load-memory

| Input | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| path | string | Si | Ruta del archivo .mmdb a cargar |

| Output | Tipo | Descripcion |
|--------|------|-------------|
| data.loaded | string | Path cargado |

### 1.6 Patron de Handler

Todos los handlers siguen esta estructura:

```typescript
handler: async (args: TypedArgs) => {
  try {
    // 1. Parsear JSON strings si aplica
    const parsed = typeof args.param === 'string' ? JSON.parse(args.param) : args.param;

    // 2. Convertir tipos numericos
    const topK = args.top_k ? Number(args.top_k) : DEFAULT;

    // 3. Ejecutar operacion via MiniMemoryApiAdapter
    const result = api.operation(parsed);

    // 4. Retornar exito
    return { success: true, data: { /* resultado estructurado */ } };
  } catch (error: any) {
    // 5. Retornar error
    return { success: false, data: null, error: `Mensaje descriptivo: ${error.message}` };
  }
}
```

### 1.7 Formato Compacto (Discovery)

Cada comando produce un bloque compacto para el LLM:

```
mm:hybrid | Busqueda hibrida combinando similitud vectorial, keywords BM25 y filtros de metadata con fusion RRF
  --vector: json
  --keywords: string
  --filter: json
  --top_k: int = 10
  --vector_weight: float (0.0-1.0)
  -> output: {keywords, hasVector, hasFilter, count, results}
  Ejemplo: mm:hybrid --keywords "authentication JWT" --filter '{"category": "security"}' --top_k 5
```

### 1.8 Tags para Discovery Semantico

| Grupo | Tags Comunes |
|-------|-------------|
| VectorDB | minimemory, search, vector, insert, keywords, filter, hybrid, hnsw, bm25 |
| Memory | learn, recall, memory, agent, code, error, snippet, experience, episode |
| Persistence | save, load, persist, backup, restore, disk, file, export, import |
| Context | context, working, project, task, goals, focus, scope, state |

---

## 2. Que NO debe hacer (MUST NOT)

### 2.1 Fuera de Alcance

- No implementa la logica de VectorDB ni AgentMemory (eso es responsabilidad de minimemory)
- No genera embeddings (eso es responsabilidad del Vector Index y el embedding adapter)
- No gestiona el transport layer (stdio, HTTP, MCP)
- No parsea el input del usuario (eso es responsabilidad del Parser)
- No implementa la busqueda semantica de commands (eso es responsabilidad del Vector Index)
- No gestiona autenticacion ni permisos
- No implementa undo logic (solo marca `undoable: true` para que el Executor lo maneje)

### 2.2 Anti-patterns Prohibidos

- No lanzar excepciones sin capturar -> Todo handler tiene try/catch obligatorio
- No retornar valores raw sin envolver en `{ success, data, error }` -> Consistencia de respuesta
- No almacenar estado mutable en el modulo -> El estado vive en MiniMemoryApiAdapter
- No hardcodear paths de persistencia -> Usar la configuracion del adapter
- No asumir tipos de argumentos -> Siempre parsear JSON strings y convertir numeros
- No ejecutar operaciones destructivas sin `confirm: true` -> Proteccion contra borrado accidental
- No acoplar a una version especifica del binding minimemory -> Usar el adapter como abstraccion

### 2.3 Restricciones de Implementacion

- No importar minimemory directamente en este modulo (usar MiniMemoryApiAdapter)
- No crear instancias del adapter internamente (recibirlo como parametro de factory)
- No usar globals ni singletons (el adapter se inyecta)
- No modificar el adapter recibido (usarlo como servicio read-only)
- No hacer I/O de red (minimemory opera localmente via napi-rs)
- No bloquear el event loop con operaciones sincronas pesadas (los handlers son async)

---

## 3. Como se que esta bien (ACCEPTANCE)

### 3.1 Criterios de Aceptacion

```gherkin
Feature: Creacion de comandos minimemory

  Scenario: Factory retorna 21 comandos
    DADO un MiniMemoryApiAdapter inicializado
    CUANDO llamo createMiniMemoryCommands(api)
    ENTONCES recibo un array de exactamente 21 elementos
    Y todos tienen namespace "mm"
    Y todos tienen version "1.0.0"
    Y todos tienen handler como funcion async

  Scenario: Todos los comandos tienen tags
    DADO el array de comandos minimemory
    CUANDO inspecciono cada comando
    ENTONCES todos tienen tags como array no vacio
    Y todos incluyen "minimemory" como primer tag

  Scenario: Comandos de discovery correctos
    DADO el array de comandos minimemory
    CUANDO el Vector Index indexa sus descriptions + tags
    ENTONCES una busqueda por "guardar datos" encuentra mm:insert y mm:save
    Y una busqueda por "buscar por similitud" encuentra mm:search y mm:hybrid
    Y una busqueda por "recordar experiencia" encuentra mm:recall

Feature: VectorDB - Operaciones CRUD

  Scenario: Insert con vector y metadata
    DADO una DB vacia
    CUANDO ejecuto mm:insert --id "doc-1" --vector "[0.1, 0.2, 0.3]" --metadata '{"title": "Test"}'
    ENTONCES recibo { success: true, data: { id: "doc-1", hasVector: true, metadataKeys: ["title"] } }
    Y la DB contiene un documento con id "doc-1"

  Scenario: Insert sin vector (solo metadata)
    DADO una DB vacia
    CUANDO ejecuto mm:insert --id "doc-2" --metadata '{"category": "tech"}'
    ENTONCES recibo { success: true, data: { id: "doc-2", hasVector: false, metadataKeys: ["category"] } }

  Scenario: Insert con content agrega a metadata
    DADO una DB vacia
    CUANDO ejecuto mm:insert --id "doc-3" --metadata '{"title": "X"}' --content "texto completo"
    ENTONCES la metadata almacenada incluye { title: "X", content: "texto completo" }

  Scenario: Get documento existente
    DADO un documento "doc-1" insertado
    CUANDO ejecuto mm:get --id "doc-1"
    ENTONCES recibo { success: true, data: { id: "doc-1", vector: [...], metadata: {...} } }

  Scenario: Get documento inexistente
    DADO una DB sin "ghost"
    CUANDO ejecuto mm:get --id "ghost"
    ENTONCES recibo { success: false, error: 'Documento "ghost" no encontrado' }

  Scenario: Delete con confirm
    DADO un documento "doc-1" insertado
    CUANDO ejecuto mm:delete --id "doc-1" (con confirm: true activado)
    ENTONCES recibo { success: true, data: { deleted: "doc-1" } }
    Y la DB ya no contiene "doc-1"

  Scenario: Stats de DB vacia
    DADO una DB recien creada (0 documentos)
    CUANDO ejecuto mm:stats
    ENTONCES recibo { success: true, data: { count: 0, dimensions: N, ... } }

Feature: VectorDB - Busquedas

  Scenario: Busqueda vectorial
    DADO una DB con 10 documentos con vectores de dimension 3
    CUANDO ejecuto mm:search --vector "[0.1, 0.2, 0.3]" --top_k 3
    ENTONCES recibo { success: true, data: { count: 3, results: [...] } }
    Y cada resultado tiene id, distance, score, metadata

  Scenario: Busqueda BM25
    DADO una DB con documentos que tienen content indexado
    CUANDO ejecuto mm:keywords --query "rust async programming"
    ENTONCES recibo resultados ordenados por relevancia BM25

  Scenario: Busqueda hibrida
    DADO una DB con documentos con vectores y fulltext
    CUANDO ejecuto mm:hybrid --keywords "auth" --filter '{"category": "security"}' --top_k 5
    ENTONCES recibo resultados combinados con fusion RRF
    Y data incluye hasVector: false, hasFilter: true

  Scenario: Busqueda por filtro metadata
    DADO una DB con documentos con metadata.category = "tech"
    CUANDO ejecuto mm:filter --field "category" --operator "eq" --value "tech"
    ENTONCES recibo solo documentos donde category es "tech"

  Scenario: Coercion automatica de value en filter
    DADO documentos con metadata.score = 5 (numero)
    CUANDO ejecuto mm:filter --field "score" --operator "gt" --value "3"
    ENTONCES value se convierte a numero 3
    Y los resultados filtran correctamente

Feature: VectorDB - Persistencia

  Scenario: Save y Load
    DADO una DB con 5 documentos
    CUANDO ejecuto mm:save --path "./test.mmdb"
    Y luego mm:load --path "./test.mmdb" en una DB nueva
    ENTONCES la DB nueva tiene 5 documentos

  Scenario: Save sin path usa configuracion por defecto
    DADO un adapter con persistPath configurado
    CUANDO ejecuto mm:save (sin --path)
    ENTONCES guarda en el path por defecto

  Scenario: Save sin path ni configuracion falla
    DADO un adapter sin persistPath configurado
    CUANDO ejecuto mm:save (sin --path)
    ENTONCES recibo { success: false, error: "...No persist path configured..." }

Feature: AgentMemory - Learn/Recall tareas

  Scenario: Aprender tarea exitosa
    DADO AgentMemory inicializado
    CUANDO ejecuto mm:learn --task "Implementar auth" --solution "JWT con refresh tokens" --outcome "success" --learnings '["Validar exp", "Rotar keys"]'
    ENTONCES recibo { success: true, data: { task: "Implementar auth", outcome: "success", learnings: 2 } }

  Scenario: Recordar experiencia similar
    DADO que aprendi tareas de autenticacion
    CUANDO ejecuto mm:recall --query "autenticacion de usuarios" --top_k 3
    ENTONCES recibo resultados con contenido relevante a auth

  Scenario: Learn con learnings como string JSON
    DADO que paso learnings como '["A", "B"]' (string)
    CUANDO el handler procesa los argumentos
    ENTONCES parsea el JSON a array ["A", "B"]

Feature: AgentMemory - Learn/Recall codigo

  Scenario: Almacenar snippet de codigo
    DADO AgentMemory inicializado
    CUANDO ejecuto mm:learn-code con code, description, language, use_case
    ENTONCES recibo { success: true, data: { description, language, useCase } }

  Scenario: Buscar snippet por descripcion
    DADO que almacene un snippet de "HTTP fetch con retry"
    CUANDO ejecuto mm:recall-code --query "HTTP client async con reintentos"
    ENTONCES recibo el snippet almacenado con relevancia alta

Feature: AgentMemory - Learn/Recall errores

  Scenario: Registrar solucion a error
    DADO AgentMemory inicializado
    CUANDO ejecuto mm:learn-error con error_message, error_type, root_cause, solution, language
    ENTONCES recibo { success: true, data: { errorType, language, hasFix: false } }

  Scenario: Registrar solucion con codigo corregido
    DADO AgentMemory inicializado
    CUANDO ejecuto mm:learn-error con fixed_code incluido
    ENTONCES data.hasFix es true

  Scenario: Buscar solucion a error
    DADO que registre una solucion para "cannot borrow as mutable"
    CUANDO ejecuto mm:recall-errors --query "borrow checker mutable reference"
    ENTONCES recibo la solucion con relevancia alta

Feature: AgentMemory - Contexto y Focus

  Scenario: Establecer contexto de trabajo
    DADO AgentMemory inicializado
    CUANDO ejecuto mm:context --project "agent-shell" --task "Tests" --goals '["Cobertura 90%"]'
    ENTONCES recibo { success: true, data: { action: "set", project: "agent-shell", ... } }

  Scenario: Obtener contexto actual (get)
    DADO que no paso ningun parametro
    CUANDO ejecuto mm:context
    ENTONCES recibo { success: true, data: { action: "get", context: {...} } }

  Scenario: Enfocar en proyecto
    DADO AgentMemory con multiples proyectos
    CUANDO ejecuto mm:focus --project "my-app"
    ENTONCES recibo { success: true, data: { focused: "my-app" } }
    Y busquedas posteriores priorizan datos de "my-app"

Feature: AgentMemory - Stats y Persistencia

  Scenario: Memory stats con AgentMemory disponible
    DADO AgentMemory inicializado con datos
    CUANDO ejecuto mm:memory-stats
    ENTONCES recibo { vectorDb: {...}, agentMemory: { totalEntries, episodes, codeSnippets, errorSolutions } }

  Scenario: Memory stats sin AgentMemory
    DADO que AgentMemory no esta disponible (binding version antigua)
    CUANDO ejecuto mm:memory-stats
    ENTONCES recibo { vectorDb: {...}, agentMemory: null }
    Y NO hay error

  Scenario: Save/Load memory
    DADO AgentMemory con datos
    CUANDO ejecuto mm:save-memory --path "./agent.mmdb"
    Y luego mm:load-memory --path "./agent.mmdb"
    ENTONCES la memoria se restaura correctamente

Feature: Manejo de errores en handlers

  Scenario: Error en operacion del adapter
    DADO que api.insert() lanza un error
    CUANDO el handler ejecuta la operacion
    ENTONCES retorna { success: false, data: null, error: "Error insertando: <mensaje>" }
    Y NO lanza excepcion al exterior

  Scenario: JSON malformado en parametro tipo json
    DADO que paso --vector "no es json valido"
    CUANDO el handler intenta JSON.parse
    ENTONCES retorna { success: false, error: "..." } con detalle del parse error

  Scenario: AgentMemory no disponible
    DADO que el binding no tiene AgentMemory
    CUANDO ejecuto mm:learn o mm:recall
    ENTONCES retorna { success: false, error: "...AgentMemory not available..." }
```

### 3.2 Casos de Prueba Requeridos

| ID | Escenario | Input | Output Esperado | Prioridad |
|----|-----------|-------|-----------------|-----------|
| T01 | Factory retorna 21 comandos | createMiniMemoryCommands(api) | Array de 21 elementos | Alta |
| T02 | Todos namespace "mm" | Inspeccionar array | Todos .namespace === "mm" | Alta |
| T03 | Todos tienen handler async | Inspeccionar array | typeof handler === "function" | Alta |
| T04 | Todos tienen tags no vacio | Inspeccionar array | .tags.length > 0 | Alta |
| T05 | Insert con vector | --id, --vector como JSON string | success: true, hasVector: true | Alta |
| T06 | Insert sin vector | --id, --metadata | success: true, hasVector: false | Alta |
| T07 | Insert con content | --id, --metadata, --content | metadata.content existe | Media |
| T08 | Delete exitoso | --id valido | success: true, deleted: id | Alta |
| T09 | Get existente | --id existente | success: true, data con doc | Alta |
| T10 | Get inexistente | --id "ghost" | success: false, error con "no encontrado" | Alta |
| T11 | Search con vector | --vector, --top_k | results con count <= top_k | Alta |
| T12 | Search top_k default | --vector (sin top_k) | Usa 5 como default | Media |
| T13 | Keywords search | --query "rust" | results con resultados BM25 | Alta |
| T14 | Hybrid solo keywords | --keywords "auth" | success: true, hasVector: false | Alta |
| T15 | Hybrid con filtro | --keywords, --filter JSON | hasFilter: true | Media |
| T16 | Filter eq | --field, --operator "eq", --value | Resultados filtrados | Alta |
| T17 | Filter coercion numerica | --value "42" | Se convierte a Number(42) | Media |
| T18 | Filter coercion booleana | --value "true" | Se convierte a true | Media |
| T19 | Save con path | --path "./test.mmdb" | success: true, saved: path | Alta |
| T20 | Save sin path (default) | (sin --path) | Usa persist path config | Media |
| T21 | Load con path | --path existente | success: true, loaded: path | Alta |
| T22 | Learn tarea | --task, --solution, --outcome | success: true | Alta |
| T23 | Learn con learnings JSON | --learnings '["A"]' | Parsea correctamente | Media |
| T24 | Recall experiencias | --query | results con RecallResult[] | Alta |
| T25 | Learn-code completo | Todos params requeridos | success: true | Alta |
| T26 | Recall-code | --query | results con snippets | Alta |
| T27 | Learn-error completo | Todos params requeridos | success: true | Alta |
| T28 | Learn-error con fixed_code | --fixed_code incluido | hasFix: true | Media |
| T29 | Recall-errors | --query | results con soluciones | Alta |
| T30 | Context set | --project, --task, --goals | action: "set" | Alta |
| T31 | Context get | (sin params) | action: "get", context: {...} | Alta |
| T32 | Focus proyecto | --project | focused: project | Media |
| T33 | Memory-stats completo | (sin params) | vectorDb + agentMemory | Alta |
| T34 | Memory-stats sin AM | AgentMemory null | agentMemory: null, sin error | Media |
| T35 | Save-memory | --path | success: true | Alta |
| T36 | Load-memory | --path | success: true | Alta |
| T37 | Error en handler capturado | adapter lanza error | success: false, error con mensaje | Alta |
| T38 | JSON invalido en vector | --vector "not json" | success: false, parse error | Alta |
| T39 | AgentMemory no disponible | learn en adapter sin AM | success: false, error | Media |
| T40 | Stats DB vacia | DB recien creada | count: 0, success: true | Media |
| T41 | Confirm flag en delete | Inspeccionar definicion | confirm: true | Alta |
| T42 | Undoable en insert | Inspeccionar definicion | undoable: true | Alta |

### 3.3 Metricas de Exito

- [ ] 21 comandos registrados correctamente en namespace "mm"
- [ ] 100% de handlers retornan formato `{ success, data, error }` (nunca excepciones)
- [ ] Discovery semantico encuentra el comando correcto en top-3 para queries naturales
- [ ] Parseo de JSON strings funciona para vector, metadata, filter, learnings, dependencies, tags, goals
- [ ] Cobertura de tests >= 90% de las lineas del modulo
- [ ] Tiempo de ejecucion por handler < 100ms para operaciones in-memory (sin I/O disco)

### 3.4 Definition of Done

- [ ] createMiniMemoryCommands(api) retorna 21 definiciones validas
- [ ] Todos los comandos cumplen el schema CommandDefinition del registry
- [ ] Todos los handlers manejan errores sin lanzar excepciones
- [ ] JSON strings se parsean correctamente en todos los parametros tipo json
- [ ] Operaciones destructivas tienen confirm: true
- [ ] Operaciones reversibles tienen undoable: true
- [ ] Tags cubren multiples sinonimos para discovery semantico
- [ ] Tests unitarios para cada handler (T01-T42)
- [ ] Tests de integracion con MiniMemoryApiAdapter real (requiere binding instalado)
- [ ] Documentacion de cada comando con ejemplo de uso

---

## 4. Que pasa si falla (ERROR HANDLING)

### 4.1 Errores Esperados

| Codigo | Condicion | Response Handler | Mensaje |
|--------|-----------|------------------|---------|
| E001 | JSON.parse falla en param tipo json | { success: false, error } | "Error [operacion]: Unexpected token..." |
| E002 | Documento no encontrado (mm:get) | { success: false, error } | 'Documento "[id]" no encontrado' |
| E003 | Path no configurado (mm:save/load) | { success: false, error } | "Error guardando: No persist path configured" |
| E004 | AgentMemory no disponible | { success: false, error } | "Error [operacion]: AgentMemory not available in this binding version" |
| E005 | Operacion nativa falla (HNSW, BM25) | { success: false, error } | "Error en busqueda [tipo]: [mensaje nativo]" |
| E006 | Archivo .mmdb no encontrado (load) | { success: false, error } | "Error cargando: [mensaje I/O]" |
| E007 | Dimensiones de vector incompatibles | { success: false, error } | "Error insertando: dimension mismatch..." |
| E008 | Operador invalido en filter | { success: false, error } | "Error en busqueda por filtros: [mensaje]" |

### 4.2 Estrategia de Fallback

- Si AgentMemory no esta disponible -> mm:memory-stats retorna `agentMemory: null` (degradacion graceful)
- Si el binding minimemory no esta instalado -> Error en construccion del adapter, no en handlers
- Si mm:save falla a medio camino -> El estado en memoria permanece intacto (no corrupcion)
- Si mm:load falla -> La DB anterior permanece en su estado previo

### 4.3 Propagacion al Core

```
Handler retorna { success: false, data: null, error: "..." }
        |
        v
Executor recibe resultado del handler
        |
        v
Core envuelve en Response:
  {
    code: 0,              // El handler NO fallo (retorno normalmente)
    data: {
      success: false,     // Pero la operacion logica fallo
      data: null,
      error: "..."
    },
    meta: { ... }
  }
```

NOTA: El handler siempre retorna exitosamente (no lanza). El `success: false` es un resultado logico dentro de `data`, no un error de ejecucion del comando. El `code` del Core Response es 0 porque el handler se ejecuto sin problemas tecnicos.

### 4.4 Logging

- **INFO**: Cada operacion exitosa (insert/delete/search/learn/recall)
- **WARN**: AgentMemory no disponible (fallback a null)
- **ERROR**: Excepcion nativa del binding (capturada en try/catch)
- Logs incluyen: comando, args principales (sin datos sensibles), duracion

### 4.5 Recuperacion

- **Retry**: No implementado a nivel de handler (el agente puede re-ejecutar el comando)
- **Rollback**: mm:insert es undoable, el Executor gestiona el undo
- **Persistencia**: mm:save/mm:load permiten backup/restore manual
- **Estado corrupto**: Re-crear el adapter con configuracion limpia

---

## 5. Que supuestos tiene (ASSUMPTIONS)

### 5.1 Precondiciones

- [ ] El binding nativo minimemory esta instalado (`npm install minimemory`)
- [ ] MiniMemoryApiAdapter esta inicializado con configuracion valida (dimensions, distance, indexType)
- [ ] La dimension configurada coincide con el modelo de embeddings usado
- [ ] El sistema de archivos tiene permisos de lectura/escritura para operaciones de persistencia
- [ ] El Command Registry esta disponible para registrar los 21 comandos
- [ ] El Vector Index esta disponible para indexar descriptions y tags

### 5.2 Dependencias

| Dependencia | Tipo | Version | Critica |
|-------------|------|---------|---------|
| minimemory | Native binding (napi-rs) | >= 0.1.0 | Si |
| MiniMemoryApiAdapter | Adapter interno | 1.0.0 | Si |
| Command Registry | Modulo Agent Shell | 1.0.0 | Si |
| Vector Index | Modulo Agent Shell | 1.0.0 | Si (para discovery) |
| Executor | Modulo Agent Shell | 1.0.0 | Si (para ejecucion) |
| Parser | Modulo Agent Shell | 1.0.0 | Si (para parseo de args) |

### 5.3 Datos de Entrada Esperados

- **Vectors**: Arrays de floats con dimension exacta igual a config.dimensions (ej: 768 para embeddinggemma)
- **Metadata**: Objetos JSON planos (no anidados profundos) para filtrado eficiente
- **IDs**: Strings unicos, sin restriccion de formato (UUID, slug, path, etc.)
- **Queries**: Strings de texto natural para BM25 y recall semantico
- **Paths**: Rutas absolutas o relativas al filesystem para .mmdb
- **JSON params**: Pueden llegar como string (del Parser) o como objeto (si ya parseados)

### 5.4 Estado del Sistema

- **MiniMemoryApiAdapter inicializado**: VectorDB creada con dimensiones y tipo de indice
- **AgentMemory puede no estar disponible**: Versiones antiguas del binding no lo incluyen
- **DB puede estar vacia o pre-cargada**: mm:load en bootstrap puede poblar datos previos
- **Multiples adapters posibles**: Un adapter para el Vector Index storage + otro para los mm: commands

### 5.5 Configuracion Tipica

```typescript
// Para el adapter de comandos mm:
const apiConfig: MiniMemoryConfig = {
  dimensions: 768,              // Match con embedding model
  distance: 'cosine',           // Default
  indexType: 'hnsw',            // Busqueda rapida
  fulltextFields: ['content', 'description', 'title'],  // BM25
  persistPath: './agent-memory.mmdb',                     // Persistencia
};

// Para el vector storage backend (indexacion de comandos):
const storageConfig = {
  dimensions: 768,
  distance: 'cosine',
  indexType: 'hnsw',
  hnswM: 16,
  hnswEfConstruction: 200,
  persistPath: './agent-shell.mmdb',
};
```

---

## 6. Que limites tiene (CONSTRAINTS)

### 6.1 Limites Tecnicos

- **Dimension del vector**: Fija al momento de crear la DB (no se puede cambiar sin re-crear)
- **Memoria**: Proporcional a documentos * (dimension * 4 bytes + metadata size)
- **HNSW build**: O(N log N) al insertar, O(log N) al buscar
- **BM25**: Requiere que fulltextFields esten configurados al crear la DB
- **Persistencia**: Formato .mmdb binario, no human-readable
- **Binding nativo**: Requiere plataforma soportada (Linux x64, macOS arm64/x64, Windows x64)
- **Concurrencia**: minimemory no es thread-safe por defecto (single-threaded Node.js OK)

### 6.2 Limites de Negocio

- **Outcome values**: mm:learn acepta cualquier string pero se espera "success", "failure", o "partial"
- **Quality score**: mm:learn-code acepta 0.0-1.0, valores fuera de rango no se validan en el handler
- **Filter operators**: Solo los soportados por minimemory (eq, ne, gt, gte, lt, lte, contains, starts_with)
- **vector_weight**: Rango 0.0-1.0, el complemento se asigna a keywords (1 - vector_weight)
- **top_k defaults**: Varian por comando (search=5, keywords=10, hybrid=10, filter=20, recall=5, recall-errors=3)

### 6.3 Limites de Seguridad

- **Sin autenticacion**: Los comandos mm: son accesibles sin credenciales (single-agent model)
- **Sin sanitizacion de paths**: mm:save/mm:load aceptan cualquier path (responsabilidad del agente)
- **Datos en memoria**: No hay encriptacion de vectores ni metadata en runtime
- **Persistencia en claro**: Los archivos .mmdb no estan encriptados

### 6.4 Limites de Alcance - Version 1.0

**Esta version NO incluye:**

- Generacion automatica de embeddings para mm:insert (el vector se pasa explicitamente)
- Bulk insert/delete (se hace uno a uno)
- Streaming de resultados de busqueda
- Paginacion nativa en resultados (se usa top_k como limite)
- Actualizacion de documentos (mm:update no existe, se debe delete+insert)
- Merge de archivos .mmdb
- Exportacion a formatos alternativos (JSON, CSV)
- Validacion de schema de metadata
- TTL o expiracion de documentos
- Indices parciales configurables desde comandos (solo mm:focus para proyectos)
- Webhooks o notificaciones de cambios

**Consideraciones para versiones futuras:**

- mm:update para modificar documentos existentes sin delete+insert
- mm:bulk-insert para carga masiva eficiente
- mm:export/mm:import para formatos abiertos (JSON-lines)
- mm:schema para definir y validar estructura de metadata
- Auto-embedding: mm:insert --content "texto" genera el vector automaticamente
- mm:gc para garbage collection de documentos huerfanos
- mm:backup con rotacion automatica
- mm:replicate para sincronizar entre instancias

---

## Anexos

### A. Glosario

| Termino | Definicion |
|---------|------------|
| minimemory | Libreria Rust con binding Node.js para VectorDB y AgentMemory |
| VectorDB | Base de datos vectorial con soporte HNSW, BM25 y filtros |
| AgentMemory | Subsistema de minimemory para memoria episodica de agentes AI |
| HNSW | Hierarchical Navigable Small World - algoritmo de busqueda vectorial aproximada |
| BM25 | Best Match 25 - algoritmo de ranking para full-text search |
| RRF | Reciprocal Rank Fusion - metodo para combinar rankings de busqueda |
| napi-rs | Framework para crear bindings nativos Node.js desde Rust |
| .mmdb | Formato binario de persistencia de minimemory |
| Episode | Unidad de memoria episodica (tarea + solucion + outcome) |
| Snippet | Fragmento de codigo almacenado con metadata contextual |
| Partial Index | Indice filtrado por proyecto para busquedas focalizadas |
| Discovery | Proceso de encontrar comandos relevantes via busqueda semantica |
| Adapter | Capa de abstraccion entre Agent Shell y el binding nativo |

### B. Referencias

- minimemory repository: https://github.com/MauricioPerera/minimemory
- Agent Shell PRD: `d:/repos/agent-shell/docs/prd.md`
- Command Registry contract: `d:/repos/agent-shell/contracts/command-registry.md`
- Vector Index contract: `d:/repos/agent-shell/contracts/vector-index.md`
- Core contract: `d:/repos/agent-shell/contracts/core.md`
- Implementacion: `d:/repos/agent-shell/demo/minimemory-commands.ts`
- Adapter API: `d:/repos/agent-shell/demo/adapters/minimemory-api.ts`
- Adapter Storage: `d:/repos/agent-shell/demo/adapters/minimemory-vector-storage.ts`

### C. Relacion con Otros Modulos

| Modulo | Relacion con minimemory-commands |
|--------|----------------------------------|
| Command Registry | Almacena las 21 definiciones y handlers del namespace mm: |
| Vector Index | Indexa descriptions + tags para discovery semantico de comandos mm: |
| Parser | Parsea "mm:insert --id X --metadata '{...}'" a args tipados |
| Executor | Ejecuta el handler de cada comando mm: con los args parseados |
| Core | Orquesta el flujo completo: parse -> resolve -> execute -> response |
| MiniMemoryApiAdapter | Provee acceso tipado al binding nativo (inyectado en factory) |
| MiniMemoryVectorStorage | Backend alternativo para el Vector Index (separado de los commands) |

### D. Ejemplo Completo de Uso

```typescript
import { MiniMemoryApiAdapter } from './adapters/minimemory-api.js';
import { createMiniMemoryCommands } from './minimemory-commands.js';

// 1. Crear adapter
const api = new MiniMemoryApiAdapter({
  dimensions: 768,
  distance: 'cosine',
  indexType: 'hnsw',
  fulltextFields: ['content', 'description'],
  persistPath: './agent-memory.mmdb',
});

// 2. Crear comandos
const mmCommands = createMiniMemoryCommands(api);
// mmCommands.length === 21

// 3. Registrar en Agent Shell
for (const cmd of mmCommands) {
  registry.register({
    ...cmd,
    output: { type: '{success, data, error}' },
  }, cmd.handler);
}

// 4. Uso via Core (como lo haria un agente AI)
await core.exec('mm:insert --id "task-1" --metadata \'{"type":"task","project":"agent-shell"}\'');
await core.exec('mm:learn --task "Integrar minimemory" --solution "Adapter pattern" --outcome "success"');
await core.exec('mm:recall --query "integracion de bases de datos vectoriales" --top_k 3');
await core.exec('mm:hybrid --keywords "vector search" --filter \'{"project":"agent-shell"}\' --top_k 5');
await core.exec('mm:save --path "./backup.mmdb"');
await core.exec('mm:memory-stats');
```

### E. Mapa de Tags por Comando

```
mm:stats         -> [minimemory, stats, status, info, database, vectors, count]
mm:insert        -> [minimemory, insert, add, store, document, vector, embedding, create]
mm:delete        -> [minimemory, delete, remove, document]
mm:get           -> [minimemory, get, fetch, retrieve, document, read]
mm:search        -> [minimemory, search, vector, semantic, similarity, find, nearest, hnsw]
mm:keywords      -> [minimemory, keywords, bm25, fulltext, text, search, find]
mm:hybrid        -> [minimemory, hybrid, search, vector, keywords, filter, combined, rrf, fusion]
mm:filter        -> [minimemory, filter, metadata, query, where, condition, operator]
mm:save          -> [minimemory, save, persist, disk, file, export, backup]
mm:load          -> [minimemory, load, restore, import, open, read]
mm:learn         -> [minimemory, learn, task, experience, episode, remember, store, memory, agent]
mm:recall        -> [minimemory, recall, remember, search, experience, similar, memory, agent, history]
mm:learn-code    -> [minimemory, learn, code, snippet, store, remember, pattern, programming]
mm:recall-code   -> [minimemory, recall, code, snippet, search, find, pattern, programming]
mm:learn-error   -> [minimemory, learn, error, solution, fix, debug, troubleshoot, bug]
mm:recall-errors -> [minimemory, recall, error, solution, debug, troubleshoot, fix, help]
mm:context       -> [minimemory, context, working, project, task, goals, current, state]
mm:focus         -> [minimemory, focus, project, scope, partial, index, filter]
mm:memory-stats  -> [minimemory, memory, stats, agent, episodes, snippets, count]
mm:save-memory   -> [minimemory, save, memory, persist, export, backup, agent]
mm:load-memory   -> [minimemory, load, memory, restore, import, agent]
```

### F. Historial de Cambios

| Version | Fecha | Autor | Cambios |
|---------|-------|-------|---------|
| 1.0 | 2026-01-24 | Spec Architect | Version inicial del contrato |
