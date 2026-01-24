# Guia de Adapters

Agent Shell usa el patron de **adapters inyectables** para mantener zero dependencias runtime. Cada adapter implementa una interfaz minima que permite conectar diferentes backends sin cambiar el core.

---

## Interfaces disponibles

| Interfaz | Proposito | Ubicacion |
|----------|-----------|-----------|
| `StorageAdapter` | Persistencia de sesiones (context, history, snapshots) | `src/context-store/types.ts` |
| `EmbeddingAdapter` | Generacion de embeddings vectoriales | `src/vector-index/types.ts` |
| `VectorStorageAdapter` | Almacenamiento y busqueda vectorial | `src/vector-index/types.ts` |
| `SQLiteDatabase` | Interfaz SQLite generica (para los SQLite adapters) | `src/context-store/sqlite-types.ts` |
| `PgClient` | Interfaz PostgreSQL generica (para pgvector adapter) | `src/vector-index/pgvector-types.ts` |

---

## 1. StorageAdapter (Persistencia de sesiones)

### Interfaz

```typescript
interface StorageAdapter {
  name: string;
  initialize(sessionId: string): Promise<void>;
  load(sessionId: string): Promise<SessionStore | null>;
  save(sessionId: string, data: SessionStore): Promise<void>;
  destroy(sessionId: string): Promise<void>;
  healthCheck(): Promise<boolean>;
  dispose?(): Promise<void>;
}
```

### Tipos asociados

```typescript
interface SessionStore {
  context: { entries: Record<string, ContextEntry> };
  history: HistoryEntry[];
  undo_snapshots: UndoSnapshot[];
}

interface ContextEntry {
  key: string;
  value: any;
  type: string;
  set_at: string;
  updated_at: string;
  version: number;
}
```

### Ejemplo: Adapter Redis

```typescript
import type { StorageAdapter, SessionStore } from 'agent-shell';

class RedisStorageAdapter implements StorageAdapter {
  name = 'redis-storage';
  private client: RedisClient;

  constructor(client: RedisClient) {
    this.client = client;
  }

  async initialize(sessionId: string): Promise<void> {
    // Redis no requiere esquema, solo verificar conexion
    await this.client.ping();
  }

  async load(sessionId: string): Promise<SessionStore | null> {
    const raw = await this.client.get(`session:${sessionId}`);
    return raw ? JSON.parse(raw) : null;
  }

  async save(sessionId: string, data: SessionStore): Promise<void> {
    await this.client.set(`session:${sessionId}`, JSON.stringify(data));
  }

  async destroy(sessionId: string): Promise<void> {
    await this.client.del(`session:${sessionId}`);
  }

  async healthCheck(): Promise<boolean> {
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async dispose(): Promise<void> {
    await this.client.quit();
  }
}
```

### Adapters incluidos

- **`SQLiteStorageAdapter`**: Persistencia SQLite con tablas relacionales (schema automatico)
- **`EncryptedStorageAdapter`**: Decorator que agrega AES-256-GCM encryption
- **In-memory** (solo en `demo/adapters/memory-storage.ts`): Ejemplo de implementacion en Map para desarrollo/tests

---

## 2. EmbeddingAdapter (Generacion de vectores)

### Interfaz

```typescript
interface EmbeddingAdapter {
  embed(text: string): Promise<EmbeddingResult>;
  embedBatch(texts: string[]): Promise<EmbeddingResult[]>;
  getDimensions(): number;
  getModelId(): string;
}

interface EmbeddingResult {
  vector: number[];
  dimensions: number;
  tokenCount: number;
  model: string;
}
```

### Ejemplo: Adapter OpenAI

```typescript
import type { EmbeddingAdapter, EmbeddingResult } from 'agent-shell';

class OpenAIEmbeddingAdapter implements EmbeddingAdapter {
  private apiKey: string;
  private model = 'text-embedding-3-small';
  private dims = 1536;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  getDimensions(): number { return this.dims; }
  getModelId(): string { return this.model; }

  async embed(text: string): Promise<EmbeddingResult> {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input: text, model: this.model }),
    });

    const data = await response.json();
    const embedding = data.data[0].embedding;

    return {
      vector: embedding,
      dimensions: this.dims,
      tokenCount: data.usage.total_tokens,
      model: this.model,
    };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input: texts, model: this.model }),
    });

    const data = await response.json();
    return data.data.map((item: any) => ({
      vector: item.embedding,
      dimensions: this.dims,
      tokenCount: Math.ceil(data.usage.total_tokens / texts.length),
      model: this.model,
    }));
  }
}
```

### Ejemplo: Adapter Ollama (local)

