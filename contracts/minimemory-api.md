# Contrato: MINIMEMORY_API_ADAPTER

> **Version**: 1.0
> **Fecha**: 2026-01-24
> **Estado**: Draft
> **Autor**: Spec Architect (Claude Opus 4.5)
> **Sistema**: Agent Shell
> **Modulo**: MiniMemory API Adapter (Namespace mm:)

## Resumen Ejecutivo

El MiniMemoryApiAdapter es el wrapper tipado que expone todas las capacidades de la base de datos hibrida embebida minimemory (Rust/napi-rs) para ser consumidas por los comandos del namespace `mm:` en Agent Shell. A diferencia de los adapters HTTP (VoltAgent, n8n, LangGraph), este adapter llama directamente al binding nativo sin red ni servidor intermedio, proporcionando operaciones de VectorDB (insert, search, hybrid search, BM25, filtros) y AgentMemory (learn/recall de tareas, codigo y errores) como primitivas de primera clase para agentes de IA.

---

## 1. Que debe hacer (MUST DO)

### 1.1 Objetivo Principal

Proveer una interfaz TypeScript tipada y ergonomica sobre el binding napi-rs de minimemory, exponiendo dos subsistemas:

1. **VectorDB**: CRUD de documentos vectoriales, busqueda por similaridad (HNSW), BM25 full-text, busqueda hibrida con fusion RRF, y filtros de metadata.
2. **AgentMemory**: Aprendizaje y recall de experiencias episodicas (tareas), snippets de codigo y soluciones a errores, con contexto de trabajo activo.

### 1.2 Funcionalidades Requeridas

#### VectorDB Operations

- [ ] **insert(params: MiniMemoryInsertParams): void**
  - Inserta un documento con ID, vector opcional, metadata opcional y contenido textual opcional
  - Si se provee vector, usa `db.insert(id, vector, metadata)`
  - Si no se provee vector, usa `db.insert_document(id, null, metadata)` para documentos solo-texto
  - El ID debe ser unico; insertar un ID existente es un error del binding

- [ ] **update(id, vector?, metadata?): void**
  - Actualiza un documento existente via `db.update_document(id, vector, metadata)`
  - Acepta actualizacion parcial (solo vector, solo metadata, o ambos)
  - Si el ID no existe, el binding lanza un error

- [ ] **delete(id: string): void**
  - Elimina un documento por ID
  - Si el ID no existe, el binding lanza un error

- [ ] **contains(id: string): boolean**
  - Verifica existencia de un documento por ID
  - Retorna boolean sin lanzar errores

- [ ] **get(id: string): {vector, metadata} | null**
  - Obtiene un documento completo por ID
  - Retorna null si no existe (catch interno del error del binding)

- [ ] **search(vector: number[], topK: number): MiniMemorySearchResult[]**
  - Busqueda por similaridad vectorial usando el indice HNSW
  - Convierte distance del binding a score: `score = 1 - distance`
  - Retorna resultados ordenados por distancia ascendente (score descendente)

- [ ] **keywordSearch(query: string, topK: number): MiniMemorySearchResult[]**
  - Busqueda BM25 full-text sobre los campos configurados como fulltextFields
  - Requiere que el VectorDB haya sido inicializado con `VectorDB.withFulltext(config, fields)`
  - Normaliza el resultado al formato MiniMemorySearchResult

- [ ] **hybridSearch(params: MiniMemoryHybridParams): MiniMemorySearchResult[]**
  - Combina vector search + keyword search + metadata filter con fusion RRF
  - Al menos uno de vector, keywords, o filter debe estar presente
  - vectorWeight controla el peso relativo (0.0 = solo keywords, 1.0 = solo vector)
  - fusionK es el parametro K de la formula RRF (default del binding)
  - Convierte parametros a formato snake_case del binding (top_k, vector_weight, fusion_k)

- [ ] **filterSearch(filters: MiniMemoryFilterParams[], topK): MiniMemorySearchResult[]**
  - Busqueda por filtros de metadata usando operadores tipados
  - Operadores soportados: eq, ne, gt, gte, lt, lte, contains, starts_with
  - Multiples filtros se combinan con AND
  - Resultados tienen distance=0 y score=1 (no hay similaridad vectorial)

- [ ] **stats(): MiniMemoryStats**
  - Retorna estadisticas actuales de la base de datos
  - Incluye: count, dimensions, distance metric, index type, has fulltext, quantization
  - Usa db.len() para el count y el config local para los demas campos

- [ ] **save(path?: string): void**
  - Persiste la base de datos a disco en formato .mmdb
  - Usa el path provisto o el persistPath del config
  - Lanza error si no hay path configurado ni provisto

- [ ] **load(path?: string): void**
  - Carga la base de datos desde un archivo .mmdb
  - Usa el path provisto o el persistPath del config
  - Lanza error si no hay path configurado ni provisto

#### Agent Memory Operations

- [ ] **learnTask(episode: TaskEpisode): void**
  - Almacena una experiencia episodica (tarea completada)
  - Convierte de formato TypeScript camelCase a snake_case del binding
  - Lanza error si AgentMemory no esta disponible

- [ ] **learnCode(snippet: CodeSnippet): void**
  - Almacena un snippet de codigo con metadata contextual
  - Mapea: useCase->use_case, qualityScore->quality_score
  - Lanza error si AgentMemory no esta disponible

