# Contrato: EXECUTOR

> **Version**: 1.1
> **Fecha**: 2026-01-23
> **Estado**: Draft
> **Autor**: Specification Architect
> **Modulo**: Executor (Agent Shell)

## Resumen Ejecutivo

El Executor es el motor de ejecucion central de Agent Shell. Recibe un `ParseResult` del Parser, resuelve el handler correspondiente via el Command Registry, aplica el pipeline de ejecucion (validacion, permisos, modo, ejecucion, historial) y retorna una respuesta estandarizada. Soporta cuatro modos de ejecucion (normal, dry-run, validate, confirm), composicion de comandos via pipeline, ejecucion batch, registro en historial y undo para comandos reversibles.

---

## 1. Que debe hacer (MUST DO)

### 1.1 Objetivo Principal

Recibir una estructura `ParseResult` (producida por el Parser) y ejecutar el comando correspondiente aplicando el pipeline completo de ejecucion, respetando modos, permisos y politicas de seguridad, retornando siempre una respuesta estructurada con codigo de estado estandar.

### 1.2 Funcionalidades Requeridas

- [ ] **Ejecucion de comando simple**: Resolver handler del registry y ejecutarlo con los argumentos parseados
- [ ] **Modo normal**: Ejecutar el handler y retornar resultado real
- [ ] **Modo --dry-run**: Simular la ejecucion sin efectos secundarios, retornando lo que "haria"
- [ ] **Modo --validate**: Validar sintaxis, existencia del comando y permisos sin ejecutar
- [ ] **Modo --confirm**: Generar preview del comando y retornar con codigo 4 (requiere confirmacion)
- [ ] **Validacion de permisos**: Verificar que el contexto actual tiene permisos para ejecutar el comando
- [ ] **Validacion de argumentos**: Verificar tipos y restricciones de argumentos contra la definicion del comando
- [ ] **Ejecucion de pipeline**: Ejecutar comandos en secuencia, pasando output como input al siguiente
- [ ] **Ejecucion batch**: Ejecutar multiples comandos independientes y agregar resultados
- [ ] **Registro en historial**: Persistir cada ejecucion exitosa con metadata para auditoria
- [ ] **Soporte undo**: Ejecutar la funcion de reversion para comandos que declaren ser reversibles
- [ ] **Respuesta estandarizada**: Toda ejecucion retorna un `ExecutionResult` con estructura fija

### 1.3 Pipeline de Ejecucion

```
ParseResult (del Parser)
    |
    v
[1. RESOLVE] --> Buscar handler en Command Registry
    |              - Si no existe: retornar code=2 (not found)
    |
    v
[2. VALIDATE ARGS] --> Verificar argumentos contra definicion del comando
    |                    - Tipos correctos
    |                    - Requeridos presentes
    |                    - Restricciones cumplidas
    |                    - Si falla: retornar code=1 (syntax/validation error)
    |
    v
[3. CHECK PERMISSIONS] --> Verificar permisos del contexto actual
    |                        - Comando requiere permisos?
    |                        - Contexto tiene los permisos?
    |                        - Si falla: retornar code=3 (sin permisos)
    |
    v
[4. APPLY MODE] --> Segun flags del ParsedCommand:
    |               - --validate? -> retornar validacion exitosa, NO ejecutar
    |               - --dry-run?  -> simular ejecucion, retornar preview
    |               - --confirm?  -> generar preview, retornar code=4
    |               - normal?     -> continuar al paso 5
    |
    v
[5. EXECUTE] --> Invocar handler con argumentos validados
    |              - Capturar resultado o error
    |              - Aplicar timeout si esta configurado
    |
    v
[6. RECORD HISTORY] --> Registrar en historial:
    |                     - Comando ejecutado
    |                     - Argumentos
    |                     - Resultado (resumen)
    |                     - Timestamp
    |                     - Reversible? (si/no)
    |
    v
[7. RETURN] --> Construir ExecutionResult estandarizado
```

### 1.4 Estructura de Respuesta Estandar (ExecutionResult)

```typescript
interface ExecutionResult {
  // Codigo de estado (protocolo Agent Shell)
  code: 0 | 1 | 2 | 3 | 4;

  // Indica si la ejecucion fue exitosa
  success: boolean;

  // Datos de respuesta (null si hay error)
  data: any | null;

  // Informacion del error (null si es exitoso)
  error: ExecutionError | null;

  // Metadata de la ejecucion
  meta: ExecutionMeta;
}

interface ExecutionError {
  code: number;                  // Codigo de error del protocolo (1-4)
  type: string;                  // Tipo especifico (E_NOT_FOUND, E_FORBIDDEN, etc.)
  message: string;               // Mensaje legible
  details?: Record<string, any>; // Detalles adicionales del error
}

interface ExecutionMeta {
  command: string;               // Comando ejecutado (namespace:command)
  mode: "normal" | "dry-run" | "validate" | "confirm";
  duration_ms: number;           // Tiempo de ejecucion
  timestamp: string;             // ISO 8601
  historyId: string | null;      // ID en historial (null si no se registro)
  reversible: boolean;           // Si el comando soporta undo
}

// Para ejecucion batch, se retorna un wrapper
interface BatchResult {
  code: 0 | 1;                   // 0 si todos exito, 1 si alguno fallo
  success: boolean;
  results: ExecutionResult[];    // Un resultado por cada comando
  meta: {
    total: number;
    succeeded: number;
    failed: number;
    duration_ms: number;
  };
}

// Para ejecucion pipeline, se retorna el resultado final
interface PipelineResult {
  code: 0 | 1 | 2 | 3 | 4;     // Codigo del ultimo comando o del que fallo
  success: boolean;
  data: any | null;              // Output del ultimo comando exitoso
  error: ExecutionError | null;  // Error del comando que fallo (si aplica)
  meta: {
    steps: PipelineStep[];       // Detalle de cada paso
    duration_ms: number;
    failedAt: number | null;     // Indice del paso que fallo (null si exito)
  };
}

interface PipelineStep {
  command: string;               // namespace:command
  code: number;
  duration_ms: number;
  inputReceived: boolean;        // Si recibio input del paso anterior
}
```

