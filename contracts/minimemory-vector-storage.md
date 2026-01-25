# Contrato: MINIMEMORY_VECTOR_STORAGE

> **Version**: 1.0
> **Fecha**: 2026-01-24
> **Estado**: Draft
> **Autor**: Spec Architect (Claude Opus 4.5)
> **Sistema**: Agent Shell
> **Modulo**: MiniMemory Vector Storage (VectorStorageAdapter impl)
> **Dependencias**: minimemory (napi-rs), vector-index/types

## Resumen Ejecutivo

MiniMemoryVectorStorage es una implementacion concreta de la interfaz VectorStorageAdapter de Agent Shell que usa la base de datos vectorial embebida minimemory (Rust + napi-rs) como backend. Reemplaza la busqueda brute-force O(n) con un indice HNSW O(log n), soporta quantizacion (Int8/Binary) para reducir memoria, y ofrece persistencia automatica a disco en formato .mmdb. Es el puente entre el motor de descubrimiento semantico de Agent Shell y el runtime nativo de Rust.

---

## 1. Que debe hacer (MUST DO)

### 1.1 Objetivo Principal

Implementar la interfaz `VectorStorageAdapter` delegando todas las operaciones vectoriales al binding nativo de minimemory, proporcionando busqueda aproximada rapida (HNSW), persistencia transparente, y manejo gracioso de errores del binding nativo, mientras se mantiene la conversion correcta entre las metricas de distancia de minimemory y los scores de similaridad esperados por Agent Shell.

### 1.2 Funcionalidades Requeridas

- [ ] **Inicializacion del backend nativo**
  - Importar dinamicamente el binding `minimemory` (napi-rs)
  - Configurar VectorDB con dimensiones, distancia, tipo de indice, parametros HNSW y quantizacion
  - Cargar datos persistidos desde disco si `persistPath` existe
  - Reconstruir el set interno de IDs a partir de los datos cargados
  - Lanzar error descriptivo si el binding no esta instalado

- [ ] **Upsert individual (upsert)**
  - Detectar si el ID ya existe (via idSet interno)
  - Si existe: llamar `db.update(id, vector, metadata)`
  - Si no existe: llamar `db.insert(id, vector, metadata)`
  - Serializar metadata (arrays a JSON strings) antes de pasar al binding
  - Actualizar idSet y auto-persistir

- [ ] **Upsert batch (upsertBatch)**
  - Iterar sobre cada entrada aplicando la logica de upsert individual
  - Capturar errores por entrada sin abortar el batch completo
  - Retornar BatchStorageResult con conteo de success/failed
  - Auto-persistir una sola vez al final del batch

- [ ] **Delete individual (delete)**
  - Verificar existencia en idSet antes de llamar al binding
  - Llamar `db.delete(id)` solo si el ID existe
  - Actualizar idSet y auto-persistir
  - Operacion silenciosa (no-op) si el ID no existe

- [ ] **Delete batch (deleteBatch)**
  - Iterar sobre cada ID aplicando logica de delete individual
  - IDs inexistentes cuentan como `failed` (no como error)
  - Capturar excepciones del binding sin abortar el batch
  - Auto-persistir una sola vez al final

- [ ] **Busqueda vectorial (search)**
  - Sobre-fetchear: solicitar `topK * 2` resultados al binding para compensar post-filtering
  - Convertir distancia a score de similaridad: `score = 1 - distance`
  - Aplicar filtro de threshold: descartar resultados con `score < threshold`
  - Aplicar filtro de namespace: comparar `metadata.namespace` con `filters.namespace`
  - Aplicar filtro de excludeIds: saltar resultados cuyo id este en la lista
  - Aplicar filtro de tags: incluir solo resultados con al menos un tag coincidente (OR logic)
  - Cortar resultados al alcanzar `topK` entradas validas
  - Deserializar metadata (JSON strings a arrays) al retornar

- [ ] **Listado de IDs (listIds)**
  - Retornar copia del idSet interno como array de strings

- [ ] **Conteo (count)**
  - Retornar el tamano del idSet interno

- [ ] **Limpieza total (clear)**
  - Iterar sobre todos los IDs en idSet llamando `db.delete()` por cada uno
  - Ignorar errores individuales durante la limpieza
  - Vaciar el idSet
  - Auto-persistir el estado limpio

- [ ] **Health check (healthCheck)**
  - Reportar status `healthy` con detalles del indice (count, dimensiones, quantizacion)
  - Reportar status `unhealthy` si el binding lanza una excepcion

- [ ] **Persistencia automatica (autoPersist)**
  - Guardar a disco despues de cada operacion de escritura si `persistPath` esta configurado
  - Silenciar errores de persistencia (no son criticos para la operacion)