- [ ] **learnError(solution: ErrorSolution): void**
  - Almacena la solucion a un error para referencia futura
  - Mapea: errorMessage->error_message, errorType->error_type, rootCause->root_cause, fixedCode->fixed_code
  - Lanza error si AgentMemory no esta disponible

- [ ] **recallSimilar(query: string, topK: number): RecallResult[]**
  - Busca experiencias similares en la memoria episodica
  - Retorna resultados con relevance, priority, transferLevel y content

- [ ] **recallCode(query: string, topK: number): RecallResult[]**
  - Busca snippets de codigo relevantes a una consulta
  - Filtra solo la memoria de tipo codigo

- [ ] **recallErrors(query: string, topK: number): RecallResult[]**
  - Busca soluciones a errores similares
  - Mapea recall_error_solutions del binding

- [ ] **recallSuccessful(query: string, topK: number): RecallResult[]**
  - Busca solo experiencias con outcome "success"
  - Util para encontrar patrones que funcionaron

- [ ] **setWorkingContext(project: string, task?: string, goals?: string[]): void**
  - Establece el contexto de trabajo activo via with_working_context callback
  - Llama set_project, set_task (si task), add_goal (iterando goals)

- [ ] **getWorkingContext(): Record<string, any>**
  - Retorna el contexto de trabajo actual como objeto plano
  - Llama working_context() del binding

- [ ] **agentMemoryStats(): AgentMemoryStats**
  - Retorna estadisticas de la memoria del agente
  - Mapea: total_entries, episodes, code_snippets, error_solutions

- [ ] **saveMemory(path: string): void**
  - Persiste la memoria del agente a disco
  - El path es obligatorio (no usa persistPath del VectorDB)

- [ ] **loadMemory(path: string): void**
  - Carga la memoria del agente desde disco
  - El path es obligatorio

- [ ] **focusProject(project: string): void**
  - Enfoca la memoria en un proyecto especifico usando indice parcial
  - Optimiza las busquedas posteriores para ese proyecto

### 1.3 Flujos Principales

#### Flujo de Inicializacion

```
Constructor(config)
      |
      |-- require('minimemory') --> VectorDB, AgentMemory classes
      |   |
      |   +-- Error? --> throw "minimemory binding not found"
      |
      |-- initDb()
      |   |
      |   +-- config.fulltextFields? --> VectorDB.withFulltext(dbConfig, fields)
      |   |                         --> new VectorDB(dbConfig)
      |   |
      |   +-- config.persistPath? --> db.load(path) catch (fresh db)
      |
      |-- initAgentMemory()
          |
          +-- dimensions <= 384? --> { type: 'small' }
          |                      --> { type: 'openai', dimensions }
          |
          +-- new AgentMemory(memConfig)
          +-- Error? --> agentMemory = null (graceful degradation)
```

#### Flujo de Hybrid Search

```
Agent (mm:hybrid)         MiniMemoryApiAdapter              minimemory binding
      |                          |                                |
      |-- hybridSearch(params) -->|                                |
      |                          |-- build searchParams            |
      |                          |   (camelCase -> snake_case)     |
      |                          |                                |
      |                          |-- db.hybrid_search(params) ---->|
      |                          |                                |
      |                          |<-- raw results[] --------------|
      |                          |                                |
      |                          |-- map to MiniMemorySearchResult |
      |                          |   (add score = 1 - distance)   |
      |                          |                                |
      |<-- MiniMemorySearchResult[] --|                           |
```

#### Flujo de Agent Memory Learn/Recall

```
Agent (mm:learn)          MiniMemoryApiAdapter              minimemory binding
      |                          |                                |
      |-- learnTask(episode) --->|                                |
      |                          |-- check agentMemory != null    |
      |                          |                                |
      |                          |-- agentMemory.learn_task(      |
      |                          |     task, solution,            |
      |                          |     outcome, learnings) ------>|
      |                          |                                |
      |                          |<-- void ----------------------|
      |<-- void -----------------|                                |

Agent (mm:recall)         MiniMemoryApiAdapter              minimemory binding
      |                          |                                |
      |-- recallSimilar(q, k) -->|                                |
      |                          |-- check agentMemory != null    |
      |                          |                                |
      |                          |-- agentMemory.recall_similar(  |
      |                          |     query, topK) ------------->|
      |                          |                                |
      |                          |<-- raw results[] --------------|
      |                          |                                |
      |                          |-- mapRecallResults(raw)        |
      |                          |   (normalize to RecallResult)  |
      |                          |                                |
      |<-- RecallResult[] -------|                                |
```

### 1.4 Inputs y Outputs

#### Inputs del Constructor

| Input | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| dimensions | number | Si | Dimensiones del vector (1-4096) |
| distance | 'cosine' \| 'euclidean' \| 'dot_product' | No | Metrica de distancia (default: cosine) |
| indexType | 'flat' \| 'hnsw' | No | Tipo de indice (default: hnsw) |
| quantization | 'none' \| 'int8' \| 'binary' | No | Tipo de quantizacion (default: none) |
| fulltextFields | string[] | No | Campos para BM25 full-text search |
| persistPath | string | No | Ruta para persistencia automatica |

