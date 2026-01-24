# Integracion Agent Shell + LangGraph

Integra LangGraph como proveedor de grafos de agentes IA para Agent Shell. Los asistentes, threads y ejecuciones de LangGraph se exponen como comandos en el namespace `langgraph:*`, permitiendo que agentes IA descubran y orquesten workflows stateful mediante busqueda semantica.

## Arquitectura

```
┌──────────────────────────────────────────────────────────────┐
│                       AI Agent (LLM)                          │
│                                                               │
│  "run the support agent on this conversation"                 │
│  → Agent Shell descubre langgraph:run via vector search       │
└───────────────────────────┬──────────────────────────────────┘
                            │ cli_exec("langgraph:run ...")
                            ▼
┌──────────────────────────────────────────────────────────────┐
│                     Agent Shell Core                          │
│                                                               │
│  ┌─────────────┐  ┌────────────┐  ┌──────────────────────┐  │
│  │ Vector Index │  │  Registry  │  │      Executor        │  │
│  │ (semantico)  │  │ (comandos) │  │ (langgraph handler)  │  │
│  └──────┬──────┘  └─────┬──────┘  └──────────┬───────────┘  │
│         │                │                     │              │
│   search "agent"    langgraph:run          call handler()    │
│   → langgraph:run   → definition           → HTTP REST      │
│                     + handler                                │
└─────────────────────────────────────────────┬────────────────┘
                                              │ HTTP REST / SSE
                                              ▼
┌──────────────────────────────────────────────────────────────┐
│                  LangGraph Server (:8123)                      │
│                                                               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │ Assistant A  │  │ Assistant B  │  │    Assistant C       │  │
│  │ Chat Agent   │  │  RAG Agent  │  │ Multi-Tool Agent     │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
│                                                               │
│  Threads ──→ Runs ──→ State (checkpoints)                    │
└──────────────────────────────────────────────────────────────┘
```

## Concepto

LangGraph es un framework de orquestacion para agentes IA stateful. Ejecuta grafos (StateGraph) donde cada nodo procesa y transforma estado, soportando:

- **Durable execution** - Persiste a traves de fallos
- **Human-in-the-loop** - Interrupciones para aprobacion humana
- **Memoria comprehensiva** - Estado de corto y largo plazo
- **Streaming** - Eventos SSE incrementales durante ejecucion

Esta integracion expone las operaciones del servidor LangGraph como comandos de Agent Shell, permitiendo que un agente IA:

1. **Descubra** grafos disponibles via busqueda semantica
2. **Cree** threads de conversacion con estado
3. **Ejecute** grafos con input estructurado
4. **Inspeccione** el estado resultante
5. **Monitoree** el historial de ejecuciones

## Comandos Disponibles

| Comando | Descripcion | Params |
|---------|-------------|--------|
| `langgraph:health` | Verifica conectividad con servidor | — |
| `langgraph:assistants` | Lista grafos/asistentes disponibles | `graph_id?`, `limit?` |
| `langgraph:describe` | Detalle de un asistente especifico | `assistant_id` |
| `langgraph:threads` | Crea nuevo thread de conversacion | `metadata?` |
| `langgraph:state` | Obtiene estado actual de un thread | `thread_id` |
| `langgraph:run` | Ejecuta grafo y espera resultado | `thread_id`, `assistant_id`, `input`, `config?` |
| `langgraph:stream` | Ejecuta con streaming SSE | `thread_id`, `assistant_id`, `input`, `stream_mode?` |
| `langgraph:runs` | Lista historial de ejecuciones | `thread_id`, `status?`, `limit?` |

## Requisitos

### LangGraph Server

El servidor LangGraph debe estar corriendo. Opciones:

```bash
# Opcion 1: langgraph CLI (requiere pip install langgraph-cli)
langgraph up

# Opcion 2: Docker
docker run -p 8123:8123 langchain/langgraph-api

# Opcion 3: Desarrollo local
pip install langgraph langgraph-api
langgraph dev
```