- [ ] **Serializacion de metadata**
  - Convertir arrays (parameters, tags) a JSON strings antes de pasar al binding nativo
  - Convertir JSON strings de vuelta a arrays al leer del binding

### 1.3 Flujo Principal: Search

```
VectorIndex                MiniMemoryVectorStorage        minimemory (Rust/NAPI)
    |                              |                              |
    |-- search(query) ------------>|                              |
    |   {vector, topK,             |                              |
    |    threshold, filters}       |                              |
    |                              |-- db.search(vector, topK*2)->|
    |                              |                              |
    |                              |<-- raw results (id,         -|
    |                              |    distance, metadata)       |
    |                              |                              |
    |                              |-- post-process:              |
    |                              |   1. score = 1 - distance    |
    |                              |   2. filter threshold        |
    |                              |   3. filter namespace        |
    |                              |   4. filter excludeIds       |
    |                              |   5. filter tags             |
    |                              |   6. cut at topK             |
    |                              |   7. deserialize metadata    |
    |                              |                              |
    |<-- VectorSearchResult[] -----|                              |
```

### 1.4 Flujo Principal: Upsert

```
VectorIndex                MiniMemoryVectorStorage        minimemory (Rust/NAPI)
    |                              |                              |
    |-- upsert(entry) ------------>|                              |
    |   {id, vector, metadata}     |                              |
    |                              |-- serialize metadata         |
    |                              |   (arrays -> JSON strings)   |
    |                              |                              |
    |                              |-- check idSet.has(id)        |
    |                              |                              |
    |                              |-- [exists] db.update() ----->|
    |                              |   [new] db.insert() -------->|
    |                              |                              |
    |                              |-- idSet.add(id)              |
    |                              |-- autoPersist() ------------>|
    |                              |                              |
    |<-- void (resolved) ----------|                              |
```

### 1.5 Inputs y Outputs

#### Constructor

| Input | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| config.dimensions | number | Si | Dimensiones del vector (1-4096) |
| config.distance | string | No | Metrica: 'cosine' (default), 'euclidean', 'dot_product' |
| config.indexType | string | No | Tipo de indice: 'hnsw' (default), 'flat' |
| config.hnswM | number | No | Conexiones por nodo HNSW (default: 16) |
| config.hnswEfConstruction | number | No | Profundidad de busqueda en construccion (default: 200) |
| config.quantization | string | No | Quantizacion: 'none' (default), 'int8', 'binary' |
| config.persistPath | string | No | Ruta para persistencia .mmdb |

#### VectorStorageAdapter Methods

| Metodo | Input | Output |
|--------|-------|--------|
| upsert | VectorEntry | Promise\<void\> |
| upsertBatch | VectorEntry[] | Promise\<BatchStorageResult\> |
| delete | string (id) | Promise\<void\> |
| deleteBatch | string[] (ids) | Promise\<BatchStorageResult\> |
| search | VectorSearchQuery | Promise\<VectorSearchResult[]\> |
| listIds | (none) | Promise\<string[]\> |
| count | (none) | Promise\<number\> |
| clear | (none) | Promise\<void\> |
| healthCheck | (none) | Promise\<HealthStatus\> |

#### Metodos Adicionales (no en interfaz)

| Metodo | Input | Output | Descripcion |
|--------|-------|--------|-------------|
| save | (none) | void | Persistir a disco manualmente |
| getDb | (none) | any | Acceso al VectorDB nativo para operaciones avanzadas |

---

## 2. Que NO debe hacer (MUST NOT)

### 2.1 Fuera de Alcance

- No implementar busqueda BM25/full-text (eso es del MiniMemoryApiAdapter)
- No implementar hybrid search (vector + keywords)
- No gestionar embeddings (solo almacena vectores pre-generados)
- No implementar AgentMemory (eso es del MiniMemoryApiAdapter)
- No manejar sincronizacion con el Command Registry (eso es del VectorIndex)
- No implementar re-ranking ni fusion de resultados
- No exponer operaciones de metadata-only (insert sin vector)

### 2.2 Anti-patterns Prohibidos

- No usar `require('minimemory')` en scope global -> Debe ser en constructor con try/catch
- No lanzar excepciones no controladas del binding nativo -> Siempre envolver en try/catch
- No persistir sincrona y bloqueantemente en operaciones de lectura (search, count, listIds)
- No almacenar vectores en memoria JavaScript duplicando el storage nativo -> Solo mantener idSet
- No asumir que el binding retorna metadata con tipos correctos -> Siempre deserializar
- No hacer pre-filtering en el binding (minimemory no soporta filtros nativos) -> Post-filter siempre
- No retornar distancias raw al consumidor -> Siempre convertir a score (1 - distance)
- No ignorar el limite de topK despues del post-filtering -> Cortar al alcanzar topK

