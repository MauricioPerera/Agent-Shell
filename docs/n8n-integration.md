# Integracion Agent Shell + n8n

Guia para exponer workflows de n8n como comandos en Agent Shell, permitiendo que agentes AI descubran y ejecuten automaciones por lenguaje natural.

## Arquitectura

```
┌──────────────────────────────────────────────────────────────┐
│                        AI Agent (LLM)                        │
│                                                              │
│  "ejecuta la automatizacion de envio de emails"              │
└──────────────────────┬───────────────────────────────────────┘
                       │ cli_exec("search 'send email'")
                       ▼
┌──────────────────────────────────────────────────────────────┐
│                      Agent Shell Core                        │
│                                                              │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ Vector Index │  │   Registry   │  │     Executor     │   │
│  │  (semantic)  │  │  (commands)  │  │  (run handler)   │   │
│  └──────┬──────┘  └──────┬───────┘  └────────┬─────────┘   │
│         │                 │                    │              │
│   search "email"    n8n:trigger          call handler()      │
│   → n8n:trigger     → definition         → N8nApiAdapter    │
│                      + handler                               │
└──────────────────────────────────────────┬───────────────────┘
                                           │ HTTP REST
                                           ▼
┌──────────────────────────────────────────────────────────────┐
│                      n8n Instance                            │
│                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │ Workflow A   │  │ Workflow B   │  │    Workflow C        │ │
│  │ Send Email   │  │ Sync CRM    │  │ Generate Report      │ │
│  └─────────────┘  └─────────────┘  └─────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

## Concepto

La estrategia consiste en registrar operaciones de la API de n8n como comandos del namespace `n8n:` en Agent Shell. Cuando el vector index indexa estos comandos con sus descripciones y tags, los agentes AI pueden encontrarlos mediante busqueda semantica sin conocer los IDs ni la estructura de n8n.

**Flujo tipico de un agente AI:**

1. El agente recibe la instruccion: "revisa si hay errores en las automatizaciones"
2. Usa `cli_exec("search 'check automation errors'")`
3. Agent Shell retorna: `n8n:executions` con score 0.87
4. El agente ejecuta: `cli_exec("n8n:executions --status error --limit 5")`
5. Recibe la lista de ejecuciones fallidas con detalles

## Comandos Disponibles

| Comando | Descripcion | Ejemplo |
|---------|-------------|---------|
| `n8n:health` | Verifica conectividad con n8n | `n8n:health` |
| `n8n:workflows` | Lista workflows con filtros | `n8n:workflows --active true` |
| `n8n:describe` | Detalle de un workflow (nodos, conexiones) | `n8n:describe --id "abc"` |
| `n8n:trigger` | Ejecuta un workflow con payload opcional | `n8n:trigger --id "abc" --payload '{"k":"v"}'` |
| `n8n:activate` | Activa un workflow | `n8n:activate --id "abc"` |
| `n8n:deactivate` | Desactiva un workflow | `n8n:deactivate --id "abc"` |
| `n8n:executions` | Lista ejecuciones recientes | `n8n:executions --status error` |

## Requisitos

### n8n

1. Instancia de n8n corriendo (local o cloud)
2. API habilitada: **Settings > API > Enable API**
3. API Key generada: **Settings > API > Create API Key**

### Agent Shell

1. Node.js >= 18 o Bun
2. Ollama corriendo localmente (para embeddings) o credenciales de Cloudflare

## Configuracion

### Variables de Entorno

```bash
# Requeridas
export N8N_API_KEY="n8n_api_xxxxxxxxxxxxxxx"

# Opcionales (con defaults)
export N8N_BASE_URL="http://localhost:5678"    # Default