### Agent Shell

```bash
# Clonar el repositorio
git clone https://github.com/your-org/agent-shell
cd agent-shell

# Instalar dependencias
bun install
```

### Backend de Embeddings

Una de estas opciones:

**Ollama (local, recomendado para desarrollo):**
```bash
ollama serve
ollama pull embeddinggemma
```

**Cloudflare Workers AI (cloud):**
- Requiere `CLOUDFLARE_ACCOUNT_ID` y `CLOUDFLARE_API_TOKEN`

## Configuracion

Variables de entorno:

```bash
# LangGraph server (opcional - default: http://localhost:8123)
LANGGRAPH_BASE_URL=http://localhost:8123

# API key (opcional - solo si el servidor requiere autenticacion)
LANGGRAPH_API_KEY=lgk_xxxxxxxxxxxxxxx

# Embeddings con Cloudflare (opcional - alternativa a Ollama)
CLOUDFLARE_ACCOUNT_ID=your-account-id
CLOUDFLARE_API_TOKEN=your-token
```

## Ejecucion

### Con Ollama (default)

```bash
bun demo/langgraph-integration.ts
```

### Con Cloudflare

```bash
CLOUDFLARE_ACCOUNT_ID=xxx CLOUDFLARE_API_TOKEN=yyy \
  bun demo/langgraph-integration.ts --cloudflare
```

### Con API key

```bash
LANGGRAPH_API_KEY=lgk_xxx bun demo/langgraph-integration.ts
```

## Output Esperado

```
=== Agent Shell + LangGraph Integration Demo ===

[1/5] Verificando configuracion LangGraph...
  ✓ LangGraph conectado en http://localhost:8123
  ✓ Estado: healthy

[2/5] Verificando Ollama...
  ✓ Ollama corriendo

[3/5] Inicializando adapters...
  ✓ Adapters inicializados

[4/5] Registrando comandos...
  → 14 comandos base (users, notes, system, math)
  → 8 comandos langgraph (assistants, threads, run...)
  = 22 comandos totales
  ✓ 22/22 comandos indexados

[5/5] Creando Core...
  ✓ Core listo

────────────────────────────────────────────────────────────────
 Agent Shell + LangGraph Integration REPL
────────────────────────────────────────────────────────────────

agent-shell[langgraph]>
```

## Uso desde AI Agent

### Via MCP Server (Claude Desktop, Cursor, etc)

```typescript
import { Core, McpServer } from 'agent-shell';
import { LangGraphApiAdapter } from './adapters/langgraph-api.js';
import { createLangGraphCommands } from './langgraph-commands.js';

// Setup
const langGraphApi = new LangGraphApiAdapter({ baseUrl: 'http://localhost:8123' });
const commands = [...baseCommands, ...createLangGraphCommands(langGraphApi)];
const core = new Core({ registry, vectorIndex, contextStore });
const mcp = new McpServer({ core });

// El LLM usa solo 2 tools: cli_help() y cli_exec(cmd)
// El vector index descubre los comandos langgraph automaticamente
```

### Via SDK programatico

```typescript
const core = new Core({ registry, vectorIndex, contextStore });

// 1. Descubrir: que comandos hay para ejecutar agentes?
const search = await core.exec('search "execute an AI agent"');
// → [{ commandId: "langgraph:run", score: 0.92, ... }]

// 2. Crear thread
const thread = await core.exec('langgraph:threads --metadata \'{"purpose":"support"}\'');
const threadId = thread.data.thread_id;

// 3. Ejecutar grafo
const result = await core.exec(
  `langgraph:run --thread_id "${threadId}" --assistant_id "support-agent" ` +
  `--input '{"messages": [{"role": "user", "content": "I need help with billing"}]}'`
);

// 4. Verificar estado
const state = await core.exec(`langgraph:state --thread_id "${threadId}"`);

// 5. Historial de ejecuciones
const runs = await core.exec(`langgraph:runs --thread_id "${threadId}"`);
```