### 2.3 Restricciones de Implementacion

- No depender de features de minimemory que no esten en la API publica del binding Node.js
- No modificar la interfaz VectorStorageAdapter para acomodar limitaciones de minimemory
- No crear indices multiples dentro de una instancia (1 instancia = 1 indice)
- No implementar caching de resultados de busqueda (la latencia HNSW es suficientemente baja)
- No usar `db.list_ids()` del binding como fuente primaria de IDs (puede no estar disponible en todas las versiones) -> Usar el idSet interno
- No hacer auto-persist en operaciones de solo lectura (search, listIds, count, healthCheck)

---

## 3. Como se que esta bien (ACCEPTANCE)

### 3.1 Criterios de Aceptacion

```gherkin
Feature: Inicializacion

  Scenario: Inicializacion exitosa con HNSW
    DADO que el binding minimemory esta instalado
    CUANDO se crea una instancia con {dimensions: 768, indexType: 'hnsw'}
    ENTONCES la instancia se crea sin errores
    Y healthCheck retorna {status: 'healthy'}
    Y count retorna 0

  Scenario: Inicializacion con persistencia existente
    DADO un archivo .mmdb con 50 vectores previamente guardados
    CUANDO se crea una instancia con persistPath apuntando a ese archivo
    ENTONCES se cargan los 50 vectores
    Y count retorna 50
    Y listIds retorna 50 IDs

  Scenario: Inicializacion sin binding instalado
    DADO que el modulo 'minimemory' NO esta disponible
    CUANDO se intenta crear una instancia
    ENTONCES lanza Error con mensaje explicativo sobre como instalar

  Scenario: Inicializacion con persistPath inexistente
    DADO que el archivo en persistPath no existe aun
    CUANDO se crea una instancia con ese persistPath
    ENTONCES la instancia se crea normalmente (database fresco)
    Y count retorna 0

Feature: Upsert

  Scenario: Insertar vector nuevo
    DADO una instancia vacia
    CUANDO se llama upsert({id: 'cmd:test', vector: [...768 floats], metadata: {...}})
    ENTONCES count retorna 1
    Y listIds incluye 'cmd:test'
    Y search con el mismo vector retorna score cercano a 1.0

  Scenario: Actualizar vector existente
    DADO un vector con id 'cmd:test' ya insertado
    CUANDO se llama upsert con id 'cmd:test' y un vector diferente
    ENTONCES count sigue siendo 1 (no duplica)
    Y search con el nuevo vector retorna score cercano a 1.0
    Y search con el vector anterior retorna score menor

  Scenario: Serializar metadata con arrays
    DADO metadata con parameters: ['--name', '--email'] y tags: ['users', 'admin']
    CUANDO se llama upsert con esa metadata
    Y luego se busca ese vector
    ENTONCES la metadata retornada tiene parameters como array (no string)
    Y tags como array (no string)

Feature: Upsert Batch

  Scenario: Batch completamente exitoso
    DADO 10 VectorEntry validos
    CUANDO se llama upsertBatch con los 10
    ENTONCES retorna {success: 10, failed: 0}
    Y count retorna 10

  Scenario: Batch parcialmente fallido
    DADO 10 VectorEntry donde 2 tienen vectores invalidos (dimension incorrecta)
    CUANDO se llama upsertBatch con los 10
    ENTONCES retorna {success: 8, failed: 2}
    Y count retorna 8 (solo los exitosos)

Feature: Delete

  Scenario: Eliminar vector existente
    DADO un vector con id 'cmd:old' insertado
    CUANDO se llama delete('cmd:old')
    ENTONCES count decrementa en 1
    Y listIds no incluye 'cmd:old'
    Y search no retorna ese id

  Scenario: Eliminar vector inexistente
    DADO una instancia sin el id 'cmd:ghost'
    CUANDO se llama delete('cmd:ghost')
    ENTONCES la operacion es silenciosa (no lanza error)
    Y count no cambia

Feature: Delete Batch

  Scenario: Batch delete con IDs mixtos
    DADO vectores con ids ['a', 'b', 'c'] insertados
    CUANDO se llama deleteBatch(['a', 'b', 'x'])
    ENTONCES retorna {success: 2, failed: 1}
    Y count retorna 1 (solo 'c' queda)

Feature: Search

  Scenario: Busqueda basica por similaridad
    DADO 100 vectores indexados
    CUANDO se busca con un vector query y topK=5
    ENTONCES retorna hasta 5 resultados
    Y estan ordenados por score descendente
    Y todos los scores estan entre 0.0 y 1.0

  Scenario: Conversion distance a score
    DADO un vector indexado y se busca con el mismo vector
    CUANDO minimemory retorna distance=0.0 (identico)
    ENTONCES el score retornado es 1.0 (1 - 0)

  Scenario: Filtro por threshold
    DADO 100 vectores indexados
    CUANDO se busca con threshold=0.8
    ENTONCES todos los resultados tienen score >= 0.8
    Y resultados con score < 0.8 son descartados

  Scenario: Filtro por namespace
    DADO vectores en namespaces 'users', 'auth', 'billing'
    CUANDO se busca con filters.namespace='users'
    ENTONCES solo retorna vectores con metadata.namespace='users'

  Scenario: Filtro por excludeIds
    DADO vectores con ids ['a', 'b', 'c', 'd']
    CUANDO se busca con filters.excludeIds=['b', 'c']
    ENTONCES los resultados no incluyen ids 'b' ni 'c'

  Scenario: Filtro por tags (OR logic)
    DADO vectores con tags variados
    CUANDO se busca con filters.tags=['admin', 'security']
    ENTONCES solo retorna vectores que tengan al menos uno de esos tags

  Scenario: Over-fetch para compensar post-filtering
    DADO un indice con 50 vectores, 25 en namespace 'users' y 25 en 'billing'
    CUANDO se busca topK=5 con filters.namespace='users'
    ENTONCES se solicitan 10 resultados (5*2) al binding
    Y se retornan hasta 5 resultados del namespace 'users'

  Scenario: Resultados insuficientes post-filter
    DADO un indice con 50 vectores pero solo 2 en namespace 'rare'
    CUANDO se busca topK=10 con filters.namespace='rare'
    ENTONCES retorna solo 2 resultados (todos los disponibles)

Feature: Clear

  Scenario: Limpiar indice completo
    DADO un indice con 50 vectores
    CUANDO se llama clear()
    ENTONCES count retorna 0
    Y listIds retorna array vacio
    Y search retorna array vacio

Feature: Health Check

  Scenario: Estado saludable
    DADO una instancia correctamente inicializada con 10 vectores
    CUANDO se llama healthCheck()
    ENTONCES retorna {status: 'healthy', details: 'minimemory HNSW index: 10 vectors, 768d, none quantization'}

  Scenario: Error en binding
    DADO que el binding nativo lanza una excepcion inesperada
    CUANDO se llama healthCheck()
    ENTONCES retorna {status: 'unhealthy', details: 'minimemory binding error'}

Feature: Persistencia

  Scenario: Auto-persist despues de upsert
    DADO una instancia con persistPath configurado
    CUANDO se llama upsert con un vector
    ENTONCES el archivo .mmdb se actualiza en disco

  Scenario: Auto-persist despues de delete
    DADO una instancia con persistPath y vectores existentes
    CUANDO se llama delete
    ENTONCES el archivo .mmdb se actualiza

  Scenario: Persist silencioso en error de I/O
    DADO una instancia con persistPath a una ruta sin permisos de escritura
    CUANDO se llama upsert (que triggerea autoPersist)
    ENTONCES el upsert completa exitosamente (no lanza error)
    Y los datos estan en memoria (se pierden al reiniciar)

  Scenario: Carga al inicializar con datos existentes
    DADO un archivo .mmdb con vectores guardados previamente
    CUANDO se crea nueva instancia con ese persistPath
    ENTONCES los vectores se cargan automaticamente
    Y el idSet se reconstruye desde los datos cargados
```