### 1.5 Comportamiento de Modos de Ejecucion

#### Modo Normal (sin flags)
```
- Ejecuta el pipeline completo: resolve -> validate -> permissions -> execute -> history
- Retorna ExecutionResult con code=0 y data del handler
- Registra en historial
```

#### Modo --dry-run
```
- Ejecuta: resolve -> validate args -> permissions -> SIMULATE
- NO ejecuta el handler real
- Retorna ExecutionResult con:
  - code: 0
  - data: {
      wouldExecute: "namespace:command",
      withArgs: { ...args validados },
      expectedEffect: "descripcion del efecto" (del command definition),
      estimatedOutput: { ...shape del output esperado }
    }
  - meta.mode: "dry-run"
- NO registra en historial
```

#### Modo --validate
```
- Ejecuta: resolve -> validate args -> permissions
- NO ejecuta ni simula
- Retorna ExecutionResult con:
  - code: 0 (si todo valido)
  - data: {
      valid: true,
      command: "namespace:command",
      resolvedArgs: { ...args con tipos convertidos },
      permissions: { allowed: true, requiredRoles: [...] }
    }
  - meta.mode: "validate"
- NO registra en historial
```

#### Modo --confirm
```
- Ejecuta: resolve -> validate args -> permissions -> GENERATE PREVIEW
- NO ejecuta el handler
- Retorna ExecutionResult con:
  - code: 4 (requiere confirmacion)
  - data: {
      preview: {
        command: "namespace:command",
        args: { ...args },
        effect: "descripcion del efecto",
        reversible: true/false,
        warning: "mensaje de advertencia" (si aplica)
      },
      confirmToken: "uuid-para-confirmar"
    }
  - meta.mode: "confirm"
- NO registra en historial
- El agente puede luego confirmar con: "confirm <token>"
```

### 1.6 Composicion (Pipeline >>)

```
Dado: cmd1 >> cmd2 >> cmd3

1. Ejecutar cmd1 normalmente
2. Si cmd1.code != 0 -> abortar, retornar PipelineResult con error
3. Tomar cmd1.data como $input para cmd2
4. En cmd2, resolver referencias $input.campo a valores del output de cmd1
5. Ejecutar cmd2 con los argumentos resueltos
6. Si cmd2.code != 0 -> abortar
7. Tomar cmd2.data como $input para cmd3
8. Ejecutar cmd3
9. Retornar PipelineResult con data = cmd3.data
```

**Reglas de composicion:**
- El output del comando N se pasa como `$input` al comando N+1
- Las referencias `$input.campo` se resuelven al valor correspondiente del output anterior
- Si un paso falla, el pipeline se aborta inmediatamente
- Los flags globales del primer comando aplican a todo el pipeline (si cmd1 tiene --dry-run, todo el pipeline es dry-run)
- Cada paso del pipeline se registra como entrada independiente en historial

### 1.7 Ejecucion Batch

```
Dado: batch [cmd1, cmd2, cmd3]

1. Para cada comando en la lista:
   a. Ejecutar pipeline completo de forma independiente
   b. Capturar ExecutionResult
   c. NO abortar si uno falla (ejecucion independiente)
2. Agregar resultados en BatchResult
3. code = 0 si todos exitosos, 1 si alguno fallo
```

**Reglas de batch:**
- Cada comando es independiente (no comparten estado)
- Un fallo en un comando NO afecta a los demas
- Los flags globales aplican individualmente a cada comando
- El orden de ejecucion es secuencial (indice 0, 1, 2...)
- Todos los comandos se registran en historial individualmente

### 1.8 Sistema de Undo

```
Dado: undo <historyId>

1. Buscar entrada en historial por historyId
2. Si no existe -> code=2 (not found)
3. Si el comando no es reversible -> code=1 (error: "command is not reversible")
4. Obtener la funcion de undo del command definition
5. Ejecutar la funcion de undo con los datos originales
6. Registrar el undo en historial como nueva entrada
7. Retornar ExecutionResult con el resultado del undo
```

**Reglas de undo:**
- Solo comandos que declaren `reversible: true` en su definicion soportan undo
- El undo se ejecuta con los mismos datos del comando original (almacenados en historial)
- Un undo es en si mismo un comando que se registra en historial
- No se soporta "undo del undo" (no hay redo)
- El undo tiene un TTL configurable (por defecto 1 hora desde la ejecucion original)

### 1.9 Inputs y Outputs

| Input | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| parseResult | ParseResult | Si | Estructura producida por el Parser |
| context | ExecutionContext | Si | Contexto de sesion (permisos, estado, config) |

| Output | Tipo | Descripcion |
|--------|------|-------------|
| result | ExecutionResult / BatchResult / PipelineResult | Resultado de la ejecucion |

### 1.10 ExecutionContext

