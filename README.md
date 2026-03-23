# Agent Shell

Framework para construir CLIs **AI-first** que actuan como gateway controlable entre agentes LLM y la ejecucion de comandos.

Resuelve el problema de escalabilidad de herramientas en agentes AI mediante un patron de **2 tools + discovery vectorial**: ~600 tokens constantes en contexto, independiente de la cantidad de comandos disponibles.

```
Tool 1: cli_help()           → Protocolo de interaccion
Tool 2: cli_exec(cmd: str)   → Ejecutar cualquier comando
```

## Instalacion

```bash
# Como dependencia en tu proyecto
npm install agent-shell

# O desarrollo local
bun install
```

## Scripts

```bash
bun run build        # Compilar con tsup
bun run test         # Ejecutar tests (vitest)
bun run test:watch   # Tests en modo watch
bun run dev          # Build en modo watch
```

## Distribucion

El paquete se publica como modulo ESM con tipos TypeScript incluidos.

**Entry points:**

```typescript
// Entry point principal
import { Core, McpServer, StdioTransport } from 'agent-shell';

// Sub-path para MCP especifico
import { McpServer, StdioTransport } from 'agent-shell/mcp';
```

**CLI global:**

```bash
# Instalar globalmente
npm install -g agent-shell

# Usar como binario
agent-shell help     # Muestra ayuda
agent-shell version  # Muestra version
agent-shell serve    # Requiere registry configurado programaticamente (ver MCP Server)
```

**Configuracion del paquete:**

| Campo | Valor |
|-------|-------|
| `license` | MIT |
| `type` | module (ESM) |
| `bin` | `agent-shell` → `./dist/cli/index.js` |
| `exports` | `.` (main) + `./mcp` (sub-path) |
| `files` | `dist`, `README.md`, `LICENSE` |
| Dependencias runtime | 0 (zero external deps) |

## Arquitectura

```
┌─────────────────────────────────────────────────────────────────┐
│                         MCP Server                               │
│                  (JSON-RPC 2.0 / stdio)                          │
├─────────────────────────────────────────────────────────────────┤
│                           Core                                   │
│                    (orquestador central)                          │
├──────┬──────┬──────┬──────┬──────┬────────┬──────────┬──────────┤
│Parser│Regis-│Execu-│Vector│Contxt│Security│JQ Filter │   CLI    │
│      │ try  │ tor  │Index │Store │        │          │          │
└──────┴──────┴──────┴──────┴──────┴────────┴──────────┴──────────┘
```

| Modulo | Descripcion |
|--------|-------------|
| **MCP Server** | Servidor Model Context Protocol. Expone `cli_help` y `cli_exec` como tools MCP via JSON-RPC 2.0 |
| **CLI** | Entry point de linea de comandos para uso standalone |
| **Core** | Orquestador central. Unico punto de entrada al sistema |
| **Parser** | Tokeniza y parsea comandos en AST tipado |
| **CommandRegistry** | Catalogo de comandos con versionado semver |
| **Executor** | Ejecucion con validacion, permisos, timeout, pipeline, batch, rate limiting |
| **VectorIndex** | Busqueda semantica sobre el catalogo de comandos |
| **ContextStore** | Estado de sesion, historial FIFO, undo con snapshots, TTL, secret detection |
| **JQ Filter** | Filtrado JSON post-ejecucion con sintaxis jq-subset |
| **Security** | Audit logging, RBAC, deteccion de secretos, encriptacion de storage |
| **Skills** | CLI creation (scaffold, wizard, registry admin) + system shell (http, json, file, shell, env) |
| **ShellAdapter** | Backend pluggable: just-bash (sandboxed) o native (child_process). Auto-detect. |

## Uso Basico

### Core (entry point recomendado)

```typescript
import { Core } from 'agent-shell';

const core = new Core({
  registry,       // CommandRegistry con comandos registrados
  vectorIndex,    // VectorIndex para busqueda semantica
  contextStore,   // ContextStore para estado de sesion
});

// El agente LLM usa solo estas 2 llamadas:
const protocol = core.help();
const response = await core.exec('users:create --name "Juan" --email j@t.com');
// → { code: 0, data: { id: 42, ... }, error: null, meta: { ... } }
```

### Respuesta Estandar (CoreResponse)

Toda interaccion retorna la misma estructura:

