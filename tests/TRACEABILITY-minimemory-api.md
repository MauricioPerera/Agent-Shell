# Matriz de Trazabilidad: CONTRACT_MINIMEMORY_API_ADAPTER v1.0

## Resumen de Cobertura

| Seccion | Items del Contrato | Tests | Cobertura |
|---------|-------------------|-------|-----------|
| 1. MUST DO - Inicializacion | 8 | 9 | 100% |
| 1. MUST DO - VectorDB CRUD | 5 | 10 | 100% |
| 1. MUST DO - VectorDB Search | 4 | 14 | 100% |
| 1. MUST DO - Stats & Persistence | 3 | 9 | 100% |
| 1. MUST DO - AgentMemory Learn | 3 | 4 | 100% |
| 1. MUST DO - AgentMemory Recall | 4 | 7 | 100% |
| 1. MUST DO - Working Context | 3 | 5 | 100% |
| 1. MUST DO - AgentMemory Stats | 2 | 4 | 100% |
| 2. MUST NOT | 5 | 7 | 100% |
| 3. ACCEPTANCE | 9 | 9 | 100% |
| 4. ON ERROR | 7 | 12 | 100% |
| 6. LIMITS | 8 | 10 | 100% |
| **TOTAL** | **61** | **100** | **100%** |

## Detalle de Trazabilidad por Seccion

### 1. MUST DO - Inicializacion (F01)

| Requisito | Test(s) | Estado |
|-----------|---------|--------|
| F01 - Constructor inicializa VectorDB | T01: creates instance with minimal config | PASS |
| F01 - withFulltext para fulltext | T02: uses VectorDB.withFulltext when fulltextFields are provided | PASS |
| F01 - Carga desde persistPath | T03: loads from persistPath when configured | PASS |
| F01 - No falla si persistPath no existe | T03b: does not throw if persistPath file does not exist | PASS |
| F01 - Defaults correctos | applies default distance=cosine, indexType=hnsw, quantization=none | PASS |
| F01 - Quantization non-none | passes quantization to binding config when not "none" | PASS |
| F01 - AgentMemory small | initializes AgentMemory with type "small" when dimensions <= 384 | PASS |
| F01 - AgentMemory openai | initializes AgentMemory with type "openai" when dimensions > 384 | PASS |
| F01 - AgentMemory graceful degradation | sets agentMemory to null if AgentMemory constructor throws | PASS |

### 1. MUST DO - VectorDB CRUD (F02-F06)

| Requisito | Test(s) | Estado |
|-----------|---------|--------|
| F02 - insert con vector | T04: insert with vector calls db.insert | PASS |
| F02 - insert sin vector | T05: insert without vector calls db.insert_document | PASS |
| F02 - insert metadata vacio | insert passes empty object when metadata is undefined | PASS |
| F03 - update documento | T06: update calls db.update_document | PASS |
| F03 - update solo vector | update with vector passes vector and null metadata | PASS |
| F04 - delete documento | T07: delete calls db.delete with the id | PASS |
| F05 - contains true | T08: contains returns true for existing document | PASS |
| F05 - contains false | contains returns false for non-existing document | PASS |
| F06 - get documento | T08b: get returns document for existing ID | PASS |
| F06 - get null si no existe | T09: get returns null for non-existing ID | PASS |

### 1. MUST DO - VectorDB Search (F07-F10)

| Requisito | Test(s) | Estado |
|-----------|---------|--------|
| F07 - search retorna topK | T10: search returns exactly topK results | PASS |
| F07 - score = 1 - distance | T11: search converts distance to score | PASS |
| F07 - search result structure | search results contain id, distance, score, and metadata | PASS |
| F08 - keywordSearch BM25 | T12: keywordSearch calls db.keyword_search | PASS |
| F08 - keywordSearch distance default | keywordSearch defaults distance to 0 | PASS |
| F09 - hybridSearch snake_case | T13: hybridSearch converts camelCase params to snake_case | PASS |
| F09 - hybridSearch keywords only | T14: hybridSearch works with keywords only | PASS |
| F09 - hybridSearch filter | hybridSearch passes filter when provided | PASS |
| F09 - hybridSearch score | hybridSearch normalizes results with score | PASS |
| F10 - filterSearch single | T15: filterSearch with single filter | PASS |
| F10 - filterSearch AND | T16: filterSearch with multiple filters builds AND | PASS |
| F10 - filterSearch contains | T17: filterSearch supports "contains" operator | PASS |
| F10 - filterSearch score=1 | filterSearch results have distance=0 and score=1 | PASS |
| F10 - filterSearch empty | filterSearch with empty filters array passes empty object | PASS |

