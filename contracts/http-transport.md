# Contrato: HTTP/SSE Transport Adapter

> **Version**: 1.0
> **Fecha**: 2026-01-24
> **Estado**: Draft
> **Modulo**: mcp/http-transport
> **Dependencias**: mcp/types, mcp/server (McpServer), node:http

## Resumen Ejecutivo

El HttpSseTransport es un adapter de transporte alternativo a StdioTransport que expone el McpServer de Agent Shell como servicio HTTP. Recibe JSON-RPC requests via HTTP POST y entrega respuestas/notificaciones via Server-Sent Events (SSE). Implementa la misma interfaz `MessageHandler` que StdioTransport, haciendo al McpServer completamente agnostico al medio de comunicacion.

---

## 1. Que debe hacer (MUST DO)

### 1.1 Objetivo Principal

Permitir que agentes LLM remotos, frontends web, y arquitecturas multi-agente consuman Agent Shell sin necesidad de un proceso local, via protocolo HTTP estandar con streaming SSE para notificaciones en tiempo real.

### 1.2 Responsabilidades

- [ ] Exponer endpoint POST `/rpc` para recibir JSON-RPC 2.0 requests
- [ ] Exponer endpoint GET `/sse` para stream de Server-Sent Events
- [ ] Exponer endpoint GET `/health` para health checks
- [ ] Implementar la interfaz `MessageHandler` (compatible con McpServer.handleMessage)
- [ ] Gestionar sesiones de clientes SSE conectados
- [ ] Aplicar CORS configurable
- [ ] Usar exclusivamente `node:http` (zero dependencias externas)
- [ ] Soportar multiples clientes SSE simultaneos
- [ ] Enviar heartbeat periodico para mantener conexiones SSE vivas
- [ ] Parsear y validar requests JSON-RPC antes de delegarlos al handler

### 1.3 Interfaz Publica

#### Constructor

```typescript
interface HttpTransportConfig {
  /** Puerto del servidor HTTP. Default: 3000 */
  port?: number;
  /** Host de bind. Default: '127.0.0.1' */
  host?: string;
  /** Origenes CORS permitidos. Default: ninguno (sin CORS headers) */
  corsOrigin?: string | string[];
  /** Intervalo de heartbeat SSE en ms. Default: 30000 */
  heartbeatInterval?: number;
  /** Timeout de request en ms. Default: 30000 */
  requestTimeout?: number;
  /** Tamano maximo del body en bytes. Default: 65536 (64KB) */
  maxBodySize?: number;
}
```

#### Clase HttpSseTransport

```typescript
class HttpSseTransport {
  constructor(config?: HttpTransportConfig);

  /** Registra el handler de mensajes (misma interfaz que StdioTransport). */
  onMessage(handler: MessageHandler): void;

  /** Inicia el servidor HTTP. Retorna Promise que resuelve cuando esta escuchando. */
  start(): Promise<void>;

  /** Detiene el servidor HTTP. Cierra todas las conexiones SSE. */
  stop(): Promise<void>;

  /** Envia una notificacion a todos los clientes SSE conectados. */
  notify(method: string, params?: Record<string, any>): void;

  /** Numero de clientes SSE actualmente conectados. */
  get connectedClients(): number;

  /** Puerto actual del servidor (util si port=0 para puerto aleatorio). */
  get port(): number;
}
```

### 1.4 Endpoints

#### POST /rpc

```
Request:
  Content-Type: application/json
  Body: JsonRpcRequest (ver mcp/types.ts)

Response:
  Content-Type: application/json
  Body: JsonRpcResponse

Errores HTTP:
  400 - Body invalido o JSON malformado
  405 - Metodo HTTP no permitido (solo POST)
  413 - Body excede maxBodySize
  500 - Error interno del servidor
```

Flujo:
1. Leer body completo
2. Verificar Content-Type es `application/json`
3. Parsear JSON
4. Validar estructura JSON-RPC 2.0 (jsonrpc, method requeridos)
5. Delegar al MessageHandler
6. Retornar JsonRpcResponse con status 200

#### GET /sse

```
Request:
  Accept: text/event-stream (opcional, se asume)

Response:
  Content-Type: text/event-stream
  Cache-Control: no-cache
  Connection: keep-alive

Eventos SSE:
  event: message
  data: {"jsonrpc":"2.0","method":"notification/...","params":{...}}

  event: heartbeat
  data: {"time": 1706140800000}
```

