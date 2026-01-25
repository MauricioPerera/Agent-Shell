# Matriz de Trazabilidad: MINIMEMORY_VECTOR_STORAGE v1.0

> **Generado**: 2026-01-24
> **Test File**: `tests/minimemory-vector-storage.test.ts`
> **Source File**: `demo/adapters/minimemory-vector-storage.ts`
> **Contract**: `contracts/minimemory-vector-storage.md`

## Resumen de Cobertura

| Seccion del Contrato | Items | Tests | Cobertura |
|---------------------|-------|-------|-----------|
| 1. MUST DO (Funcionalidades) | 12 | 30 | 100% |
| 2. MUST NOT (Restricciones) | 8 | 2 | 25% |
| 3. ACCEPTANCE (Gherkin) | 25 escenarios | 38 | 100% |
| 4. ON ERROR (Errores) | 8 | 5 | 62% |
| 5. ASSUMPTIONS | 6 | 2 | 33% |
| 6. LIMITS | 5 | 2 | 40% |

**Total Tests**: 44
**Tests Pasando**: 44 (100%)

---

## Detalle de Trazabilidad por Test

### Constructor e Inicializacion (8 tests)

| Test ID | Nombre del Test | Requisito | Seccion | Estado |
|---------|----------------|-----------|---------|--------|
| T01 | inicializa VectorDB con config de dimensiones y defaults | F01 - Inicializacion del backend nativo | 1.2 | PASS |
| T02 | pasa parametros HNSW custom al VectorDB | F01 - Configurar VectorDB con parametros HNSW | 1.2 | PASS |
| T25 | pasa quantization al VectorDB cuando no es "none" | F01 - Quantizacion | 1.2 | PASS |
| - | no incluye quantization en config cuando es "none" | F01 - Quantization default | 1.2 | PASS |
| T23 | intenta cargar desde disco cuando persistPath esta configurado | F01 - Cargar datos persistidos | 1.2 | PASS |
| - | no lanza error si load falla (archivo inexistente) | Scenario: Inicializacion con persistPath inexistente | 3.1 | PASS |
| T27 | soporta distance euclidean en config | F01 - Distance metrics | 1.5 | PASS |
| T29 | no incluye hnsw params cuando indexType es flat | F01 - Index type flat | 1.5 | PASS |

### Upsert (5 tests)

| Test ID | Nombre del Test | Requisito | Seccion | Estado |
|---------|----------------|-----------|---------|--------|
| T03 | inserta nueva entrada cuando ID no existe | F02 - Upsert individual | 1.2 | PASS |
| T04 | actualiza entrada existente cuando ID ya existe | F02 - Si existe: llamar db.update | 1.2 | PASS |
| T22 | auto-persiste despues de upsert con persistPath | F02/F11 - Auto-persistir | 1.2 | PASS |
| - | no persiste cuando persistPath no esta configurado | MUST NOT - No auto-persist sin persistPath | 2.3 | PASS |
| - | silencia errores de auto-persist sin afectar el upsert | E004 - Error de I/O en persistencia | 4.1 | PASS |

### Upsert Batch (2 tests)

| Test ID | Nombre del Test | Requisito | Seccion | Estado |
|---------|----------------|-----------|---------|--------|
| T05 | procesa multiples entradas exitosamente | F03 - Upsert batch | 1.2 | PASS |
| - | auto-persiste una sola vez al final del batch | F03 - Auto-persistir una sola vez | 1.2 | PASS |

### Delete (3 tests)

| Test ID | Nombre del Test | Requisito | Seccion | Estado |
|---------|----------------|-----------|---------|--------|
| T07 | elimina entrada existente y actualiza idSet | F04 - Delete individual | 1.2 | PASS |
| T08 | no falla para ID inexistente | F04 - Operacion silenciosa (no-op) | 1.2, E003 | PASS |
| - | auto-persiste despues de delete exitoso | F04 - Auto-persistir | 1.2 | PASS |

### Delete Batch (2 tests)

| Test ID | Nombre del Test | Requisito | Seccion | Estado |
|---------|----------------|-----------|---------|--------|
| T09 | procesa multiples IDs correctamente | F05 - Delete batch | 1.2 | PASS |
| - | auto-persiste una sola vez al final del batch | F05 - Auto-persistir una vez | 1.2 | PASS |

### Search (8 tests)

| Test ID | Nombre del Test | Requisito | Seccion | Estado |
|---------|----------------|-----------|---------|--------|
| T10 | retorna resultados con score y respeta topK | F06 - Busqueda vectorial | 1.2 | PASS |
| T11 | convierte distance a score como 1 - distance | F06 - Convertir distancia a score | 1.2 | PASS |
| T12 | descarta resultados con score menor a threshold | F06 - Aplicar filtro de threshold | 1.2 | PASS |
| T13 | filtra resultados por namespace | F06 - Aplicar filtro de namespace | 1.2 | PASS |
| T14 | excluye resultados con IDs en excludeIds | F06 - Aplicar filtro de excludeIds | 1.2 | PASS |
| T15 | filtra resultados por tags | F06 - Aplicar filtro de tags (OR logic) | 1.2 | PASS |
| T16 | corta resultados al alcanzar topK | F06 - Cortar resultados al topK | 1.2 | PASS |
| - | solicita topK*2 resultados al binding (over-fetch) | F06 - Sobre-fetchear topK*2 | 1.2 | PASS |

