# Contrato: CONTEXT_STORE

> **Version**: 1.1
> **Fecha**: 2026-01-23
> **Estado**: Draft
> **Autor**: Spec Architect (AI-assisted)
> **Proyecto**: Agent Shell
> **Modulo**: Context Store (Componente #6 del sistema)

## Resumen Ejecutivo

El Context Store es el componente de Agent Shell responsable de mantener estado de sesion entre llamadas del agente LLM. Permite persistir valores clave-valor, almacenar historial de comandos ejecutados y soportar operaciones de undo para comandos reversibles. Es agnostico al backend de almacenamiento mediante un patron adaptador. Soporta expiracion de sesiones (TTL), deteccion de secretos en valores, politicas de retencion de historial y encriptacion at-rest via decorator.

---

## 1. Que debe hacer (MUST DO)

### 1.1 Objetivo Principal

Proveer un almacen de estado de sesion que permita al agente LLM persistir y recuperar informacion entre multiples invocaciones de `cli_exec()`, manteniendo coherencia contextual sin depender de la memoria del modelo.

### 1.2 Funcionalidades Requeridas

- [ ] **Gestion de contexto clave-valor**
  - Almacenar pares clave-valor arbitrarios en la sesion activa
  - Recuperar valores individuales por clave
  - Listar todo el contexto actual de la sesion
  - Eliminar claves individuales
  - Limpiar todo el contexto de sesion

- [ ] **Historial de comandos**
  - Registrar cada comando ejecutado con su resultado
  - Consultar los ultimos N comandos ejecutados
  - Almacenar metadata del comando (timestamp, duracion, codigo de salida)
  - Persistir estado previo para comandos marcados como reversibles

- [ ] **Mecanismo de undo**
  - Almacenar snapshot del estado previo antes de ejecutar comandos reversibles
  - Revertir al estado anterior de un comando especifico por ID
  - Validar que un comando es reversible antes de intentar undo
  - Mantener cadena de undo (multiples niveles)

- [ ] **Abstraccion de storage**
  - Interface de adaptador para multiples backends
  - Implementacion en memoria (default, para desarrollo/testing)
  - Implementacion en disco (persistencia entre reinicios)
  - Implementacion en Redis (para sesiones distribuidas)
  - Intercambio de backend sin cambios en la logica de negocio

- [ ] **Expiracion de sesiones (TTL)**
  - Configuracion de `ttl_ms` para tiempo maximo de vida de sesion
  - Verificacion de expiracion en cada operacion
  - Callback `onExpired` invocado cuando una sesion expira
  - Cleanup automatico de sesiones expiradas

- [ ] **Deteccion de secretos**
  - Configuracion de `secretDetection` con modo `warn` o `reject`
  - Verificar valores en `set()` contra patrones de credenciales
  - Modo `warn`: Permite el set pero agrega warning al resultado
  - Modo `reject`: Bloquea el set y retorna error
  - Masking automatico en `recordCommand()` para args y resultados

- [ ] **Politicas de retencion de historial**
  - Configuracion de `retentionPolicy` con `maxAge_ms` y/o `maxEntries`
  - Aplicacion automatica en `recordCommand()` despues de agregar nueva entrada
  - Eliminacion por antiguedad: entries mas viejas que `maxAge_ms`
  - Eliminacion por cantidad: solo mantener las `maxEntries` mas recientes

- [ ] **Encriptacion at-rest (via adapter decorator)**
  - `EncryptedStorageAdapter` como decorator del StorageAdapter base
  - Encripta datos en `save()`, desencripta en `load()`
  - AES-256-GCM con IV aleatorio por operacion
  - Backward compatible con datos no encriptados

### 1.3 Flujos Principales

```
FLUJO 1: Establecer contexto
  Agent -> cli_exec("context:set project_id 42")
        -> ContextStore.set("project_id", "42")
        -> Response: {status: 0, data: {key: "project_id", value: "42"}}

FLUJO 2: Obtener valor del contexto
  Agent -> cli_exec("context:get project_id")
        -> ContextStore.get("project_id")
        -> Response: {status: 0, data: {key: "project_id", value: "42"}}

FLUJO 3: Ver todo el contexto
  Agent -> cli_exec("context")
        -> ContextStore.getAll()
        -> Response: {status: 0, data: {project_id: "42", user: "admin", ...}}

FLUJO 4: Historial de comandos
  Agent -> cli_exec("history")
        -> ContextStore.getHistory()
        -> Response: {status: 0, data: [{id: "cmd_01", command: "...", ...}]}

FLUJO 5: Undo de comando
  Agent -> cli_exec("undo cmd_01")
        -> ContextStore.getUndoSnapshot("cmd_01")
        -> Executor.applyUndo(snapshot)
        -> Response: {status: 0, data: {reverted: "cmd_01", ...}}

FLUJO 6: Registro automatico de comando (interno)
  Executor -> ejecuta comando
           -> ContextStore.recordCommand({id, command, result, undoable, snapshot})
           -> Comando queda registrado en historial
```

### 1.4 Operaciones Soportadas (Interfaz de Usuario)

| Comando | Descripcion | Sintaxis |
|---------|-------------|----------|
| `context` | Ver todo el contexto de sesion | `context` |
| `context:set` | Establecer un valor | `context:set <key> <value>` |
| `context:get` | Obtener un valor | `context:get <key>` |
| `context:delete` | Eliminar una clave | `context:delete <key>` |
| `context:clear` | Limpiar todo el contexto | `context:clear` |
| `history` | Ver historial de comandos | `history [--limit N]` |
| `undo` | Revertir un comando | `undo <command_id>` |

### 1.5 Configuracion (ContextStoreConfig)

```typescript
interface ContextStoreConfig {
  /** TTL de sesion en ms. Si se supera desde creacion, la sesion se destruye. */
  ttl_ms?: number;

  /** Callback invocado cuando una sesion expira por TTL. */
  onExpired?: (sessionId: string) => void;

  /** Deteccion de secretos en valores almacenados via set(). */
  secretDetection?: {
    /** 'warn' permite el set con warning; 'reject' bloquea el set. */
    mode: 'warn' | 'reject';
    /** Patrones custom (default: DEFAULT_SECRET_PATTERNS del modulo Security). */
    patterns?: SecretPattern[];
  };

  /** Politica de retencion para historial de comandos. */
  retentionPolicy?: RetentionPolicy;
}

interface RetentionPolicy {
  /** Eliminar entries mas viejas que este valor (ms desde executed_at). */
  maxAge_ms?: number;
  /** Mantener solo las N entries mas recientes. */
  maxEntries?: number;
}
```

**Flujo de expiracion:**

```
1. set()/get()/recordCommand() -> checkExpiry()
2. checkExpiry():
   - Si ttl_ms no configurado -> no-op
   - Si (now - createdAt) > ttl_ms:
     a. Invocar onExpired(sessionId) si configurado
     b. Destruir sesion via adapter
     c. Retornar error SESSION_EXPIRED
```

**Flujo de deteccion de secretos en set():**

```
1. Recibir set(key, value)
2. Si secretDetection configurado:
   a. Ejecutar containsSecret(value, patterns)
   b. Si detecta secreto:
      - Modo 'warn': Continuar con set, agregar warning en respuesta
      - Modo 'reject': Retornar error, no almacenar valor
3. Si no detecta: Continuar normalmente
```

**Flujo de retencion en recordCommand():**

```
1. Agregar nueva entrada al historial
2. Si retentionPolicy configurada:
   a. Si maxAge_ms: Filtrar entries donde (now - executed_at) > maxAge_ms
   b. Si maxEntries: Ordenar por fecha, mantener solo las N mas recientes
3. Persistir historial actualizado
```

### 1.6 Inputs y Outputs

**Operacion: context:set**

| Input | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| key | string | Si | Nombre de la clave (alfanumerico, puntos, guiones bajos) |
| value | string | Si | Valor a almacenar (se parsea a tipo inferido) |

| Output | Tipo | Descripcion |
|--------|------|-------------|
| status | int | Codigo de salida (0 = exito) |
| data.key | string | Clave establecida |
| data.value | any | Valor almacenado (tipado inferido) |
| data.previous | any/null | Valor anterior si existia |

**Operacion: context:get**

| Input | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| key | string | Si | Nombre de la clave a buscar |

| Output | Tipo | Descripcion |
|--------|------|-------------|
| status | int | Codigo de salida (0 = exito, 2 = no encontrado) |
| data.key | string | Clave consultada |
| data.value | any | Valor almacenado |

**Operacion: context (getAll)**

| Input | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| (ninguno) | - | - | - |

| Output | Tipo | Descripcion |
|--------|------|-------------|
| status | int | Codigo de salida |
| data | object | Mapa completo clave-valor del contexto |
| meta.count | int | Cantidad de claves almacenadas |
| meta.session_id | string | ID de la sesion actual |

**Operacion: history**

| Input | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| --limit | int | No | Cantidad maxima de resultados (default: 20) |
| --offset | int | No | Saltar primeros N registros |

| Output | Tipo | Descripcion |
|--------|------|-------------|
| status | int | Codigo de salida |
| data | array | Lista de entradas del historial |
| meta.total | int | Total de comandos en historial |

**Operacion: undo**

| Input | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| command_id | string | Si | ID del comando a revertir |

| Output | Tipo | Descripcion |
|--------|------|-------------|
| status | int | Codigo de salida |
| data.reverted | string | ID del comando revertido |
| data.snapshot_applied | object | Estado restaurado |

---

## 2. Que NO debe hacer (MUST NOT)

### 2.1 Fuera de Alcance

- No implementar autenticacion de sesiones (responsabilidad del gateway)
- No implementar sincronizacion entre multiples instancias (responsabilidad del adaptador Redis si se usa)
- No ejecutar comandos de undo directamente (solo provee el snapshot, el Executor aplica)
- No validar permisos de acceso a claves (responsabilidad del modulo de seguridad)
- No implementar TTL por clave individual (solo TTL de sesion completa)
- No proveer subscripciones o eventos reactivos sobre cambios de contexto
- No implementar encriptacion directamente (se delega al EncryptedStorageAdapter decorator)

### 2.2 Anti-patterns Prohibidos

- No usar singleton mutable global para el store -> Usar inyeccion de dependencias con sesion explicita
- No acoplar la logica de negocio al backend de storage -> Usar interface/adaptador
- No almacenar datos binarios o blobs grandes -> Solo valores serializables a JSON
- No mantener referencias circulares en el contexto -> Validar estructura plana o anidada simple
- No bloquear el event loop en operaciones de I/O -> Usar operaciones async en adaptadores de disco/redis
- No exponer internals del storage en las respuestas -> Solo datos del contrato

### 2.3 Restricciones de Implementacion

- No usar ORM ni abstraccion de base de datos relacional (no es su caso de uso)
- No depender de librerias externas para el adaptador en memoria
- No modificar el formato de respuesta definido por el protocolo de Agent Shell
- No almacenar passwords, tokens o secrets en el contexto (debe rechazarlos o advertir)

---

## 3. Como se que esta bien (ACCEPTANCE)

### 3.1 Criterios de Aceptacion

```gherkin
Feature: Context Store - Operaciones basicas

  Scenario: Establecer y recuperar un valor
    DADO una sesion nueva sin contexto
    CUANDO ejecuto "context:set project_id 42"
    ENTONCES el status es 0
    Y data.key es "project_id"
    Y data.value es 42 (tipado como int)
    CUANDO ejecuto "context:get project_id"
    ENTONCES el status es 0
    Y data.value es 42

  Scenario: Obtener clave inexistente
    DADO una sesion sin la clave "foo"
    CUANDO ejecuto "context:get foo"
    ENTONCES el status es 2
    Y error.message contiene "not found"

  Scenario: Ver todo el contexto
    DADO una sesion con claves {a: 1, b: "hello", c: true}
    CUANDO ejecuto "context"
    ENTONCES el status es 0
    Y data contiene exactamente {a: 1, b: "hello", c: true}
    Y meta.count es 3

  Scenario: Eliminar una clave
    DADO una sesion con la clave "temp" = "value"
    CUANDO ejecuto "context:delete temp"
    ENTONCES el status es 0
    Y la clave "temp" ya no existe en el contexto

  Scenario: Limpiar todo el contexto
    DADO una sesion con multiples claves
    CUANDO ejecuto "context:clear"
    ENTONCES el status es 0
    Y el contexto esta vacio
    Y meta.count es 0

  Scenario: Sobrescribir valor existente
    DADO una sesion con la clave "mode" = "dev"
    CUANDO ejecuto "context:set mode prod"
    ENTONCES el status es 0
    Y data.value es "prod"
    Y data.previous es "dev"

Feature: Context Store - Historial

  Scenario: Registrar comando en historial
    DADO una sesion vacia
    CUANDO el Executor ejecuta el comando "users:list --limit 5"
    ENTONCES history contiene una entrada con command "users:list --limit 5"
    Y la entrada tiene un id unico
    Y la entrada tiene timestamp
    Y la entrada tiene exit_code

  Scenario: Consultar historial con limite
    DADO un historial con 50 comandos
    CUANDO ejecuto "history --limit 10"
    ENTONCES data contiene exactamente 10 entradas
    Y estan ordenadas por timestamp descendente (mas reciente primero)

  Scenario: Historial vacio
    DADO una sesion nueva
    CUANDO ejecuto "history"
    ENTONCES el status es 0
    Y data es un array vacio
    Y meta.total es 0

Feature: Context Store - Undo

  Scenario: Undo de comando reversible
    DADO un comando "config:set theme dark" ejecutado con id "cmd_05"
    Y el comando fue marcado como undoable con snapshot {theme: "light"}
    CUANDO ejecuto "undo cmd_05"
    ENTONCES el status es 0
    Y data.reverted es "cmd_05"
    Y data.snapshot_applied contiene {theme: "light"}

  Scenario: Undo de comando no reversible
    DADO un comando "report:generate" ejecutado con id "cmd_06"
    Y el comando NO fue marcado como undoable
    CUANDO ejecuto "undo cmd_06"
    ENTONCES el status es 1
    Y error.message contiene "not undoable"

  Scenario: Undo de comando inexistente
    DADO que no existe un comando con id "cmd_99"
    CUANDO ejecuto "undo cmd_99"
    ENTONCES el status es 2
    Y error.message contiene "not found"

  Scenario: Undo ya aplicado (doble undo)
    DADO un comando "cmd_05" que ya fue revertido
    CUANDO ejecuto "undo cmd_05"
    ENTONCES el status es 1
    Y error.message contiene "already reverted"

Feature: Context Store - Adaptador de Storage

  Scenario: Intercambio de backend transparente
    DADO un ContextStore configurado con MemoryAdapter
    CUANDO cambio la configuracion a DiskAdapter
    Y ejecuto las mismas operaciones
    ENTONCES los resultados son identicos
    Y la interfaz de uso no cambia
```

### 3.2 Casos de Prueba Requeridos

| ID | Escenario | Input | Output Esperado | Prioridad |
|----|-----------|-------|-----------------|-----------|
| T01 | Set valor string | `context:set name "John"` | status 0, value "John" | Alta |
| T02 | Set valor numerico | `context:set count 42` | status 0, value 42 (int) | Alta |
| T03 | Set valor booleano | `context:set active true` | status 0, value true (bool) | Alta |
| T04 | Set valor JSON | `context:set config {"a":1}` | status 0, value {a:1} | Media |
| T05 | Get existente | `context:get name` | status 0, value "John" | Alta |
| T06 | Get inexistente | `context:get xyz` | status 2, error | Alta |
| T07 | Context completo | `context` | status 0, all keys | Alta |
| T08 | Delete existente | `context:delete name` | status 0 | Alta |
| T09 | Delete inexistente | `context:delete xyz` | status 2 | Media |
| T10 | Clear | `context:clear` | status 0, empty | Alta |
| T11 | History default | `history` | ultimos 20 cmds | Alta |
| T12 | History con limit | `history --limit 5` | exactamente 5 | Media |
| T13 | Undo reversible | `undo cmd_01` | status 0, snapshot | Alta |
| T14 | Undo no reversible | `undo cmd_02` | status 1, error | Alta |
| T15 | Undo inexistente | `undo cmd_99` | status 2, error | Alta |
| T16 | Undo duplicado | `undo cmd_01` (2da vez) | status 1, error | Media |
| T17 | Key con puntos | `context:set db.host localhost` | status 0 | Media |
| T18 | Key invalida | `context:set "" value` | status 1, error | Media |
| T19 | Valor vacio | `context:set key ""` | status 0, value "" | Baja |
| T20 | Concurrencia adaptador | Set/Get simultaneo | sin corrupcion | Alta |

### 3.3 Metricas de Exito

- [ ] Latencia de operaciones en memoria: < 1ms por operacion
- [ ] Latencia de operaciones en disco: < 10ms por operacion
- [ ] Latencia de operaciones en Redis: < 5ms por operacion (red local)
- [ ] Capacidad del contexto: soportar al menos 1000 claves por sesion
- [ ] Capacidad del historial: soportar al menos 10000 entradas por sesion
- [ ] Serializacion/deserializacion: < 5ms para contexto completo de 1000 claves

### 3.4 Definition of Done

- [ ] Todas las operaciones (set, get, getAll, delete, clear) implementadas
- [ ] Historial de comandos funcional con registro automatico
- [ ] Mecanismo de undo implementado con snapshots
- [ ] Interface StorageAdapter definida y documentada
- [ ] MemoryAdapter implementado (default)
- [ ] DiskAdapter implementado (JSON file)
- [ ] RedisAdapter implementado (o stub con interface lista)
- [ ] Tests unitarios pasando (cobertura minima: 90%)
- [ ] Tests de integracion con cada adaptador
- [ ] Sin dependencias externas para el core (solo para adaptadores opcionales)
- [ ] Respuestas siguen el formato del protocolo Agent Shell
- [ ] Documentacion de la interface del adaptador

---

## 4. Que pasa si falla (ERROR HANDLING)

### 4.1 Errores Esperados

| Codigo | Condicion | Respuesta | Accion de Usuario |
|--------|-----------|-----------|-------------------|
| E001 | Clave no encontrada en get/delete | `{status: 2, error: {code: "KEY_NOT_FOUND", message: "Key '<key>' not found in context"}}` | Usar `context` para ver claves disponibles |
| E002 | Clave invalida (vacia, caracteres prohibidos) | `{status: 1, error: {code: "INVALID_KEY", message: "Key must match pattern [a-zA-Z0-9._-]+"}}` | Corregir formato de la clave |
| E003 | Valor no serializable | `{status: 1, error: {code: "INVALID_VALUE", message: "Value must be JSON-serializable"}}` | Simplificar el valor |
| E004 | Comando no encontrado para undo | `{status: 2, error: {code: "COMMAND_NOT_FOUND", message: "Command '<id>' not found in history"}}` | Usar `history` para ver IDs validos |
| E005 | Comando no es reversible | `{status: 1, error: {code: "NOT_UNDOABLE", message: "Command '<id>' is not marked as undoable"}}` | No se puede revertir este comando |
| E006 | Comando ya revertido | `{status: 1, error: {code: "ALREADY_REVERTED", message: "Command '<id>' was already reverted"}}` | No requiere accion |
| E007 | Storage backend no disponible | `{status: 1, error: {code: "STORAGE_ERROR", message: "Storage backend unavailable: <detail>"}}` | Verificar configuracion del backend |
| E008 | Sesion no inicializada | `{status: 1, error: {code: "NO_SESSION", message: "No active session"}}` | Iniciar nueva sesion |
| E009 | Limite de almacenamiento excedido | `{status: 1, error: {code: "STORAGE_LIMIT", message: "Context exceeds maximum size of <limit>"}}` | Limpiar claves innecesarias |

### 4.2 Estrategia de Fallback

- Si el adaptador de disco falla al escribir -> Mantener en memoria y reintentar en siguiente operacion, advertir en respuesta
- Si Redis no responde -> Fallback a memoria con warning en meta.warnings
- Si la deserializacion del historial falla -> Retornar historial vacio con warning, no bloquear operaciones
- Si el snapshot de undo esta corrupto -> Retornar error E007 con detalle, no aplicar cambios parciales

### 4.3 Logging y Monitoreo

- Nivel INFO: Operaciones exitosas de set/delete/clear (sin valores, solo claves)
- Nivel WARN: Fallback de adaptador, reintentos, snapshots grandes
- Nivel ERROR: Fallo de adaptador, corrupcion de datos, errores no recuperables
- Metricas a trackear:
  - Operaciones por segundo por tipo (set/get/delete)
  - Tamano del contexto (cantidad de claves, bytes)
  - Tamano del historial (cantidad de entradas)
  - Errores por tipo
  - Latencia por operacion y por adaptador

### 4.4 Recuperacion

- Retry policy: Para adaptadores de red (Redis), 3 reintentos con backoff exponencial (100ms, 200ms, 400ms)
- Circuit breaker: Si el adaptador falla 5 veces consecutivas, cambiar a MemoryAdapter con flag de degradacion
- Rollback: Las operaciones de set almacenan valor previo; si el write al adaptador falla despues del set logico, restaurar valor previo
- Corrupcion de datos: Si el archivo de disco no es parseable, renombrar como .bak y crear nuevo

---

## 5. Que supuestos tiene (ASSUMPTIONS)

### 5.1 Precondiciones

- [ ] Existe una sesion activa (creada por el framework al iniciar interaccion)
- [ ] El adaptador de storage esta configurado antes de la primera operacion
- [ ] El modulo Executor notifica al Context Store despues de cada ejecucion de comando
- [ ] Los comandos reversibles declaran su capacidad de undo en su definicion (Command Registry)

### 5.2 Dependencias

| Dependencia | Tipo | Version | Critica |
|-------------|------|---------|---------|
| Session Manager | Modulo interno | - | Si |
| Command Registry | Modulo interno | - | Si (para metadata de undoable) |
| Executor | Modulo interno | - | Si (para registro de historial) |
| Security | Modulo interno | 1.0 | No (maskSecrets, containsSecret) |
| JSON serializer | Libreria standard | - | Si |
| node:crypto | Runtime | - | No (solo para EncryptedStorageAdapter) |
| Redis client | Libreria externa | - | No (solo para RedisAdapter) |
| File system API | Runtime | - | No (solo para DiskAdapter) |

### 5.3 Datos de Entrada Esperados

- Formato de claves: String matching `/^[a-zA-Z][a-zA-Z0-9._-]*$/` (1-128 caracteres)
- Formato de valores: Cualquier valor JSON-serializable (string, number, boolean, object, array)
- Tamano maximo de valor individual: 64 KB serializado
- Tamano maximo de contexto total: 1 MB serializado
- Encoding: UTF-8

### 5.4 Estado del Sistema

- Una sesion se crea al inicio de la interaccion agente-CLI
- El session_id es unico y generado por el framework
- Multiples sesiones pueden coexistir (cada una con su propio contexto)
- La sesion NO persiste entre reinicios del proceso (salvo con DiskAdapter o RedisAdapter)

---

## 6. Que limites tiene (CONSTRAINTS)

### 6.1 Limites Tecnicos

- Memoria maxima por sesion: 1 MB de contexto + 5 MB de historial
- Cantidad maxima de claves: 1000 por sesion
- Longitud maxima de clave: 128 caracteres
- Tamano maximo de valor: 64 KB
- Historial maximo: 10000 entradas (FIFO, las mas antiguas se descartan)
- Snapshots de undo: Maximo 100 snapshots activos (los mas antiguos se descartan)
- Tiempo de respuesta por operacion (memoria): < 1ms
- Tiempo de respuesta por operacion (disco): < 10ms
- Tiempo de respuesta por operacion (redis): < 5ms

### 6.2 Limites de Negocio

- El contexto es por sesion, no por usuario (sin persistencia cross-sesion en v1)
- El undo solo aplica al comando inmediato, no soporta redo
- El historial es de solo lectura (no se pueden eliminar entradas individuales)
- Los valores sensibles pueden ser bloqueados (`secretDetection.mode: 'reject'`) o advertidos (`'warn'`) segun configuracion

### 6.3 Limites de Seguridad

- No encriptacion de valores en memoria (responsabilidad del entorno de ejecucion)
- Encriptacion at-rest disponible via `EncryptedStorageAdapter` (AES-256-GCM)
- DiskAdapter: Archivo con permisos 600 (solo owner)
- RedisAdapter: Requiere configuracion de auth externalizada
- No logging de valores, solo de claves en operaciones
- Sanitizacion de claves para prevenir injection en backends
- Secret masking automatico en historial (previene persistencia de credenciales)

### 6.4 Limites de Alcance (Version 1.1)

- Esta version NO incluye:
  - TTL por clave individual (solo TTL de sesion completa)
  - Namespaces dentro del contexto
  - Eventos / hooks on-change
  - Transacciones atomicas multi-key
  - Compresion de historial
  - Export/import de contexto
  - Busqueda en historial por patron
- Lo que SI incluye (v1.1):
  - TTL de sesion con callback `onExpired`
  - Deteccion de secretos en `set()` (modos warn/reject)
  - Masking automatico en `recordCommand()` via `maskSecrets()`
  - Politicas de retencion de historial (por edad y cantidad)
  - Encriptacion at-rest via `EncryptedStorageAdapter` decorator
- Consideraciones futuras:
  - TTL por clave individual (v2)
  - Contexto compartido entre sesiones (v2)
  - Streaming de cambios via events (v3)
  - Key rotation para EncryptedStorageAdapter (v2)

---

## 7. Estructuras de Datos

### 7.1 Estructura del Contexto (ContextData)

```typescript
interface ContextData {
  session_id: string;           // UUID de la sesion
  created_at: string;           // ISO 8601 timestamp
  updated_at: string;           // ISO 8601 timestamp
  entries: Record<string, ContextEntry>;
}

interface ContextEntry {
  key: string;                  // Nombre de la clave
  value: any;                   // Valor almacenado (JSON-serializable)
  type: "string" | "number" | "boolean" | "object" | "array";
  set_at: string;              // ISO 8601 timestamp
  updated_at: string;          // ISO 8601 timestamp
  version: number;             // Incrementa en cada update
}
```

### 7.2 Estructura del Historial (HistoryEntry)

```typescript
interface HistoryEntry {
  id: string;                   // ID unico del comando (ej: "cmd_001")
  command: string;              // Comando completo ejecutado
  namespace: string;            // Namespace del comando
  args: Record<string, any>;   // Argumentos parseados
  executed_at: string;          // ISO 8601 timestamp
  duration_ms: number;         // Duracion de ejecucion en ms
  exit_code: number;           // Codigo de salida (0-4)
  result_summary: string;      // Resumen del resultado (truncado a 256 chars)
  undoable: boolean;           // Si el comando es reversible
  undo_status: "available" | "applied" | "expired" | null;
  snapshot_id: string | null;  // Referencia al snapshot de undo si undoable
}
```

### 7.3 Estructura del Snapshot de Undo (UndoSnapshot)

```typescript
interface UndoSnapshot {
  id: string;                   // ID unico del snapshot
  command_id: string;           // ID del comando asociado
  created_at: string;           // ISO 8601 timestamp
  state_before: Record<string, any>;  // Estado previo relevante
  rollback_command: string | null;     // Comando inverso a ejecutar (si aplica)
  metadata: Record<string, any>;      // Informacion adicional del handler
}
```

### 7.4 Estructura completa del Store (SessionStore)

```typescript
interface SessionStore {
  context: ContextData;
  history: HistoryEntry[];
  undo_snapshots: UndoSnapshot[];
  meta: {
    adapter: string;            // Nombre del adaptador activo
    degraded: boolean;          // Si esta en modo degradado (fallback)
    warnings: string[];         // Warnings activos
  };
}
```

---

## 8. Interface del Adaptador de Storage

### 8.1 StorageAdapter Interface

```typescript
interface StorageAdapter {
  /**
   * Nombre del adaptador para logging/debug
   */
  readonly name: string;

  /**
   * Inicializar el adaptador (conexion, crear archivo, etc)
   * Se llama una vez al crear la sesion
   */
  initialize(session_id: string): Promise<void>;

  /**
   * Leer todo el store de una sesion
   * Retorna null si la sesion no existe
   */
  load(session_id: string): Promise<SessionStore | null>;

  /**
   * Persistir todo el store de una sesion
   */
  save(session_id: string, store: SessionStore): Promise<void>;

  /**
   * Eliminar todos los datos de una sesion
   */
  destroy(session_id: string): Promise<void>;

  /**
   * Verificar si el adaptador esta disponible y funcional
   */
  healthCheck(): Promise<boolean>;

  /**
   * Liberar recursos (cerrar conexiones, etc)
   */
  dispose(): Promise<void>;
}
```

### 8.2 Adaptadores Requeridos

#### MemoryAdapter
```typescript
class MemoryAdapter implements StorageAdapter {
  name = "memory";
  // Almacena en un Map<string, SessionStore> en memoria
  // Sin I/O, maximo rendimiento
  // Se pierde al terminar el proceso
}
```

#### DiskAdapter
```typescript
class DiskAdapter implements StorageAdapter {
  name = "disk";
  // Almacena en archivo JSON en ruta configurable
  // Path: {base_path}/{session_id}.json
  // Permisos: 0600
  // Atomic write (write to .tmp, rename)
}
```

#### RedisAdapter
```typescript
class RedisAdapter implements StorageAdapter {
  name = "redis";
  // Almacena en Redis con key prefix "agentshell:session:{session_id}"
  // TTL configurable (default: 24h)
  // Serialization: JSON
  // Requiere redis client configurado externamente
}
```

#### EncryptedStorageAdapter (Decorator)
```typescript
class EncryptedStorageAdapter implements StorageAdapter {
  name = "encrypted(<inner.name>)";
  // Decorator que envuelve cualquier StorageAdapter
  // Encripta en save(), desencripta en load()
  // Algoritmo: AES-256-GCM con IV aleatorio por operacion
  // Backward compatible: datos sin _encrypted flag pasan sin descifrar
  // Requiere clave de 32 bytes (Buffer)
  constructor(inner: StorageAdapter, config: EncryptionConfig);
}
```

### 8.3 Configuracion del Adaptador

```typescript
interface StorageConfig {
  adapter: "memory" | "disk" | "redis";
  options: MemoryOptions | DiskOptions | RedisOptions;
  fallback: "memory" | null;   // Adaptador de fallback si el primario falla
}

interface MemoryOptions {
  max_sessions: number;         // Default: 100
}

interface DiskOptions {
  base_path: string;            // Directorio de almacenamiento
  pretty_print: boolean;        // JSON legible (default: false)
}

interface RedisOptions {
  url: string;                  // Redis connection URL
  prefix: string;              // Key prefix (default: "agentshell:session")
  ttl_seconds: number;         // TTL por sesion (default: 86400)
}
```

---

## 9. Formato de Respuestas

### 9.1 Respuesta Exitosa

```json
{
  "status": 0,
  "data": { },
  "meta": {
    "session_id": "uuid-here",
    "timestamp": "2026-01-22T10:30:00Z"
  }
}
```

### 9.2 Respuesta de Error

```json
{
  "status": 1,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable message"
  },
  "meta": {
    "session_id": "uuid-here",
    "timestamp": "2026-01-22T10:30:00Z"
  }
}
```

### 9.3 Respuesta con Warnings

```json
{
  "status": 0,
  "data": { },
  "meta": {
    "session_id": "uuid-here",
    "timestamp": "2026-01-22T10:30:00Z",
    "warnings": ["Storage degraded to memory adapter"]
  }
}
```

---

## Anexos

### A. Glosario

| Termino | Definicion |
|---------|------------|
| Sesion | Periodo de interaccion entre un agente y Agent Shell, identificado por un UUID |
| Contexto | Conjunto de pares clave-valor persistidos durante una sesion |
| Historial | Registro cronologico de todos los comandos ejecutados en una sesion |
| Snapshot | Captura del estado relevante antes de ejecutar un comando reversible |
| Undo | Operacion de revertir los efectos de un comando previamente ejecutado |
| Adaptador | Implementacion concreta de la interface de storage para un backend especifico |
| Degradado | Estado donde el sistema opera con un adaptador de fallback por fallo del primario |
| FIFO | First In First Out - politica de descarte del historial cuando alcanza el limite |

### B. Referencias

- [Agent Shell PRD](../docs/prd.md) - Documento de requisitos del producto
- Seccion "Estado" del protocolo de interaccion (lineas 105-107 del PRD)
- Seccion "Historial" del protocolo de interaccion (lineas 109-110 del PRD)
- Componente #6 de la arquitectura (linea 233 del PRD)

### C. Relacion con Otros Modulos

| Modulo | Relacion |
|--------|----------|
| Parser | Parsea comandos context/history/undo antes de llegar al Context Store |
| Executor | Notifica al Context Store despues de cada ejecucion para registro en historial |
| Command Registry | Provee metadata de undoable para cada comando |
| Router | Rutea comandos context/history/undo hacia el Context Store |
| Security | Provee maskSecrets() para historial y containsSecret() para set() |

### D. Historial de Cambios

| Version | Fecha | Autor | Cambios |
|---------|-------|-------|---------|
| 1.0 | 2026-01-22 | Spec Architect | Version inicial del contrato |
| 1.1 | 2026-01-23 | Spec Architect | Agregado: ContextStoreConfig (1.5), TTL de sesion, secretDetection, retentionPolicy, EncryptedStorageAdapter, relacion con Security |

---

## 9. Estado de Implementación v1.0

### Implementado
- ContextStore con set(), get(), getAll(), delete(), clear(), recordCommand(), undo(), getHistory()
- **SQLiteStorageAdapter** con schema relacional (sessions, session_context, command_history, undo_snapshots)
- **EncryptedStorageAdapter** (decorator AES-256-GCM con IV aleatorio)
- TTL de sesion configurable (ttl_ms)
- Secret detection con modos 'warn' y 'reject'
- Retention policy (maxAge_ms, maxEntries) para historial
- Inferencia automatica de tipo de valor (string, number, boolean, object, array)
- Campos adicionales: createdAt, lastAccessAt en SessionStore

### Implementado (v1.1)
- TTL expirado ahora lanza SessionExpiredError (code SESSION_EXPIRED)
- Getter publico `getSessionId(): string`
- Metodo `dispose()` expuesto en ContextStore (delega a adapter)
- Enforzamiento de MAX_KEYS = 1000 por sesion (error en set() si se excede)
- Limpieza de snapshots antiguos (max 100 activos, slice automatico)

### Discrepancias con contrato
- Adapters Memory, Disk, Redis del contrato NO implementados (reemplazados por SQLiteStorageAdapter)
- Convenciones de nombres mixtas: camelCase en TypeScript, snake_case en SQL

### Pendiente
- MemoryAdapter (contrato seccion 8.2) — en demo/ como ejemplo, no en paquete principal
- DiskAdapter (contrato seccion 8.2)
- RedisAdapter (contrato seccion 8.2)
- Validacion de referencias circulares en valores
- Validacion de datos binarios/blobs