Flujo:
1. Registrar cliente en la lista de conexiones SSE activas
2. Enviar evento inicial `connected` con id de sesion
3. Mantener conexion abierta
4. Enviar heartbeat cada `heartbeatInterval` ms
5. Al cerrar conexion, remover cliente de la lista

#### GET /health

```
Response:
  Content-Type: application/json
  Body: {
    "status": "ok",
    "uptime": number,
    "connectedClients": number,
    "transport": "http-sse"
  }
```

### 1.5 Formato de Respuesta SSE

Cada evento SSE sigue el formato estandar:

```
event: <tipo>\n
data: <json>\n
\n
```

Tipos de evento:
- `connected`: Enviado al conectarse. Data: `{"sessionId": string}`
- `message`: Notificacion JSON-RPC del servidor. Data: `JsonRpcNotification`
- `heartbeat`: Keepalive periodico. Data: `{"time": number}`
- `error`: Error en la conexion. Data: `{"code": number, "message": string}`

### 1.6 Session Management

- Cada conexion SSE recibe un `sessionId` unico (UUID v4 generado con `crypto.randomUUID()`)
- El sessionId se incluye en el evento `connected` inicial
- Los clientes PUEDEN enviar header `X-Session-Id` en requests POST `/rpc` para asociar requests a una sesion SSE
- Si no se envia `X-Session-Id`, el request se procesa sin asociacion a sesion

### 1.7 CORS

Cuando `corsOrigin` esta configurado:

```
Access-Control-Allow-Origin: <origin configurado>
Access-Control-Allow-Methods: POST, GET, OPTIONS
Access-Control-Allow-Headers: Content-Type, X-Session-Id
Access-Control-Max-Age: 86400
```

- Si `corsOrigin` es un array, verificar el origin del request contra la lista
- Responder a OPTIONS con 204 y headers CORS (preflight)

---

## 2. Que NO debe hacer (MUST NOT)

- [ ] NO debe depender de librerias externas (solo `node:http` y `node:crypto`)
- [ ] NO debe almacenar estado de aplicacion (es un transporte puro)
- [ ] NO debe modificar los mensajes JSON-RPC (solo parsear y delegar)
- [ ] NO debe implementar autenticacion (eso es responsabilidad de middleware externo)
- [ ] NO debe buffear mensajes SSE (envio inmediato)
- [ ] NO debe aceptar WebSocket upgrades (scope es HTTP+SSE unicamente)
- [ ] NO debe loggear a stdout/stderr (conflicto con StdioTransport)
- [ ] NO debe crash-ar el proceso por errores de conexion individuales

---

## 3. Limites y Restricciones

### 3.1 Tamano de Input

| Parametro | Valor | Configurable |
|-----------|-------|:---:|
| Max body size | 64 KB | Si (`maxBodySize`) |
| Max concurrent SSE clients | 100 | Si (futuro) |
| Heartbeat interval | 30s | Si (`heartbeatInterval`) |
| Request timeout | 30s | Si (`requestTimeout`) |

### 3.2 Seguridad

- Bind por defecto a `127.0.0.1` (solo localhost)
- CORS deshabilitado por defecto (sin headers)
- Content-Type validation obligatoria en POST
- Body size limit para prevenir memory exhaustion
- Request timeout para prevenir connection hogging

### 3.3 Performance

- Una instancia de `node:http.Server` por transport
- Event-driven (no blocking)
- SSE clients gestionados con Set (O(1) add/remove)
- Sin buffering de mensajes SSE

---

## 4. Interfaz con otros modulos

### 4.1 Dependencias Directas

| Modulo | Uso | Acoplamiento |
|--------|-----|:---:|
| `mcp/types` | Tipos JSON-RPC y MCP | Tipos only |
| `node:http` | Servidor HTTP | API nativa |
| `node:crypto` | Generacion de sessionId (randomUUID) | API nativa |

### 4.2 Consumidores

| Consumidor | Mecanismo |
|-----------|-----------|
| McpServer | Via `onMessage()` (misma interfaz que StdioTransport) |
| CLI | Instanciado por subcomando `serve --transport http` |

### 4.3 Compatibilidad con McpServer

El `McpServer` actualmente instancia `StdioTransport` en su constructor. Para soportar transportes pluggables:

**Opcion elegida**: El McpServer expone `handleMessage()` como metodo publico (ya existe). El HttpSseTransport lo llama directamente sin modificar McpServer.

```typescript
// Uso:
const transport = new HttpSseTransport({ port: 3001 });
transport.onMessage((req) => mcpServer.handleMessage(req));
await transport.start();
```

Esto no requiere modificaciones al McpServer existente.

---

## 5. Definicion de Tipos (TypeScript)

```typescript
import type { JsonRpcRequest, JsonRpcResponse, JsonRpcNotification } from './types.js';
import type { MessageHandler } from './transport.js';

export interface HttpTransportConfig {
  port?: number;
  host?: string;
  corsOrigin?: string | string[];
  heartbeatInterval?: number;
  requestTimeout?: number;
  maxBodySize?: number;
}

export interface SseClient {
  id: string;
  response: import('node:http').ServerResponse;
  connectedAt: number;
}

export interface HealthResponse {
  status: 'ok';
  uptime: number;
  connectedClients: number;
  transport: 'http-sse';
}
```

---

## 6. Criterios de Aceptacion

### 6.1 Funcionales

- [ ] `POST /rpc` recibe un JSON-RPC request y retorna la respuesta del McpServer
- [ ] `POST /rpc` retorna 400 si el body no es JSON valido
- [ ] `POST /rpc` retorna 400 si falta `jsonrpc` o `method`
- [ ] `POST /rpc` retorna 413 si el body excede `maxBodySize`
- [ ] `POST /rpc` aplica timeout configurable
- [ ] `GET /sse` establece conexion SSE con headers correctos
- [ ] `GET /sse` envia evento `connected` con sessionId al conectarse
- [ ] `GET /sse` envia heartbeat cada `heartbeatInterval` ms
- [ ] `GET /sse` cierra limpiamente al desconectar el cliente
- [ ] `GET /health` retorna status, uptime y clients count
- [ ] `notify()` envia evento a todos los clientes SSE conectados
- [ ] CORS headers se agregan cuando `corsOrigin` esta configurado
- [ ] OPTIONS preflight retorna 204 con headers CORS
- [ ] `start()` resuelve cuando el servidor esta escuchando
- [ ] `stop()` cierra servidor y todas las conexiones SSE
- [ ] Multiples clientes SSE pueden conectarse simultaneamente
- [ ] Errores de un cliente no afectan a otros clientes

### 6.2 No-Funcionales

- [ ] Zero dependencias externas (solo node:http, node:crypto)
- [ ] Compatible con Node.js >= 18 y Bun
- [ ] Misma interfaz `MessageHandler` que StdioTransport
- [ ] Resistente a desconexiones abruptas de clientes
- [ ] No memory leaks en conexiones SSE de larga duracion
- [ ] Heartbeat previene timeout de proxies/load balancers intermedios

---

## 7. Ejemplos de Uso

### 7.1 Uso Standalone (sin McpServer)

```typescript
import { HttpSseTransport } from 'agent-shell';

const transport = new HttpSseTransport({ port: 3001 });
transport.onMessage(async (req) => {
  // Custom handler
  return { jsonrpc: '2.0', id: req.id!, result: { echo: req.method } };
});
await transport.start();
```

### 7.2 Uso con McpServer

```typescript
import { McpServer, HttpSseTransport } from 'agent-shell';
import { Core } from 'agent-shell';

const core = new Core({ /* ... */ });
const mcpServer = new McpServer({ core });

const transport = new HttpSseTransport({
  port: 3001,
  host: '0.0.0.0',
  corsOrigin: 'http://localhost:5173',
});
transport.onMessage((req) => mcpServer.handleMessage(req));
await transport.start();

console.log(`Agent Shell HTTP/SSE listening on port ${transport.port}`);
```

### 7.3 Consumo desde Cliente (curl)

```bash
# JSON-RPC request
curl -X POST http://localhost:3001/rpc \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'

# SSE stream
curl -N http://localhost:3001/sse

# Health check
curl http://localhost:3001/health
```

### 7.4 Consumo desde Frontend (fetch + EventSource)

```typescript
// RPC call
const response = await fetch('http://localhost:3001/rpc', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'cli_exec', arguments: { command: 'search users' } }
  })
});
const result = await response.json();

// SSE notifications
const source = new EventSource('http://localhost:3001/sse');
source.addEventListener('message', (e) => {
  const notification = JSON.parse(e.data);
  console.log('Notification:', notification);
});
```

