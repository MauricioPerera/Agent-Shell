# Contrato: VECTOR_INDEX

> **Version**: 1.0
> **Fecha**: 2026-01-22
> **Estado**: Draft
> **Autor**: Spec Architect (Claude Opus 4.5)
> **Sistema**: Agent Shell
> **Modulo**: Vector Index (Discovery Semantico)

## Resumen Ejecutivo

El Vector Index es el motor de descubrimiento semantico de Agent Shell. Indexa las definiciones de comandos como embeddings vectoriales y responde queries en lenguaje natural retornando los comandos mas relevantes por similaridad. Es el componente que habilita que un agente LLM con solo 2 tools pueda descubrir dinamicamente cualquier comando disponible sin listarlos todos en contexto.

---

## 1. Que debe hacer (MUST DO)

### 1.1 Objetivo Principal

Proveer un servicio de busqueda semantica sobre el catalogo de comandos registrados en el Command Registry, permitiendo que el agente LLM descubra comandos relevantes a partir de descripciones en lenguaje natural, manteniendo el indice sincronizado y siendo agnostico tanto al proveedor de embeddings como al storage vectorial.

### 1.2 Funcionalidades Requeridas

- [ ] **Indexacion de comandos**
  - Recibir definiciones de comandos del Command Registry
  - Generar embeddings vectoriales a partir de la metadata del comando (nombre, descripcion, namespace, parametros, ejemplos)
  - Almacenar vectores con metadata asociada en el storage vectorial
  - Soportar indexacion individual y batch

- [ ] **Busqueda semantica**
  - Recibir queries en lenguaje natural
  - Convertir el query a embedding vectorial
  - Ejecutar busqueda por similaridad (cosine similarity / dot product)
  - Retornar los Top-N resultados ordenados por score de relevancia
  - Incluir metadata del comando en cada resultado

- [ ] **Sincronizacion con Command Registry**
  - Detectar comandos nuevos, modificados o eliminados
  - Re-indexar comandos modificados automaticamente
  - Eliminar vectores de comandos removidos
  - Soportar sincronizacion completa (full rebuild) y diferencial (delta)

- [ ] **Abstraccion de proveedores**
  - Interface adaptable para proveedores de embeddings (OpenAI, Cohere, local, etc.)
  - Interface adaptable para storage vectorial (Pinecone, Qdrant, ChromaDB, pgvector, en memoria, etc.)
  - Configuracion por inyeccion de dependencias
  - Sin acoplamiento a implementaciones concretas

### 1.3 Flujos Principales

#### Flujo de Indexacion

```
Command Registry                Vector Index                  Embedding Adapter    Storage Adapter
      |                              |                              |                    |
      |-- register/update command -->|                              |                    |
      |                              |-- build indexable text ----->|                    |
      |                              |                              |                    |
      |                              |<-- embedding vector ---------|                    |
      |                              |                              |                    |
      |                              |-- upsert(id, vector, meta) --|-------------------->|
      |                              |                              |                    |
      |                              |<-- confirmation -------------|---------------------|
      |                              |                              |                    |
      |<-- indexed confirmation -----|                              |                    |
```

#### Flujo de Busqueda (Search)

```
Agent (via cli_exec)           Vector Index                  Embedding Adapter    Storage Adapter
      |                              |                              |                    |
      |-- search("intent query") --->|                              |                    |
      |                              |-- embed query -------------->|                    |
      |                              |                              |                    |
      |                              |<-- query vector -------------|                    |
      |                              |                              |                    |
      |                              |-- similarity_search ---------|-------------------->|
      |                              |   (vector, top_k, filters)   |                    |
      |                              |                              |                    |
      |                              |<-- ranked results -----------|---------------------|
      |                              |                              |                    |
      |                              |-- format response ---------->|                    |
      |                              |                              |                    |
      |<-- SearchResult[] -----------|                              |                    |
```

#### Flujo de Sincronizacion

```
Command Registry               Vector Index                  Storage Adapter
      |                              |                              |
      |-- sync_request ------------->|                              |
      |   (full | delta)             |                              |
      |                              |-- get indexed ids ---------->|
      |                              |<-- current ids --------------|
      |                              |                              |
      |                              |-- diff with registry ------->|
      |                              |   (added, modified, removed) |
      |                              |                              |
      |                              |-- batch upsert (new/mod) --->|
      |                              |-- batch delete (removed) --->|
      |                              |                              |
      |<-- sync report --------------|                              |
```

### 1.4 Interfaces del Sistema