#### Outputs de Operaciones

| Metodo | Output | Descripcion |
|--------|--------|-------------|
| insert | void | Sin retorno; lanza en error |
| search | MiniMemorySearchResult[] | Array de resultados con id, distance, score, metadata |
| hybridSearch | MiniMemorySearchResult[] | Idem, fusionando multiples senales |
| keywordSearch | MiniMemorySearchResult[] | Idem, desde BM25 |
| filterSearch | MiniMemorySearchResult[] | Idem, score siempre 1.0 |
| stats | MiniMemoryStats | count, dimensions, distance, indexType, hasFulltext, quantization |
| recallSimilar | RecallResult[] | id, relevance, priority, transferLevel, content |
| agentMemoryStats | AgentMemoryStats | totalEntries, episodes, codeSnippets, errorSolutions |

---

## 2. Que NO debe hacer (MUST NOT)

### 2.1 Fuera de Alcance

- No genera embeddings (el adapter recibe vectores ya generados)
- No expone HTTP ni WebSocket (es invocacion directa al binding nativo)
- No gestiona autenticacion ni permisos de usuario
- No implementa cache de resultados
- No re-rankea ni post-procesa resultados del binding
- No gestiona multiples instancias de VectorDB simultaneas
- No implementa sync con otras fuentes de datos externas

### 2.2 Anti-patterns Prohibidos

- No hacer `require('minimemory')` fuera del constructor (una sola carga del binding)
- No mantener estado entre llamadas que no sea el db y agentMemory del binding
- No capturar excepciones del binding silenciosamente excepto en `get()` e `initAgentMemory()`
- No mutar los parametros de entrada recibidos (crear nuevos objetos para el binding)
- No serializar/deserializar vectores internamente (el binding acepta number[] directamente)
- No intentar reconectar ni reinicializar el binding si falla despues del constructor
- No asumir que AgentMemory esta disponible sin verificar null

### 2.3 Restricciones de Implementacion

- No usar `import()` dinamico para el binding (usar `require()` para carga sincrona en constructor)
- No exponer la instancia interna de `db` ni `agentMemory` al consumidor
- No modificar el config despues de la inicializacion (inmutable post-constructor)
- No agregar logica de negocio (solo traduccion de interfaces y normalizacion de resultados)
- No hacer auto-save despues de cada operacion de escritura (a diferencia de MiniMemoryVectorStorage)
- No implementar retry ni circuit breaker (responsabilidad del consumidor, ej: los command handlers)

---

## 3. Como se que esta bien (ACCEPTANCE)

### 3.1 Criterios de Aceptacion