# Para embeddings con Cloudflare (alternativa a Ollama)
export CLOUDFLARE_ACCOUNT_ID="your-account-id"
export CLOUDFLARE_API_TOKEN="your-token"
```

### Generar API Key en n8n

1. Abrir n8n en el navegador
2. Ir a **Settings** (icono de engranaje)
3. Seleccionar **API**
4. Click en **Create API Key**
5. Copiar el key generado

## Ejecucion del Demo

### Con Ollama (local, gratuito)

```bash
# 1. Asegurar que Ollama esta corriendo
ollama serve

# 2. Descargar modelo de embeddings (solo la primera vez)
ollama pull embeddinggemma

# 3. Ejecutar el demo
N8N_API_KEY=your-key bun demo/n8n-integration.ts
```

### Con Cloudflare Workers AI

```bash
N8N_API_KEY=your-key \
CLOUDFLARE_ACCOUNT_ID=your-id \
CLOUDFLARE_API_TOKEN=your-token \
bun demo/n8n-integration.ts --cloudflare
```

### Salida Esperada

```
=== Agent Shell + n8n Integration Demo ===

[1/5] Verificando configuracion n8n...
  ✓ n8n conectado en http://localhost:5678
  ✓ Estado: healthy

[2/5] Verificando Ollama...
  ✓ Ollama corriendo

[3/5] Inicializando adapters...
  ✓ Adapters inicializados

[4/5] Registrando comandos...
  → 14 comandos base (users, notes, system, math)
  → 7 comandos n8n (workflows, trigger, executions...)
  = 21 comandos totales
  ✓ 21/21 comandos indexados

[5/5] Creando Core...
  ✓ Core listo

────────────────────────────────────────────────────────
 Agent Shell + n8n Integration REPL
────────────────────────────────────────────────────────

agent-shell[n8n]>
```

## Uso desde un Agente AI

### Via MCP Server (recomendado)

En la configuracion del cliente MCP (Claude Desktop, Cursor, etc.):

```json
{
  "mcpServers": {
    "agent-shell-n8n": {
      "command": "bun",
      "args": ["path/to/your-entry-point.js"],
      "env": {
        "N8N_BASE_URL": "http://localhost:5678",
        "N8N_API_KEY": "your-key"
      }
    }
  }
}
```

El agente AI interactua usando solo 2 tools:
- `cli_help()` → Obtiene el protocolo de interaccion
- `cli_exec(command)` → Ejecuta cualquier comando

### Via SDK (programatico)

```typescript
import { Core, VectorIndex, ContextStore } from 'agent-shell';
import { N8nApiAdapter } from './adapters/n8n-api.js';
import { createN8nCommands } from './n8n-commands.js';

// 1. Crear adapter n8n
const n8nApi = new N8nApiAdapter({
  baseUrl: 'http://localhost:5678',
  apiKey: process.env.N8N_API_KEY!,
});

// 2. Generar comandos
const n8nCommands = createN8nCommands(n8nApi);

// 3. Registrar en el sistema
const registry = createRegistry(n8nCommands);
const core = new Core({ registry, vectorIndex, contextStore });

// 4. Usar
const result = await core.exec('n8n:workflows --active true');
console.log(result.data);
```

## Ejemplo: Flujo Completo de un Agente

Supongamos un agente AI que recibe la instruccion: **"revisa las automatizaciones y ejecuta la de reportes mensuales"**

```
Turno 1: El agente usa cli_help() para entender el protocolo
         → Recibe instrucciones de uso

Turno 2: cli_exec("search 'list automations workflows'")
         → Resultado: n8n:workflows (score: 0.91)

Turno 3: cli_exec("n8n:workflows")
         → Resultado: [
              { id: "wf-001", name: "Daily Email Digest", active: true },
              { id: "wf-002", name: "Monthly Reports", active: true },
              { id: "wf-003", name: "CRM Sync", active: false }
            ]

Turno 4: cli_exec("search 'execute run monthly report'")
         → Resultado: n8n:trigger (score: 0.89)

Turno 5: cli_exec("n8n:trigger --id wf-002")
         → Resultado: { executionId: "exec-789", status: "running" }