#### EmbeddingAdapter Interface

```typescript
interface EmbeddingAdapter {
  /**
   * Genera el embedding vectorial para un texto dado.
   * @param text - Texto a vectorizar (max segun proveedor)
   * @returns Vector de dimensiones N (float32[])
   */
  embed(text: string): Promise<EmbeddingResult>;

  /**
   * Genera embeddings en batch para multiples textos.
   * @param texts - Array de textos a vectorizar
   * @returns Array de vectores en el mismo orden
   */
  embedBatch(texts: string[]): Promise<EmbeddingResult[]>;

  /**
   * Retorna la dimension del vector que genera este adapter.
   * Necesario para validar compatibilidad con el storage.
   */
  getDimensions(): number;

  /**
   * Retorna el nombre/identificador del modelo de embeddings.
   */
  getModelId(): string;
}

interface EmbeddingResult {
  vector: number[];        // Float32 array de N dimensiones
  dimensions: number;      // Cantidad de dimensiones del vector
  tokenCount: number;      // Tokens consumidos por el texto
  model: string;           // Modelo usado para generar el embedding
}
```

#### VectorStorageAdapter Interface

```typescript
interface VectorStorageAdapter {
  /**
   * Inserta o actualiza un vector con su metadata asociada.
   */
  upsert(entry: VectorEntry): Promise<void>;

  /**
   * Inserta o actualiza multiples vectores en batch.
   */
  upsertBatch(entries: VectorEntry[]): Promise<BatchResult>;

  /**
   * Elimina un vector por su ID.
   */
  delete(id: string): Promise<void>;

  /**
   * Elimina multiples vectores por sus IDs.
   */
  deleteBatch(ids: string[]): Promise<BatchResult>;

  /**
   * Busca los vectores mas similares al vector query.
   */
  search(query: VectorSearchQuery): Promise<VectorSearchResult[]>;

  /**
   * Retorna todos los IDs almacenados (para sincronizacion).
   */
  listIds(): Promise<string[]>;

  /**
   * Retorna la cantidad de vectores almacenados.
   */
  count(): Promise<number>;

  /**
   * Elimina todos los vectores (para full rebuild).
   */
  clear(): Promise<void>;

  /**
   * Verifica que el storage esta disponible y operativo.
   */
  healthCheck(): Promise<HealthStatus>;
}

interface VectorEntry {
  id: string;                    // ID unico del comando (namespace:command)
  vector: number[];              // Embedding vector
  metadata: CommandMetadata;     // Metadata asociada al comando
}

interface VectorSearchQuery {
  vector: number[];              // Vector del query
  topK: number;                  // Cantidad de resultados (default: 5, max: 20)
  threshold?: number;            // Score minimo de similaridad (0.0 - 1.0)
  filters?: SearchFilters;       // Filtros opcionales sobre metadata
}

interface SearchFilters {
  namespace?: string;            // Filtrar por namespace
  tags?: string[];               // Filtrar por tags
  excludeIds?: string[];         // Excluir comandos especificos
}

interface VectorSearchResult {
  id: string;                    // ID del comando encontrado
  score: number;                 // Score de similaridad (0.0 - 1.0)
  metadata: CommandMetadata;     // Metadata del comando
}

interface CommandMetadata {
  namespace: string;             // Namespace del comando
  command: string;               // Nombre del comando
  description: string;           // Descripcion corta
  signature: string;             // Firma compacta del comando
  parameters: string[];          // Lista de parametros
  tags: string[];                // Tags para filtrado
  indexedAt: string;             // ISO 8601 timestamp de indexacion
  version: string;               // Version del comando
}
```

#### VectorIndex Interface (Principal)

```typescript
interface VectorIndex {
  /**
   * Inicializa el indice con los adapters configurados.
   */
  initialize(config: VectorIndexConfig): Promise<void>;

  /**
   * Indexa un comando individual.
   */
  indexCommand(command: CommandDefinition): Promise<IndexResult>;

  /**
   * Indexa multiples comandos en batch.
   */
  indexBatch(commands: CommandDefinition[]): Promise<BatchIndexResult>;

  /**
   * Busca comandos por similaridad semantica.
   */
  search(query: string, options?: SearchOptions): Promise<SearchResponse>;

  /**
   * Elimina un comando del indice.
   */
  removeCommand(commandId: string): Promise<void>;

  /**
   * Sincroniza el indice con el Command Registry.
   */
  sync(mode: 'full' | 'delta'): Promise<SyncReport>;

  /**
   * Retorna estadisticas del indice.
   */
  getStats(): Promise<IndexStats>;

  /**
   * Verifica la salud del servicio completo.
   */
  healthCheck(): Promise<HealthStatus>;
}

interface VectorIndexConfig {
  embeddingAdapter: EmbeddingAdapter;
  storageAdapter: VectorStorageAdapter;
  defaultTopK: number;           // Default: 5
  defaultThreshold: number;      // Default: 0.3
  batchSize: number;             // Default: 50
  indexableFields: string[];     // Campos a incluir en el texto indexable
}
```