```gherkin
Feature: Inicializacion del Adapter

  Scenario: Inicializacion exitosa con configuracion minima
    DADO que el binding minimemory esta instalado
    CUANDO se crea un MiniMemoryApiAdapter con { dimensions: 384 }
    ENTONCES la instancia tiene un VectorDB funcional con HNSW y cosine
    Y agentMemory esta inicializado (o null si no esta disponible)
    Y stats() retorna { count: 0, dimensions: 384, distance: 'cosine', indexType: 'hnsw', hasFulltext: false, quantization: 'none' }

  Scenario: Inicializacion con fulltext habilitado
    DADO que el binding minimemory esta instalado
    CUANDO se crea con { dimensions: 768, fulltextFields: ['content', 'title'] }
    ENTONCES el VectorDB se inicializa via VectorDB.withFulltext()
    Y stats().hasFulltext es true
    Y keywordSearch() funciona correctamente

  Scenario: Binding no disponible
    DADO que minimemory no esta instalado
    CUANDO se intenta crear un MiniMemoryApiAdapter
    ENTONCES lanza Error con mensaje "minimemory Node.js binding not found"
    Y el mensaje incluye instrucciones de instalacion

  Scenario: Carga desde persistPath existente
    DADO un archivo .mmdb valido en el persistPath
    CUANDO se crea el adapter con ese persistPath
    ENTONCES carga los datos existentes automaticamente
    Y stats().count refleja los documentos cargados

  Scenario: AgentMemory no disponible en el binding
    DADO un binding que no expone la clase AgentMemory
    CUANDO se crea el adapter
    ENTONCES agentMemory queda como null (no lanza error)
    Y las operaciones VectorDB funcionan normalmente
    Y las operaciones AgentMemory lanzan "AgentMemory not available"

Feature: VectorDB - CRUD

  Scenario: Insert con vector y metadata
    DADO un adapter inicializado con dimensions: 3
    CUANDO se llama insert({ id: "doc-1", vector: [0.1, 0.2, 0.3], metadata: { title: "Test" } })
    ENTONCES contains("doc-1") retorna true
    Y get("doc-1") retorna { vector: [0.1, 0.2, 0.3], metadata: { title: "Test" } }

  Scenario: Insert sin vector (solo metadata)
    DADO un adapter inicializado
    CUANDO se llama insert({ id: "doc-2", metadata: { category: "notes" } })
    ENTONCES contains("doc-2") retorna true
    Y el documento se inserta via insert_document

  Scenario: Update de metadata existente
    DADO un documento "doc-1" insertado con metadata { a: 1 }
    CUANDO se llama update("doc-1", undefined, { a: 2, b: 3 })
    ENTONCES get("doc-1").metadata contiene { a: 2, b: 3 }

  Scenario: Delete de documento existente
    DADO un documento "doc-1" insertado
    CUANDO se llama delete("doc-1")
    ENTONCES contains("doc-1") retorna false

  Scenario: Get de documento inexistente
    DADO un adapter sin documentos
    CUANDO se llama get("no-existe")
    ENTONCES retorna null (no lanza error)

Feature: VectorDB - Search

  Scenario: Vector search retorna resultados ordenados
    DADO 10 documentos insertados con vectores de dimension 3
    CUANDO se llama search([0.5, 0.5, 0.5], 3)
    ENTONCES retorna exactamente 3 resultados
    Y cada resultado tiene id, distance, score y metadata
    Y score = 1 - distance
    Y estan ordenados por distance ascendente

  Scenario: Keyword search con BM25
    DADO un adapter con fulltextFields: ['content']
    Y documentos insertados con metadata.content: "rust programming async"
    CUANDO se llama keywordSearch("rust async", 5)
    ENTONCES retorna documentos cuyo content contiene esos terminos
    Y los resultados tienen score basado en BM25

  Scenario: Hybrid search combina senales
    DADO documentos con vectores y metadata indexada
    CUANDO se llama hybridSearch({ vector: [...], keywords: "test", topK: 5, vectorWeight: 0.7 })
    ENTONCES combina similaridad vectorial con BM25
    Y el peso relativo respeta vectorWeight

  Scenario: Filter search por operador eq
    DADO documentos con metadata { category: "tech" } y otros con { category: "art" }
    CUANDO se llama filterSearch([{ field: "category", operator: "eq", value: "tech" }], 10)
    ENTONCES retorna solo documentos con category "tech"
    Y todos los resultados tienen score: 1, distance: 0

  Scenario: Filter search con AND de multiples filtros
    DADO documentos con metadata variada
    CUANDO se llama filterSearch con 2 filtros (field A y field B)
    ENTONCES retorna solo documentos que cumplen AMBOS filtros

Feature: VectorDB - Persistencia

  Scenario: Save y load preservan datos
    DADO un adapter con 5 documentos insertados
    CUANDO se llama save("./test.mmdb")
    Y se crea un nuevo adapter con persistPath: "./test.mmdb"
    ENTONCES el nuevo adapter tiene stats().count === 5
    Y get() retorna los mismos documentos

  Scenario: Save sin path configurado
    DADO un adapter sin persistPath en config
    CUANDO se llama save() sin argumento
    ENTONCES lanza Error "No persist path configured"

Feature: Agent Memory - Learn

  Scenario: Learn task almacena episodio
    DADO un adapter con AgentMemory disponible
    CUANDO se llama learnTask({ task: "Deploy app", solution: "Docker compose", outcome: "success", learnings: ["Usar healthcheck"] })
    ENTONCES recallSimilar("deploy") retorna un resultado que contiene la tarea

  Scenario: Learn code almacena snippet
    DADO un adapter con AgentMemory disponible
    CUANDO se llama learnCode({ code: "fn main() {}", description: "Entry point", language: "rust", dependencies: [], useCase: "CLI app", qualityScore: 0.9, tags: ["rust", "cli"] })
    ENTONCES recallCode("entry point rust") retorna el snippet

  Scenario: Learn error almacena solucion
    DADO un adapter con AgentMemory disponible
    CUANDO se llama learnError({ errorMessage: "cannot borrow", errorType: "E0596", rootCause: "missing mut", solution: "add mut", language: "rust" })
    ENTONCES recallErrors("borrow error rust") retorna la solucion

Feature: Agent Memory - Recall

  Scenario: recallSimilar busca por relevancia
    DADO memoria con 3 episodios de tareas
    CUANDO se llama recallSimilar("authentication", 2)
    ENTONCES retorna hasta 2 resultados
    Y cada resultado tiene id, relevance, content

  Scenario: recallSuccessful filtra por outcome
    DADO memoria con episodios success y failure
    CUANDO se llama recallSuccessful("deploy", 5)
    ENTONCES retorna solo episodios con outcome "success"

Feature: Agent Memory - Working Context

  Scenario: Set y get working context
    DADO un adapter con AgentMemory disponible
    CUANDO se llama setWorkingContext("my-project", "implement auth", ["unit tests", "docs"])
    Y se llama getWorkingContext()
    ENTONCES el contexto retornado incluye el project, task y goals

  Scenario: focusProject optimiza busquedas
    DADO un adapter con AgentMemory disponible
    CUANDO se llama focusProject("agent-shell")
    ENTONCES las busquedas posteriores se enfocan en ese proyecto

Feature: Agent Memory - AgentMemory no disponible

  Scenario: Operaciones de memoria lanzan error descriptivo
    DADO un adapter donde agentMemory es null
    CUANDO se llama cualquier operacion de AgentMemory (learnTask, recallSimilar, etc.)
    ENTONCES lanza Error "AgentMemory not available in this binding version"
```

### 3.2 Casos de Prueba Requeridos

