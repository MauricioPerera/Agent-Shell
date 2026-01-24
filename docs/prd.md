# Agent Shell - PRD (Product Requirements Document)

## Resumen Ejecutivo

Agent Shell es un framework para construir CLIs **AI-first** y **auto-declarativas** que actuan como gateway controlable entre agentes LLM y la ejecucion de comandos. Resuelve el problema de escalabilidad de herramientas en agentes AI mediante un patron de 2 tools + discovery vectorial.

---

## Problema

En el ecosistema actual de agentes AI (MCP, function calling):

- Cada tool definition consume tokens en **cada** llamada a la API del LLM
- N tools x ~300 tokens = crecimiento lineal del contexto consumido
- Modelos con ventana de contexto limitada se saturan rapidamente
- A mayor cantidad de tools, peor precision en la seleccion del modelo
- No existe mecanismo nativo de simulacion/dry-run en tools MCP

---

## Solucion

Una CLI disenada para consumo de LLM que expone solo **2 tools** al agente:

```
Tool 1: cli_help()           -> Protocolo de interaccion (como usar la CLI)
Tool 2: cli_exec(cmd: str)   -> Ejecutar cualquier comando
```

**~600 tokens constantes** en contexto, independiente de la cantidad de comandos disponibles.

---

## Conceptos Core

### 1. Help como Protocolo (no como catalogo)

`help` no lista comandos. Describe **como interactuar** con la CLI:

- Como buscar comandos (search vectorial)
- Como ejecutar comandos
- Modos de ejecucion (dry-run, validate, confirm)
- Filtrado de output (jq)
- Paginacion, composicion, batch
- Codigos de error

### 2. Discovery Vectorial

Un comando `search` que realiza busqueda semantica sobre el indice de todos los comandos disponibles. El LLM describe su intencion en lenguaje natural y recibe los comandos mas relevantes.

### 3. CLI como Gateway Controlable

La CLI actua como capa intermedia entre la intencion del agente y la ejecucion real, permitiendo:

- Simulacion sin consecuencias (--dry-run)
- Validacion de sintaxis y permisos (--validate)
- Preview antes de ejecutar (--confirm)
- Logging, rate limiting, politicas de seguridad
- Testing del agente en modo simulacion completo

### 4. Security como Gateway Centralizado

La CLI actua como unico punto de seguridad:

- **Audit logging**: Eventos tipados para cada accion (ejecucion, denegacion, confirmacion, errores)
- **RBAC**: Roles con herencia que agrupan permisos (ej. `admin` hereda de `viewer`)
- **Rate limiting**: Ventana deslizante configurable por sesion
- **Secret detection**: Deteccion de credenciales en contexto e historial con masking automatico
- **Encryption at-rest**: Adapter decorator AES-256-GCM para datos de sesion
- **Token lifecycle**: TTL para tokens de confirmacion con revocacion explicita
- **Session expiry**: TTL por sesion con cleanup automatico

### 5. Formato de Definicion de Comandos (AI-optimizado)

Formato compacto (~3x menos tokens que JSON Schema) disenado para consumo de LLM:

```
namespace:comando | Descripcion concisa en una linea
  --arg1: tipo (restricciones) [REQUIRED]
  --arg2: tipo = default (restricciones)
  -> output: tipo | descripcion del retorno
  Ejemplo: namespace:comando --arg1 valor | .campo_esperado
```

---

## Especificacion del Protocolo de Interaccion (Help)