### 1.5 Inputs y Outputs

#### Inputs

| Input | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| query | string | Si (search) | Texto en lenguaje natural describiendo la intencion |
| command | CommandDefinition | Si (index) | Definicion completa del comando a indexar |
| topK | number | No | Cantidad de resultados (default: 5, max: 20) |
| threshold | number | No | Score minimo de relevancia (default: 0.3) |
| namespace | string | No | Filtro por namespace |
| mode | 'full' \| 'delta' | Si (sync) | Modo de sincronizacion |

#### Outputs

| Output | Tipo | Descripcion |
|--------|------|-------------|
| SearchResponse | object | Resultados de busqueda con scores |
| IndexResult | object | Confirmacion de indexacion |
| SyncReport | object | Reporte de sincronizacion |
| IndexStats | object | Estadisticas del indice |

### 1.6 Formato de Respuesta del Search

```typescript
interface SearchResponse {
  query: string;                      // Query original
  results: SearchResultItem[];        // Resultados ordenados por score
  totalIndexed: number;               // Total de comandos en el indice
  searchTimeMs: number;               // Tiempo de busqueda en ms
  model: string;                      // Modelo de embeddings usado
}

interface SearchResultItem {
  commandId: string;                  // "namespace:command"
  score: number;                      // 0.0 - 1.0
  command: string;                    // Nombre del comando
  namespace: string;                  // Namespace
  description: string;                // Descripcion corta
  signature: string;                  // Firma compacta AI-optimizada
  example: string;                    // Ejemplo de uso
}
```

**Ejemplo de respuesta formateada para el agente:**

```
search "crear un usuario nuevo"

Resultados (3 de 47 comandos indexados, 23ms):

  0.94  users:create | Crea un nuevo usuario en el sistema
        --name: string [REQUIRED] --email: string (email) [REQUIRED] --role: enum(admin,user)
        Ejemplo: users:create --name "Juan" --email "j@mail.com" | .id

  0.78  auth:register | Registra credenciales para un usuario existente
        --user-id: string [REQUIRED] --password: string (min:8) [REQUIRED]
        Ejemplo: auth:register --user-id "usr_123" --password "***"

  0.65  users:invite | Envia invitacion por email a un nuevo usuario
        --email: string (email) [REQUIRED] --team: string
        Ejemplo: users:invite --email "nuevo@empresa.com" --team "dev"
```

### 1.7 Construccion del Texto Indexable

Para generar el embedding de cada comando, se construye un texto compuesto que maximiza la calidad de la busqueda semantica:

```typescript
function buildIndexableText(cmd: CommandDefinition): string {
  const parts = [
    cmd.description,                           // Descripcion principal
    `comando: ${cmd.namespace}:${cmd.command}`, // Identificacion
    `namespace: ${cmd.namespace}`,             // Contexto de dominio
    cmd.parameters.map(p => p.name).join(', '), // Nombres de parametros
    cmd.tags?.join(', ') || '',                // Tags/categorias
    cmd.examples?.join(' ') || '',             // Ejemplos de uso
    cmd.aliases?.join(', ') || '',             // Alias/sinonimos
  ];
  return parts.filter(Boolean).join(' | ');
}
```

---

## 2. Que NO debe hacer (MUST NOT)

### 2.1 Fuera de Alcance

- No ejecutar comandos (solo descubrirlos)
- No almacenar resultados de ejecucion
- No generar embeddings para queries del historial del agente
- No cachear resultados de busqueda entre sesiones diferentes
- No re-rankear resultados con un modelo LLM adicional
- No gestionar permisos de acceso a comandos (eso es del Executor)
- No parsear el query del usuario (recibe string plano)

### 2.2 Anti-patterns Prohibidos