| ID | Escenario | Input | Output Esperado | Prioridad |
|----|-----------|-------|-----------------|-----------|
| T01 | Constructor minimo | { dimensions: 384 } | Instancia funcional | Alta |
| T02 | Constructor con fulltext | { dimensions: 768, fulltextFields: ['content'] } | hasFulltext: true | Alta |
| T03 | Constructor sin binding | require falla | Error con instrucciones | Alta |
| T04 | Insert con vector | id, vector[384], metadata | contains() true | Alta |
| T05 | Insert sin vector | id, metadata solo | document insertado | Alta |
| T06 | Update metadata | id existente, nueva metadata | get() refleja cambio | Alta |
| T07 | Delete existente | id valido | contains() false | Alta |
| T08 | Get existente | id valido | { vector, metadata } | Alta |
| T09 | Get inexistente | id invalido | null | Alta |
| T10 | Vector search topK | vector, topK=3 | Exactamente 3 resultados | Alta |
| T11 | Vector search score | vector query | score = 1 - distance | Alta |
| T12 | Keyword search | "rust async" con fulltext | Resultados BM25 | Alta |
| T13 | Hybrid search con vector+keywords | params completos | Resultados fusionados | Alta |
| T14 | Hybrid search solo keywords | { keywords: "test", topK: 5 } | Resultados BM25 | Media |
| T15 | Filter eq | field="category", value="tech" | Solo docs tech | Alta |
| T16 | Filter multiple AND | 2 filtros | Interseccion | Media |
| T17 | Filter contains | field="name", operator="contains" | Match parcial | Media |
| T18 | Stats completo | Adapter con docs | Todos los campos correctos | Alta |
| T19 | Save a path | path valido | Archivo .mmdb creado | Alta |
| T20 | Save sin path | ni arg ni config | Error "No persist path" | Media |
| T21 | Load existente | path con datos | stats().count > 0 | Alta |
| T22 | LearnTask success | TaskEpisode valido | Sin error | Alta |
| T23 | LearnCode completo | CodeSnippet con todos los campos | Sin error | Alta |
| T24 | LearnError con fixedCode | ErrorSolution completo | Sin error | Alta |
| T25 | RecallSimilar topK | query, topK=3 | Hasta 3 RecallResult | Alta |
| T26 | RecallCode | query de codigo | RecallResult[] filtrado | Alta |
| T27 | RecallErrors | query de error | RecallResult[] filtrado | Alta |
| T28 | RecallSuccessful | query general | Solo outcome success | Media |
| T29 | SetWorkingContext completo | project, task, goals | getWorkingContext() correcto | Alta |
| T30 | FocusProject | project name | Sin error | Media |
| T31 | AgentMemoryStats | Memoria con datos | Conteos correctos | Media |
| T32 | SaveMemory/LoadMemory | path valido | Persistencia funcional | Alta |
| T33 | AgentMemory null - learnTask | TaskEpisode | Error descriptivo | Alta |
| T34 | AgentMemory null - recall | query | Error descriptivo | Alta |
| T35 | Dimensions mismatch | insert vector[3] en db dimension 384 | Error del binding | Media |
| T36 | Insert ID duplicado | mismo id 2 veces | Error del binding | Media |

### 3.3 Metricas de Exito

- [ ] Cobertura de tests: >= 90% del adapter (excluir binding calls mockeados)
- [ ] Latencia insert: < 1ms por operacion (sin I/O disco)
- [ ] Latencia search: < 5ms para indices de hasta 10,000 vectores (HNSW)
- [ ] Latencia keyword search: < 10ms para indices con fulltext
- [ ] Latencia hybrid search: < 15ms (combina vector + BM25 + filter)
- [ ] Save/Load: < 500ms para bases de hasta 10,000 documentos
- [ ] Overhead del adapter sobre el binding nativo: < 0.5ms (solo normalizacion de datos)
- [ ] Zero memory leaks: el binding napi-rs gestiona su propia memoria nativa

### 3.4 Definition of Done

- [ ] Clase MiniMemoryApiAdapter implementada con todos los metodos listados en 1.2
- [ ] Todas las interfaces TypeScript exportadas (MiniMemoryConfig, MiniMemorySearchResult, etc.)
- [ ] Constructor con deteccion de binding y error descriptivo
- [ ] VectorDB con fulltext condicional (withFulltext vs new VectorDB)
- [ ] AgentMemory con degradacion graceful (null si no disponible)
- [ ] Mapeo camelCase <-> snake_case correcto para todos los tipos
- [ ] Normalizacion de score (1 - distance) en todos los metodos de search
- [ ] Tests unitarios con mock del binding (cobertura >= 90%)
- [ ] Tests de integracion con binding real (si disponible)
- [ ] Comandos del namespace mm: registrados y funcionales
- [ ] Documentacion de tipos JSDoc en todos los metodos publicos

---

## 4. Que pasa si falla (ERROR HANDLING)

### 4.1 Errores Esperados