```
CLI Interface Protocol:

  Descubrimiento:
    search <query>                   Busqueda semantica de comandos
    describe <comando>               Detalle y firma de un comando

  Ejecucion:
    <comando> [--args]               Ejecutar comando
    --dry-run                        Simular sin ejecutar
    --validate                       Solo validar sintaxis/permisos
    --confirm                        Preview antes de ejecutar

  Filtrado de output:
    | .campo                         Extraer campo (sintaxis jq)
    | [.campo1, .campo2]             Extraer multiples campos

  Paginacion:
    --limit N                        Maximo N resultados
    --offset N                       Saltar primeros N

  Composicion:
    cmd1 >> cmd2                     Output de cmd1 como input de cmd2

  Batch:
    batch [cmd1, cmd2, cmd3]         Ejecutar multiples en una llamada

  Estado:
    context                          Ver contexto/sesion actual
    context:set <key> <value>        Persistir valor entre llamadas

  Historial:
    history                          Ultimos comandos ejecutados
    undo <id>                        Revertir un comando (si reversible)

  Output:
    --format json|table|csv          Formato de respuesta

  Errores:
    Codigo 0 = exito
    Codigo 1 = error de sintaxis
    Codigo 2 = no encontrado
    Codigo 3 = sin permisos
    Codigo 4 = requiere confirmacion
```

---

## Especificacion del Formato de Comandos

### Estructura

```
namespace:comando | Descripcion concisa
  --param: tipo (restricciones) [REQUIRED]
  --param: tipo = default (restricciones)
  -> output: tipo<shape>
  Ejemplo: uso real con filtro jq
```

### Tipos soportados

| Tipo | Descripcion |
|------|-------------|
| `int` | Entero |
| `float` | Decimal |
| `string` | Cadena de texto |
| `bool` | true/false |
| `date` | Fecha ISO 8601 |
| `json` | Objeto JSON arbitrario |
| `enum(a,b,c)` | Valor de lista cerrada |
| `array<tipo>` | Lista tipada |

### Restricciones inline

```
(>0)                   Numerico mayor a 0
(min:2, max:100)       Longitud de string
(email)                Formato email
(multiple)             Acepta multiples valores
(1-100)                Rango numerico
```

### Output shape

```
-> output: {id, nombre, email}                   Objeto con campos
-> output: array<{id, nombre}>                   Lista de objetos
-> output: string                                Valor simple
-> output: {status, data: array<{id, nombre}>}   Anidado
```

---

## Flujo de Interaccion Tipico

```
1. Agente recibe tarea del usuario
2. cli_help() -> aprende el protocolo
3. cli_exec("search <intencion>") -> descubre comandos relevantes
4. cli_exec("<comando> --dry-run") -> simula ejecucion
5. cli_exec("<comando> | .campo") -> ejecuta y filtra resultado
6. Agente responde al usuario con el dato obtenido
```

---

## Arquitectura de Alto Nivel

```
+------------------+      +------------------+
|   Agente LLM     |      |  Agente Remoto   |
|  (local/stdio)   |      |  (HTTP client)   |
+--------+---------+      +--------+---------+
         |                          |
    cli_help() / cli_exec()    POST /rpc + GET /sse
         |                          |
+--------v---------+    +-----------v--------+
| StdioTransport   |    | HttpSseTransport   |
| (JSON-RPC stdio) |    | (JSON-RPC HTTP+SSE)|
+--------+---------+    +-----------+--------+
         |                          |
         +----------+  +------------+
                    |  |
             +------v--v-------+
             |   McpServer     |
             |   (Gateway)     |
             |                 |
             |  - Parser       |
             |  - Router       |
             |  - Executor     |
             |  - Security     |
             |  - JQ Filter    |
             |  - Modes        |
             +--------+--------+
                      |
                 +----+----+
                 |         |
           +-----v-+ +----v-------+
           | Vector | | Command    |
           | Index  | | Registry   |
           | (DB)   | | (handlers) |
           +--------+ +------------+
```

### Transportes Soportados

| Transporte | Protocolo | Uso principal |
|-----------|-----------|---------------|
| **StdioTransport** | JSON-RPC 2.0 sobre stdin/stdout | Integracion local (MCP clients, IDEs) |
| **HttpSseTransport** | JSON-RPC 2.0 sobre HTTP + SSE | Integracion remota (web, servicios, multi-agente) |

---

## Componentes del Sistema

### 1. Parser
Interpreta el string del comando: namespace, comando, argumentos, flags, filtros jq, pipes.