- No hacer llamadas sincronas bloqueantes al proveedor de embeddings en el hot path de search
- No almacenar el texto original del comando dentro del vector store (solo metadata compacta)
- No recalcular embeddings en cada busqueda si el comando no cambio (usar versionamiento)
- No hacer full-rebuild del indice en cada inicio de la aplicacion (usar delta sync)
- No retornar mas de 20 resultados por query (limitar para no saturar contexto del LLM)
- No exponer internals del vector store al consumidor (scores raw, IDs internos del DB, etc.)
- No acoplar el formato de respuesta a un proveedor especifico de embeddings

### 2.3 Restricciones de Implementacion

- No usar llamadas directas a APIs de embeddings sin pasar por el adapter
- No persistir vectores en memoria sin un mecanismo de flush/recovery
- No modificar el Command Registry desde el Vector Index (flujo unidireccional)
- No asumir dimensiones fijas del vector (depende del adapter configurado)
- No hardcodear umbrales de similaridad (deben ser configurables)
- No usar distance metrics diferentes a las soportadas por el storage adapter

---

## 3. Como se que esta bien (ACCEPTANCE)

### 3.1 Criterios de Aceptacion

```gherkin
Feature: Indexacion de Comandos

  Scenario: Indexar un comando nuevo
    DADO un Command Registry con el comando "users:create" registrado
    CUANDO el Vector Index recibe la senal de nuevo comando
    ENTONCES genera el embedding del texto indexable del comando
    Y almacena el vector con metadata en el storage
    Y retorna confirmacion con el ID indexado

  Scenario: Indexar comandos en batch
    DADO un Command Registry con 100 comandos nuevos
    CUANDO se ejecuta indexBatch con los 100 comandos
    ENTONCES todos los comandos quedan indexados
    Y el tiempo total es menor que 100 * tiempo_individual (eficiencia batch)
    Y se retorna un BatchIndexResult con conteo de exitosos/fallidos

  Scenario: Re-indexar comando modificado
    DADO un comando "users:create" ya indexado con version "1.0"
    CUANDO el Command Registry notifica cambio a version "1.1"
    ENTONCES se genera nuevo embedding con la definicion actualizada
    Y se actualiza (upsert) el vector existente
    Y la metadata refleja la nueva version y timestamp

Feature: Busqueda Semantica

  Scenario: Busqueda exitosa con resultados relevantes
    DADO un indice con 50 comandos de dominios variados
    CUANDO el agente busca "crear un usuario nuevo"
    ENTONCES retorna resultados con score > 0.6 para comandos de creacion de usuarios
    Y el resultado mas relevante tiene score > 0.8
    Y los resultados estan ordenados por score descendente
    Y cada resultado incluye commandId, score, description y signature

  Scenario: Busqueda sin resultados suficientes
    DADO un indice con comandos de dominio "finance"
    CUANDO el agente busca "editar foto de perfil"
    ENTONCES retorna 0 resultados (ningun score supera el threshold)
    Y el searchTimeMs se reporta correctamente
    Y la respuesta incluye totalIndexed para contexto

  Scenario: Busqueda con filtro de namespace
    DADO un indice con comandos en namespaces "users", "auth", "billing"
    CUANDO el agente busca "listar todos" con filtro namespace="users"
    ENTONCES solo retorna comandos del namespace "users"
    Y los scores reflejan similaridad dentro del namespace filtrado

  Scenario: Busqueda respeta topK
    DADO un indice con 50 comandos relevantes a "listar"
    CUANDO el agente busca "listar" con topK=3
    ENTONCES retorna exactamente 3 resultados (o menos si no hay suficientes)
    Y son los 3 con mayor score

  Scenario: Busqueda respeta threshold
    DADO un indice con comandos variados
    CUANDO el agente busca con threshold=0.8
    ENTONCES solo retorna resultados con score >= 0.8

Feature: Sincronizacion

  Scenario: Sync delta detecta cambios
    DADO un indice con 50 comandos
    Y el Command Registry tiene 52 comandos (2 nuevos, 1 modificado, 0 eliminados)
    CUANDO se ejecuta sync('delta')
    ENTONCES indexa los 2 comandos nuevos
    Y re-indexa el 1 comando modificado
    Y el SyncReport refleja: added=2, updated=1, removed=0

  Scenario: Sync full reconstruye el indice
    DADO un indice con datos posiblemente inconsistentes
    CUANDO se ejecuta sync('full')
    ENTONCES limpia todo el storage
    Y re-indexa todos los comandos del Registry
    Y el indice final es consistente con el Registry actual

  Scenario: Sync maneja comando eliminado
    DADO un indice con el comando "legacy:oldcmd" indexado
    Y el Command Registry ya no tiene ese comando
    CUANDO se ejecuta sync('delta')
    ENTONCES elimina el vector de "legacy:oldcmd" del storage
    Y el SyncReport refleja removed=1

Feature: Adapters

  Scenario: Cambio de embedding adapter
    DADO un VectorIndex configurado con OpenAI embeddings
    CUANDO se reconfigura con un adapter de Cohere embeddings
    ENTONCES requiere full rebuild del indice (dimensiones pueden diferir)
    Y la busqueda funciona correctamente con el nuevo adapter

  Scenario: Cambio de storage adapter
    DADO un VectorIndex configurado con almacenamiento en memoria
    CUANDO se reconfigura con Qdrant como storage
    ENTONCES el indice debe ser reconstruido en el nuevo storage
    Y la busqueda retorna mismos resultados que antes (para mismos embeddings)

  Scenario: Health check detecta adapter no disponible
    DADO un storage adapter que no puede conectarse
    CUANDO se ejecuta healthCheck()
    ENTONCES retorna status "unhealthy" con detalle del error
    Y no se produce un crash del sistema
```