### 3.2 Casos de Prueba Requeridos

| ID | Escenario | Input | Output Esperado | Prioridad |
|----|-----------|-------|-----------------|-----------|
| T01 | Constructor con binding disponible | config valido | Instancia creada | Alta |
| T02 | Constructor sin binding | minimemory no instalado | Error descriptivo | Alta |
| T03 | Upsert nuevo | VectorEntry valido | void, count=1 | Alta |
| T04 | Upsert update | VectorEntry con id existente | void, count=1 (no duplica) | Alta |
| T05 | UpsertBatch 100 entries | 100 VectorEntry validos | {success:100, failed:0} | Alta |
| T06 | UpsertBatch con fallos | 10 entries, 2 invalidos | {success:8, failed:2} | Media |
| T07 | Delete existente | id que existe | void, count decrementado | Alta |
| T08 | Delete inexistente | id que no existe | void, count sin cambio (no-op) | Media |
| T09 | DeleteBatch mixto | ids existentes + inexistentes | BatchStorageResult correcto | Media |
| T10 | Search basico topK=5 | vector + topK=5 | max 5 resultados ordenados | Alta |
| T11 | Search score conversion | vector identico al indexado | score cercano a 1.0 | Alta |
| T12 | Search threshold filter | threshold=0.8 | solo scores >= 0.8 | Alta |
| T13 | Search namespace filter | filters.namespace='users' | solo namespace 'users' | Alta |
| T14 | Search excludeIds filter | filters.excludeIds=['a'] | 'a' excluido | Media |
| T15 | Search tags filter | filters.tags=['admin'] | solo entries con tag 'admin' | Media |
| T16 | Search over-fetch | topK=5 con filtros activos | solicita topK*2 al binding | Alta |
| T17 | ListIds | instancia con 3 vectores | array de 3 strings | Media |
| T18 | Count | instancia con 10 vectores | 10 | Media |
| T19 | Clear | instancia con vectores | count=0 despues | Alta |
| T20 | HealthCheck healthy | instancia funcional | {status:'healthy'} | Media |
| T21 | HealthCheck unhealthy | binding con error | {status:'unhealthy'} | Media |
| T22 | Persistencia auto | upsert con persistPath | archivo .mmdb actualizado | Alta |
| T23 | Carga desde disco | persistPath con datos | vectores cargados, idSet ok | Alta |
| T24 | Metadata arrays roundtrip | metadata con arrays | arrays preservados post-search | Alta |
| T25 | Quantization int8 | config.quantization='int8' | instancia creada, search funciona | Media |
| T26 | Quantization binary | config.quantization='binary' | instancia creada, search funciona | Media |
| T27 | Distance metric euclidean | config.distance='euclidean' | search retorna scores validos | Baja |
| T28 | Distance metric dot_product | config.distance='dot_product' | search retorna scores validos | Baja |
| T29 | Index type flat | config.indexType='flat' | instancia creada, search funciona | Baja |
| T30 | Concurrencia 10 upserts | 10 upsert simultaneos | todos exitosos, count=10 | Media |