```typescript
interface ExecutionContext {
  // Identidad y permisos
  sessionId: string;
  permissions: string[];          // Lista de permisos del contexto actual

  // Estado de sesion (context:set values)
  state: Record<string, any>;

  // Configuracion
  config: ExecutorConfig;

  // Historial (referencia al store)
  history: HistoryStore;

  // Seguridad (opcional, inyectable)
  auditLogger?: AuditLogger;      // Logger de auditoria (emite eventos tipados)
}

interface ExecutorConfig {
  timeout_ms: number;             // Timeout global por comando (default: 30000)
  maxPipelineDepth: number;       // Maximo de pasos en pipeline (default: 10)
  maxBatchSize: number;           // Maximo de comandos en batch (default: 20)
  undoTTL_ms: number;             // Tiempo maximo para hacer undo (default: 3600000)
  enableHistory: boolean;         // Si se registra en historial (default: true)
  confirmTTL_ms?: number;         // TTL de tokens de confirmacion (default: 300000 = 5min)
  rateLimit?: {                   // Rate limiting por sesion
    maxRequests: number;          // Maximo de requests en la ventana
    windowMs: number;             // Tamano de la ventana en ms
  };
}
```

### 1.11 Interfaz con Command Registry

```typescript
// Lo que el Executor espera del Command Registry
interface CommandDefinition {
  namespace: string;
  command: string;

  // Definicion de argumentos
  args: ArgDefinition[];

  // Metadata
  description: string;
  effect: string;                  // Descripcion del efecto (para dry-run/confirm)
  reversible: boolean;
  requiredPermissions: string[];

  // Handlers
  handler: (args: ValidatedArgs, input?: any) => Promise<any>;
  undoHandler?: (originalArgs: ValidatedArgs, originalResult: any) => Promise<any>;
  dryRunHandler?: (args: ValidatedArgs) => DryRunPreview;
}

interface ArgDefinition {
  name: string;
  type: "int" | "float" | "string" | "bool" | "date" | "json" | "enum" | "array";
  required: boolean;
  default?: any;
  constraints?: Record<string, any>;  // min, max, enum values, etc.
  enumValues?: string[];               // Para tipo enum
}

interface ValidatedArgs {
  [key: string]: any;             // Argumentos con tipos ya convertidos
}
```

### 1.12 Rate Limiting por Sesion

El Executor implementa rate limiting con sliding window para prevenir abuso:

```
Algoritmo: Sliding Window
1. Mantener array de timestamps de requests recientes
2. En cada execute():
   a. Filtrar timestamps fuera de la ventana (> windowMs ago)
   b. Si timestamps.length >= maxRequests -> retornar code=3, E_RATE_LIMITED
   c. Si no -> agregar timestamp actual y continuar pipeline
```

**Configuracion:**

```typescript
rateLimit: {
  maxRequests: 100,   // Maximo 100 requests...
  windowMs: 60000     // ...por minuto
}
```

**Comportamiento:**

- El rate limit se evalua ANTES del pipeline (antes de resolve)
- Si se excede, retorna `code: 3`, `error.type: "E_RATE_LIMITED"`
- Los timestamps se mantienen en memoria por instancia del Executor
- La ventana se desliza: solo se cuentan requests dentro de los ultimos `windowMs` ms
- Si `rateLimit` no esta configurado, no aplica limite

### 1.13 Confirm Token Lifecycle

Los tokens de confirmacion generados por modo `--confirm` tienen un ciclo de vida controlado:

```
1. GENERACION: Modo --confirm genera UUID como confirmToken
   -> Se almacena en pendingConfirms Map con {command, args, createdAt}

2. CONFIRMACION: cli_exec("confirm <token>")
   -> Buscar token en pendingConfirms
   -> Si existe y no expiro -> ejecutar comando original -> eliminar token
   -> Si no existe -> code=2, E_CONFIRM_INVALID
   -> Si expiro -> code=2, E_CONFIRM_INVALID (limpiado automatico)

3. EXPIRACION: Automatica via confirmTTL_ms
   -> cleanExpiredConfirms() se ejecuta al inicio de cada execute()
   -> Tokens con (now - createdAt) > confirmTTL_ms se eliminan
   -> Emite audit event 'confirm:expired'

4. REVOCACION MANUAL:
   -> revokeConfirm(token): Elimina un token especifico
   -> revokeAllConfirms(): Elimina todos los tokens pendientes
```

**API:**

```typescript
class Executor {
  /** Confirma y ejecuta un comando previamente previewed. */
  async confirm(token: string): Promise<ExecutionResult>;

  /** Revoca un token de confirmacion especifico. */
  revokeConfirm(token: string): boolean;

  /** Revoca todos los tokens de confirmacion pendientes. */
  revokeAllConfirms(): number;
}
```

### 1.14 Integracion con AuditLogger

Cuando `context.auditLogger` esta presente, el Executor emite eventos en puntos clave:

| Punto del pipeline | Evento emitido | Datos |
|--------------------|---------------|-------|
| Ejecucion exitosa (paso 7) | `command:executed` | `{command, args, duration_ms, mode}` |
| Handler lanza excepcion | `command:failed` | `{command, error: message}` |
| Permisos insuficientes (paso 3) | `permission:denied` | `{command, required, actual}` |
| Modo confirm genera token | `confirm:requested` | `{command, token}` |
| Token confirmado | `confirm:executed` | `{command, token}` |
| Token expira | `confirm:expired` | `{token, elapsed_ms}` |
| Handler excede timeout | `error:timeout` | `{command, timeout_ms}` |

---

## 2. Que NO debe hacer (MUST NOT)

### 2.1 Fuera de Alcance

- No parsear comandos (eso es del Parser)
- No aplicar filtros jq sobre el output (eso es del modulo JQ Filter)
- No realizar busqueda vectorial de comandos (eso es del Vector Index)
- No gestionar el transporte (stdio, HTTP, etc.)
- No implementar la logica de negocio de los comandos (eso esta en los handlers)
- No gestionar el context store directamente (solo leerlo via ExecutionContext)