### 3.2 Casos de Prueba Requeridos

| ID | Escenario | Input | Output Esperado | Prioridad |
|----|-----------|-------|-----------------|-----------|
| T01 | Indexar comando simple | CommandDefinition valida | IndexResult con id | Alta |
| T02 | Indexar batch de 100 | 100 CommandDefinitions | BatchResult.success=100 | Alta |
| T03 | Search query relevante | "crear usuario" + indice con users:create | Score > 0.8 en primer resultado | Alta |
| T04 | Search query irrelevante | "receta de cocina" + indice tech | results.length === 0 | Alta |
| T05 | Search con topK=3 | Query generica + indice con 50 cmds | Exactamente 3 resultados | Media |
| T06 | Search con threshold=0.9 | Query ambiguo | Solo resultados con score >= 0.9 | Media |
| T07 | Search con namespace filter | "listar" + filter.namespace="users" | Solo cmds de namespace users | Media |
| T08 | Sync delta - nuevos | Registry con 2 cmds nuevos | SyncReport.added=2 | Alta |
| T09 | Sync delta - eliminados | Registry sin cmd indexado | SyncReport.removed=1 | Alta |
| T10 | Sync delta - modificados | Registry con cmd version+1 | SyncReport.updated=1 | Alta |
| T11 | Sync full rebuild | Registry con 50 cmds | Indice = 50 vectores exactos | Media |
| T12 | Embedding adapter mock | Texto cualquiera | Vector de dimension correcta | Alta |
| T13 | Storage adapter mock | VectorEntry valido | Upsert/delete/search funcionales | Alta |
| T14 | Health check - healthy | Adapters operativos | {status: "healthy"} | Media |
| T15 | Health check - unhealthy | Storage no disponible | {status: "unhealthy", error} | Media |
| T16 | Query vacio | "" | Error E002 (query invalido) | Media |
| T17 | Comando sin descripcion | CommandDef.description="" | Indexa con campos disponibles | Baja |
| T18 | Concurrencia search | 10 search simultaneos | Todos responden correctamente | Media |
| T19 | Idempotencia indexar | Mismo comando 2 veces | Solo 1 vector en storage | Alta |
| T20 | Search time < 200ms | Query tipico con 1000 vectores | searchTimeMs < 200 | Alta |

### 3.3 Metricas de Exito

- [ ] Relevancia: El comando correcto esta en el top-3 en >= 90% de queries bien formulados
- [ ] Latencia de search: p95 < 200ms para indices de hasta 1000 comandos
- [ ] Latencia de indexacion: < 500ms por comando individual
- [ ] Indexacion batch: < 50ms/comando en batches de 50+
- [ ] Sincronizacion delta: < 5 segundos para 100 cambios
- [ ] Disponibilidad: healthCheck retorna en < 100ms
- [ ] Consistencia: Post-sync, 100% de comandos del Registry estan indexados

### 3.4 Definition of Done

- [ ] Interfaces EmbeddingAdapter, VectorStorageAdapter y VectorIndex implementadas
- [ ] Al menos 1 implementacion concreta de EmbeddingAdapter (puede ser mock/in-memory)
- [ ] Al menos 1 implementacion concreta de VectorStorageAdapter (puede ser in-memory)
- [ ] Flujo de indexacion individual y batch funcional
- [ ] Flujo de search con topK, threshold y filters funcional
- [ ] Sincronizacion full y delta implementada
- [ ] Tests unitarios con cobertura >= 85%
- [ ] Tests de integracion con adapters mock
- [ ] Formato de respuesta cumple con SearchResponse interface
- [ ] Documentacion de las interfaces actualizada
- [ ] healthCheck implementado para ambos adapters
- [ ] Configuracion por inyeccion de dependencias validada
- [ ] Performance benchmarks ejecutados y dentro de limites

