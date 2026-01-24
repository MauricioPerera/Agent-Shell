# HTTP/SSE Transport

Agent Shell soporta dos transportes para comunicarse con agentes LLM:

| Transporte | Protocolo | Uso |
|-----------|-----------|-----|
| `StdioTransport` | JSON-RPC 2.0 sobre stdin/stdout | Integracion local (MCP clients, IDEs) |
| `HttpSseTransport` | JSON-RPC 2.0 sobre HTTP + SSE | Integracion remota (web, servicios, multi-agente) |

Este documento cubre el uso del `HttpSseTransport`.

---

## Quick Start

```typescript
import { Core, McpServer, HttpSseTransport } from 'agent-shell';

// 1. Configurar Core con tu registry
const core = new Core({ registry });

// 2. Crear McpServer
const mcp = new McpServer({ core });

// 3. Crear transporte HTTP/SSE
const transport = new HttpSseTransport({ port: 3001 });

// 4. Conectar transport al McpServer
transport.onMessage((req) => mcp.handleMessage(req));

// 5. Iniciar
await transport.start();
console.log(`Listening on http://127.0.0.1:${transport.port}`);
```

---

## Configuracion

```typescript
interface HttpTransportConfig {
  port?: number;            // Default: 3000
  host?: string;            // Default: '127.0.0.1'
  corsOrigin?: string | string[];  // Default: undefined (sin CORS)
  heartbeatInterval?: number;      // Default: 30000 (30s)
  requestTimeout?: number;         // Default: 30000 (30s)
  maxBodySize?: number;            // Default: 65536 (64KB)
}
```

### Opciones

| Opcion | Default | Descripcion |
|--------|---------|-------------|
| `port` | 3000 | Puerto HTTP. Usar `0` para puerto aleatorio. |
| `host` | `'127.0.0.1'` | Host de bind. Usar `'0.0.0.0'` para aceptar conexiones externas. |
| `corsOrigin` | `undefined` | Origenes CORS permitidos. Sin valor = sin headers CORS. |
| `heartbeatInterval` | 30000 | Intervalo de heartbeat SSE en ms. |
| `requestTimeout` | 30000 | Timeout para requests HTTP en ms. |
| `maxBodySize` | 65536 | Tamano maximo del body en bytes (proteccion contra memory exhaustion). |

---

## Endpoints

### POST /rpc

Recibe JSON-RPC 2.0 requests y retorna la respuesta del McpServer.

```bash
curl -X POST http://localhost:3001/rpc \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
```

**Response:**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2024-11-05",
    "capabilities": { "tools": {} },
    "serverInfo": { "name": "agent-shell", "version": "0.1.0" }
  }
}
```

**Codigos HTTP:**

| Status | Cuando |
|--------|--------|
| 200 | Request procesado correctamente |
| 204 | Notification (request sin `id`) |
| 400 | JSON invalido o estructura JSON-RPC incorrecta |
| 405 | Metodo HTTP incorrecto (solo POST) |
| 413 | Body excede `maxBodySize` |
| 500 | Error interno (handler throw o no registrado) |
| 504 | Request timeout |

### GET /sse

Establece una conexion Server-Sent Events para recibir notificaciones del servidor.

```bash
curl -N http://localhost:3001/sse
```

**Eventos:**

| Evento | Cuando | Data |
|--------|--------|------|
| `connected` | Al conectarse | `{"sessionId": "uuid"}` |
| `heartbeat` | Cada N segundos | `{"time": 1706140800000}` |
| `message` | Notificacion del servidor | `JsonRpcNotification` |

**Ejemplo de stream:**

```
event: connected
data: {"sessionId":"a1b2c3d4-e5f6-7890-abcd-ef1234567890"}

event: heartbeat
data: {"time":1706140800000}

event: message
data: {"jsonrpc":"2.0","method":"progress","params":{"status":"indexing"}}
```

### GET /health

Retorna estado del servidor.

```bash
curl http://localhost:3001/health
```

```json
{
  "status": "ok",
  "uptime": 3600,
  "connectedClients": 2,
  "transport": "http-sse"
}
```

---

## API

### `HttpSseTransport`

```typescript
const transport = new HttpSseTransport(config?: HttpTransportConfig);
```

**Metodos:**

| Metodo | Descripcion |
|--------|-------------|
| `onMessage(handler)` | Registra el handler de mensajes JSON-RPC |
| `start(): Promise<void>` | Inicia el servidor HTTP |
| `stop(): Promise<void>` | Detiene el servidor, cierra todas las conexiones SSE |
| `notify(method, params?)` | Envia notificacion a todos los clientes SSE |

**Propiedades:**

| Propiedad | Tipo | Descripcion |
|-----------|------|-------------|
| `port` | `number` | Puerto actual (util con port=0) |
| `connectedClients` | `number` | Clientes SSE conectados |

---

## Ejemplos

### Flujo completo con MCP