---

## 8. Flujo de Interaccion

```
Cliente HTTP                    HttpSseTransport              McpServer
     |                               |                          |
     |--- GET /sse ------------------>|                          |
     |<-- event: connected -----------|                          |
     |<-- event: heartbeat -----------|  (cada 30s)              |
     |                               |                          |
     |--- POST /rpc (initialize) ---->|                          |
     |                               |--- handleMessage() ----->|
     |                               |<-- JsonRpcResponse ------|
     |<-- 200 JSON-RPC response ------|                          |
     |                               |                          |
     |--- POST /rpc (tools/call) ---->|                          |
     |                               |--- handleMessage() ----->|
     |                               |<-- JsonRpcResponse ------|
     |<-- 200 JSON-RPC response ------|                          |
     |                               |                          |
     |                               |<-- notify() -------------|
     |<-- event: message -------------|                          |
     |                               |                          |
     |--- close SSE ----------------->|                          |
     |                               | (remove client)          |
```

---

## 9. Consideraciones de Implementacion

### 9.1 Estructura de Archivos

```
src/mcp/
  http-transport.ts     <- Implementacion principal
  types.ts              <- Agregar HttpTransportConfig, SseClient, HealthResponse
  index.ts              <- Agregar export de HttpSseTransport
```

### 9.2 Body Parsing

Leer el body completo antes de parsear (no streaming de request body):

```typescript
// Pseudocodigo
const chunks: Buffer[] = [];
req.on('data', (chunk) => {
  if (totalSize > maxBodySize) { res.writeHead(413); res.end(); return; }
  chunks.push(chunk);
});
req.on('end', () => {
  const body = Buffer.concat(chunks).toString('utf-8');
  // parse and handle...
});
```

### 9.3 SSE Keep-Alive

```typescript
// Headers SSE
res.writeHead(200, {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
});

// Enviar evento
function sendEvent(res: ServerResponse, event: string, data: any): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
```

### 9.4 Graceful Shutdown

```typescript
async stop(): Promise<void> {
  // 1. Cerrar todas las conexiones SSE
  for (const client of this.clients) {
    client.response.end();
  }
  this.clients.clear();

  // 2. Cerrar heartbeat interval
  clearInterval(this.heartbeatTimer);

  // 3. Cerrar servidor HTTP
  await new Promise<void>((resolve) => this.server.close(() => resolve()));
}
```

---

## 10. Edge Cases y Error Handling

| Escenario | Comportamiento esperado |
|-----------|------------------------|
| Body no es JSON | 400 + `{"error": "Invalid JSON"}` |
| Body excede maxBodySize | 413 + connection close |
| JSON-RPC invalido (falta method) | 400 + JSON-RPC error response |
| Handler throws | 500 + JSON-RPC internal error |
| Handler timeout | 504 + JSON-RPC timeout error |
| SSE client desconecta abruptamente | Remove de clients Set, no crash |
| POST a ruta inexistente | 404 |
| Metodo HTTP no soportado | 405 |
| Servidor ya iniciado (double start) | No-op o error |
| `stop()` sin `start()` previo | No-op |
| Port en uso | Reject de `start()` con error descriptivo |

---

## 11. Relacion con el Ecosistema

### 11.1 MCP Spec Compliance

El adapter mantiene compatibilidad con la especificacion MCP:
- Los mensajes JSON-RPC son identicos a los de StdioTransport
- El flujo initialize -> tools/list -> tools/call es el mismo
- Solo cambia el medio de transporte (HTTP en vez de stdio)

### 11.2 Alternativas Consideradas

| Alternativa | Razon de descarte |
|------------|-------------------|
| WebSocket | Mas complejo, requiere upgrade HTTP, no necesario para JSON-RPC request/response |
| HTTP Long Polling | Ineficiente comparado con SSE, mas latencia |
| gRPC | Requiere dependencia externa (protobuf), over-engineered |
| Raw TCP | No HTTP-compatible, problemas con proxies/firewalls |

Se eligio HTTP + SSE porque:
1. HTTP POST cubre el patron request/response de JSON-RPC
2. SSE cubre notificaciones servidor->cliente
3. Ambos son estandares web soportados nativamente en browsers
4. Zero dependencias externas
5. Compatible con proxies, load balancers, y CDNs