### 3.3 Metricas de Exito

- [ ] Search latency p95 < 5ms para indice de 1000 vectores (HNSW, en memoria)
- [ ] Search latency p95 < 50ms para indice de 10,000 vectores
- [ ] Upsert individual < 2ms promedio
- [ ] UpsertBatch 100 entries < 50ms (sin persistencia)
- [ ] Memoria por vector: ~dimensions * 4 bytes (float32) sin quantizacion
- [ ] Memoria por vector con int8: ~dimensions bytes (4x compresion)
- [ ] Memoria por vector con binary: ~dimensions/8 bytes (32x compresion)
- [ ] Score de vector identico (self-search): > 0.99
- [ ] Recall@10 del HNSW >= 95% vs busqueda exhaustiva

### 3.4 Definition of Done

- [ ] Clase MiniMemoryVectorStorage implementa VectorStorageAdapter completa
- [ ] Constructor maneja correctamente binding ausente con mensaje descriptivo
- [ ] Todos los metodos de la interfaz implementados y funcionales
- [ ] Conversion distance->score correcta para las 3 metricas de distancia
- [ ] Post-filtering implementado para namespace, tags, excludeIds, threshold
- [ ] Over-fetch (topK*2) implementado para compensar post-filtering
- [ ] Serializacion/deserializacion de metadata arrays funcional
- [ ] Auto-persist funcional con error silencing
- [ ] Carga desde disco funcional con reconstruccion de idSet
- [ ] Tests unitarios con mock del binding nativo (cobertura >= 90%)
- [ ] Test de integracion con binding real (si disponible)
- [ ] Configuraciones de quantization (none, int8, binary) validadas
- [ ] Documentacion de instalacion del binding incluida

---

## 4. Que pasa si falla (ERROR HANDLING)

### 4.1 Errores Esperados

| Codigo | Condicion | Respuesta | Accion de Recuperacion |
|--------|-----------|-----------|------------------------|
| MM001 | Binding nativo no instalado | throw Error("minimemory Node.js binding not found...") | Instalar: npm install minimemory |
| MM002 | Dimension mismatch en insert | Binding lanza excepcion nativa | Capturar en upsertBatch, contar como failed |
| MM003 | ID no encontrado en delete | No-op silencioso | Ninguna requerida |
| MM004 | Error de I/O en persistencia | Error silenciado en autoPersist | Datos en memoria, reintentar save() manual |
| MM005 | Archivo .mmdb corrupto en load | Error silenciado, database fresco | Se inicia con indice vacio |
| MM006 | Vector con NaN/Infinity | Binding puede crashear o dar resultados invalidos | Validar antes de pasar al binding |
| MM007 | Memoria insuficiente (indice muy grande) | Binding puede lanzar OOM | Usar quantizacion o reducir dimensiones |
| MM008 | Binding version incompatible | Metodos ausentes (list_ids, etc.) | Usar fallback (idSet interno) |