### 1. MUST DO - Stats & Persistence (F11-F13)

| Requisito | Test(s) | Estado |
|-----------|---------|--------|
| F11 - stats completo | T18: stats returns complete database information | PASS |
| F11 - stats fulltext | stats.hasFulltext is true when initialized with fulltextFields | PASS |
| F11 - stats count | stats uses db.len() for the count value | PASS |
| F12 - save con path | T19: save calls db.save with the provided path | PASS |
| F12 - save persistPath | save uses persistPath from config when no argument provided | PASS |
| F12 - save error | T20: save throws "No persist path configured" | PASS |
| F13 - load con path | T21: load calls db.load with the provided path | PASS |
| F13 - load persistPath | load uses persistPath from config | PASS |
| F13 - load error | load throws "No persist path configured" | PASS |

### 1. MUST DO - AgentMemory Learn (F14-F16)

| Requisito | Test(s) | Estado |
|-----------|---------|--------|
| F14 - learnTask | T22: learnTask calls agentMemory.learn_task | PASS |
| F15 - learnCode snake_case | T23: learnCode maps camelCase to snake_case | PASS |
| F16 - learnError | T24: learnError maps all fields to snake_case | PASS |
| F16 - learnError fixedCode null | learnError maps fixedCode to null when not provided | PASS |

### 1. MUST DO - AgentMemory Recall (F17-F20)

| Requisito | Test(s) | Estado |
|-----------|---------|--------|
| F17 - recallSimilar | T25: recallSimilar calls recall_similar and maps results | PASS |
| F18 - recallCode | T26: recallCode calls recall_code and maps results | PASS |
| F19 - recallErrors | T27: recallErrors calls recall_error_solutions | PASS |
| F20 - recallSuccessful | T28: recallSuccessful calls recall_successful | PASS |
| F17 - transfer_level mapping | recall maps transfer_level to transferLevel | PASS |
| F17 - null results | recall returns empty array when binding returns null | PASS |
| F17 - score fallback | recall uses score as fallback when relevance is missing | PASS |

### 1. MUST DO - Working Context (F21-F23)

| Requisito | Test(s) | Estado |
|-----------|---------|--------|
| F21 - setWorkingContext | T29: setWorkingContext calls with_working_context | PASS |
| F21 - setWorkingContext callback | setWorkingContext callback calls set_project, set_task, add_goal | PASS |
| F21 - setWorkingContext skip task | setWorkingContext skips set_task when task is not provided | PASS |
| F22 - getWorkingContext | getWorkingContext returns result from agentMemory.working_context() | PASS |
| F23 - focusProject | T30: focusProject calls agentMemory.focus_project | PASS |

### 1. MUST DO - AgentMemory Stats (F24-F25)

| Requisito | Test(s) | Estado |
|-----------|---------|--------|
| F24 - agentMemoryStats camelCase | T31: agentMemoryStats maps snake_case to camelCase | PASS |
| F24 - agentMemoryStats defaults | agentMemoryStats defaults to 0 for missing fields | PASS |
| F25 - saveMemory | T32: saveMemory calls agentMemory.save | PASS |
| F25 - loadMemory | loadMemory calls agentMemory.load | PASS |

### 2. MUST NOT (Restricciones)

| Restriccion | Test(s) | Estado |
|-------------|---------|--------|
| No mutar params insert | does not mutate input params on insert | PASS |
| No mutar params hybridSearch | does not mutate input params on hybridSearch | PASS |
| Config inmutable | stats reflects initial config values | PASS |
| No exponer internos | does not expose internal db or agentMemory | PASS |
| No capturar excepciones | propagates binding errors on search operations | PASS |
| No capturar excepciones | propagates binding errors on keywordSearch | PASS |
| No re-rankear | preserves binding result order in search | PASS |