| Codigo | Condicion | Respuesta | Accion del Consumidor |
|--------|-----------|-----------|----------------------|
| E-MM-001 | Binding minimemory no instalado | "minimemory Node.js binding not found. Install with: npm install minimemory" | Instalar el paquete o compilar desde fuente |
| E-MM-002 | AgentMemory no disponible | "AgentMemory not available in this binding version" | Usar solo operaciones VectorDB; actualizar binding |
| E-MM-003 | No persist path configurado | "No persist path configured" | Proveer path como argumento o en config |
| E-MM-004 | ID no encontrado en update/delete | Error del binding nativo (propagado) | Verificar existencia con contains() antes |
| E-MM-005 | Dimension mismatch en insert/search | Error del binding nativo (propagado) | Verificar que vector.length === config.dimensions |
| E-MM-006 | ID duplicado en insert | Error del binding nativo (propagado) | Usar update() para modificar existentes |
| E-MM-007 | Fulltext no configurado en keywordSearch | Error del binding nativo (propagado) | Inicializar con fulltextFields en config |
| E-MM-008 | Archivo .mmdb corrupto o incompatible | Error del binding en load() | Verificar version del archivo; recrear base |
| E-MM-009 | Vector vacio o invalido | Error del binding nativo | Validar vector antes de llamar al adapter |
| E-MM-010 | topK fuera de rango | Error del binding o resultados truncados | Usar topK entre 1 y 100 |

### 4.2 Estrategia de Fallback

- **Binding no disponible**: Fatal en constructor. El adapter no puede funcionar sin el binding nativo. El consumidor (command handler) debe capturar el error y reportar al agente.

- **AgentMemory no disponible**: Degradacion graceful. Se inicializa `agentMemory = null`. Los metodos VectorDB funcionan normalmente. Los metodos AgentMemory lanzan error descriptivo que el handler convierte a `{ success: false, error: "..." }`.

- **persistPath no existe al iniciar**: No es error. Se crea una base de datos fresca. El catch silencioso en `initDb()` maneja este caso.

- **Error en operacion de escritura (insert/update/delete)**: Propagacion directa. El binding lanza y el error sube al command handler que lo formatea como respuesta de error.

- **Error en operacion de lectura (search/get)**:
  - `get()` retorna null (catch interno)
  - `search/keywordSearch/hybridSearch/filterSearch` propagan el error

### 4.3 Logging y Monitoreo

**El adapter NO implementa logging propio.** La responsabilidad de logging esta en los command handlers que lo consumen:

- Los handlers del namespace mm: capturan errors con try/catch
- Retornan `{ success: false, data: null, error: "mensaje descriptivo" }`
- El Core de Agent Shell registra el error en el historial de contexto

**Metricas recomendadas para el consumidor:**
- `mm.operation.latency_ms` - Latencia por operacion (insert, search, etc.)
- `mm.operation.errors` - Contador de errores por tipo de operacion
- `mm.stats.count` - Cantidad de documentos en la base
- `mm.agent_memory.available` - Boolean, si AgentMemory esta disponible
- `mm.persist.save_ms` - Latencia de save
- `mm.persist.load_ms` - Latencia de load

### 4.4 Recuperacion

**Retry policy**: No aplica dentro del adapter. Las operaciones al binding nativo son sincronas y deterministicas. Si fallan, reintentar producira el mismo resultado. El consumidor decide si reintentar con parametros diferentes.

**Circuit breaker**: No aplica. El binding es local (no hay red ni servicios externos que puedan degradarse temporalmente).

**Rollback en persistencia**:
- save() es atomica desde la perspectiva del adapter (el binding maneja la escritura)
- Si save() falla a mitad, el archivo puede quedar corrupto
- Recomendacion para el consumidor: mantener un backup antes de save, o usar rutas temporales

---

## 5. Que supuestos tiene (ASSUMPTIONS)

### 5.1 Precondiciones

- [ ] El paquete `minimemory` esta instalado y accesible via require()
- [ ] El binding napi-rs esta compilado para la plataforma actual (win32/linux/darwin + arch)
- [ ] La version del binding expone al menos: VectorDB con constructor, insert, search, delete, contains, get, len, save, load
- [ ] Si se usan fulltextFields, el binding soporta VectorDB.withFulltext() como metodo estatico
- [ ] Node.js >= 18 (requerido por napi-rs)
- [ ] Las dimensiones del config coinciden con el modelo de embeddings usado externamente

### 5.2 Dependencias

| Dependencia | Tipo | Version | Critica | Descripcion |
|-------------|------|---------|---------|-------------|
| minimemory | Native binding (napi-rs) | >= 0.1.0 | Si | Base de datos vectorial embebida en Rust |
| minimemory.VectorDB | Clase exportada | N/A | Si | Operaciones de base de datos vectorial |
| minimemory.AgentMemory | Clase exportada | N/A | No | Memoria episodica del agente (puede no existir) |
| Node.js | Runtime | >= 18.0 | Si | Requerido por napi-rs |
| TypeScript | Lenguaje | >= 5.0 | Si | Sistema de tipos |

### 5.3 Datos de Entrada Esperados

**Vectores:**
- Tipo: number[] (Float64 en JS, convertido a f32 en Rust)
- Longitud: Exactamente igual a config.dimensions
- Rango: Valores normalizados o sin normalizar (depende del distance metric)
- No NaN, no Infinity

**Metadata:**
- Tipo: Record<string, any> (objeto plano serializable)
- Valores: string, number, boolean, arrays de primitivos, objetos anidados
- Tamanio: Sin limite explicito pero sujeto a memoria disponible
- Encoding: UTF-8 para strings

**IDs:**
- Tipo: string
- Formato: Libre (el consumidor define la convencion)
- Unicidad: Obligatoria dentro de una instancia de VectorDB
- Longitud: Sin limite explicito