---

## 4. Que pasa si falla (ERROR HANDLING)

### 4.1 Errores Esperados

| Codigo | Condicion | Respuesta | Accion de Recuperacion |
|--------|-----------|-----------|------------------------|
| E001 | Embedding adapter no disponible | "Embedding service unavailable" | Reintentar con backoff; degradar a busqueda por texto si persiste |
| E002 | Query vacio o invalido | "Invalid search query" | Retornar error sin llamar al adapter |
| E003 | Storage adapter no disponible | "Vector storage unavailable" | Reintentar; reportar en healthCheck |
| E004 | Dimension mismatch | "Vector dimension mismatch: expected N, got M" | Requiere rebuild del indice con adapter correcto |
| E005 | Comando no encontrado para delete | "Command not found in index: {id}" | Log warning, operacion es no-op |
| E006 | Batch parcialmente fallido | "Batch completed with errors: N/M failed" | Retornar BatchResult con detalle de fallidos |
| E007 | Timeout en embedding | "Embedding generation timeout" | Reintentar 1 vez; retornar error si persiste |
| E008 | Storage lleno / cuota excedida | "Vector storage capacity exceeded" | Alertar; no indexar nuevos hasta resolver |
| E009 | Texto indexable vacio | "Cannot index command with empty indexable text" | Skip con warning en log |
| E010 | Sync conflict | "Sync already in progress" | Rechazar nueva sync; esperar a que termine la actual |

### 4.2 Estrategia de Fallback

- Si el embedding adapter no responde despues de 2 reintentos:
  - Marcar healthCheck como "degraded"
  - Search retorna error descriptivo (no se bloquea el sistema)
  - Indexacion se encola para retry posterior

- Si el storage adapter no responde:
  - Search retorna error "service_unavailable"
  - Indexacion se encola en buffer local
  - Al recuperar storage, flush del buffer pendiente

- Si la sincronizacion falla a mitad:
  - Registrar punto de progreso
  - Siguiente sync retoma desde el ultimo punto exitoso
  - No dejar indice en estado inconsistente (operaciones atomicas por comando)

### 4.3 Logging y Monitoreo

**Niveles de log:**
- INFO: Indexacion exitosa, sync completada, search ejecutado
- WARN: Resultado con 0 matches, comando sin descripcion, retry activado
- ERROR: Adapter no disponible, dimension mismatch, timeout

**Metricas a trackear:**
- `vector_index.search.latency_ms` - Histograma de latencia de search
- `vector_index.search.results_count` - Cantidad de resultados por query
- `vector_index.search.zero_results_rate` - Tasa de busquedas sin resultados
- `vector_index.index.commands_total` - Total de comandos indexados
- `vector_index.index.latency_ms` - Latencia de indexacion
- `vector_index.sync.duration_ms` - Duracion de sincronizacion
- `vector_index.sync.changes` - Cambios por sync (added/updated/removed)
- `vector_index.adapter.embedding.errors` - Errores del embedding adapter
- `vector_index.adapter.storage.errors` - Errores del storage adapter
- `vector_index.health.status` - Estado actual (healthy/degraded/unhealthy)

**Alertas:**
- Cuando error rate > 5% en ventana de 5 minutos
- Cuando search latency p95 > 500ms
- Cuando healthCheck retorna "unhealthy"
- Cuando sync falla 3 veces consecutivas

### 4.4 Recuperacion

**Retry policy:**
- Embedding adapter: Max 2 reintentos, backoff exponencial (100ms, 400ms)
- Storage adapter: Max 3 reintentos, backoff exponencial (200ms, 800ms, 3200ms)
- Sync: Max 1 reintento automatico, luego requiere trigger manual

**Circuit breaker:**
- Se activa despues de 5 fallos consecutivos al mismo adapter
- Half-open despues de 30 segundos
- Se cierra con 3 exitos consecutivos en half-open

**Rollback (sync):**
- Si sync full falla a mitad, no se elimina el indice anterior hasta confirmar el nuevo
- Si sync delta falla, los cambios parciales ya aplicados son validos (cada operacion es atomica)

---

## 5. Que supuestos tiene (ASSUMPTIONS)

### 5.1 Precondiciones