```typescript
class OllamaEmbeddingAdapter implements EmbeddingAdapter {
  private model: string;
  private dims: number;
  private baseUrl: string;

  constructor(config: { model: string; dims: number; baseUrl?: string }) {
    this.model = config.model;
    this.dims = config.dims;
    this.baseUrl = config.baseUrl ?? 'http://localhost:11434';
  }

  getDimensions() { return this.dims; }
  getModelId() { return `ollama/${this.model}`; }

  async embed(text: string): Promise<EmbeddingResult> {
    const res = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: 'POST',
      body: JSON.stringify({ model: this.model, prompt: text }),
    });
    const data = await res.json();
    return {
      vector: data.embedding,
      dimensions: this.dims,
      tokenCount: text.split(/\s+/).length,
      model: this.model,
    };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    return Promise.all(texts.map(t => this.embed(t)));
  }
}
```

---

## 3. VectorStorageAdapter (Almacenamiento vectorial)

### Interfaz

```typescript
interface VectorStorageAdapter {
  upsert(entry: VectorEntry): Promise<void>;
  upsertBatch(entries: VectorEntry[]): Promise<BatchStorageResult>;
  delete(id: string): Promise<void>;
  deleteBatch(ids: string[]): Promise<BatchStorageResult>;
  search(query: VectorSearchQuery): Promise<VectorSearchResult[]>;
  listIds(): Promise<string[]>;
  count(): Promise<number>;
  clear(): Promise<void>;
  healthCheck(): Promise<HealthStatus>;
}
```

### Tipos asociados

```typescript
interface VectorEntry {
  id: string;
  vector: number[];
  metadata: CommandMetadata;
}

interface VectorSearchQuery {
  vector: number[];
  topK: number;
  threshold?: number;
  filters?: SearchFilters;
}

interface SearchFilters {
  namespace?: string;
  tags?: string[];
  excludeIds?: string[];
}

interface VectorSearchResult {
  id: string;
  score: number;       // 0-1, mayor = mas similar
  metadata: CommandMetadata;
}

interface BatchStorageResult {
  success: number;
  failed: number;
}

interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  details?: string;
}
```

### Ejemplo: Adapter Pinecone

```typescript
import type { VectorStorageAdapter, VectorEntry, VectorSearchQuery, VectorSearchResult, BatchStorageResult, HealthStatus } from 'agent-shell';

class PineconeStorageAdapter implements VectorStorageAdapter {
  private index: PineconeIndex;

  constructor(index: PineconeIndex) {
    this.index = index;
  }

  async upsert(entry: VectorEntry): Promise<void> {
    await this.index.upsert([{
      id: entry.id,
      values: entry.vector,
      metadata: entry.metadata,
    }]);
  }

  async upsertBatch(entries: VectorEntry[]): Promise<BatchStorageResult> {
    try {
      await this.index.upsert(entries.map(e => ({
        id: e.id,
        values: e.vector,
        metadata: e.metadata,
      })));
      return { success: entries.length, failed: 0 };
    } catch {
      return { success: 0, failed: entries.length };
    }
  }

  async delete(id: string): Promise<void> {
    await this.index.deleteOne(id);
  }

  async deleteBatch(ids: string[]): Promise<BatchStorageResult> {
    await this.index.deleteMany(ids);
    return { success: ids.length, failed: 0 };
  }

  async search(query: VectorSearchQuery): Promise<VectorSearchResult[]> {
    const filter: any = {};
    if (query.filters?.namespace) filter.namespace = query.filters.namespace;

    const results = await this.index.query({
      vector: query.vector,
      topK: query.topK,
      filter: Object.keys(filter).length > 0 ? filter : undefined,
      includeMetadata: true,
    });

    return results.matches
      .filter(m => !query.threshold || m.score >= query.threshold)
      .map(m => ({
        id: m.id,
        score: m.score,
        metadata: m.metadata as CommandMetadata,
      }));
  }

  async listIds(): Promise<string[]> {
    // Pinecone no soporta list nativo, requiere fetch paginado
    const stats = await this.index.describeIndexStats();
    // Simplificacion: retornar vacio y usar count() para validar
    return [];
  }

  async count(): Promise<number> {
    const stats = await this.index.describeIndexStats();
    return stats.totalRecordCount;
  }

  async clear(): Promise<void> {
    await this.index.deleteAll();
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      await this.index.describeIndexStats();
      return { status: 'healthy' };
    } catch (err: any) {
      return { status: 'unhealthy', details: err.message };
    }
  }
}
```

### Adapters incluidos

- **`PgVectorStorageAdapter`**: PostgreSQL con extension pgvector (incluido en el paquete)
- **In-memory** (solo en `demo/adapters/memory-vector-storage.ts`): Cosine similarity en memoria para desarrollo/tests
- **SQLite vector** (solo en `demo/adapters/sqlite-vector-storage.ts`): SQLite con cosine similarity en JS

---

## 4. SQLiteDatabase (Para SQLite adapters)

### Interfaz