### 4.2 Estrategia de Fallback

- Si `db.load()` falla al inicializar:
  - Log warning (si hubiera logger)
  - Continuar con database vacio
  - No es un error fatal

- Si `autoPersist()` falla:
  - Silenciar el error completamente
  - Los datos permanecen en memoria
  - El usuario puede llamar `save()` manualmente para diagnosticar

- Si un entry individual falla en upsertBatch:
  - Incrementar contador `failed`
  - Continuar con el siguiente entry
  - Retornar BatchStorageResult con totales

- Si `db.delete()` falla en clear:
  - Ignorar el error individual
  - Continuar limpiando los demas
  - El idSet se limpia independientemente

- Si `db.list_ids()` no esta disponible en el binding:
  - Usar el idSet interno como fuente de verdad
  - El idSet se reconstruye al cargar desde disco (si el metodo existe)

### 4.3 Logging y Monitoreo

**Niveles de log (actualmente sin logger inyectado):**
- ERROR: Binding no encontrado (en constructor, lanza excepcion)
- WARN: Fallo en autoPersist, fallo en load al inicializar, entry fallido en batch
- DEBUG: Cada upsert/delete/search ejecutado (para troubleshooting)

**Metricas potenciales (para futura instrumentacion):**
- `minimemory.search.latency_ms` - Latencia de busqueda HNSW
- `minimemory.search.pre_filter_count` - Resultados antes de post-filter
- `minimemory.search.post_filter_count` - Resultados despues de post-filter
- `minimemory.upsert.latency_ms` - Latencia de insert/update
- `minimemory.persist.latency_ms` - Latencia de auto-persist
- `minimemory.persist.failures` - Conteo de fallos de persistencia
- `minimemory.vectors.total` - Total de vectores en el idSet
- `minimemory.memory.bytes` - Memoria estimada del indice

### 4.4 Recuperacion

**Ante corrupcion de datos:**
- Eliminar archivo .mmdb corrupto
- Reinstanciar MiniMemoryVectorStorage (se crea database fresco)
- Ejecutar sync('full') desde VectorIndex para re-poblar

**Ante OOM del binding:**
- Reducir dimensiones del embedding model
- Activar quantizacion (int8 o binary)
- Reducir hnswM para menor consumo de memoria

**Ante perdida de persistencia:**
- Los datos en memoria siguen disponibles hasta el reinicio
- Llamar `save()` manualmente con nueva ruta
- Si se reinicia, ejecutar sync('full') para reconstruir

---

## 5. Que supuestos tiene (ASSUMPTIONS)

### 5.1 Precondiciones

- [ ] El paquete `minimemory` esta instalado (npm install minimemory) o compilado localmente
- [ ] El binding nativo es compatible con la plataforma (Windows/Linux/macOS, Node.js version)
- [ ] Los vectores pasados a upsert tienen exactamente `config.dimensions` dimensiones
- [ ] Los vectores son arrays de numeros float (no NaN, no Infinity)
- [ ] La metadata cumple con la interfaz CommandMetadata
- [ ] Si se usa persistPath, el directorio padre existe y tiene permisos de escritura

### 5.2 Dependencias

| Dependencia | Tipo | Version | Critica | Descripcion |
|-------------|------|---------|---------|-------------|
| minimemory | Native binding (napi-rs) | >=0.1.0 | Si | Motor vectorial Rust con HNSW |
| VectorStorageAdapter | Interface (types.ts) | N/A | Si | Contrato que implementa |
| VectorEntry | Type (types.ts) | N/A | Si | Formato de entrada |
| VectorSearchQuery | Type (types.ts) | N/A | Si | Formato de query |
| VectorSearchResult | Type (types.ts) | N/A | Si | Formato de resultado |
| BatchStorageResult | Type (types.ts) | N/A | Si | Formato de resultado batch |
| HealthStatus | Type (types.ts) | N/A | Si | Formato de health check |
| Node.js | Runtime | >=18.0 | Si | Para napi-rs compatibility |

### 5.3 Datos de Entrada Esperados

**VectorEntry (para upsert):**
- `id`: String no vacio, formato tipico "namespace:command"
- `vector`: number[] de exactamente `config.dimensions` elementos, valores float32
- `metadata.namespace`: String no vacio
- `metadata.command`: String no vacio
- `metadata.description`: String (puede ser vacio)
- `metadata.signature`: String
- `metadata.parameters`: string[] (puede ser vacio)
- `metadata.tags`: string[] (puede ser vacio)
- `metadata.indexedAt`: ISO 8601 string
- `metadata.version`: Semver string