```typescript
{
  code: number,         // 0=ok, 1=sintaxis, 2=no encontrado, 3=permisos, 4=confirmacion
  data: any | null,     // Resultado de la ejecucion
  error: string | null, // Mensaje de error (null si ok)
  meta: {
    duration_ms: number,
    command: string,
    mode: string,       // "execute" | "dry-run" | "validate" | "confirm"
    timestamp: string   // ISO 8601
  }
}
```

### MCP Server (integracion con agentes)

El MCP Server expone Agent Shell como un servidor [Model Context Protocol](https://modelcontextprotocol.io), permitiendo que cualquier cliente MCP (Claude Desktop, Cursor, etc.) use los comandos registrados.

```typescript
import { McpServer, Core } from 'agent-shell';

const core = new Core({ registry, vectorIndex, contextStore });

const server = new McpServer({ core });
server.start(); // Escucha JSON-RPC 2.0 via stdin/stdout
```

El servidor expone exactamente 2 tools al agente:

| Tool | Parametros | Descripcion |
|------|-----------|-------------|
| `cli_help` | ninguno | Retorna el protocolo de interaccion |
| `cli_exec` | `command: string` | Ejecuta cualquier comando |

**Protocolo:** JSON-RPC 2.0 sobre stdio (newline-delimited JSON).

**Metodos soportados:**
- `initialize` — Handshake MCP con capabilities
- `tools/list` — Lista tools disponibles
- `tools/call` — Invoca un tool
- `ping` — Health check

**Para transporte custom** (HTTP, WebSocket, etc.):

```typescript
const server = new McpServer({ core });

// handleMessage es publico para usar con cualquier transporte
const response = await server.handleMessage({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: 'cli_exec', arguments: { command: 'users:list' } },
});
```

**Configuracion en Claude Desktop (`claude_desktop_config.json`):**

> **Nota:** El comando `serve` requiere un registry con comandos registrados.
> Para uso en produccion, crear un script de entry point que configure el Core
> y use `McpServer.start()` programaticamente.

```json
{
  "mcpServers": {
    "agent-shell": {
      "command": "node",
      "args": ["./tu-entry-point.js"]
    }
  }
}
```

### CLI

Entry point de linea de comandos para uso standalone o como binario MCP.

```bash
# Despues de instalar globalmente o via npx
agent-shell help       # Muestra ayuda
agent-shell version    # Muestra version
agent-shell serve      # MCP server (requiere registry configurado programaticamente)
```

El binario se registra automaticamente en `package.json`:

```json
{
  "bin": { "agent-shell": "./dist/cli/index.js" }
}
```

## Modulos en Detalle

### Parser

Transforma un string de comando en un AST tipado.

```typescript
import { parse } from 'agent-shell';

// Comando simple
parse('users:list --limit 5');
// → { type: 'single', commands: [{ namespace: 'users', command: 'list', ... }] }

// Pipeline
parse('users:list >> users:export --format csv');
// → { type: 'pipeline', commands: [...] }

// Batch
parse('batch [users:list, orders:list]');
// → { type: 'batch', commands: [...] }

// Con filtro jq
parse('users:get --id 1 | .name');
// → commands[0].jqFilter = { raw: '.name', type: 'field', fields: ['name'] }
```

**Flags globales soportadas:** `--dry-run`, `--validate`, `--confirm`, `--format json|table|csv`, `--limit N`, `--offset N`

### JQ Filter

Filtra JSON con un subset de la sintaxis jq.

```typescript
import { applyFilter } from 'agent-shell';

const data = { users: [{ name: 'Juan' }, { name: 'Ana' }] };

applyFilter(data, '.users.[0].name');
// → { success: true, result: 'Juan' }

applyFilter(data, '.users.[].name');
// → { success: true, result: ['Juan', 'Ana'] }

applyFilter(data, '[.users, .count]');
// → { success: true, result: [[...], undefined] }
```

**Sintaxis soportada:**
- `.campo` — acceso a campo
- `.a.b.c` — campos anidados
- `.[N]` / `.[-N]` — indice de array
- `.[]` — iteracion sobre array
- `[.a, .b]` — multi-select

### ContextStore

Almacen de estado de sesion con historial y undo.

```typescript
import { ContextStore } from 'agent-shell';

const store = new ContextStore(storageAdapter, 'session-1');

// Claves con inferencia de tipo automatica (JSON.parse)
await store.set('user.name', '"Juan"');
await store.set('count', '42');           // → tipo: number
await store.set('active', 'true');        // → tipo: boolean

const result = await store.get('count');
// → { status: 0, data: { key: 'count', value: 42 } }

// Historial FIFO
await store.recordCommand({ command: 'users:list', exitCode: 0 });
const history = await store.getHistory({ limit: 20 });

// Undo con snapshots
await store.undo('command-id');
```

**StorageAdapter:** interfaz inyectable para persistencia (en memoria, archivo, DB).

**Configuracion avanzada:**

```typescript
const store = new ContextStore(storageAdapter, 'session-1', {
  ttl_ms: 3600000,                        // Expiracion de sesion (1h)
  secretDetection: { mode: 'reject' },    // Rechazar valores con secretos
  retentionPolicy: { maxAge_ms: 86400000, maxEntries: 5000 },
});
```

### CommandRegistry

Catalogo de comandos con soporte para versionado semver.

```typescript
import { CommandRegistry } from 'agent-shell';

const registry = new CommandRegistry();

const definition = {
  namespace: 'users',
  name: 'create',
  version: '1.0.0',
  description: 'Crea un nuevo usuario',
  params: [
    { name: 'name', type: 'string', required: true },
    { name: 'email', type: 'string', required: true },
    { name: 'role', type: 'enum', enumValues: ['admin', 'user'], default: 'user' },
  ],
  undoable: true,
};

const handler = async (args) => ({ success: true, data: { id: 1, ...args } });

registry.register(definition, handler);

// Resolucion (retorna ultima version)
const cmd = registry.resolve('users:create');

// Texto compacto AI-optimizado
const text = registry.toCompactText(definition);
// → "users:create | Crea un nuevo usuario\n  --name: string [REQUIRED]\n  ..."
```

### Executor

Motor de ejecucion con pipeline completo: validacion → permisos → modo → timeout → historial.

```typescript
import { Executor } from 'agent-shell';

const executor = new Executor(registry, {
  sessionId: 'sess-1',
  permissions: ['users:*', 'orders:list'],
  state: {},
  config: { timeout_ms: 5000, maxPipelineDepth: 10, maxBatchSize: 20, undoTTL_ms: 300000, enableHistory: true },
  history: { entries: [], append(e) { this.entries.push(e); }, getById(id) { return null; } },
});

// Ejecucion simple
const result = await executor.execute(parseResult);
// → ExecutionResult | PipelineResult | BatchResult

// Undo
await executor.undo(historyId);
```

**Modos de ejecucion:**
- **normal** — ejecuta el handler
- **dry-run** — simula sin efectos
- **validate** — solo valida args y permisos
- **confirm** — genera token de confirmacion, requiere segundo exec

**Confirm token management:**

```typescript
// Ejecutar con --confirm genera un token
const preview = await executor.execute(parseConfirmResult);
// → { code: 4, data: { preview, confirmToken: 'abc123' } }

// Confirmar ejecucion con el token
const result = await executor.confirm('abc123');

// Revocar tokens (retornan ExecutionResult)
executor.revokeConfirm('abc123');
executor.revokeAllConfirms();  // → ExecutionResult { data: { revoked: number } }
```

**Rate limiting:** configurable por sesion con ventana deslizante.

```typescript
const executor = new Executor(registry, {
  ...context,
  config: {
    ...config,
    confirmTTL_ms: 60000,                      // TTL de tokens de confirmacion (1 min)
    rateLimit: { maxRequests: 100, windowMs: 60000 },  // 100 req/min
  },
});
```

### VectorIndex

Motor de busqueda semantica sobre el catalogo de comandos.

```typescript
import { VectorIndex } from 'agent-shell';

const index = new VectorIndex({
  embeddingAdapter,   // Implementacion de EmbeddingAdapter
  storageAdapter,     // Implementacion de VectorStorageAdapter
  defaultTopK: 5,
  defaultThreshold: 0.4,
});

// Indexar comandos (usa embedBatch internamente — 1 sola llamada al API)
await index.indexBatch(commands);

// Indexar uno individual
await index.indexCommand({ namespace: 'users', name: 'create', version: '1.0.0', description: '...' });

// Busqueda semantica
const results = await index.search('crear un usuario nuevo', { topK: 3, threshold: 0.5 });
// → { query, results: [{ commandId, score, description, ... }], totalIndexed, searchTimeMs }

// Sincronizacion con registry
await index.sync('delta', registry);  // Solo diferencias
await index.sync('full', registry);   // Rebuild completo

// Health check
const health = await index.healthCheck();
```

**Indexacion batch optimizada:** `indexBatch` usa `embedBatch` para generar todos los embeddings en una sola llamada al API, con fallback secuencial si falla.

**Texto indexable enriquecido:** Cada comando se indexa combinando: `description`, `longDescription`, namespace, nombre, descripciones de parametros, tags y ejemplo. Esto maximiza la superficie semantica para el modelo de embeddings.

**Adapters inyectables:**
- `EmbeddingAdapter` — genera vectores desde texto (OpenAI, Cohere, Ollama, Cloudflare, etc.)
- `VectorStorageAdapter` — almacena y busca vectores (Pinecone, Qdrant, pgvector, en memoria, etc.)

#### Matryoshka Progressive Search

Modelos entrenados con Matryoshka loss (Gemma Embedding, nomic-embed, OpenAI text-embedding-3-*) producen vectores donde los primeros N dimensiones forman un embedding valido de N dimensiones. Agent Shell aprovecha esto con busqueda progresiva en funnel:

```
Query → embed a 768d
  ├─ 64d:  todos los comandos → cosine similarity → top 50
  ├─ 128d: 50 candidatos → re-score → top 25
  ├─ 256d: 25 candidatos → re-score → top 10
  └─ 768d: 10 candidatos → ranking final → top K
```

```typescript
import { VectorIndex, defaultMatryoshkaConfig } from 'agent-shell';

const index = new VectorIndex({
  embeddingAdapter,
  storageAdapter,
  defaultTopK: 5,
  defaultThreshold: 0.3,
  matryoshka: defaultMatryoshkaConfig(768), // 64→128→256→768 funnel
});

const results = await index.search('crear usuario');
// results.matryoshkaStages muestra el narrowing por capa:
// [{ dimensions: 64, candidatesIn: 100, candidatesOut: 50 },
//  { dimensions: 128, candidatesIn: 50, candidatesOut: 25 },
//  { dimensions: 256, candidatesIn: 25, candidatesOut: 10 },
//  { dimensions: 768, candidatesIn: 10, candidatesOut: 5 }]
```

**`MatryoshkaEmbeddingAdapter`** — wrapper adapter-agnostico que trunca cualquier embedding:

```typescript
import { MatryoshkaEmbeddingAdapter } from 'agent-shell';

// Truncar embeddings de 1024d a 768d para storage
const adapter = new MatryoshkaEmbeddingAdapter(ollamaAdapter, 768);
```

**Configuracion custom de capas:**

```typescript
const index = new VectorIndex({
  embeddingAdapter,
  storageAdapter,
  defaultTopK: 5,
  defaultThreshold: 0.3,
  matryoshka: {
    enabled: true,
    fullDimensions: 768,
    layers: [
      { dimensions: 64, candidateTopK: 100 },
      { dimensions: 256, candidateTopK: 20 },
    ],
  },
});
```

> **Nota:** Matryoshka search usa el mapa in-memory (`indexed`), no el `storageAdapter.search()`, ya que los storage backends no soportan truncado multi-resolucion. Los comandos deben indexarse via `indexCommand()`/`indexBatch()`.

### Security

Modulo transversal de seguridad con audit logging, RBAC, deteccion de secretos y encriptacion.

#### AuditLogger

Emite eventos tipados para todas las acciones relevantes de seguridad.

```typescript
import { AuditLogger } from 'agent-shell/security';

const logger = new AuditLogger('session-id');

// Suscribirse a eventos especificos
logger.on('command:executed', (event) => console.log(event));
logger.on('permission:denied', (event) => alert(event));

// Suscripcion wildcard (todos los eventos)
logger.on('*', (event) => sendToSIEM(event));
```

**Eventos soportados:** `command:executed`, `command:failed`, `permission:denied`, `confirm:requested`, `confirm:executed`, `confirm:expired`, `session:created`, `session:expired`, `error:handler`, `error:timeout`

#### Secret Detection & Masking

Deteccion automatica de credenciales con patrones configurables.

```typescript
import { containsSecret, maskSecrets } from 'agent-shell/security';

// Detectar secretos
containsSecret('mi-api-key: sk_live_abc123');  // → true

// Enmascarar recursivamente (objetos, arrays, strings)
maskSecrets({ token: 'Bearer eyJhbGc...' });
// → { token: '[REDACTED:bearer_token]' }
```

**Patrones detectados:** API keys, Bearer tokens, passwords, AWS keys (AKIA), JWTs, private keys, hex secrets (32+ chars).

#### RBAC (Role-Based Access Control)

Sistema de roles con herencia para permisos agrupados.

```typescript
import { RBAC } from 'agent-shell/security';

const rbac = new RBAC();
rbac.addRole({ name: 'viewer', permissions: ['users:list', 'notes:list'] });
rbac.addRole({ name: 'admin', permissions: ['users:*', 'system:*'], inherits: ['viewer'] });

const perms = rbac.resolvePermissions('admin');
// → ['users:*', 'system:*', 'users:list', 'notes:list']
```

#### EncryptedStorageAdapter

Wrapper decorator que encripta datos at-rest con AES-256-GCM.

```typescript
import { EncryptedStorageAdapter } from 'agent-shell';

const encrypted = new EncryptedStorageAdapter(baseAdapter, {
  key: crypto.randomBytes(32),  // 256 bits requeridos
});

const store = new ContextStore(encrypted, 'session-1');
// Todos los datos se encriptan/desencriptan transparentemente
```

**Caracteristicas:** IV aleatorio por operacion, AEAD authentication tag, backward-compatible con datos no encriptados.

### Command Builder

API fluida para definir comandos sin construir objetos manualmente.

```typescript
import { command } from 'agent-shell';

const def = command('users', 'create')
  .version('1.0.0')
  .description('Creates a new user')
  .requiredParam('name', 'string', 'Full name')
  .requiredParam('email', 'string', 'Email address')
  .optionalParam('role', 'enum(admin,user)', 'user', 'User role')
  .param('age', 'int', p => p.constraints('min:0,max:150'))
  .output('object', 'Created user')
  .example('users:create --name "John" --email "j@t.com"')
  .tags('users', 'crud')
  .reversible()
  .permissions('users:write')
  .build();
```

**Shorthands:** `requiredParam()`, `optionalParam()` para los casos mas comunes.

### SQLite Adapters

Persistencia SQLite para ContextStore y CommandRegistry. Acepta cualquier database compatible con la interfaz `SQLiteDatabase` (`bun:sqlite`, `better-sqlite3`).

```typescript
import { SQLiteStorageAdapter, SQLiteRegistryAdapter } from 'agent-shell';
import { Database } from 'bun:sqlite'; // o better-sqlite3

const db = new Database('agent-shell.db');

// ContextStore con SQLite
const storage = new SQLiteStorageAdapter({ db });
const store = new ContextStore(storage, 'session-1');

// CommandRegistry persistente
const registryAdapter = new SQLiteRegistryAdapter({ db });
registryAdapter.initialize();
registryAdapter.saveBatch(definitions);  // Persistir en disco
const loaded = registryAdapter.loadAll(); // Cargar en cold-start
```

**Caracteristicas:** Auto-migrations, transacciones atomicas, sin dependencias externas (interfaz inyectable).

## Agent Profiles (Control de Acceso)

Agent Shell permite limitar lo que un agente puede descubrir y ejecutar mediante perfiles predefinidos o permisos custom.

```typescript
// Agente admin — acceso total
const core = new Core({ registry, agentProfile: 'admin' });

// Agente reader — solo puede buscar, describir y leer
const core = new Core({ registry, agentProfile: 'reader' });

// Permisos custom
const core = new Core({ registry, permissions: ['users:read', 'users:create', 'orders:*'] });

// RBAC con roles
const rbac = new RBAC({ roles: [...], defaultRole: 'viewer' });
const core = new Core({ registry, rbac, permissions: ['viewer'] });
```

| Profile | Puede hacer | No puede |
|---------|-------------|----------|
| `admin` | Todo | — |
| `operator` | CRUD, shell, http, files, env | Delete, admin |
| `reader` | Read, search, describe | Crear, modificar, eliminar |
| `restricted` | Solo comandos publicos (sin `requiredPermissions`) | Todo lo demas |

**Enforcement en 3 capas:**
- **Ejecucion**: `executeCommand()` verifica permisos antes del handler
- **Discovery**: `search` oculta comandos sin permiso; `describe` deniega inspeccion
- **Pipeline**: Cada step verificado individualmente

Sin `agentProfile` ni `permissions` = sin restricciones (backward compatible).

## Shell Skills (Acceso al Sistema)

Skills opcionales que dan al agente capacidades reales del sistema, protegidas por permisos.

```typescript
import { registerShellSkills, createShellAdapter } from 'agent-shell';

// Auto-detect: just-bash sandboxed si esta instalado, native child_process si no
registerShellSkills(registry);

// Forzar backend sandboxed con filesystem virtual
const adapter = createShellAdapter({
  prefer: 'just-bash',
  files: { '/workspace/data.json': '{}' },
  network: { allowedUrlPrefixes: ['https://api.myapp.com/'] },
});
registerShellSkills(registry, adapter);
```

| Namespace | Comandos | Permiso | Backend |
|-----------|----------|---------|---------|
| `http` | get, post, request | `http:read/write` | fetch nativo |
| `json` | filter, parse | `json:read` | jq-filter interno |
| `file` | read, write, list | `file:read/write` | ShellAdapter |
| `shell` | exec, which | `shell:exec/read` | ShellAdapter |
| `env` | get, list | `env:read` | process.env (masks secrets) |

**ShellAdapter backends:**
- **`just-bash`** (peer dep opcional): Interprete bash TS, filesystem virtual, 79 comandos Unix built-in, sin procesos reales
- **`native`** (fallback): `child_process` + `fs/promises`, acceso real al sistema

## CLI Creation Skills

Skills para generar proyectos CLI con Agent Shell.

```typescript
import { registerSkills } from 'agent-shell';
registerSkills(registry); // 9 comandos
```

| Skill | Funcion |
|-------|---------|
| `scaffold:init --name my-cli` | Genera proyecto completo (package.json, tsconfig, entry point) |
| `scaffold:add-namespace --namespace users` | Genera directorio + barrel export |
| `scaffold:add-command --namespace users --name create` | Genera archivo con CommandBuilder |
| `wizard:create-command --namespace users --name create --description "..."` | Retorna CommandDefinition + handler skeleton |
| `wizard:create-namespace --namespace users --commands '[...]'` | Crea N definiciones de una vez |
| `registry:list` | Lista comandos registrados |
| `registry:describe --command users:create` | Definicion completa |
| `registry:stats` | Conteos, namespaces, tags |
| `registry:export` | Export JSON |

## Protocolo de Interaccion (Help)

El protocolo que recibe el agente LLM al llamar `cli_help()`:

```
Descubrimiento:
  search <query>              Busqueda semantica de comandos
  describe <ns:cmd>           Ver definicion de un comando

Ejecucion:
  namespace:comando --arg v   Ejecutar comando
  --dry-run                   Simular sin ejecutar
  --validate                  Solo validar argumentos
  --confirm                   Preview antes de ejecutar

Filtrado:
  comando | .campo            Extraer campo del resultado
  comando | [.a, .b]         Multi-select

Composicion:
  cmd1 >> cmd2                Pipeline
  batch [cmd1, cmd2, cmd3]    Batch

Estado:
  context                     Ver contexto actual
  context:set key valor       Guardar valor
  context:get key             Obtener valor
  context:delete key          Eliminar clave
  history                     Ver historial
  undo <id>                   Revertir comando
```

## Estructura del Proyecto

```
src/
├── index.ts                 # Barrel exports
├── cli/
│   └── index.ts             # CLI entry point (bin: agent-shell)
├── mcp/
│   ├── types.ts             # JSON-RPC 2.0, MCP tool definitions
│   ├── transport.ts         # StdioTransport (newline-delimited JSON)
│   ├── server.ts            # McpServer (initialize, tools/list, tools/call)
│   └── index.ts             # Barrel exports
├── core/
│   ├── types.ts             # CoreResponse, CoreConfig
│   └── index.ts             # Core (orquestador)
├── parser/
│   ├── types.ts             # ParseResult, ParsedCommand, ParseError
│   ├── tokenizer.ts         # Tokenizador de bajo nivel
│   ├── errors.ts            # Constructores de errores
│   └── index.ts             # parse()
├── jq-filter/
│   ├── types.ts             # FilterResult, PathSegment
│   ├── parser.ts            # Parser de expresiones jq
│   ├── resolver.ts          # Evaluador de paths sobre JSON
│   └── index.ts             # applyFilter()
├── context-store/
│   ├── types.ts             # SessionStore, StorageAdapter, ContextStoreConfig
│   ├── sqlite-types.ts      # SQLiteDatabase interface
│   ├── sqlite-storage-adapter.ts  # SQLite-backed StorageAdapter
│   ├── encrypted-storage-adapter.ts  # AES-256-GCM wrapper
│   └── index.ts             # ContextStore
├── command-registry/
│   ├── types.ts             # CommandDefinition, CommandParam
│   ├── sqlite-registry-adapter.ts  # SQLite persistence for commands
│   └── index.ts             # CommandRegistry
├── executor/
│   ├── types.ts             # ExecutionResult, PipelineResult, BatchResult
│   └── index.ts             # Executor
├── command-builder/
│   └── index.ts             # command(), CommandBuilder, ParamBuilder
├── security/
│   ├── types.ts             # AuditEvent, SecurityConfig
│   ├── audit-logger.ts      # EventEmitter de auditoria
│   ├── secret-patterns.ts   # Deteccion y masking de secretos
│   ├── rbac.ts              # Role-Based Access Control
│   ├── rbac-types.ts        # Tipos RBAC
│   ├── permission-matcher.ts # Matching de permisos con wildcards
│   └── index.ts             # Barrel exports
├── vector-index/
│   ├── types.ts             # EmbeddingAdapter, VectorStorageAdapter
│   ├── matryoshka.ts        # Matryoshka progressive search
│   ├── pgvector-storage-adapter.ts  # PostgreSQL + pgvector adapter
│   └── index.ts             # VectorIndex
├── skills/
│   ├── scaffold.ts          # scaffold:init, add-namespace, add-command
│   ├── wizard.ts            # wizard:create-command, create-namespace
│   ├── registry-admin.ts    # registry:list, describe, stats, export
│   ├── shell-http.ts        # http:get, post, request
│   ├── shell-json.ts        # json:filter, parse
│   ├── shell-file.ts        # file:read, write, list
│   ├── shell-exec.ts        # shell:exec, which
│   ├── shell-env.ts         # env:get, list
│   └── index.ts             # registerSkills, registerShellSkills, registerAllSkills
└── just-bash/
    ├── types.ts             # ShellAdapter, ShellResult interfaces
    ├── adapter.ts           # JustBashShellAdapter, NativeShellAdapter
    ├── factory.ts           # createShellAdapter, isJustBashAvailable
    └── index.ts             # Barrel exports

contracts/                   # Contratos de especificacion por modulo
tests/                       # 913 tests across 24 suites (vitest)
docs/                        # PRD, diagramas, roadmap, schemas
```

## Tests

913 tests across 24 suites:

```bash
bun run test

# 24 suites, 913 tests passing
# Key suites:
# ✓ full-system.test.ts (65 tests)        — Full stack integration battery
# ✓ scalability-promise.test.ts (16 tests) — Token economy proof
# ✓ minimemory-api.test.ts (100 tests)    — MiniMemory integration
# ✓ minimemory-commands.test.ts (82 tests) — MiniMemory commands
# ✓ security.test.ts (63 tests)           — RBAC, audit, secrets
# ✓ vector-index.test.ts (46 tests)       — Vector search + matryoshka
# ✓ executor.test.ts (42 tests)           — Execution engine
# ✓ jq-filter.test.ts (40 tests)          — JSON filtering
# ✓ context-store.test.ts (37 tests)      — Session state
# ✓ sqlite-adapters.test.ts (35 tests)    — SQLite persistence
# ✓ http-transport.test.ts (32 tests)     — HTTP/SSE transport
# ✓ skills.test.ts (30 tests)             — CLI creation skills
# ✓ shell-skills.test.ts (27 tests)       — System shell skills
# ✓ just-bash-adapter.test.ts (24 tests)  — Shell adapter
# ✓ agent-permissions.test.ts (22 tests)  — Permission enforcement
# + 9 more suites
```

## Stack Tecnico

- **Runtime:** Bun
- **Lenguaje:** TypeScript (ES2022, ESM)
- **Testing:** Vitest
- **Build:** tsup
- **Dependencias externas:** cero (core standalone)

## Limites del Sistema

| Parametro | Limite |
|-----------|--------|
| Input maximo | 4096 caracteres |
| Pipeline max depth | 10 comandos |
| Batch max size | 20 comandos |
| Top-K search max | 20 resultados |
| Context max keys | 1000 por sesion |
| History max entries | 10,000 (FIFO) |
| JQ expression max | 256 caracteres |
| JQ path max depth | 20 segmentos |
| JQ multi-select max fields | 20 campos |
| JQ max input size | 10 MB |
| Value max size | 64 KB |

## Demo

El directorio `demo/` contiene un sistema completo funcional con 14 comandos en 4 namespaces (users, notes, system, math), usando embeddings reales para busqueda semantica.

### Requisitos

Elegir uno de los backends de embeddings:

| Backend | Modelo | Requisito |
|---------|--------|-----------|
| Ollama (local) | `embeddinggemma` | Ollama corriendo en `localhost:11434` |
| Cloudflare Workers AI | `embeddinggemma-300m` | Account ID + API Token |

Ambos producen vectores de 768 dimensiones.

### Ejecucion

```bash
# Con Ollama (default)
bun demo/index.ts

# Con Cloudflare Workers AI
bun demo/index.ts --cloudflare

# Test E2E no-interactivo (Ollama)
bun demo/test-e2e.ts

# Test E2E no-interactivo (Cloudflare)
bun demo/test-e2e-cloudflare.ts
```

### Estructura del Demo

```
demo/
├── index.ts                          # REPL interactivo
├── test-e2e.ts                       # E2E con Ollama
├── test-e2e-cloudflare.ts            # E2E con Cloudflare
├── benchmark-sqlite-vector.ts        # Benchmark de storage adapters
├── commands.ts                       # 14 comandos CRUD en memoria
└── adapters/
    ├── ollama-embedding.ts           # EmbeddingAdapter → Ollama local
    ├── cloudflare-embedding.ts       # EmbeddingAdapter → Cloudflare Workers AI
    ├── memory-vector-storage.ts      # VectorStorageAdapter en memoria
    ├── memory-storage.ts             # StorageAdapter en memoria (ContextStore)
    ├── sqlite-vector-storage.ts      # VectorStorageAdapter → SQLite + JS cosine
    └── sqlite-native-vector-storage.ts  # VectorStorageAdapter → SQLite streaming
```

### Adapters de Embedding

Los adapters implementan la interfaz `EmbeddingAdapter` del modulo VectorIndex:

```typescript
import { CloudflareEmbeddingAdapter } from './adapters/cloudflare-embedding.js';

const adapter = new CloudflareEmbeddingAdapter({
  accountId: 'tu-account-id',
  apiToken: 'tu-api-token',
  model: '@cf/google/embeddinggemma-300m', // opcional, es el default
});

// O con Ollama local:
import { OllamaEmbeddingAdapter } from './adapters/ollama-embedding.js';

const adapter = new OllamaEmbeddingAdapter({
  baseUrl: 'http://localhost:11434', // opcional
  model: 'embeddinggemma',           // opcional
});
```

### Comandos Disponibles en el Demo

| Comando | Descripcion |
|---------|-------------|
| `users:create` | Crea un usuario (name, email, role) |
| `users:list` | Lista usuarios con filtro por rol |
| `users:get` | Obtiene usuario por ID |
| `users:update` | Actualiza datos de usuario |
| `users:delete` | Elimina usuario (con confirmacion) |
| `users:count` | Cuenta total de usuarios |
| `notes:create` | Crea una nota (title, content, author) |
| `notes:list` | Lista notas con filtro por autor |
| `notes:get` | Obtiene nota por ID |
| `notes:delete` | Elimina nota |
| `notes:search` | Busca notas por texto |
| `system:status` | Estado del sistema y estadisticas |
| `system:echo` | Repite un mensaje (testing) |
| `math:calc` | Operaciones aritmeticas (add, sub, mul, div) |

## Licencia

MIT