### 5.4 Estado del Sistema

- El adapter es stateful: mantiene referencia al db y agentMemory del binding
- Una instancia del adapter corresponde a una instancia de VectorDB y una de AgentMemory
- El adapter no es thread-safe (operaciones sincronas sobre estado compartido)
- El adapter no soporta hot-reload del config (crear nueva instancia para reconfigurar)
- Las operaciones de VectorDB y AgentMemory son independientes (distintas instancias internas)

### 5.5 Supuestos Tecnicos

- El binding napi-rs gestiona la memoria nativa (Rust) automaticamente via Drop
- Las operaciones del binding son sincronas (bloquean el event loop brevemente)
- El formato .mmdb es propietario de minimemory y no es compatible con otros formatos
- La inicializacion del VectorDB con HNSW es O(1) para base vacia, O(n) para load
- El AgentMemory usa internamente el VectorDB del binding (no el que crea el adapter)
- Los resultados de search del binding estan pre-ordenados por distancia ascendente

---

## 6. Que limites tiene (CONSTRAINTS)

### 6.1 Limites Tecnicos

| Parametro | Limite | Razon |
|-----------|--------|-------|
| dimensions | 1 - 4096 | Restriccion del binding de minimemory |
| topK | 1 - 100 | Restriccion del binding; protege memoria |
| Tamano de vector | Exactamente = dimensions | Mismatch causa error del binding |
| Documentos por instancia | Sin limite explicito | Limitado por RAM disponible |
| Tamano de metadata | Sin limite explicito | Limitado por RAM disponible |
| Operaciones concurrentes | 1 (sincrono) | Binding es single-threaded per-instance |
| Tamanio archivo .mmdb | Limitado por disco | Proporcional a count * (dimensions * 4 + metadata_size) |
| fulltextFields | Definidos al crear la instancia | No se pueden agregar/quitar despues |
| quantization | Definida al crear la instancia | Cambia la precision de los vectores almacenados |
| Latencia de operaciones | Microsegundos-milisegundos | No hay red; binding nativo directo |

### 6.2 Limites de Negocio

- Una instancia de MiniMemoryApiAdapter = una base de datos aislada
- VectorDB y AgentMemory del adapter son instancias separadas (no comparten datos)
- Los vectores deben ser generados externamente (el adapter no integra modelos de embeddings)
- La calidad de busqueda depende de la calidad de los embeddings provistas por el consumidor
- La persistencia es manual (el consumidor decide cuando save/load)
- No hay versionado de documentos (update sobrescribe, no hay historial)
- No hay transacciones (cada operacion es independiente)

### 6.3 Limites de Seguridad

- **Autenticacion**: No aplica. Es un componente in-process, no un servicio.
- **Autorizacion**: No aplica. Todos los consumidores tienen acceso total a todas las operaciones.
- **Datos sensibles**: Los vectores y metadata se almacenan en texto plano en .mmdb. No usar para secretos/credenciales.
- **Input validation**: Minima. Se delega al binding nativo la validacion de tipos y rangos.
- **Path traversal**: Los paths de save/load se pasan directo al binding. El consumidor es responsable de sanitizar.
- **Injection**: No aplica. No hay interpretacion de queries como codigo.

### 6.4 Limites de Alcance - Version 1.0

**Esta version NO incluye:**
- Operaciones batch nativas (insert_batch, delete_batch) - iterar manualmente
- Paginacion de resultados de search (solo topK)
- Streaming de resultados grandes
- Subscripcion a cambios (watchers/events)
- Merge de multiples archivos .mmdb
- Export a otros formatos (JSON, Parquet, etc.)
- Validacion de dimensiones del vector antes de pasar al binding
- Metrics/tracing integrado

**Consideraciones futuras (v2.0+):**
- Batch operations nativas cuando el binding las soporte
- Validacion pre-binding de vectores (dimensions, NaN, Infinity)
- Integración con el EmbeddingAdapter de Agent Shell para generar vectores on-the-fly
- Export/import JSON para portabilidad
- Namespace isolation (multiples VectorDB en un adapter)
- AgentMemory con decay temporal (olvidar experiencias antiguas)
- Compresion/quantizacion configurable post-init via rebuild

---

## 7. Mapping de Comandos mm: (Referencia)

El adapter es consumido por los command handlers del namespace `mm:`. Esta tabla mapea comandos a metodos:

| Comando | Metodo del Adapter | Params Principales |
|---------|-------------------|-------------------|
| mm:stats | stats() | - |
| mm:insert | insert(params) | id, vector?, metadata?, content? |
| mm:delete | delete(id) | id |
| mm:get | get(id) | id |
| mm:search | search(vector, topK) | vector, top_k? |
| mm:keywords | keywordSearch(query, topK) | query, top_k? |
| mm:hybrid | hybridSearch(params) | vector?, keywords?, filter?, top_k?, vector_weight? |
| mm:filter | filterSearch(filters, topK) | field, operator, value, top_k? |
| mm:save | save(path?) | path? |
| mm:load | load(path?) | path? |
| mm:learn | learnTask(episode) | task, solution, outcome, learnings? |
| mm:recall | recallSimilar(query, topK) | query, top_k? |
| mm:learn-code | learnCode(snippet) | code, description, language, use_case, dependencies?, tags?, quality? |
| mm:recall-code | recallCode(query, topK) | query, top_k? |
| mm:learn-error | learnError(solution) | error_message, error_type, root_cause, solution, fixed_code?, language |
| mm:recall-errors | recallErrors(query, topK) | query, top_k? |
| mm:context | setWorkingContext/getWorkingContext | project?, task?, goals? |
| mm:focus | focusProject(project) | project |
| mm:memory-stats | agentMemoryStats() + stats() | - |
| mm:save-memory | saveMemory(path) | path |
| mm:load-memory | loadMemory(path) | path |