### 2.2 Anti-patterns Prohibidos

- No ejecutar handlers sin pasar por todo el pipeline (resolve -> validate -> permissions -> mode -> execute)
- No capturar excepciones genericas y silenciarlas; siempre propagar como ExecutionError estructurado
- No mutar el ParseResult recibido (trabajar sobre copias)
- No mantener estado mutable entre ejecuciones diferentes (cada ejecucion es independiente excepto historial)
- No ejecutar handlers en el hilo principal sin timeout (siempre con proteccion de timeout)
- No confiar en los tipos de los argumentos del ParseResult (el parser pasa todo como string; el executor debe convertir tipos)
- No ejecutar undo sin verificar TTL y reversibilidad
- No registrar en historial ejecuciones de modos --dry-run, --validate, --confirm
- No exponer stack traces o detalles internos en los mensajes de error al agente

### 2.3 Restricciones de Implementacion

- No ejecutar comandos en paralelo dentro de un pipeline (son secuenciales por definicion)
- No ejecutar comandos batch en paralelo en v1 (secuencial para simplificar; paralelismo es mejora futura)
- No implementar retry automatico en handlers que fallan (eso es responsabilidad del agente)
- No cachear resultados de handlers (cada ejecucion es fresca)
- No modificar el Command Registry en runtime (es de solo lectura para el Executor)
- No implementar rate limiting por comando individual (el rate limit es global por sesion)

---

## 3. Como se que esta bien (ACCEPTANCE)

### 3.1 Criterios de Aceptacion

```gherkin
Feature: Ejecucion normal de comando simple

  DADO un ParseResult de tipo "single" con un comando valido
  Y el comando existe en el Command Registry
  Y los argumentos son validos
  Y el contexto tiene los permisos requeridos
  CUANDO se ejecuta el comando
  ENTONCES se invoca el handler del comando con los argumentos validados
  Y se retorna ExecutionResult con code=0 y data del handler
  Y se registra la ejecucion en historial

Feature: Modo --dry-run

  DADO un ParseResult con flags.dryRun=true
  Y el comando existe y los argumentos son validos
  CUANDO se ejecuta en modo dry-run
  ENTONCES NO se invoca el handler real
  Y se retorna code=0 con data describiendo lo que "haria"
  Y meta.mode es "dry-run"
  Y NO se registra en historial

Feature: Modo --validate

  DADO un ParseResult con flags.validate=true
  CUANDO se ejecuta en modo validate
  ENTONCES solo se validan existencia, argumentos y permisos
  Y se retorna code=0 con data.valid=true si todo es correcto
  Y meta.mode es "validate"
  Y NO se registra en historial

Feature: Modo --confirm

  DADO un ParseResult con flags.confirm=true
  Y el comando es valido
  CUANDO se ejecuta en modo confirm
  ENTONCES se retorna code=4 (requiere confirmacion)
  Y data contiene preview y confirmToken
  Y meta.mode es "confirm"
  Y NO se registra en historial

Feature: Confirmacion de comando

  DADO un confirmToken valido generado previamente por --confirm
  CUANDO se recibe "confirm <token>"
  ENTONCES se ejecuta el comando original con los argumentos almacenados
  Y se retorna ExecutionResult normal

Feature: Comando no encontrado

  DADO un ParseResult con un comando que no existe en el registry
  CUANDO se intenta ejecutar
  ENTONCES se retorna code=2
  Y error.type es "E_NOT_FOUND"
  Y error.message indica el comando que no se encontro

Feature: Argumentos invalidos

  DADO un ParseResult con argumentos que no cumplen la definicion del comando
  CUANDO se validan los argumentos
  ENTONCES se retorna code=1
  Y error.type es "E_INVALID_ARGS"
  Y error.details lista los argumentos invalidos con razon

Feature: Sin permisos

  DADO un comando que requiere permisos
  Y el contexto actual NO tiene esos permisos
  CUANDO se verifican permisos
  ENTONCES se retorna code=3
  Y error.type es "E_FORBIDDEN"
  Y error.message indica los permisos faltantes

Feature: Ejecucion de pipeline

  DADO un ParseResult de tipo "pipeline" con 2+ comandos
  CUANDO se ejecuta el pipeline
  ENTONCES los comandos se ejecutan en secuencia
  Y el output de cmd1 se pasa como $input a cmd2
  Y se retorna PipelineResult con data del ultimo comando

Feature: Pipeline con fallo intermedio

  DADO un pipeline donde el paso 2 falla
  CUANDO se ejecuta
  ENTONCES se aborta en el paso 2
  Y PipelineResult.meta.failedAt es 1 (indice 0-based)
  Y PipelineResult.error contiene el error del paso fallido
  Y los pasos posteriores NO se ejecutan

Feature: Ejecucion batch

  DADO un ParseResult de tipo "batch" con N comandos
  CUANDO se ejecuta el batch
  ENTONCES todos los comandos se ejecutan independientemente
  Y BatchResult.results contiene N ExecutionResult
  Y un fallo en un comando NO aborta los demas

Feature: Undo de comando reversible

  DADO un comando ejecutado previamente que es reversible
  Y el undo esta dentro del TTL
  CUANDO se ejecuta undo <historyId>
  ENTONCES se invoca el undoHandler del comando
  Y se retorna el resultado del undo
  Y se registra el undo en historial

Feature: Undo de comando no reversible

  DADO un comando ejecutado previamente que NO es reversible
  CUANDO se ejecuta undo <historyId>
  ENTONCES se retorna code=1
  Y error.message indica que el comando no es reversible

Feature: Timeout de handler

  DADO un handler que excede el timeout configurado
  CUANDO se ejecuta
  ENTONCES se cancela la ejecucion
  Y se retorna code=1
  Y error.type es "E_TIMEOUT"

Feature: Conversion de tipos de argumentos

  DADO un comando con args definidos como int, bool, date, etc.
  Y el ParseResult contiene los valores como strings
  CUANDO se validan los argumentos
  ENTONCES los valores se convierten al tipo correcto
  Y se pasan al handler ya tipados
```