**VectorSearchQuery (para search):**
- `vector`: number[] de exactamente `config.dimensions` elementos
- `topK`: number >= 1 y <= 20 (MAX_RESULTS)
- `threshold`: number entre 0.0 y 1.0 (opcional)
- `filters.namespace`: string (opcional)
- `filters.tags`: string[] (opcional)
- `filters.excludeIds`: string[] (opcional)

### 5.4 Estado del Sistema

- El constructor es sincrono (la carga desde disco es sincrona via el binding nativo)
- La instancia es stateful (mantiene el idSet y la referencia al db nativo)
- No es thread-safe en el sentido estricto (pero Node.js es single-threaded)
- Los metodos async de la interfaz son sync internamente (wrapped en Promise para cumplir la interfaz)
- El binding nativo maneja su propia memoria (Rust ownership)

### 5.5 Supuestos sobre minimemory

- `VectorDB` es la clase exportada del binding napi-rs
- Metodos disponibles: `insert(id, vector, metadata)`, `update(id, vector, metadata)`, `delete(id)`, `search(vector, topK)`, `save(path)`, `load(path)`
- `search()` retorna array de objetos con al menos `{id, distance, metadata}`
- `distance` es un numero >= 0 donde 0 = identico
- Para cosine distance: rango tipico [0, 2], donde 0 = vectores identicos
- `list_ids()` puede no estar disponible en todas las versiones del binding
- El binding maneja internamente la logica HNSW (M, ef_construction)
- Quantization reduce precision pero mantiene la API identica

---

## 6. Que limites tiene (CONSTRAINTS)

### 6.1 Limites Tecnicos

| Parametro | Limite | Razon |
|-----------|--------|-------|
| Dimensiones minimas | 1 | Limite fisico de un vector |
| Dimensiones maximas | 4096 | Limite practico de memoria y latencia |
| topK maximo | 20 | MAX_RESULTS del VectorIndex (no del storage) |
| Over-fetch maximo | topK * 2 | Balance entre cobertura post-filter y costo |
| Vectores por instancia | ~100,000 (recomendado) | Limite practico para proceso embebido |
| Tamano de metadata por entry | ~2 KB (recomendado) | El binding serializa a JSON |
| Persistencia (archivo .mmdb) | Limitado por disco | Formato binario propio de minimemory |
| hnswM | 4-64 (tipico: 16) | Balance memoria vs recall |
| hnswEfConstruction | 50-500 (tipico: 200) | Balance tiempo de build vs recall |
| Concurrencia | Single-threaded (Node.js) | El binding no es thread-safe |

### 6.2 Limites de Negocio

- La calidad del search depende directamente de la calidad de los embeddings (no del storage)
- El score 1-distance asume que distance=0 significa identico (valido para cosine, euclidean, dot_product normalizado)
- Los filtros son post-search, no pre-search: no reducen el costo computacional del HNSW traversal
- El over-fetch (topK*2) puede no ser suficiente si la mayoria de vectores no pasan los filtros
- La persistencia es best-effort: un crash entre upsert y autoPersist pierde el ultimo cambio
- No hay transacciones atomicas: un crash durante upsertBatch puede dejar el indice parcialmente actualizado

### 6.3 Limites de Seguridad

- **Datos en memoria**: Los vectores y metadata estan en memoria del proceso Node.js (accesibles via heap dump)
- **Archivo .mmdb**: Sin encriptacion, legible por cualquier proceso con permisos de archivo
- **getDb()**: Expone el binding nativo directamente, sin sandboxing
- **No validacion de inputs**: No verifica dimensiones del vector antes de pasar al binding (el binding puede crashear)
- **Path traversal**: persistPath se usa directamente sin sanitizacion

### 6.4 Limites de Alcance - Version 1.0

**Esta version NO incluye:**
- Validacion de dimensiones del vector antes de pasar al binding
- Logger inyectable (errores se silencian o se lanzan)
- Circuit breaker propio (el VectorIndex tiene el suyo)
- Metricas/instrumentacion
- Soporte para multiples indices en una instancia
- Operaciones bulk nativas del binding (itera uno por uno)
- Pre-filtering en el binding (solo post-filtering en JS)
- Streaming de resultados para indices muy grandes
- Compresion del archivo .mmdb
- Migracion entre versiones de .mmdb
- Backup automatico del archivo de persistencia
- Soporte para indices distribuidos / multi-proceso