```typescript
interface SQLiteDatabase {
  prepare(sql: string): SQLiteStatement;
  exec(sql: string): void;
  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T;
}

interface SQLiteStatement {
  run(...params: any[]): any;
  get(...params: any[]): any;
  all(...params: any[]): any[];
}
```

### Compatibilidad

| Libreria | Compatible | Notas |
|----------|-----------|-------|
| `bun:sqlite` | Si | API nativa de Bun |
| `better-sqlite3` | Si | API sincrona para Node.js |
| `sql.js` | Parcial | Requiere wrapper minimo |

### Uso con `better-sqlite3`

```typescript
import Database from 'better-sqlite3';
import { SQLiteStorageAdapter, SQLiteRegistryAdapter } from 'agent-shell';

const db = new Database('agent-shell.db');

// Storage para sesiones
const storage = new SQLiteStorageAdapter({ db });
await storage.initialize('session-1');

// Registry para comandos
const registry = new SQLiteRegistryAdapter({ db });
registry.initialize();
```

### Uso con `bun:sqlite`

```typescript
import { Database } from 'bun:sqlite';
import { SQLiteStorageAdapter } from 'agent-shell';

const db = new Database('agent-shell.db');
const storage = new SQLiteStorageAdapter({ db });
await storage.initialize('my-session');
```

---

## 5. PgClient (Para pgvector adapter)

### Interfaz

```typescript
interface PgClient {
  query(text: string, values?: any[]): Promise<PgQueryResult>;
}

interface PgQueryResult {
  rows: any[];
  rowCount: number | null;
}
```

### Compatibilidad

| Libreria | Compatible | Notas |
|----------|-----------|-------|
| `pg` (node-postgres) | Si | Tanto `Client` como `Pool` |
| `postgres` (postgres.js) | Parcial | Requiere wrapper |
| `@vercel/postgres` | Si | Usa `pg` internamente |

### Uso con `pg`

```typescript
import { Pool } from 'pg';
import { PgVectorStorageAdapter, VectorIndex } from 'agent-shell';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const vectorStorage = new PgVectorStorageAdapter({
  client: pool,
  dimensions: 1536,              // Debe coincidir con el embedding adapter
  tableName: 'command_vectors',   // Default: 'vector_entries'
  distanceType: 'cosine',        // 'cosine' | 'l2' | 'inner_product'
  hnswOptions: { m: 16, efConstruction: 64 },
});

await vectorStorage.initialize();

// Usar con VectorIndex
const vectorIndex = new VectorIndex({
  embeddingAdapter: myEmbeddingAdapter,
  storageAdapter: vectorStorage,
  defaultTopK: 5,
  defaultThreshold: 0.7,
});
```

---

## Patrones comunes

### Decorator pattern (composicion de adapters)

```typescript
// Encriptar datos antes de persistir
import { EncryptedStorageAdapter, SQLiteStorageAdapter } from 'agent-shell';

const sqlite = new SQLiteStorageAdapter({ db });
const encrypted = new EncryptedStorageAdapter(sqlite, {
  key: Buffer.from(process.env.ENCRYPTION_KEY!, 'hex'),
});

// `encrypted` implementa StorageAdapter y delega a `sqlite`
```

### Creando un adapter custom

1. Implementa la interfaz correspondiente
2. El adapter recibe sus dependencias por constructor (inyeccion)
3. No agrega dependencias runtime al proyecto
4. Usa `initialize()` para setup (tablas, conexiones)
5. Implementa `healthCheck()` para monitoreo
6. Los adapters son stateless excepto por la conexion

### Testing de adapters custom

```typescript
import { describe, it, expect } from 'vitest';

describe('MyCustomAdapter', () => {
  it('implementa el contrato de StorageAdapter', async () => {
    const adapter = new MyCustomAdapter(/* config */);

    // initialize no lanza
    await adapter.initialize('test-session');

    // load retorna null si no existe
    expect(await adapter.load('nonexistent')).toBeNull();

    // save + load roundtrip
    const data = { context: { entries: {} }, history: [], undo_snapshots: [] };
    await adapter.save('sess-1', data);
    const loaded = await adapter.load('sess-1');
    expect(loaded).toEqual(data);

    // destroy elimina
    await adapter.destroy('sess-1');
    expect(await adapter.load('sess-1')).toBeNull();

    // healthCheck retorna boolean
    expect(await adapter.healthCheck()).toBe(true);
  });
});
```

---

## Requisitos para PostgreSQL + pgvector

```sql
-- Instalar extension (requiere superuser o permisos CREATE EXTENSION)
CREATE EXTENSION IF NOT EXISTS vector;

-- El adapter crea la tabla automaticamente con initialize()
-- pero si prefieres crearla manualmente:
CREATE TABLE vector_entries (
  id TEXT PRIMARY KEY,
  embedding vector(1536),    -- dimension del modelo
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indice HNSW para busqueda eficiente
CREATE INDEX idx_vector_entries_embedding
ON vector_entries
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);
```
