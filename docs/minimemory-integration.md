# Integración Agent Shell + minimemory

Integra [minimemory](https://github.com/MauricioPerera/minimemory) como motor de almacenamiento vectorial y memoria de agente para Agent Shell. A diferencia de otras integraciones (VoltAgent, n8n, LangGraph) que usan HTTP, minimemory es una **librería embebida** que corre localmente via bindings napi-rs.

## Tabla de Contenidos

- [Integración Nativa](#integración-nativa-v010)
- [API Reference](#api-reference)
- [Arquitectura](#arquitectura)
- [Comandos mm:](#comandos-mm-namespace-completo)
- [Ejemplos de Uso](#ejemplos-de-uso)
- [Instalación](#instalación)
- [Tests](#tests)
- [Troubleshooting](#troubleshooting)

---

## Integración Nativa (v0.1.0+)

minimemory está integrado nativamente en agent-shell como **peer dependency opcional**. Esto significa:

- **Zero dependencias obligatorias** - agent-shell sigue sin requerir dependencias de producción
- **Detección automática** - Si minimemory está instalado, se usa HNSW; si no, fallback a in-memory
- **Factory function** - `createVectorStorage()` selecciona el mejor backend disponible

### Quick Start

```typescript
import { createVectorStorage, isMinimemoryAvailable } from 'agent-shell';

// Verificar disponibilidad
console.log(`minimemory disponible: ${isMinimemoryAvailable()}`);

// Auto-selección del mejor backend
const { storage, backend } = await createVectorStorage({
  dimensions: 768,
  minimemory: { persistPath: './data.mmdb' }
});

console.log(`Usando backend: ${backend}`); // 'minimemory' o 'memory'

// Usar el storage
await storage.upsert({
  id: 'doc-1',
  vector: embeddings,
  metadata: { namespace: 'docs', title: 'Example' }
});

const results = await storage.search({
  vector: queryEmbedding,
  topK: 5,
  threshold: 0.7
});
```

### Instalación

```bash
# Agent Shell (siempre)
npm install agent-shell

# minimemory (opcional - para HNSW + persistencia)
npm install minimemory
```

---

## API Reference

### Funciones Exportadas

#### `isMinimemoryAvailable()`

Verifica si el binding de minimemory está instalado.

```typescript
function isMinimemoryAvailable(): boolean
```

**Retorna**: `true` si minimemory está disponible, `false` si no.

**Ejemplo**:
```typescript
import { isMinimemoryAvailable } from 'agent-shell';

if (isMinimemoryAvailable()) {
  console.log('HNSW disponible - búsquedas O(log n)');
} else {
  console.log('Usando fallback in-memory - búsquedas O(n)');
}
```

---

#### `loadMinimemory()`

Carga el binding de minimemory dinámicamente.

```typescript
function loadMinimemory(): MiniMemoryBinding | null
```

**Retorna**: El binding de minimemory o `null` si no está disponible.

**Ejemplo**:
```typescript
import { loadMinimemory } from 'agent-shell';

const binding = loadMinimemory();
if (binding) {
  const db = new binding.VectorDB({ dimensions: 768 });
}
```

---

#### `createVectorStorage(options)`

Factory function que crea un `VectorStorageAdapter` con auto-selección de backend.

```typescript
async function createVectorStorage(options: StorageFactoryOptions): Promise<StorageFactoryResult>
```

**Parámetros**:

| Param | Tipo | Descripción |
|-------|------|-------------|
| `dimensions` | `number` | Dimensiones del vector (requerido) |
| `prefer` | `'minimemory' \| 'memory' \| 'auto'` | Backend preferido (default: `'auto'`) |
| `minimemory` | `object` | Configuración específica de minimemory |

**Opciones de `minimemory`**:

| Opción | Tipo | Default | Descripción |
|--------|------|---------|-------------|
| `distance` | `'cosine' \| 'euclidean' \| 'dot_product'` | `'cosine'` | Métrica de distancia |
| `indexType` | `'flat' \| 'hnsw'` | `'hnsw'` | Tipo de índice |
| `hnswM` | `number` | `16` | Conexiones máximas por nodo HNSW |
| `hnswEfConstruction` | `number` | `200` | Profundidad de búsqueda en construcción |
| `quantization` | `'none' \| 'int8' \| 'binary'` | `'none'` | Tipo de cuantización |
| `persistPath` | `string` | - | Ruta para persistencia automática |

**Retorna**: `StorageFactoryResult`

```typescript
interface StorageFactoryResult {
  storage: VectorStorageAdapter;  // El adapter creado
  backend: 'minimemory' | 'memory';  // Backend usado
  minimemoryAvailable: boolean;  // Si minimemory está instalado
}
```

**Ejemplos**:

```typescript
import { createVectorStorage } from 'agent-shell';

// Auto-selección (default)
const { storage, backend } = await createVectorStorage({
  dimensions: 768
});

// Forzar minimemory (error si no disponible)
const { storage } = await createVectorStorage({
  dimensions: 768,
  prefer: 'minimemory',
  minimemory: {
    persistPath: './vectors.mmdb',
    indexType: 'hnsw',
    quantization: 'int8'  // 4x compresión
  }
});

// Forzar in-memory (útil para tests)
const { storage } = await createVectorStorage({
  dimensions: 768,
  prefer: 'memory'
});
```

---

### Clases Exportadas

#### `MiniMemoryVectorStorage`

Implementación de `VectorStorageAdapter` usando minimemory HNSW.

```typescript
class MiniMemoryVectorStorage implements VectorStorageAdapter {
  constructor(config: MiniMemoryVectorStorageConfig, binding?: MiniMemoryBinding)
}
```

**Métodos**:

| Método | Descripción |
|--------|-------------|
| `upsert(entry)` | Inserta o actualiza un vector |
| `upsertBatch(entries)` | Inserta/actualiza múltiples vectores |
| `delete(id)` | Elimina un vector por ID |
| `deleteBatch(ids)` | Elimina múltiples vectores |
| `search(query)` | Búsqueda vectorial con filtros |
| `listIds()` | Lista todos los IDs |
| `count()` | Cuenta total de vectores |
| `clear()` | Elimina todos los vectores |
| `healthCheck()` | Verifica estado del storage |
| `save()` | Persiste a disco manualmente |
| `getDb()` | Acceso al VectorDB nativo |
| `getConfig()` | Obtiene la configuración |

**Ejemplo directo** (sin factory):

```typescript
import { MiniMemoryVectorStorage, loadMinimemory } from 'agent-shell';

const storage = new MiniMemoryVectorStorage({
  dimensions: 768,
  distance: 'cosine',
  indexType: 'hnsw',
  persistPath: './my-vectors.mmdb'
});

// Insertar
await storage.upsert({
  id: 'doc-1',
  vector: [0.1, 0.2, ...],
  metadata: { namespace: 'docs', title: 'Hello' }
});

// Buscar
const results = await storage.search({
  vector: queryVector,
  topK: 10,
  threshold: 0.5,
  filters: { namespace: 'docs' }
});

// Persistir manualmente
storage.save();
```

---

### Tipos Exportados

```typescript
// Configuración del storage
export type {
  MiniMemoryVectorStorageConfig,
  MiniMemoryApiConfig,
  StorageFactoryOptions,
  StorageFactoryResult,
} from 'agent-shell';

// Tipos de búsqueda
export type {
  MiniMemorySearchResult,
  MiniMemoryHybridParams,
  MiniMemoryStats,
} from 'agent-shell';

// Tipos de Agent Memory
export type {
  TaskEpisode,
  CodeSnippet,
  ErrorSolution,
  AgentMemoryStats,
  RecallResult,
} from 'agent-shell';
```

---

## Características Clave

| Feature | Descripción |
|---------|-------------|
| **HNSW Index** | Búsqueda O(log n) vs O(n) brute-force |
| **Búsqueda Híbrida** | Vector + BM25 keywords + filtros metadata |
| **AgentMemory** | Memoria episódica/semántica para agentes IA |
| **Quantización** | Int8 (4x) y Binary (32x) compresión |
| **Persistencia** | Archivos `.mmdb` sin servidor externo |
| **Zero Network** | Todo corre en proceso, sin latencia HTTP |

---

## Arquitectura

```
┌──────────────────────────────────────────────────────────────────┐
│                       AI Agent (LLM)                              │
│                                                                   │
│  "remember this authentication pattern for later"                 │
│  → Agent Shell descubre mm:learn-code via vector search          │
└───────────────────────────┬──────────────────────────────────────┘
                            │ cli_exec("mm:learn-code ...")
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│                     Agent Shell Core                              │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │              VectorIndex + MiniMemoryVectorStorage          │  │
│  │              (HNSW backend para discovery de comandos)      │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌─────────────┐  ┌────────────┐  ┌──────────────────────────┐  │
│  │  Registry   │  │  Executor  │  │    mm: command handlers   │  │
│  │ (comandos)  │  │            │  │    (21 comandos)          │  │
│  └──────┬──────┘  └─────┬──────┘  └────────────┬─────────────┘  │
│         │               │                       │                 │
└─────────┼───────────────┼───────────────────────┼─────────────────┘
          │               │      ┌────────────────┘
          │               │      │ Direct call (no HTTP)
          ▼               ▼      ▼
┌──────────────────────────────────────────────────────────────────┐
│                minimemory (Rust napi-rs binding)                  │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                        VectorDB                              │ │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  │ │
│  │  │   HNSW   │  │   BM25   │  │  Filter  │  │ Hybrid RRF │  │ │
│  │  │  Index   │  │  Index   │  │  Engine  │  │   Fusion   │  │ │
│  │  └──────────┘  └──────────┘  └──────────┘  └────────────┘  │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                     AgentMemory                              │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │ │
│  │  │  Episodic    │  │   Semantic   │  │     Working      │  │ │
│  │  │  (tasks)     │  │   (code)     │  │    (context)     │  │ │
│  │  └──────────────┘  └──────────────┘  └──────────────────┘  │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│                    Persistence: .mmdb files                       │
└──────────────────────────────────────────────────────────────────┘
```

---

## Dos Niveles de Integración

### Nivel 1: VectorStorageAdapter (Backend de Búsqueda)

`MiniMemoryVectorStorage` reemplaza el storage in-memory para **todas** las búsquedas de Agent Shell:

```typescript
import { MiniMemoryVectorStorage, VectorIndex } from 'agent-shell';

// Reemplaza MemoryVectorStorage con HNSW
const vectorStorage = new MiniMemoryVectorStorage({
  dimensions: 768,
  distance: 'cosine',
  indexType: 'hnsw',
  persistPath: './agent-shell.mmdb',
});

const vectorIndex = new VectorIndex({
  embeddingAdapter,
  storageAdapter: vectorStorage,  // ← HNSW backend
  defaultTopK: 5,
});
```

**Beneficio**: Todas las integraciones (n8n, LangGraph, VoltAgent, etc.) obtienen automáticamente búsqueda HNSW sin cambiar su código.

### Nivel 2: Comandos mm: (Namespace Completo)

21 comandos que exponen VectorDB y AgentMemory al agente:

| Comando | Descripción |
|---------|-------------|
| **VectorDB** | |
| `mm:stats` | Estadísticas de la DB |
| `mm:insert` | Insertar documento con vector/metadata |
| `mm:delete` | Eliminar documento |
| `mm:get` | Obtener documento por ID |
| `mm:search` | Búsqueda vectorial HNSW |
| `mm:keywords` | Búsqueda BM25 full-text |
| `mm:hybrid` | Búsqueda híbrida (vector + BM25 + filtros) |
| `mm:filter` | Búsqueda por metadata |
| `mm:save` | Persistir a disco |
| `mm:load` | Cargar desde disco |
| **AgentMemory** | |
| `mm:learn` | Aprender de una tarea completada |
| `mm:recall` | Recordar experiencias similares |
| `mm:learn-code` | Almacenar snippet de código |
| `mm:recall-code` | Buscar snippets similares |
| `mm:learn-error` | Registrar solución a error |
| `mm:recall-errors` | Buscar soluciones a errores |
| `mm:context` | Set/get working context |
| `mm:focus` | Enfocar en proyecto (partial index) |
| `mm:memory-stats` | Stats de agent memory |
| `mm:save-memory` | Guardar memoria a disco |
| `mm:load-memory` | Cargar memoria desde disco |

---

## Ejemplos de Uso

### Uso con VectorIndex (Recomendado)

```typescript
import {
  createVectorStorage,
  VectorIndex,
  OllamaEmbeddingAdapter
} from 'agent-shell';

// 1. Crear embedding adapter
const embeddings = new OllamaEmbeddingAdapter({
  model: 'nomic-embed-text',
  dimensions: 768
});

// 2. Crear storage con auto-detección
const { storage, backend } = await createVectorStorage({
  dimensions: 768,
  minimemory: { persistPath: './commands.mmdb' }
});
console.log(`Backend: ${backend}`);

// 3. Crear VectorIndex
const index = new VectorIndex({
  embeddingAdapter: embeddings,
  storageAdapter: storage,
  defaultTopK: 5
});

// 4. Indexar comandos
await index.indexCommand({
  id: 'users:create',
  definition: { /* ... */ }
});

// 5. Buscar
const results = await index.search('crear usuario');
```

### Búsqueda Híbrida (demo)

```bash
# Combinar vector + keywords + filtros
agent-shell[mm]> mm:hybrid --keywords "authentication JWT" --filter '{"category": "security"}' --top_k 5

[OK] (12ms)
{
  "keywords": "authentication JWT",
  "hasVector": false,
  "hasFilter": true,
  "count": 3,
  "results": [
    { "id": "auth-pattern-1", "score": 0.95, "metadata": {...} },
    ...
  ]
}
```

### Aprender de una Tarea (demo)

```bash
agent-shell[mm]> mm:learn --task "Implementar auth JWT" --solution "Usar jsonwebtoken + middleware express" --outcome "success" --learnings '["Validar expiration", "Usar refresh tokens"]'

[OK] (3ms)
{
  "task": "Implementar auth JWT",
  "outcome": "success",
  "learnings": 2
}
```

### Recordar Experiencias Similares (demo)

```bash
agent-shell[mm]> mm:recall --query "autenticación de usuarios" --top_k 3

[OK] (8ms)
{
  "query": "autenticación de usuarios",
  "count": 2,
  "results": [
    { "id": "task-42", "relevance": 0.91, "content": {"task": "Implementar auth JWT", ...} },
    { "id": "task-28", "relevance": 0.85, "content": {"task": "OAuth2 con Google", ...} }
  ]
}
```

### Persistencia

```bash
# Guardar estado
agent-shell[mm]> mm:save --path "./backup.mmdb"
[OK] (45ms)
{ "saved": "./backup.mmdb" }

# Cargar estado
agent-shell[mm]> mm:load --path "./backup.mmdb"
[OK] (32ms)
{ "loaded": "./backup.mmdb", "count": 127 }
```

---

## Flujo Típico de un AI Agent

```
Turno 1: Agent recibe "guarda este patrón de autenticación para usarlo después"

  1. cli_exec('search "store code pattern"')
     → Descubre: mm:learn-code (score: 0.92)

  2. cli_exec('mm:learn-code --code "..." --description "Auth pattern" --language "typescript" --use_case "REST APIs"')
     → Almacena snippet en memoria semántica

Turno 2: Agent recibe "cómo hice la autenticación en el proyecto anterior?"

  3. cli_exec('search "recall authentication code"')
     → Descubre: mm:recall-code (score: 0.89)

  4. cli_exec('mm:recall-code --query "authentication REST API" --top_k 3')
     → Retorna snippets similares

Turno 3: Agent recibe "guarda que este error se solucionó así"

  5. cli_exec('mm:learn-error --error_message "ECONNREFUSED" --error_type "network" --root_cause "Server not running" --solution "Start server first" --language "node"')
     → Almacena solución para futura referencia

Turno 4: Agent encuentra el mismo error

  6. cli_exec('mm:recall-errors --query "ECONNREFUSED connection refused"')
     → Encuentra solución previamente aprendida
```

---

## Comparativa con Otras Integraciones

| Aspecto | VoltAgent/n8n/LangGraph | minimemory |
|---------|-------------------------|------------|
| **Transporte** | HTTP REST / SSE | Binding nativo (napi-rs) |
| **Latencia** | ~50-200ms (red) | ~1-5ms (local) |
| **Dependencia** | Servidor externo | Librería embebida |
| **Persistencia** | Gestionada por servidor | Archivo .mmdb local |
| **Offline** | No | Sí |
| **Búsqueda** | Depende del servidor | HNSW + BM25 + filtros |
| **Memoria de agente** | No incluida | AgentMemory integrado |

---

## Estructura de Archivos

```
src/minimemory/                           # Integración nativa
├── types.ts                              # Tipos e interfaces
├── vector-storage.ts                     # MiniMemoryVectorStorage
├── factory.ts                            # createVectorStorage()
└── index.ts                              # Exports

demo/                                     # Demo con comandos mm:
├── minimemory-integration.ts             # Entry point (bootstrap + REPL)
├── minimemory-commands.ts                # 21 comandos en namespace mm:
└── adapters/
    ├── minimemory-vector-storage.ts      # VectorStorageAdapter (demo)
    └── minimemory-api.ts                 # Wrapper tipado del binding

contracts/
├── minimemory-vector-storage.md          # Contrato del adapter
├── minimemory-api.md                     # Contrato del API
└── minimemory-commands.md                # Contrato de comandos

tests/
├── minimemory-native.test.ts             # 13 tests (integración nativa)
├── minimemory-vector-storage.test.ts     # 44 tests
├── minimemory-api.test.ts                # 100 tests
└── minimemory-commands.test.ts           # 82 tests
```

---

## Tests

```bash
# Todos los tests
npm test

# Solo tests de minimemory
npx vitest run tests/minimemory*.test.ts

# Output esperado:
# ✓ tests/minimemory-native.test.ts (13 tests)
# ✓ tests/minimemory-vector-storage.test.ts (44 tests)
# ✓ tests/minimemory-api.test.ts (100 tests)
# ✓ tests/minimemory-commands.test.ts (82 tests)
# Test Files  4 passed (4)
#      Tests  239 passed (239)
```

---

## Ejecución Demo

### Con Ollama (default)

```bash
bun demo/minimemory-integration.ts
```

### Con Cloudflare

```bash
CLOUDFLARE_ACCOUNT_ID=xxx CLOUDFLARE_API_TOKEN=yyy \
  bun demo/minimemory-integration.ts --cloudflare
```

### Output Esperado

```
=== Agent Shell + minimemory Integration Demo ===

[1/5] Inicializando minimemory...
  ✓ minimemory inicializado (0 docs, 768d, HNSW)
  ✓ Persistencia: ./agent-shell.mmdb

[2/5] Verificando Ollama...
  ✓ Ollama corriendo

[3/5] Inicializando embedding adapter...
  ✓ Embedding: Ollama embeddinggemma

[4/5] Registrando comandos...
  → 14 comandos base (users, notes, system, math)
  → 21 comandos minimemory (insert, search, hybrid, learn, recall...)
  = 35 comandos totales
  ✓ 35/35 comandos indexados (HNSW backend)

[5/5] Creando Core...
  ✓ Core listo

────────────────────────────────────────────────────────────────
 Agent Shell + minimemory Integration REPL
────────────────────────────────────────────────────────────────

agent-shell[mm]>
```

---

## Troubleshooting

| Error | Causa | Solución |
|-------|-------|----------|
| `minimemory binding not available` | Binding no instalado | `npm install minimemory` o compilar desde fuente |
| `Ollama no disponible` | Ollama no corriendo | `ollama serve` |
| `AgentMemory not available` | Versión del binding sin AgentMemory | Actualizar binding o usar solo VectorDB |
| `Cannot load .mmdb` | Archivo corrupto o versión incompatible | Eliminar archivo y recrear |
| `Dimension mismatch` | Vector de query ≠ dimensiones de DB | Verificar que el embedding model coincida |

---

## Benchmarks de Referencia

| Operación | minimemory (HNSW) | In-memory (brute-force) |
|-----------|-------------------|-------------------------|
| Search 100 docs | ~0.1ms | ~0.2ms |
| Search 1,000 docs | ~0.3ms | ~2ms |
| Search 10,000 docs | ~0.5ms | ~20ms |
| Search 100,000 docs | ~1ms | ~200ms |
| Hybrid search | ~1.5ms | N/A |
| Persist 10k docs | ~50ms | N/A |

---

## Próximos Pasos

- [ ] **Auto-embedding**: Generar embeddings automáticamente al insertar documentos con texto
- [ ] **Streaming recall**: Retornar resultados incrementalmente para grandes conjuntos
- [ ] **Cross-project transfer**: Transferir conocimiento entre proyectos usando GenericMemory
- [ ] **MCP Resource**: Exponer memoria como MCP resource para compartir entre agentes
- [ ] **Índices parciales dinámicos**: Crear índices on-demand basados en filtros frecuentes