### 3. ACCEPTANCE (Flujos de Aceptacion)

| Escenario | Test(s) | Estado |
|-----------|---------|--------|
| VectorDB CRUD flow | full CRUD flow: insert -> contains -> get -> update -> delete | PASS |
| AgentMemory Learn/Recall | learn and recall flow: learnTask -> recallSimilar | PASS |
| Stats reflects insertions | stats().count reflects number of inserted documents | PASS |
| Working Context flow | setWorkingContext then getWorkingContext | PASS |
| VectorDB independencia | VectorDB operations work even when AgentMemory is null | PASS |
| Fulltext search | keywordSearch works when initialized with fulltextFields | PASS |
| Save/Load persistPath | save and load use persistPath from config | PASS |
| Save/Load override | save and load with explicit path overrides persistPath | PASS |

### 4. ON ERROR (Manejo de Errores)

| Error Code | Test(s) | Estado |
|------------|---------|--------|
| E-MM-001 | E-MM-001: error message includes installation instructions | PASS |
| E-MM-002 | E-MM-002: learnTask throws when AgentMemory is null | PASS |
| E-MM-002 | E-MM-002: recallSimilar throws when AgentMemory is null | PASS |
| E-MM-002 | E-MM-002: all AgentMemory operations throw when null | PASS |
| E-MM-003 | E-MM-003: save without path throws | PASS |
| E-MM-003 | E-MM-003: load without path throws | PASS |
| E-MM-004 | E-MM-004: update with non-existing ID propagates binding error | PASS |
| E-MM-004 | E-MM-004: delete with non-existing ID propagates binding error | PASS |
| E-MM-006 | E-MM-006: insert with duplicate ID propagates binding error | PASS |
| get null | get catches binding error for non-existing ID and returns null | PASS |

### 6. LIMITS (Tests de Limites)

| Limite | Test(s) | Estado |
|--------|---------|--------|
| dimensions min=1 | accepts dimensions at lower boundary (1) | PASS |
| dimensions max=4096 | accepts dimensions at upper boundary (4096) | PASS |
| AgentMemory type 384 | uses "small" type at exactly 384 dimensions | PASS |
| AgentMemory type 385 | uses "openai" type at 385 dimensions | PASS |
| Dimension mismatch | T35: propagates binding error on dimension mismatch | PASS |
| topK=1 | search accepts topK=1 as minimum | PASS |
| All distance metrics | accepts all valid distance metrics | PASS |
| All index types | accepts all valid index types | PASS |
| All quantization types | accepts all valid quantization types | PASS |
| Empty metadata | handles empty metadata object in insert | PASS |
| hybridSearch minimal | hybridSearch works with only topK | PASS |
| vectorWeight=0 | hybridSearch passes vectorWeight=0 | PASS |
| vectorWeight=1 | hybridSearch passes vectorWeight=1 | PASS |

## Archivos Generados

| Archivo | Descripcion |
|---------|-------------|
| `tests/minimemory-api.test.ts` | Suite completa de 100 tests |
| `node_modules/minimemory/index.js` | Mock del binding para tests |
| `node_modules/minimemory/package.json` | Package.json del mock |
| `tests/TRACEABILITY-minimemory-api.md` | Esta matriz de trazabilidad |

## Notas de Implementacion

1. **Mock Strategy**: Se creo un mock package en `node_modules/minimemory` porque el adapter usa `require('minimemory')` en runtime, lo cual no puede ser interceptado por `vi.mock()` en ESM.

2. **State Sharing**: El `mockState` se comparte entre el mock y los tests a traves de la referencia exportada del modulo mock.

3. **Test Organization**: Los tests estan organizados en secciones que corresponden a las secciones del contrato:
   - Initialization
   - VectorDB CRUD
   - VectorDB Search
   - Stats & Persistence
   - Agent Memory Learn/Recall/Context/Stats
   - Error Handling
   - MUST NOT (negative tests)
   - LIMITS (boundary tests)
   - Acceptance Flows (integration-style)

4. **Docblocks**: Cada test incluye anotaciones `@test`, `@requirement`, `@error`, `@mustnot`, o `@limit` para trazabilidad.
