# Integracion Agent Shell + VoltAgent

Integra VoltAgent como proveedor de agentes IA y workflows para Agent Shell. Los agentes, conversaciones y workflows de VoltAgent se exponen como comandos en el namespace `voltagent:*`, permitiendo que agentes IA descubran y orquesten operaciones multi-agente mediante busqueda semantica.

## Arquitectura

```
┌──────────────────────────────────────────────────────────────┐
│                       AI Agent (LLM)                          │
│                                                               │
│  "send a message to the support agent"                       │
│  → Agent Shell descubre voltagent:send via vector search     │
└───────────────────────────┬──────────────────────────────────┘
                            │ cli_exec("voltagent:send ...")
                            ▼
┌──────────────────────────────────────────────────────────────┐
│                     Agent Shell Core                          │
│                                                               │
│  ┌─────────────┐  ┌────────────┐  ┌──────────────────────┐  │
│  │ Vector Index │  │  Registry  │  │      Executor        │  │
│  │ (semantico)  │  │ (comandos) │  │ (voltagent handler)  │  │
│  └──────┬──────┘  └─────┬──────┘  └──────────┬───────────┘  │
│         │                │                     │              │
│   search "agent"    voltagent:send         call handler()    │
│   → voltagent:send  → definition           → HTTP REST      │
│                     + handler                                │
└─────────────────────────────────────────────┬────────────────┘
                                              │ HTTP REST / SSE
                                              ▼
┌──────────────────────────────────────────────────────────────┐
│                  VoltAgent Server (:3141)                      │
│                                                               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │  Agent A     │  │  Agent B    │  │    Agent C           │  │
│  │  Support     │  │  RAG Agent  │  │ Multi-Tool Agent     │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
│                                                               │
│  Workflows ──→ Steps ──→ Suspend/Resume (human-in-the-loop) │
│  Memory    ──→ Conversations ──→ Messages                    │
└──────────────────────────────────────────────────────────────┘
```

## Concepto

VoltAgent es un framework TypeScript para construir agentes IA con:

- **Multi-agent supervision** - Agentes especializados bajo coordinacion
- **Typed tools** - Herramientas con validacion Zod
- **Workflows** - Automatizacion multi-paso con suspend/resume
- **Memory persistente** - Conversaciones con historial durable
- **Streaming** - Respuestas incrementales via SSE

Esta integracion expone las operaciones del servidor VoltAgent como comandos de Agent Shell, permitiendo que un agente IA:

1. **Descubra** agentes disponibles via busqueda semantica
2. **Envie** mensajes a agentes especificos
3. **Converse** con streaming en tiempo real
4. **Ejecute** workflows multi-paso
5. **Reanude** workflows suspendidos (human-in-the-loop)
6. **Consulte** historial de conversaciones

## Comandos Disponibles

| Comando | Descripcion | Params |
|---------|-------------|--------|
| `voltagent:health` | Verifica conectividad con servidor | — |
| `voltagent:agents` | Lista agentes disponibles | — |
| `voltagent:send` | Envia mensaje y recibe respuesta | `agent_id`, `input`, `conversation_id?`, `user_id?` |
| `voltagent:chat` | Conversacion con streaming SSE | `agent_id`, `input`, `conversation_id?`, `user_id?` |
| `voltagent:object` | Genera objeto JSON estructurado | `agent_id`, `input`, `schema?` |
| `voltagent:workflows` | Lista workflows disponibles | — |
| `voltagent:run-workflow` | Ejecuta workflow completo | `workflow_id`, `input` |
| `voltagent:stream-workflow` | Ejecuta workflow con streaming | `workflow_id`, `input` |
| `voltagent:resume-workflow` | Reanuda workflow suspendido | `workflow_id`, `execution_id`, `input?` |
| `voltagent:cancel-workflow` | Cancela workflow en ejecucion | `workflow_id`, `execution_id`, `reason?` |
| `voltagent:conversations` | Lista conversaciones de un agente | `agent_id`, `limit?` |
| `voltagent:messages` | Obtiene mensajes de conversacion | `conversation_id`, `agent_id`, `limit?` |

## Requisitos

### VoltAgent Server

El servidor VoltAgent debe estar corriendo. Ejemplo minimo:

```typescript
// src/index.ts (proyecto VoltAgent)
import { VoltAgent, Agent } from "@voltagent/core";
import { VercelAIProvider } from "@voltagent/vercel-ai";
import { openai } from "@ai-sdk/openai";
import { honoServer } from "@voltagent/server-hono";

const agent = new Agent({
  name: "my-agent",
  instructions: "A helpful assistant",
  llmProvider: new VercelAIProvider(),
  model: openai("gpt-4o-mini"),
});

new VoltAgent({
  agents: { agent },
  server: honoServer(),
});
```

```bash
# Iniciar servidor VoltAgent
npm run dev
# → Server running at http://localhost:3141
```

### Agent Shell

```bash
git clone https://github.com/your-org/agent-shell
cd agent-shell
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
# VoltAgent server (opcional - default: http://localhost:3141)
VOLTAGENT_BASE_URL=http://localhost:3141

# API key (opcional - solo si el servidor requiere autenticacion)
VOLTAGENT_API_KEY=your-api-key

# Embeddings con Cloudflare (opcional - alternativa a Ollama)
CLOUDFLARE_ACCOUNT_ID=your-account-id
CLOUDFLARE_API_TOKEN=your-token
```

## Ejecucion

### Con Ollama (default)

```bash
bun demo/voltagent-integration.ts
```

### Con Cloudflare

```bash
CLOUDFLARE_ACCOUNT_ID=xxx CLOUDFLARE_API_TOKEN=yyy \
  bun demo/voltagent-integration.ts --cloudflare
```

### Con API key

```bash
VOLTAGENT_API_KEY=xxx bun demo/voltagent-integration.ts
```

## Output Esperado

```
=== Agent Shell + VoltAgent Integration Demo ===

[1/5] Verificando configuracion VoltAgent...
  ✓ VoltAgent conectado en http://localhost:3141
  ✓ Estado: healthy

[2/5] Verificando Ollama...
  ✓ Ollama corriendo

[3/5] Inicializando adapters...
  ✓ Adapters inicializados

[4/5] Registrando comandos...
  → 14 comandos base (users, notes, system, math)
  → 12 comandos voltagent (agents, send, chat, workflows...)
  = 26 comandos totales
  ✓ 26/26 comandos indexados

[5/5] Creando Core...
  ✓ Core listo

────────────────────────────────────────────────────────────────
 Agent Shell + VoltAgent Integration REPL
────────────────────────────────────────────────────────────────

agent-shell[voltagent]>
```

## Uso desde AI Agent

### Via MCP Server (Claude Desktop, Cursor, etc)

```typescript
import { Core, McpServer } from 'agent-shell';
import { VoltAgentApiAdapter } from './adapters/voltagent-api.js';
import { createVoltAgentCommands } from './voltagent-commands.js';

// Setup
const voltAgentApi = new VoltAgentApiAdapter({ baseUrl: 'http://localhost:3141' });
const commands = [...baseCommands, ...createVoltAgentCommands(voltAgentApi)];
const core = new Core({ registry, vectorIndex, contextStore });
const mcp = new McpServer({ core });

// El LLM usa solo 2 tools: cli_help() y cli_exec(cmd)
// El vector index descubre los comandos voltagent automaticamente
```

### Via SDK programatico

```typescript
const core = new Core({ registry, vectorIndex, contextStore });

// 1. Descubrir: que agentes hay disponibles?
const search = await core.exec('search "send message to AI agent"');
// → [{ commandId: "voltagent:send", score: 0.91, ... }]

// 2. Listar agentes
const agents = await core.exec('voltagent:agents');
// → { count: 3, agents: [{ id: "support", name: "Support Agent", ... }] }

// 3. Enviar mensaje
const result = await core.exec(
  'voltagent:send --agent_id "support" --input "I need help with billing"'
);
// → { response: "I'd be happy to help with billing...", conversationId: "conv-abc" }

// 4. Continuar conversacion
const followUp = await core.exec(
  `voltagent:chat --agent_id "support" --input "What are the pricing tiers?" ` +
  `--conversation_id "${result.data.conversationId}"`
);

// 5. Ejecutar workflow
const workflow = await core.exec(
  'voltagent:run-workflow --workflow_id "expense-approval" ' +
  '--input \'{"amount": 5000, "department": "engineering"}\''
);

// 6. Reanudar workflow suspendido
const resumed = await core.exec(
  `voltagent:resume-workflow --workflow_id "expense-approval" ` +
  `--execution_id "${workflow.data.execution_id}" --input '{"approved": true}'`
);
```