```typescript
import { Core, CommandRegistry, McpServer, HttpSseTransport } from 'agent-shell';

// Setup
const registry = new CommandRegistry();
registry.register(
  { namespace: 'users', name: 'list', description: 'List all users', params: [] },
  async () => [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }]
);

const core = new Core({ registry });
const mcp = new McpServer({ core });
const transport = new HttpSseTransport({
  port: 3001,
  corsOrigin: 'http://localhost:5173',
});

transport.onMessage((req) => mcp.handleMessage(req));
await transport.start();
```

### Consumo desde Frontend (fetch + EventSource)

```typescript
// Conectar SSE para notificaciones
const sse = new EventSource('http://localhost:3001/sse');
sse.addEventListener('connected', (e) => {
  console.log('Connected:', JSON.parse(e.data).sessionId);
});
sse.addEventListener('message', (e) => {
  console.log('Notification:', JSON.parse(e.data));
});

// Ejecutar comando via RPC
async function execCommand(command: string) {
  const res = await fetch('http://localhost:3001/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: 'cli_exec', arguments: { command } },
    }),
  });
  return res.json();
}

// Uso
const result = await execCommand('search create user');
console.log(result);
```

### Consumo desde Node.js (http module)

```typescript
import { request } from 'node:http';

function rpc(port: number, method: string, params?: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const req = request(
      { hostname: '127.0.0.1', port, path: '/rpc', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => resolve(JSON.parse(data)));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

// Inicializar
await rpc(3001, 'initialize');

// Listar tools
const tools = await rpc(3001, 'tools/list');

// Ejecutar
const result = await rpc(3001, 'tools/call', {
  name: 'cli_exec',
  arguments: { command: 'users:list | [.id, .name]' },
});
```

### Notificaciones server-push

```typescript
// Enviar notificacion a todos los clientes SSE conectados
transport.notify('commands/updated', { added: ['users:delete'] });
transport.notify('session/expired', { sessionId: 'abc-123' });
```

### Puerto aleatorio (testing)

```typescript
const transport = new HttpSseTransport({ port: 0 });
transport.onMessage(handler);
await transport.start();
console.log(`Random port: ${transport.port}`);
```

### Graceful shutdown

```typescript
process.on('SIGINT', async () => {
  await transport.stop(); // Cierra servidor + conexiones SSE
  process.exit(0);
});
```

---

## CORS

Por defecto, no se envian headers CORS. Para habilitarlo:

```typescript
// Un solo origen
new HttpSseTransport({ corsOrigin: 'http://localhost:5173' });

// Multiples origenes
new HttpSseTransport({ corsOrigin: ['http://localhost:5173', 'https://app.example.com'] });
```

Headers enviados cuando CORS esta habilitado:

```
Access-Control-Allow-Origin: <origin>
Access-Control-Allow-Methods: POST, GET, OPTIONS
Access-Control-Allow-Headers: Content-Type, X-Session-Id
Access-Control-Max-Age: 86400
```

Con array de origenes, solo se envian headers si el `Origin` del request coincide con alguno de la lista.

---

## Seguridad

| Aspecto | Comportamiento |
|---------|---------------|
| Bind default | `127.0.0.1` (solo localhost) |
| CORS | Deshabilitado por defecto |
| Body size | Limitado a 64KB (configurable) |
| Request timeout | 30s (configurable) |
| Autenticacion | No incluida (usar reverse proxy o middleware externo) |

**Recomendaciones para produccion:**

1. Usar reverse proxy (nginx, Caddy) para TLS y autenticacion
2. Configurar `corsOrigin` con los origenes exactos necesarios
3. No exponer `host: '0.0.0.0'` directamente a internet sin proxy
4. Considerar rate limiting a nivel de proxy

---

## CLI

El CLI soporta el transporte HTTP via flags:

```bash
agent-shell serve --transport http --port 3001 --host 0.0.0.0 --cors-origin http://localhost:5173
```

| Flag | Default | Descripcion |
|------|---------|-------------|
| `--transport` | `stdio` | `stdio` o `http` |
| `--port` | `3000` | Puerto HTTP |
| `--host` | `127.0.0.1` | Host de bind |
| `--cors-origin` | (ninguno) | Origen CORS |

> Nota: El CLI requiere un registry configurado programaticamente. Ver el mensaje de ayuda para un ejemplo de uso via API.

---

## Diferencias con StdioTransport

| Aspecto | StdioTransport | HttpSseTransport |
|---------|---------------|-----------------|
| Protocolo | JSON-RPC sobre stdin/stdout | JSON-RPC sobre HTTP POST |
| Notificaciones | stdout | Server-Sent Events |
| Conexion | 1 proceso = 1 cliente | N clientes simultaneos |
| Uso tipico | MCP clients, IDEs | Web, servicios, multi-agente |
| Dependencias | Ninguna | `node:http`, `node:crypto` |
| Descubrimiento | Via MCP client | Via URL conocida |

Ambos implementan la misma interfaz `MessageHandler` y son intercambiables sin modificar el McpServer.

---

## Dependencias

Zero dependencias externas. Solo usa modulos nativos de Node.js:

- `node:http` - Servidor HTTP
- `node:crypto` - Generacion de session IDs (`randomUUID`)