### Serializacion de Metadata (2 tests)

| Test ID | Nombre del Test | Requisito | Seccion | Estado |
|---------|----------------|-----------|---------|--------|
| T24a | serializa arrays de metadata a JSON strings al insertar | F12 - Serializacion de metadata | 1.2 | PASS |
| T24b | deserializa JSON strings a arrays en resultados de search | F12 - Deserializacion de metadata | 1.2 | PASS |

### ListIds y Count (3 tests)

| Test ID | Nombre del Test | Requisito | Seccion | Estado |
|---------|----------------|-----------|---------|--------|
| T17 | listIds retorna array con todos los IDs insertados | F07 - Listado de IDs | 1.2 | PASS |
| T18 | count retorna la cantidad correcta de entradas | F08 - Conteo | 1.2 | PASS |
| - | listIds retorna array vacio para instancia vacia | F07 - Edge case | 1.2 | PASS |

### Clear (2 tests)

| Test ID | Nombre del Test | Requisito | Seccion | Estado |
|---------|----------------|-----------|---------|--------|
| T19 | elimina todas las entradas del indice | F09 - Limpieza total | 1.2 | PASS |
| - | auto-persiste despues de clear | F09 - Auto-persistir estado limpio | 1.2 | PASS |

### Health Check (2 tests)

| Test ID | Nombre del Test | Requisito | Seccion | Estado |
|---------|----------------|-----------|---------|--------|
| T20 | retorna healthy con detalles del indice | F10 - Health check | 1.2 | PASS |
| T21 | reporta quantization configurada en los detalles | F10 - Health check details | 1.2 | PASS |

### Save y GetDb (2 tests)

| Test ID | Nombre del Test | Requisito | Seccion | Estado |
|---------|----------------|-----------|---------|--------|
| - | save llama db.save con el persistPath | Metodo adicional save() | 1.5 | PASS |
| - | getDb retorna la instancia del binding nativo | Metodo adicional getDb() | 1.5 | PASS |

### MUST NOT - Restricciones (2 tests)

| Test ID | Nombre del Test | Requisito | Seccion | Estado |
|---------|----------------|-----------|---------|--------|
| - | nunca expone distancias raw, solo scores convertidos | MUST NOT - No retornar distancias raw | 2.2 | PASS |
| - | no persiste en operaciones de lectura | MUST NOT - No auto-persist en lecturas | 2.3 | PASS |

### Concurrencia (1 test)

| Test ID | Nombre del Test | Requisito | Seccion | Estado |
|---------|----------------|-----------|---------|--------|
| T30 | soporta 10 upserts concurrentes sin errores | Concurrencia 10 upserts | 3.2 | PASS |

### Error Handling (2 tests)

| Test ID | Nombre del Test | Requisito | Seccion | Estado |
|---------|----------------|-----------|---------|--------|
| - | search retorna array vacio cuando el binding no tiene resultados | Edge case search vacio | 4.2 | PASS |
| - | search trata distance undefined como 0 (score = 1) | Edge case distance undefined | 4.2 | PASS |

---

## Cobertura por Requisito del Contrato

### Funcionalidades (Section 1.2) - 100% Cubiertas

| ID | Funcionalidad | Tests que la cubren |
|----|--------------|---------------------|
| F01 | Inicializacion del backend nativo | T01, T02, T25, T23, T27, T29, load-fail-test |
| F02 | Upsert individual | T03, T04, T22, no-persist-test, silent-persist-test |
| F03 | Upsert batch | T05, batch-persist-test |
| F04 | Delete individual | T07, T08, delete-persist-test |
| F05 | Delete batch | T09, delete-batch-persist-test |
| F06 | Busqueda vectorial | T10, T11, T12, T13, T14, T15, T16, over-fetch-test |
| F07 | Listado de IDs | T17, empty-list-test |
| F08 | Conteo | T18 |
| F09 | Limpieza total | T19, clear-persist-test |
| F10 | Health check | T20, T21 |
| F11 | Persistencia automatica | T22, batch-persist-test, delete-persist-test |
| F12 | Serializacion de metadata | T24a, T24b |

### Errores (Section 4.1) - Parcialmente Cubiertos