- [ ] El Command Registry esta disponible y expone una interface para listar comandos
- [ ] Los comandos tienen al menos: id, namespace, command, description
- [ ] El embedding adapter esta configurado con credenciales validas (si es remoto)
- [ ] El storage adapter esta inicializado y accesible
- [ ] La configuracion del VectorIndex esta validada antes de inicializar

### 5.2 Dependencias

| Dependencia | Tipo | Version | Critica | Descripcion |
|-------------|------|---------|---------|-------------|
| Command Registry | Modulo interno | N/A | Si | Fuente de verdad de comandos |
| EmbeddingAdapter impl | Interface | N/A | Si | Al menos 1 implementacion disponible |
| VectorStorageAdapter impl | Interface | N/A | Si | Al menos 1 implementacion disponible |
| Config system | Modulo interno | N/A | Si | Provee configuracion de adapters |

### 5.3 Datos de Entrada Esperados

**CommandDefinition (para indexacion):**
- Formato: Objeto estructurado (interface tipada)
- Campos minimos: id, namespace, command, description
- Campos opcionales: parameters, examples, tags, aliases, version
- Encoding: UTF-8
- Tamano maximo de descripcion: 500 caracteres
- Tamano maximo de texto indexable construido: 2000 caracteres

**Query (para search):**
- Formato: String en lenguaje natural
- Idioma: El mismo que las descripciones de comandos
- Longitud: 1 - 500 caracteres
- Encoding: UTF-8

### 5.4 Estado del Sistema

- El sistema no requiere autenticacion de usuario para el search (es interno al agente)
- El VectorIndex se inicializa una vez al arrancar la aplicacion
- La sincronizacion puede triggerearse manualmente o por evento del Registry
- El indice puede estar vacio al inicio (primera sync lo puebla)

### 5.5 Supuestos Tecnicos

- Los embeddings del mismo modelo son deterministas para el mismo input
- La similaridad coseno es la metrica default (puede variar por storage adapter)
- Los vectores son float32 (precision suficiente para similarity search)
- El storage adapter maneja su propia persistencia (no es responsabilidad del VectorIndex)
- Cambiar de modelo de embeddings requiere rebuild completo del indice

---

## 6. Que limites tiene (CONSTRAINTS)

### 6.1 Limites Tecnicos

| Parametro | Limite | Razon |
|-----------|--------|-------|
| topK maximo | 20 resultados | Evitar saturar contexto del LLM |
| Tamano del indice | Hasta 10,000 comandos | Limite practico para latencia < 200ms |
| Dimension del vector | Depende del adapter (tipico: 256-1536) | Definido por modelo de embeddings |
| Texto indexable max | 2000 caracteres | Limite de tokens de la mayoria de modelos |
| Query max length | 500 caracteres | Suficiente para intent en lenguaje natural |
| Batch size max | 100 comandos por batch | Balance entre eficiencia y memoria |
| Concurrencia search | 50 queries simultaneos | Proteger al embedding adapter |
| Sync timeout | 60 segundos para delta, 300 para full | Evitar bloqueos prolongados |
| Retry max per operation | 3 intentos | Evitar cascada de errores |
| Search latency target | p95 < 200ms | UX del agente fluida |

### 6.2 Limites de Negocio

- Solo se indexan comandos registrados en el Command Registry (no inputs del usuario)
- El score de similaridad es relativo al modelo de embeddings usado (no comparable entre modelos)
- Los resultados de search no implican que el usuario tenga permiso de ejecutar el comando
- La calidad del search depende directamente de la calidad de las descripciones de comandos
- Cambiar de idioma en las descripciones puede degradar la calidad del search

### 6.3 Limites de Seguridad

- **Autenticacion**: No aplica (componente interno, no expuesto directamente)
- **Autorizacion**: No filtra por permisos del usuario (responsabilidad del Executor)
- **Datos sensibles**: No almacenar tokens/credenciales en metadata de vectores
- **Injection**: El query del usuario se pasa directo al embedding adapter sin interpretacion; no se ejecuta como codigo
- **Rate limiting**: Delegado al adapter de embeddings si es servicio externo

### 6.4 Limites de Alcance - Version 1.0

**Esta version NO incluye:**
- Multi-tenancy (un indice por instalacion)
- Busqueda hibrida (vectorial + keyword)
- Re-ranking con modelos adicionales
- Cache distribuido de embeddings
- Soporte para multiples idiomas simultaneos
- Versionado de indices (rollback a indice anterior)
- Metricas de relevancia con feedback del usuario
- Streaming de resultados