### 3.2 Casos de Prueba Requeridos

| ID | Escenario | Input | Output Esperado | Prioridad |
|----|-----------|-------|-----------------|-----------|
| T01 | Comando simple exitoso | ParseResult(users:list) | code=0, data=[...users] | Alta |
| T02 | Comando con args nombrados | ParseResult(users:get --id 42) | code=0, data={user} | Alta |
| T03 | Comando no encontrado | ParseResult(fake:cmd) | code=2, E_NOT_FOUND | Alta |
| T04 | Arg requerido faltante | ParseResult(users:create) sin --name | code=1, E_INVALID_ARGS | Alta |
| T05 | Arg tipo incorrecto | ParseResult(users:get --id "abc") donde id es int | code=1, E_INVALID_ARGS | Alta |
| T06 | Sin permisos | ParseResult(admin:delete) sin permiso admin | code=3, E_FORBIDDEN | Alta |
| T07 | Modo dry-run | ParseResult(users:delete --id 5 --dry-run) | code=0, data.wouldExecute="users:delete" | Alta |
| T08 | Modo validate ok | ParseResult(users:get --id 1 --validate) | code=0, data.valid=true | Alta |
| T09 | Modo validate fallo | ParseResult(users:get --validate) sin args requeridos | code=1, E_INVALID_ARGS | Alta |
| T10 | Modo confirm | ParseResult(users:delete --id 5 --confirm) | code=4, data.confirmToken != null | Alta |
| T11 | Confirmacion con token valido | confirm <valid-token> | code=0, ejecuta comando original | Alta |
| T12 | Confirmacion con token invalido | confirm <invalid-token> | code=2, E_NOT_FOUND | Media |
| T13 | Pipeline 2 pasos exitoso | ParseResult(users:get --id 1 >> orders:list --user-id $input.id) | code=0, data=[...orders] | Alta |
| T14 | Pipeline con fallo en paso 1 | ParseResult(fake:cmd >> orders:list) | code=2, failedAt=0 | Alta |
| T15 | Pipeline con fallo en paso 2 | ParseResult(users:get --id 1 >> fake:cmd) | code=2, failedAt=1 | Alta |
| T16 | Pipeline resolucion de $input | ParseResult donde cmd2 usa $input.name) | cmd2 recibe valor de cmd1.data.name | Alta |
| T17 | Batch 3 comandos exitosos | batch [a:cmd, b:cmd, c:cmd] | code=0, 3 results, succeeded=3 | Alta |
| T18 | Batch con 1 fallo | batch [a:ok, b:fail, c:ok] | code=1, succeeded=2, failed=1 | Alta |
| T19 | Undo comando reversible | undo <id-de-users:create> | code=0, undo ejecutado | Alta |
| T20 | Undo comando no reversible | undo <id-de-users:list> | code=1, "not reversible" | Alta |
| T21 | Undo expirado (TTL) | undo <id-expirado> | code=1, "undo expired" | Media |
| T22 | Undo inexistente | undo <id-inexistente> | code=2, E_NOT_FOUND | Media |
| T23 | Timeout de handler | handler que tarda 60s, timeout=5s | code=1, E_TIMEOUT | Media |
| T24 | Historial se registra | Ejecucion normal exitosa | historyStore contiene entrada | Alta |
| T25 | Historial NO en dry-run | Ejecucion con --dry-run | historyStore NO contiene entrada | Alta |
| T26 | Conversion tipo int | arg definido int, valor "42" | handler recibe 42 (number) | Alta |
| T27 | Conversion tipo bool | arg "true" como string | handler recibe true (boolean) | Alta |
| T28 | Conversion tipo date | arg "2026-01-22" como string | handler recibe Date valido | Media |
| T29 | Arg con default | arg no enviado, default definido | handler recibe valor default | Alta |
| T30 | Constraint violado | arg --age "150" con constraint (1-120) | code=1, E_INVALID_ARGS | Media |
| T31 | Pipeline con --dry-run global | cmd1 --dry-run >> cmd2 | Todo el pipeline es dry-run | Media |
| T32 | Enum invalido | arg tipo enum("a","b"), valor "c" | code=1, E_INVALID_ARGS | Media |
| T33 | Arg multiple | --tag valor1 --tag valor2 (constraint multiple) | handler recibe ["valor1","valor2"] | Media |
| T34 | Batch vacio (0 commands) | ParseResult batch con 0 commands | code=1, "empty batch" | Baja |
| T35 | Pipeline profundidad maxima | Pipeline con 11 pasos (max=10) | code=1, "pipeline too deep" | Baja |

### 3.3 Metricas de Exito

- [ ] Tiempo de pipeline (sin handler): < 5ms para comando simple
- [ ] Overhead del Executor sobre el handler: < 10ms
- [ ] 100% de cobertura en los casos de prueba listados
- [ ] 0 ejecuciones sin pasar por pipeline completo (resolve->validate->permissions->mode->execute)
- [ ] 0 handlers ejecutados cuando el modo es dry-run, validate o confirm
- [ ] 100% de ejecuciones normales registradas en historial
- [ ] 0 ejecuciones de modos no-normales registradas en historial