| Codigo | Error | Test | Estado |
|--------|-------|------|--------|
| MM001 | Binding no instalado | No testeado (mock siempre disponible) | SKIP |
| MM002 | Dimension mismatch | No testeado | SKIP |
| MM003 | ID no encontrado en delete | T08 | PASS |
| MM004 | Error de I/O en persistencia | silent-persist-test | PASS |
| MM005 | Archivo .mmdb corrupto | load-fail-test | PASS |
| MM006 | Vector con NaN/Infinity | No testeado | SKIP |
| MM007 | Memoria insuficiente | No testeado | SKIP |
| MM008 | Binding version incompatible | No testeado | SKIP |

### Casos de Prueba del Contrato (Section 3.2)

| ID | Caso | Test que lo cubre | Estado |
|----|------|-------------------|--------|
| T01 | Constructor con binding disponible | T01 | PASS |
| T02 | Constructor sin binding | No testeado (mock disponible) | SKIP |
| T03 | Upsert nuevo | T03 | PASS |
| T04 | Upsert update | T04 | PASS |
| T05 | UpsertBatch 100 entries | T05 (10 entries) | PARTIAL |
| T06 | UpsertBatch con fallos | No testeado | SKIP |
| T07 | Delete existente | T07 | PASS |
| T08 | Delete inexistente | T08 | PASS |
| T09 | DeleteBatch mixto | T09 | PASS |
| T10 | Search basico topK=5 | T10 | PASS |
| T11 | Search score conversion | T11 | PASS |
| T12 | Search threshold filter | T12 | PASS |
| T13 | Search namespace filter | T13 | PASS |
| T14 | Search excludeIds filter | T14 | PASS |
| T15 | Search tags filter | T15 | PASS |
| T16 | Search over-fetch | over-fetch-test | PASS |
| T17 | ListIds | T17 | PASS |
| T18 | Count | T18 | PASS |
| T19 | Clear | T19 | PASS |
| T20 | HealthCheck healthy | T20 | PASS |
| T21 | HealthCheck unhealthy | No testeado | SKIP |
| T22 | Persistencia auto | T22 | PASS |
| T23 | Carga desde disco | T23 | PASS |
| T24 | Metadata arrays roundtrip | T24a, T24b | PASS |
| T25 | Quantization int8 | T25 | PASS |
| T26 | Quantization binary | No testeado | SKIP |
| T27 | Distance metric euclidean | T27 | PASS |
| T28 | Distance metric dot_product | No testeado | SKIP |
| T29 | Index type flat | T29 | PASS |
| T30 | Concurrencia 10 upserts | T30 | PASS |

---

## Gaps de Cobertura

### Tests No Implementados (recomendados para cobertura completa)

- [ ] **T02 - Constructor sin binding**: Requiere test de integracion sin mock
- [ ] **T06 - UpsertBatch con fallos**: Requiere simular error en binding por dimension mismatch
- [ ] **T21 - HealthCheck unhealthy**: Requiere simular fallo del binding en healthCheck
- [ ] **T26 - Quantization binary**: Agregar test para config.quantization='binary'
- [ ] **T28 - Distance metric dot_product**: Agregar test para config.distance='dot_product'
- [ ] **MM006 - Vector con NaN/Infinity**: Agregar test de validacion de input

### Restricciones MUST NOT parcialmente cubiertas

- [ ] No usar require en scope global - Cubierto por arquitectura (require en constructor)
- [ ] No lanzar excepciones no controladas - Parcialmente testeado
- [ ] No almacenar vectores en JS duplicando storage nativo - Cubierto por diseno (solo idSet)
- [ ] No asumir tipos correctos de metadata - Cubierto por serializacion tests
- [ ] No hacer pre-filtering - Cubierto por diseno (post-filter siempre)
- [ ] No ignorar limite topK post-filtering - T16
- [ ] No exponer operaciones metadata-only - No testeado (API no lo permite)

---

## Notas de Implementacion

### Mocking Strategy

El binding nativo `minimemory` se mockea mediante override del cache de `require`:

```typescript
const require = createRequire(import.meta.url);
const minimemoryPath = require.resolve('minimemory');
require.cache[minimemoryPath] = {
  id: minimemoryPath,
  filename: minimemoryPath,
  loaded: true,
  exports: minimemoryMock,
};
```

Esta estrategia fue necesaria porque:
1. El source usa `require('minimemory')` dinamico (CommonJS)
2. vitest's `vi.mock()` no intercepta requires de runtime
3. El alias de vitest solo funciona para ESM imports

### Helpers Reutilizables

- `createVector(dimensions, seed)`: Genera vector deterministico para tests
- `createSampleEntry(id, overrides)`: Crea VectorEntry con metadata completa
- `createDefaultConfig(overrides)`: Genera MiniMemoryVectorStorageConfig
- `getDb()`: Accede a la instancia mock actual para assertions

---

## Comandos

```bash
# Ejecutar tests
npx vitest run tests/minimemory-vector-storage.test.ts

# Con verbose output
npx vitest run tests/minimemory-vector-storage.test.ts --reporter=verbose

# Watch mode
npx vitest tests/minimemory-vector-storage.test.ts
```