Turno 6: cli_exec("n8n:executions --workflow_id wf-002 --limit 1")
         → Resultado: { status: "success", stoppedAt: "..." }
```

## Extender: Registrar Workflows Individuales como Comandos

Para granularidad maxima, puedes auto-registrar cada workflow de n8n como su propio comando:

```typescript
import { N8nApiAdapter } from './adapters/n8n-api.js';

async function registerWorkflowsAsCommands(api: N8nApiAdapter) {
  const workflows = await api.listWorkflows({ active: true });

  return workflows.map(wf => ({
    namespace: 'n8n-wf',
    name: wf.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    version: '1.0.0',
    description: `Ejecuta el workflow "${wf.name}" en n8n (ID: ${wf.id})`,
    params: [
      { name: 'payload', type: 'json', required: false, description: 'Datos de entrada para el workflow' },
    ],
    tags: ['n8n', 'workflow', ...wf.tags?.map(t => t.name) || [], wf.name.toLowerCase()],
    example: `n8n-wf:${wf.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')} --payload '{"key": "value"}'`,
    handler: async (args: any) => {
      const payload = args.payload
        ? (typeof args.payload === 'string' ? JSON.parse(args.payload) : args.payload)
        : undefined;
      const execution = await api.executeWorkflow(wf.id, payload);
      return { success: true, data: execution };
    },
    confirm: true,
    undoable: false,
  }));
}
```

Esto permite que un agente busque `"send daily email digest"` y encuentre directamente `n8n-wf:daily-email-digest` sin necesidad de conocer el ID del workflow.

## Seguridad

### RBAC

Puedes restringir acceso a comandos n8n por rol:

```typescript
import { command } from 'agent-shell';

const triggerCmd = command('n8n', 'trigger')
  .description('Ejecuta un workflow de n8n')
  .requiredParam('id', 'string', 'ID del workflow')
  .permissions('n8n:execute')       // Solo roles con este permiso
  .requiresConfirmation()           // Requiere --confirm
  .build();
```

### Audit Logging

Todas las ejecuciones se registran automaticamente en el AuditLogger de Agent Shell:

```typescript
import { AuditLogger } from 'agent-shell';

const logger = new AuditLogger('n8n-session');
logger.on('command:executed', (event) => {
  if (event.command.startsWith('n8n:trigger')) {
    // Alertar sobre ejecuciones de workflows
    notifyAdmin(event);
  }
});
```

### Secret Detection

Agent Shell detecta automaticamente API keys en los argumentos y las enmascara en logs:

```
n8n:trigger --id "wf-001" --payload '{"api_key": "sk_live_xxx"}'
                                                    ↓
Audit log: payload contains [REDACTED:api_key]
```

## Estructura de Archivos

```
demo/
├── n8n-integration.ts          # Entry point del demo
├── n8n-commands.ts             # Definiciones de comandos n8n
└── adapters/
    └── n8n-api.ts              # Adapter HTTP para n8n REST API
```

## Troubleshooting

| Problema | Solucion |
|----------|----------|
| `n8n no disponible` | Verificar que n8n este corriendo en la URL configurada |
| `API error 401` | Verificar N8N_API_KEY, regenerar si es necesario |
| `API error 404` | Verificar que la version de n8n soporte API v1 |
| `Ollama no disponible` | Ejecutar `ollama serve` y `ollama pull embeddinggemma` |
| Baja relevancia en busqueda | Ajustar `defaultThreshold` en VectorIndex (default: 0.4) |

## Proximos Pasos

- **Estrategia 1 (complementaria)**: Crear un HTTP/SSE transport para que n8n consuma Agent Shell como MCP server via su nodo MCP Client Tool
- **Auto-discovery**: Sincronizar automaticamente nuevos workflows de n8n al registry
- **Bidireccional**: Crear un webhook handler que permita a n8n enviar eventos a Agent Shell