### 2. Vector Index
Base de datos vectorial con embeddings de las descripciones de comandos. Recibe queries en lenguaje natural y retorna comandos relevantes por similaridad semantica.

### 3. Command Registry
Registro de todos los comandos disponibles con sus definiciones, handlers y metadata.

### 4. Executor
Motor de ejecucion que soporta los modos (normal, dry-run, validate, confirm) y aplica politicas de seguridad.

### 5. JQ Filter
Procesador de filtros sobre el output JSON para extraer campos especificos.

### 6. Context Store
Almacen de estado de sesion para persistir valores entre llamadas. Soporta TTL de sesion, deteccion de secretos, politicas de retencion y encriptacion at-rest via adapter decorator.

### 7. Security
Modulo transversal que provee audit logging (EventEmitter tipado), RBAC con herencia de roles, deteccion y masking de secretos, y encriptacion de storage (AES-256-GCM).

### 8. Transport Layer (Pluggable)
Capa de transporte intercambiable que abstrae la comunicacion entre agentes y el McpServer:
- **StdioTransport**: JSON-RPC 2.0 sobre stdin/stdout (integracion local, MCP clients)
- **HttpSseTransport**: JSON-RPC 2.0 sobre HTTP POST + Server-Sent Events (integracion remota, web, multi-agente)

Ambos transportes implementan la misma interfaz `MessageHandler`, permitiendo que el McpServer sea agnostico al medio de comunicacion.

---

## Ventajas sobre MCP Directo

| Aspecto | MCP (N tools) | Agent Shell (2 tools) |
|---------|---------------|----------------------|
| Tokens en contexto | O(n) | O(1) constante |
| Discovery | Listado completo | Semantico por intencion |
| Escalabilidad | Limitada por contexto | Ilimitada |
| Simulacion | Por tool (custom) | Global (--dry-run) |
| Seguridad | Por tool (custom) | Gateway centralizado |
| Testing agente | Complejo | Modo simulacion global |
| Precision LLM | Degrada con N tools | Constante (2 tools) |

---

## Casos de Uso Target

1. **Agentes con muchas capacidades**: CRMs, ERPs, plataformas con 100+ operaciones
2. **Agentes multi-dominio**: Un agente que opera sobre multiples sistemas
3. **Entornos con contexto limitado**: Modelos pequenos o con ventana reducida
4. **Operaciones sensibles**: Donde dry-run y confirmacion son criticos
5. **Testing de agentes**: Validar comportamiento sin ejecucion real
6. **Integracion remota via HTTP/SSE**: Agentes o frontends que consumen Agent Shell como servicio HTTP, recibiendo notificaciones en tiempo real via SSE
7. **Arquitecturas multi-agente**: Multiples agentes conectados a una misma instancia de Agent Shell via HTTP, cada uno con su sesion independiente

---

## No-Goals (Fuera de Alcance)

- No reemplaza MCP para casos simples (<10 tools)
- No es un shell de proposito general
- No ejecuta comandos del sistema operativo directamente
- No incluye un LLM embebido

---

## Artefactos Derivados

A partir de este PRD se generaran:

1. **Contratos de especificacion** por modulo (parser, executor, vector index, etc.)
2. **Schemas de base de datos** para el command registry y vector index
3. **API specs** si se expone como servicio
4. **Test suites** por contrato
5. **Diagramas de arquitectura** detallados

---

## Stack Tecnologico

- **Runtime**: Bun
- **Lenguaje**: TypeScript (ES2022, ESM, strict mode)
- **Testing**: Vitest (248 tests)
- **Build**: tsup
- **Vector DB**: Agnostico via adapter (en memoria, SQLite, pgvector, Qdrant)
- **Embeddings**: Agnostico via adapter (Ollama, Cloudflare Workers AI, OpenAI, Cohere)
- **Output parsing**: Subset de jq (campos, arrays, multi-select)
- **Dependencias externas**: Cero (core standalone)
- **Encriptacion**: AES-256-GCM (Node.js crypto nativo)