### 3.4 Definition of Done

- [ ] Implementacion completa del pipeline de ejecucion (7 pasos)
- [ ] Los 4 modos de ejecucion implementados y testeados
- [ ] Composicion (pipeline >>) funcional con resolucion de $input
- [ ] Ejecucion batch funcional con agregacion de resultados
- [ ] Sistema de undo funcional con verificacion de TTL y reversibilidad
- [ ] Validacion de argumentos con conversion de tipos
- [ ] Verificacion de permisos
- [ ] Registro en historial para ejecuciones normales
- [ ] Todos los tests T01-T35 pasando
- [ ] Cobertura minima de tests: 90%
- [ ] Tipos exportados (ExecutionResult, BatchResult, PipelineResult, etc.) disponibles
- [ ] Timeout configurable en handlers
- [ ] Documentacion inline de la API publica
- [ ] Benchmark de overhead del executor

---

## 4. Que pasa si falla (ERROR HANDLING)

### 4.1 Errores Esperados

| Codigo | Tipo | Condicion | Mensaje (template) | Code Protocolo |
|--------|------|-----------|---------------------|----------------|
| E_NOT_FOUND | Comando no existe | namespace:command no esta en registry | "Command '{ns}:{cmd}' not found. Use 'search' to discover available commands." | 2 |
| E_INVALID_ARGS | Argumentos invalidos | Tipo incorrecto, requerido faltante, constraint violado | "Invalid arguments for '{cmd}': {details}" | 1 |
| E_MISSING_REQUIRED | Argumento requerido faltante | Arg marcado REQUIRED no presente y sin default | "Missing required argument '--{arg}' for '{cmd}'" | 1 |
| E_TYPE_MISMATCH | Tipo no convertible | Valor no puede convertirse al tipo esperado | "Argument '--{arg}' expects {expected_type}, got '{value}'" | 1 |
| E_CONSTRAINT_VIOLATED | Restriccion no cumplida | Valor fuera de rango, longitud, etc. | "Argument '--{arg}' violates constraint: {constraint}" | 1 |
| E_FORBIDDEN | Sin permisos | Contexto sin los permisos requeridos | "Permission denied: '{cmd}' requires [{perms}]" | 3 |
| E_CONFIRM_REQUIRED | Requiere confirmacion | Modo --confirm activo | "Confirmation required. Use 'confirm {token}' to proceed." | 4 |
| E_TIMEOUT | Handler excede timeout | Ejecucion supera timeout_ms | "Command '{cmd}' timed out after {ms}ms" | 1 |
| E_HANDLER_ERROR | Handler lanza excepcion | Error no controlado en handler | "Command '{cmd}' failed: {message}" | 1 |
| E_PIPELINE_DEPTH | Pipeline muy profundo | Mas pasos que maxPipelineDepth | "Pipeline exceeds maximum depth of {max} steps" | 1 |
| E_BATCH_SIZE | Batch muy grande | Mas comandos que maxBatchSize | "Batch exceeds maximum size of {max} commands" | 1 |
| E_UNDO_EXPIRED | Undo fuera de TTL | Tiempo desde ejecucion > undoTTL_ms | "Undo expired: command was executed {time} ago (max: {ttl})" | 1 |
| E_UNDO_NOT_REVERSIBLE | Comando no reversible | Comando no declara reversible:true | "Command '{cmd}' is not reversible" | 1 |
| E_CONFIRM_INVALID | Token de confirmacion invalido | Token no existe o ya fue usado | "Invalid or expired confirmation token" | 2 |
| E_INPUT_RESOLUTION | Error resolviendo $input | Campo referenciado no existe en output anterior | "Cannot resolve '$input.{field}': field not found in previous output" | 1 |
| E_RATE_LIMITED | Rate limit excedido | Mas de maxRequests en windowMs | "Rate limit exceeded: {count}/{max} requests in {window}ms window" | 3 |

### 4.2 Estrategia de Fallback

- Si un handler lanza una excepcion no tipada -> capturar, envolver en E_HANDLER_ERROR, retornar code=1
- Si el Command Registry no esta disponible -> retornar code=1 con E_HANDLER_ERROR indicando "registry unavailable"
- Si el historial no esta disponible -> ejecutar el comando normalmente pero loguear warning (no bloquear ejecucion)
- Si la conversion de tipos falla parcialmente -> reportar TODOS los errores de conversion de una vez (no solo el primero)

### 4.3 Logging y Monitoreo

- Nivel INFO: Cada ejecucion exitosa (comando, duracion, code)
- Nivel WARN: Ejecuciones con historial fallido, timeouts cercanos al limite
- Nivel ERROR: Handlers que lanzan excepciones, errores de permisos
- Nivel DEBUG: Detalle de cada paso del pipeline, resolucion de $input, conversion de tipos

Metricas a exponer:
- `executor.commands.total` (counter, por namespace:command)
- `executor.commands.success` (counter)
- `executor.commands.error` (counter, por tipo de error)
- `executor.commands.duration_ms` (histogram)
- `executor.pipeline.depth` (histogram)
- `executor.batch.size` (histogram)
- `executor.undo.total` (counter)
- `executor.undo.expired` (counter)
- `executor.timeout.total` (counter)

### 4.4 Recuperacion