**Consideraciones futuras (v2.0+):**
- Busqueda hibrida: combinar similarity search con BM25/keyword matching
- Feedback loop: el agente reporta si el resultado fue util para mejorar ranking
- Multi-index: indices separados por dominio/tenant
- Embedding cache: cachear embeddings de queries frecuentes
- Compresion de vectores: quantization para reducir storage
- Index warming: pre-cargar embeddings de queries comunes al iniciar

---

## Anexos

### A. Glosario

| Termino | Definicion |
|---------|------------|
| Embedding | Representacion numerica (vector) de un texto en un espacio de alta dimension |
| Vector | Array de numeros float32 que representa un punto en espacio N-dimensional |
| Cosine Similarity | Metrica de similaridad entre vectores (1.0 = identico, 0.0 = ortogonal) |
| Top-K | Los K resultados con mayor score de similaridad |
| Threshold | Score minimo para considerar un resultado como relevante |
| Upsert | Operacion que inserta si no existe o actualiza si ya existe |
| Delta Sync | Sincronizacion que solo procesa cambios desde la ultima sync |
| Full Rebuild | Reconstruccion completa del indice desde cero |
| Indexable Text | Texto compuesto construido a partir de la metadata del comando para generar su embedding |
| Command Registry | Fuente de verdad de todos los comandos disponibles en Agent Shell |
| Namespace | Agrupacion logica de comandos (ej: "users", "auth", "billing") |
| Adapter | Implementacion concreta de una interface abstracta (patron Strategy) |

### B. Referencias

- PRD Agent Shell: `d:/repos/agent-shell/docs/prd.md`
- Formato de definicion de comandos: Seccion "Formato de Definicion de Comandos" del PRD
- Arquitectura de alto nivel: Seccion "Arquitectura de Alto Nivel" del PRD
- OpenAI Embeddings API: https://platform.openai.com/docs/guides/embeddings
- Qdrant Documentation: https://qdrant.tech/documentation/
- ChromaDB Documentation: https://docs.trychroma.com/

### C. Diagrama de Dependencias

```
                    +-------------------+
                    | Command Registry  |
                    | (source of truth) |
                    +--------+----------+
                             |
                    events / pull
                             |
                    +--------v----------+
                    |   Vector Index    |
                    |   (orchestrator)  |
                    +---+----------+----+
                        |          |
              +---------+          +----------+
              |                               |
   +----------v-----------+     +-------------v----------+
   |  EmbeddingAdapter    |     | VectorStorageAdapter   |
   |  (interface)         |     | (interface)            |
   +----------+-----------+     +-------------+----------+
              |                               |
   +----+-----+-----+            +----+-------+------+
   |    |           |            |    |              |
   v    v           v            v    v              v
OpenAI Cohere  LocalModel   Qdrant pgvector    InMemory
```

### D. Historial de Cambios

| Version | Fecha | Autor | Cambios |
|---------|-------|-------|---------|
| 1.0 | 2026-01-22 | Spec Architect (Claude Opus 4.5) | Version inicial del contrato |

---

## 9. Estado de Implementación v1.0

### Implementado
- VectorIndex con indexCommand(), indexBatch(), search(), sync(), removeCommand(), healthCheck(), getStats()
- PgVectorStorageAdapter completo (PostgreSQL + pgvector)
- buildIndexableText() combinando description, longDescription, namespace, nombre, params, tags, example
- Sync con modos 'delta' y 'full'
- Fallback secuencial si embedBatch falla
- Filtro por namespace en search
- Campo adicional: longDescription en CommandDefinition (no en contrato)
- Campo adicional: namespace en SearchOptions

### Implementado (v1.1)
- SearchResultItem.example ahora usa metadata.example del comando
- Filtros por tags (every match) y excludeIds (skip) en search
- Campos batchSize e indexableFields en VectorIndexConfig
- Error codes tipados E001-E010 con clase VectorIndexError
- Circuit breaker (5 fallas → open, 30s cooldown → half-open, 3 exitos → closed)
- Retry con buffer queue en batch failures (chunks de batchSize, reintentos individuales)

### Discrepancias con contrato
- CommandDefinition usa campo `name` (contrato usa `command` en metadata)
- buildIndexableText usa `cmd.example` singular (contrato dice `cmd.examples` plural)
- buildIndexableText usa `cmd.params` (contrato dice `cmd.parameters`)
- No hay metodo initialize() separado (configuracion via constructor)

### Pendiente
- PgVectorStorageAdapter.initialize() no definido en interfaz VectorStorageAdapter