---

## 8. Diferencias Clave con Otros Adapters

| Aspecto | MiniMemoryApiAdapter | HTTP Adapters (VoltAgent/n8n) |
|---------|---------------------|-------------------------------|
| Transporte | Binding nativo (napi-rs) | HTTP/SSE |
| Latencia | Microsegundos | Milisegundos-segundos |
| Dependencia externa | Solo el paquete npm | Servidor corriendo |
| Estado | In-process (mismo heap) | Externo (otro proceso) |
| Inicializacion | Sincrona en constructor | Async con health check |
| Error handling | Excepciones JS | HTTP status codes |
| Concurrencia | Single-threaded | Multi-request |
| Persistencia | .mmdb (binding maneja) | Database del servicio |

---

## Anexos

### A. Glosario

| Termino | Definicion |
|---------|------------|
| napi-rs | Framework para crear bindings nativos de Rust para Node.js |
| HNSW | Hierarchical Navigable Small World - algoritmo de busqueda aproximada de vecinos cercanos |
| BM25 | Best Matching 25 - algoritmo de ranking para full-text search |
| RRF | Reciprocal Rank Fusion - metodo para combinar rankings de multiples fuentes |
| Quantization | Compresion de vectores (float32->int8/binary) para reducir memoria |
| AgentMemory | Subsistema de minimemory para memoria episodica de agentes IA |
| TaskEpisode | Registro de una tarea completada con su solucion y resultado |
| .mmdb | Formato binario propietario de minimemory para persistencia |
| Fulltext | Indice invertido para busqueda por texto completo (BM25) |
| Distance | Distancia entre vectores (menor = mas similar para cosine/euclidean) |
| Score | Similaridad derivada: 1 - distance (mayor = mas similar) |
| Fusion K | Parametro de la formula RRF: 1/(k + rank). Default tipico: 60 |

### B. Referencias

- minimemory repository: https://github.com/MauricioPerera/minimemory
- Adapter source: `d:/repos/agent-shell/demo/adapters/minimemory-api.ts`
- Commands source: `d:/repos/agent-shell/demo/minimemory-commands.ts`
- VectorStorage adapter: `d:/repos/agent-shell/demo/adapters/minimemory-vector-storage.ts`
- Integration demo: `d:/repos/agent-shell/demo/minimemory-integration.ts`
- Vector Index contract: `d:/repos/agent-shell/contracts/vector-index.md`
- Core contract: `d:/repos/agent-shell/contracts/core.md`

### C. Tipos Completos (TypeScript)

```typescript
// --- Config ---
interface MiniMemoryConfig {
  dimensions: number;
  distance?: 'cosine' | 'euclidean' | 'dot_product';
  indexType?: 'flat' | 'hnsw';
  quantization?: 'none' | 'int8' | 'binary';
  fulltextFields?: string[];
  persistPath?: string;
}

// --- VectorDB Types ---
interface MiniMemoryInsertParams {
  id: string;
  vector?: number[];
  metadata?: Record<string, any>;
  content?: string;
}

interface MiniMemorySearchResult {
  id: string;
  distance: number;
  score: number;
  metadata?: Record<string, any>;
}

interface MiniMemoryHybridParams {
  vector?: number[];
  keywords?: string;
  filter?: Record<string, any>;
  topK: number;
  vectorWeight?: number;
  fusionK?: number;
}

interface MiniMemoryFilterParams {
  field: string;
  operator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'starts_with';
  value: any;
}

interface MiniMemoryStats {
  count: number;
  dimensions: number;
  distance: string;
  indexType: string;
  hasFulltext: boolean;
  quantization: string;
}

// --- Agent Memory Types ---
interface TaskEpisode {
  task: string;
  solution: string;
  outcome: 'success' | 'failure' | 'partial';
  learnings: string[];
}

interface CodeSnippet {
  code: string;
  description: string;
  language: string;
  dependencies: string[];
  useCase: string;
  qualityScore: number;
  tags: string[];
}

interface ErrorSolution {
  errorMessage: string;
  errorType: string;
  rootCause: string;
  solution: string;
  fixedCode?: string;
  language: string;
}

interface RecallResult {
  id: string;
  relevance: number;
  priority?: string;
  transferLevel?: string;
  content: Record<string, any>;
}

interface AgentMemoryStats {
  totalEntries: number;
  episodes: number;
  codeSnippets: number;
  errorSolutions: number;
}
```

### D. Historial de Cambios

| Version | Fecha | Autor | Cambios |
|---------|-------|-------|---------|
| 1.0 | 2026-01-24 | Spec Architect (Claude Opus 4.5) | Version inicial del contrato |