**Consideraciones futuras (v2.0+):**
- Validacion de dimensiones con error descriptivo antes de llamar al binding
- Logger inyectable via constructor config
- Metodos bulk nativos del binding (insertBatch, deleteBatch) cuando esten disponibles
- Pre-filtering nativo de minimemory (cuando soporte filtros en search)
- Incrementar over-fetch ratio dinámicamente basado en hit-rate observado
- Warm-up del indice: pre-buscar vectores frecuentes al inicializar
- Snapshot/backup del .mmdb antes de operaciones destructivas
- Metricas de recall comparando HNSW vs flat search

---

## Anexos

### A. Glosario

| Termino | Definicion |
|---------|------------|
| HNSW | Hierarchical Navigable Small World - algoritmo de busqueda aproximada de vecinos cercanos con complejidad O(log n) |
| napi-rs | Framework para crear addons nativos de Node.js en Rust |
| Quantizacion | Reduccion de precision numerica de vectores para ahorrar memoria (Int8: 4x, Binary: 32x) |
| Post-filtering | Aplicar filtros despues de la busqueda vectorial (vs pre-filtering que filtra antes) |
| Over-fetch | Solicitar mas resultados de los necesarios para compensar perdidas por post-filtering |
| Distance | Medida de disimilaridad entre vectores (menor = mas similar) |
| Score | Medida de similaridad (mayor = mas similar), calculado como 1 - distance |
| .mmdb | Formato binario de persistencia propio de minimemory |
| idSet | Set<string> interno que trackea IDs existentes sin consultar el binding |
| autoPersist | Guardado automatico a disco despues de cada operacion de escritura |
| Flat index | Busqueda exhaustiva (brute-force) O(n) - exacta pero lenta |
| efConstruction | Parametro HNSW que controla la calidad del grafo durante la construccion |
| M (HNSW) | Numero maximo de conexiones por nodo en el grafo HNSW |

### B. Referencias

- Contrato VectorIndex: `d:/repos/agent-shell/contracts/vector-index.md`
- Types del modulo: `d:/repos/agent-shell/src/vector-index/types.ts`
- Implementacion: `d:/repos/agent-shell/demo/adapters/minimemory-vector-storage.ts`
- API adapter complementario: `d:/repos/agent-shell/demo/adapters/minimemory-api.ts`
- Demo de integracion: `d:/repos/agent-shell/demo/minimemory-integration.ts`
- minimemory repo: https://github.com/MauricioPerera/minimemory
- HNSW paper: https://arxiv.org/abs/1603.09320
- napi-rs docs: https://napi.rs/

### C. Diagrama de Dependencias

```
                    +-------------------+
                    |   VectorIndex     |
                    |  (orchestrator)   |
                    +--------+----------+
                             |
                    uses VectorStorageAdapter
                             |
                    +--------v-------------------+
                    | MiniMemoryVectorStorage    |
                    | (this contract)            |
                    +--------+-------------------+
                             |
                    napi-rs binding (require)
                             |
                    +--------v-------------------+
                    |    minimemory VectorDB     |
                    |    (Rust native)           |
                    +----------------------------+
                    | - HNSW index               |
                    | - Quantization (int8/bin)  |
                    | - .mmdb persistence        |
                    | - Distance metrics         |
                    +----------------------------+

    Data flow:

    VectorEntry.metadata (JS objects)
         |
         v
    serializeMetadata() --- arrays to JSON strings
         |
         v
    minimemory binding  --- stores as native types
         |
         v
    deserializeMetadata() --- JSON strings back to arrays
         |
         v
    VectorSearchResult.metadata (JS objects)
```

### D. Comparativa con In-Memory Storage

| Aspecto | MemoryVectorStorage | MiniMemoryVectorStorage |
|---------|--------------------|-----------------------|
| Busqueda | O(n) brute-force | O(log n) HNSW |
| Persistencia | No | Si (.mmdb) |
| Quantizacion | No | Int8, Binary |
| Runtime | Pure JS | Rust (napi-rs) |
| Memoria (1000 vecs, 768d) | ~3 MB | ~3 MB (none), ~750 KB (int8), ~96 KB (binary) |
| Latencia search (1000 vecs) | ~10ms | ~1ms |
| Dependencia externa | Ninguna | minimemory binding |
| Exactitud | 100% (exhaustiva) | ~95-99% (aproximada) |
| Caso de uso | Dev/testing | Produccion embebida |

### E. Historial de Cambios

| Version | Fecha | Autor | Cambios |
|---------|-------|-------|---------|
| 1.0 | 2026-01-24 | Spec Architect (Claude Opus 4.5) | Version inicial del contrato |