- **Timeout**: Cancelar ejecucion del handler, liberar recursos, retornar error inmediatamente
- **Handler error**: Capturar excepcion, no reintentar, retornar error estructurado
- **Pipeline fallo**: Abortar pasos restantes, retornar resultado parcial hasta el fallo
- **Batch fallo parcial**: Continuar con los demas comandos, reportar fallos en resultado agregado
- **Historial no disponible**: Continuar sin registrar, loguear warning, marcar meta.historyId=null

---

## 5. Que supuestos tiene (ASSUMPTIONS)

### 5.1 Precondiciones

- [ ] El ParseResult recibido es valido (ya paso por el Parser sin errores)
- [ ] El Command Registry esta inicializado y disponible con todos los comandos registrados
- [ ] El ExecutionContext contiene un sessionId valido y una lista de permisos actualizada
- [ ] Los handlers registrados en el Command Registry son funciones async que retornan datos o lanzan excepciones
- [ ] El HistoryStore esta disponible para escritura (o se degrada gracefully)
- [ ] Los tipos definidos en ArgDefinition son los 8 tipos del protocolo (int, float, string, bool, date, json, enum, array)

### 5.2 Dependencias

| Dependencia | Tipo | Version | Critica |
|-------------|------|---------|---------|
| Parser | Modulo interno | 1.0 | Si (provee ParseResult) |
| Command Registry | Modulo interno | 1.0 | Si (provee CommandDefinition) |
| History Store | Modulo interno | 1.0 | No (degrada gracefully) |
| ExecutionContext | Estructura | 1.0 | Si (provee permisos y config) |
| Security | Modulo interno | 1.0 | No (AuditLogger, maskSecrets) |
| UUID generator | Utilidad | - | No (para confirmTokens) |
| Timer/Clock | Utilidad | - | No (para timestamps y TTL) |

### 5.3 Datos de Entrada Esperados

- ParseResult: Estructura TypeScript valida segun contrato del Parser
- CommandArgs: Todos los valores son strings (la conversion de tipos es responsabilidad del Executor)
- Permisos: Array de strings en formato "namespace:action" (ej: "users:delete", "admin:*")
- ConfirmToken: UUID v4 como string

### 5.4 Estado del Sistema

- El Command Registry es inmutable durante la vida del Executor (se carga al inicio)
- Los handlers no modifican el estado del Executor ni del Registry
- El historial es append-only (nunca se modifican entradas existentes)
- Los confirmTokens tienen un TTL configurable via `confirmTTL_ms` (default: 5 minutos)
- El contexto de sesion puede cambiar entre ejecuciones (nuevos permisos, estado actualizado)

---

## 6. Que limites tiene (CONSTRAINTS)

### 6.1 Limites Tecnicos

- Timeout maximo por handler: configurable, default 30 segundos
- Profundidad maxima de pipeline: 10 pasos
- Tamano maximo de batch: 20 comandos
- TTL de undo: configurable, default 1 hora
- TTL de confirmToken: 5 minutos
- Tamano maximo de data en ExecutionResult: sin limite explicito (depende del handler)
- Tamano maximo de entrada en historial: 10KB (truncar data si excede)
- Historial maximo por sesion: 1000 entradas (FIFO si se excede)
- Concurrencia: una ejecucion a la vez por sesion (no hay paralelismo intra-sesion)

### 6.2 Limites de Negocio

- Solo los 5 codigos de error del protocolo son validos (0, 1, 2, 3, 4)
- Un comando con --confirm NO se ejecuta hasta recibir el token de confirmacion
- El undo solo aplica a la ultima ejecucion de un comando (no a ejecuciones anteriores del mismo)
- Los permisos se verifican en el momento de la ejecucion (no al parsear)
- Un handler no puede ejecutar otros comandos del shell (no hay recursion)

### 6.3 Limites de Seguridad

- Los handlers se ejecutan en un sandbox logico (no pueden acceder al filesystem del host directamente)
- Los mensajes de error NO exponen stack traces ni rutas internas
- Los confirmTokens son UUIDs no predecibles
- Los datos del historial no incluyen valores de argumentos marcados como "sensitive" en la definicion
- Los permisos se verifican en CADA ejecucion (no se cachean entre comandos)
- El executor NO evalua expresiones dinamicas en argumentos (prevencion de inyeccion)
- Los argumentos se sanitizan despues de la conversion de tipo (null bytes, etc.)

### 6.4 Limites de Alcance (esta version)

- Esta version NO incluye:
  - Ejecucion paralela de batch (es secuencial)
  - Retry automatico de handlers fallidos
  - Cache de resultados
  - Rate limiting por comando individual (solo global por sesion)
  - Hooks pre/post ejecucion (middleware pattern)
  - Transacciones en pipelines (rollback si paso N falla)
  - Redo (deshacer un undo)
  - Ejecucion condicional en pipelines (if/else basado en output)
  - Streaming de resultados (todo es request/response)
- Lo que SI incluye (v1.1):
  - Rate limiting global por sesion (sliding window)
  - Confirm token lifecycle (TTL, revocacion manual)
  - Integracion con AuditLogger (eventos tipados)
  - Secret masking en historial (via maskSecrets)
- Consideraciones futuras:
  - Batch paralelo con control de concurrencia
  - Middleware hooks para logging, metricas, transformacion
  - Pipeline transaccional con rollback automatico
  - Prioridad de comandos en batch
  - Ejecucion distribuida para handlers pesados

---

## 7. Codigos de Estado del Protocolo

### 7.1 Tabla de Codigos