## Flujo Completo de un AI Agent

```
Turno 1: Agent recibe "ejecuta el agente de soporte con mi consulta"

  1. cli_exec('search "execute support agent"')
     → Descubre: langgraph:run (score: 0.89)

  2. cli_exec('langgraph:assistants')
     → Lista: [{ assistant_id: "support-agent", graph_id: "support-flow" }]

  3. cli_exec('langgraph:threads --metadata \'{"user":"customer-42"}\'')
     → Crea: { thread_id: "t-abc123" }

  4. cli_exec('langgraph:run --thread_id "t-abc123" --assistant_id "support-agent" --input \'{"messages":[...]}\'')
     → Ejecuta grafo, retorna resultado

  5. cli_exec('langgraph:state --thread_id "t-abc123"')
     → Verifica estado final del thread

Turno 2: Agent recibe "que paso con la ejecucion?"

  6. cli_exec('langgraph:runs --thread_id "t-abc123"')
     → Lista historial de runs con status
```

## Streaming SSE

El comando `langgraph:stream` ejecuta un grafo con Server-Sent Events, colectando todos los eventos y retornandolos como array:

```bash
agent-shell[langgraph]> langgraph:stream --thread_id "t-1" --assistant_id "a-1" --input '{"messages":[...]}' --stream_mode updates
```

Modos de streaming:
- `values` - Retorna el estado completo en cada paso
- `updates` - Retorna solo los deltas/cambios por nodo
- `events` - Retorna todos los eventos internos del grafo

Respuesta:
```json
{
  "assistant_id": "a-1",
  "thread_id": "t-1",
  "events_count": 5,
  "events": [
    { "event": "values", "data": { "messages": [...] } },
    { "event": "values", "data": { "messages": [..., "agent response"] } }
  ],
  "final_state": { "messages": [...] }
}
```

## Estructura de Archivos

```
demo/
├── langgraph-integration.ts          # Entry point (bootstrap + REPL)
├── langgraph-commands.ts             # 8 comandos en namespace langgraph:*
├── test-e2e-langgraph.ts             # Tests E2E no-interactivos
└── adapters/
    └── langgraph-api.ts              # HTTP adapter para LangGraph REST API

docs/
└── langgraph-integration.md          # Esta documentacion
```

## Tests E2E

```bash
# Requiere Ollama + LangGraph server corriendo
bun demo/test-e2e-langgraph.ts
```

Valida:
- Busqueda semantica encuentra comandos `langgraph:*`
- Ejecucion directa retorna respuestas estructuradas
- `describe` muestra definicion de comandos
- Manejo de errores retorna formato correcto

## Troubleshooting

| Error | Causa | Solucion |
|-------|-------|----------|
| `LangGraph no disponible en localhost:8123` | Servidor no corriendo | `langgraph up` o `docker run ...` |
| `Ollama no disponible` | Ollama no corriendo | `ollama serve` |
| `LangGraph API error 401` | API key incorrecta/faltante | Verificar `LANGGRAPH_API_KEY` |
| `LangGraph API error 404` | Assistant/thread no existe | Verificar IDs con `langgraph:assistants` |
| `LangGraph API error 422` | Input invalido | Verificar formato JSON del input |
| Timeout en streaming | Grafo tarda mucho | Verificar recursion_limit en config |

## Proximos Pasos

- **Integracion bidireccional**: Agent Shell como tool dentro de nodos LangGraph
- **Auto-discovery de grafos**: Indexar asistentes como comandos dinamicamente
- **Human-in-the-loop**: Manejar interrupciones de LangGraph via `--confirm`
- **Checkpoints**: Exponer time-travel y branching de estados
- **Store compartido**: Sincronizar context store de Agent Shell con LangGraph Store API