## Flujo Completo de un AI Agent

```
Turno 1: Agent recibe "habla con el agente de soporte sobre mi factura"

  1. cli_exec('search "talk to support agent about invoice"')
     → Descubre: voltagent:send (score: 0.89), voltagent:chat (score: 0.87)

  2. cli_exec('voltagent:agents')
     → Lista: [{ id: "support", name: "Support Agent" }, ...]

  3. cli_exec('voltagent:send --agent_id "support" --input "I have a question about my invoice"')
     → Respuesta: { response: "Sure, I can help...", conversationId: "conv-xyz" }

Turno 2: Agent recibe "ejecuta el workflow de aprobacion con monto 3000"

  4. cli_exec('search "run approval workflow"')
     → Descubre: voltagent:run-workflow (score: 0.92)

  5. cli_exec('voltagent:run-workflow --workflow_id "expense-approval" --input \'{"amount": 3000}\'')
     → { execution_id: "exec-456", status: "suspended" }

  6. cli_exec('voltagent:resume-workflow --workflow_id "expense-approval" --execution_id "exec-456" --input \'{"approved": true}\'')
     → { status: "completed", result: { ... } }
```

## Streaming SSE

Los comandos `voltagent:chat` y `voltagent:stream-workflow` usan Server-Sent Events internamente, colectando todos los eventos y retornandolos como respuesta estructurada:

```bash
agent-shell[voltagent]> voltagent:chat --agent_id "my-agent" --input "Tell me about TypeScript"
```

Respuesta:
```json
{
  "agent_id": "my-agent",
  "response": "TypeScript is a typed superset of JavaScript...",
  "conversationId": "conv-abc123",
  "events_count": 12
}
```

## Estructura de Archivos

```
demo/
├── voltagent-integration.ts             # Entry point (bootstrap + REPL)
├── voltagent-commands.ts                # 12 comandos en namespace voltagent:*
└── adapters/
    └── voltagent-api.ts                 # HTTP adapter para VoltAgent REST API

docs/
└── voltagent-integration.md             # Esta documentacion
```

## Diferencias con Integracion LangGraph

| Aspecto | LangGraph | VoltAgent |
|---------|-----------|-----------|
| **Paradigma** | Grafos stateful (StateGraph) | Agentes con tools + workflows |
| **Estado** | Threads + checkpoints | Conversaciones + memory |
| **Ejecucion** | Nodos en grafo | Agentes independientes |
| **Streaming** | SSE por nodo | SSE por token/evento |
| **Human-in-the-loop** | Interrupciones en grafo | Workflow suspend/resume |
| **Multi-agent** | Sub-grafos | Supervisor + sub-agentes |
| **Outputs** | Estado del grafo | Text, Object, Stream |

Ambas integraciones pueden coexistir: un LLM con Agent Shell puede orquestar tanto grafos LangGraph como agentes VoltAgent usando los mismos 2 tools (`cli_help`, `cli_exec`).

## Troubleshooting

| Error | Causa | Solucion |
|-------|-------|----------|
| `VoltAgent no disponible en localhost:3141` | Servidor no corriendo | `npm run dev` en proyecto VoltAgent |
| `Ollama no disponible` | Ollama no corriendo | `ollama serve` |
| `VoltAgent API error 401` | API key incorrecta | Verificar `VOLTAGENT_API_KEY` |
| `VoltAgent API error 404` | Agent/workflow no existe | Verificar IDs con `voltagent:agents` |
| `VoltAgent API error 500` | Error interno del agente | Verificar logs del servidor VoltAgent |
| Timeout en streaming | Respuesta larga del LLM | Verificar configuracion de timeout |

## Proximos Pasos

- **Agent Shell como tool VoltAgent**: Registrar Agent Shell como herramienta dentro de agentes VoltAgent (integracion bidireccional)
- **MCP bridge**: Conectar via Model Context Protocol para interoperabilidad estandar
- **Auto-discovery**: Indexar agentes VoltAgent dinamicamente al arrancar
- **Guardrails**: Propagar guardrails de VoltAgent como validaciones en Agent Shell
- **Observabilidad**: Integrar audit logs de Agent Shell con VoltOps Console