| Code | Significado | Cuando se usa | Accion esperada del agente |
|------|-------------|---------------|---------------------------|
| 0 | Exito | Comando ejecutado correctamente | Usar data del resultado |
| 1 | Error de entrada/ejecucion | Syntax, tipos, constraints, timeout, handler error | Corregir argumentos o reportar error |
| 2 | No encontrado | Comando no existe en registry, token invalido | Usar `search` para descubrir comandos |
| 3 | Sin permisos | Contexto no tiene permisos requeridos | Informar al usuario sobre permisos |
| 4 | Requiere confirmacion | Modo --confirm activo | Ejecutar `confirm <token>` o cancelar |

### 7.2 Mapeo de Errores Internos a Codigos

```
code=0: Ejecucion exitosa (todos los modos cuando pasan)
code=1: E_INVALID_ARGS, E_MISSING_REQUIRED, E_TYPE_MISMATCH, E_CONSTRAINT_VIOLATED,
        E_TIMEOUT, E_HANDLER_ERROR, E_PIPELINE_DEPTH, E_BATCH_SIZE,
        E_UNDO_EXPIRED, E_UNDO_NOT_REVERSIBLE, E_INPUT_RESOLUTION
code=2: E_NOT_FOUND, E_CONFIRM_INVALID
code=3: E_FORBIDDEN, E_RATE_LIMITED
code=4: E_CONFIRM_REQUIRED
```

---

## 8. Diagrama de Decision del Executor

```
                         ParseResult
                             |
                             v
                    +--------+--------+
                    |    type?        |
                    +---+----+----+---+
                        |    |    |
                  single | pipeline | batch
                        |    |    |
                        v    |    v
                   [Execute  |  [Execute each
                    Single]  |   independently]
                        |    |        |
                        |    v        v
                        | [Execute    BatchResult
                        |  Sequential]
                        |      |
                        |      v
                        | PipelineResult
                        v
                   [1. RESOLVE]
                        |
                   found? --NO--> code=2
                        |
                       YES
                        |
                        v
                   [2. VALIDATE ARGS]
                        |
                   valid? --NO--> code=1
                        |
                       YES
                        |
                        v
                   [3. CHECK PERMISSIONS]
                        |
                   allowed? --NO--> code=3
                        |
                       YES
                        |
                        v
                   [4. APPLY MODE]
                        |
               +--------+--------+--------+
               |        |        |        |
           validate  dry-run  confirm  normal
               |        |        |        |
               v        v        v        v
           code=0    code=0   code=4  [5. EXECUTE]
           return    return   return       |
                                           v
                                      success? --NO--> code=1
                                           |
                                          YES
                                           |
                                           v
                                      [6. RECORD HISTORY]
                                           |
                                           v
                                      [7. RETURN code=0]
```

---

## Anexos

### A. Glosario

| Termino | Definicion |
|---------|------------|
| Handler | Funcion que implementa la logica de un comando |
| Pipeline | Secuencia de comandos donde el output de uno es input del siguiente |
| Batch | Ejecucion de multiples comandos independientes en una sola llamada |
| Dry-run | Modo de simulacion que describe lo que haria sin ejecutar |
| Validate | Modo que solo verifica sintaxis, tipos y permisos |
| Confirm | Modo que genera preview y espera confirmacion explicita |
| ConfirmToken | UUID temporal que autoriza la ejecucion de un comando previewed |
| TTL | Time To Live; tiempo maximo de validez de un token o undo |
| Undo | Reversion de un comando previamente ejecutado |
| Command Registry | Registro de todos los comandos con sus definiciones y handlers |
| ExecutionContext | Objeto que contiene sesion, permisos, estado y configuracion |
| $input | Referencia al output del comando anterior en un pipeline |

### B. Referencias

- PRD Agent Shell: `d:/repos/agent-shell/docs/prd.md`
- Contrato del Parser: `d:/repos/agent-shell/contracts/parser.md`
- Protocolo de Interaccion: Seccion "Especificacion del Protocolo" del PRD
- Codigos de error: Seccion "Errores" del PRD

### C. Historial de Cambios

| Version | Fecha | Autor | Cambios |
|---------|-------|-------|---------|
| 1.0 | 2026-01-22 | Specification Architect | Version inicial basada en PRD v1 y contrato Parser v1 |
| 1.1 | 2026-01-23 | Specification Architect | Agregado: rate limiting (1.12), confirm token lifecycle (1.13), integracion AuditLogger (1.14), auditLogger en ExecutionContext, confirmTTL_ms y rateLimit en ExecutorConfig, E_RATE_LIMITED |

---

## 9. Estado de Implementación v1.0

### Implementado
- Modos: normal, dry-run, validate, confirm
- Pipeline con encadenamiento de output → input
- Batch paralelo con resultados individuales
- Confirm tokens con TTL y revocacion
- Rate limiting con ventana deslizante
- Undo via historial
- Timeout configurable por handler
- Validacion de tipos: string, int, float, bool, json, date, enum, array
- Error E_CONFIRM_EXPIRED (adicional al contrato)
- PipelineStep incluye campo `mode` (adicional al contrato)

### Implementado (v1.1)
- `revokeConfirm()` ahora retorna `boolean` (true si revocado, false si no existe)
- `revokeAllConfirms()` ahora retorna `number` (cantidad revocada)
- Validacion de batch size limit (maxBatchSize) enforzada
- Constraint validation para float (min/max), string (minLength/maxLength), array (minItems/maxItems)

### Discrepancias con contrato
- Modo validate no incluye campo `permissions` en respuesta
- Modo dry-run no incluye `estimatedOutput`
- Modo confirm no incluye `warning` en preview

### Pendiente
- Campo `details` en error E_INVALID_ARGS
- Campo `estimatedOutput` en dry-run response
- Campo `permissions` en validate response
- Campo `warning` en confirm preview
