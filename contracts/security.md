# Contrato: SECURITY

> **Version**: 1.0
> **Fecha**: 2026-01-23
> **Estado**: Draft
> **Autor**: Specification Architect
> **Modulo**: Security (Agent Shell)

## Resumen Ejecutivo

El modulo Security provee servicios transversales de seguridad a Agent Shell: audit logging de eventos tipados, control de acceso basado en roles (RBAC) con herencia, deteccion y masking de secretos en valores, y encriptacion at-rest de datos de sesion. Todos los componentes son inyectables y configurables, con cero dependencias externas (usa `node:crypto` y `node:events`).

---

## 1. Que debe hacer (MUST DO)

### 1.1 Objetivo Principal

Proveer una capa transversal de seguridad que permita a los demas modulos (Executor, ContextStore) auditar acciones, controlar acceso, proteger credenciales en datos y encriptar informacion persistida, sin acoplar la logica de seguridad a la logica de negocio.

### 1.2 Funcionalidades Requeridas

- [ ] **Audit Logging**: Emitir eventos tipados para acciones relevantes de seguridad
- [ ] **RBAC**: Resolver permisos efectivos a partir de roles con herencia
- [ ] **Secret Detection**: Detectar patrones de credenciales en valores arbitrarios
- [ ] **Secret Masking**: Reemplazar credenciales detectadas con placeholders seguros
- [ ] **Encrypted Storage**: Encriptar/desencriptar datos de sesion de forma transparente

### 1.3 Componentes

#### 1.3.1 AuditLogger

Logger basado en EventEmitter que emite eventos tipados de auditoria.

```typescript
class AuditLogger extends EventEmitter {
  constructor(sessionId: string);

  /** Emite un evento de auditoria tipado. */
  audit(type: AuditEventType, data: Record<string, any>): void;

  /** Registra un listener para un tipo de evento o wildcard '*'. */
  onAudit(type: AuditEventType | '*', listener: AuditListener): this;
}
```

**Tipos de evento (AuditEventType):**

| Tipo | Cuando se emite | Datos tipicos |
|------|-----------------|---------------|
| `command:executed` | Comando ejecutado exitosamente | `{command, args, duration_ms}` |
| `command:failed` | Handler lanza excepcion o timeout | `{command, error, duration_ms}` |
| `permission:denied` | Contexto sin permisos requeridos | `{command, required, actual}` |
| `confirm:requested` | Modo --confirm genera token | `{command, token}` |
| `confirm:executed` | Token de confirmacion usado | `{command, token}` |
| `confirm:expired` | Token expira sin ser usado | `{token, elapsed_ms}` |
| `session:created` | Nueva sesion iniciada | `{sessionId}` |
| `session:expired` | Sesion expira por TTL | `{sessionId, elapsed_ms}` |
| `error:handler` | Error no controlado en handler | `{command, error}` |
| `error:timeout` | Handler excede timeout | `{command, timeout_ms}` |

**Estructura del evento emitido:**

```typescript
interface AuditEvent {
  type: AuditEventType;
  timestamp: string;         // ISO 8601
  sessionId: string;
  data: Record<string, any>;
}
```

**Inyeccion:**

El AuditLogger se inyecta via `ExecutionContext.auditLogger` al Executor. El Executor emite eventos en los puntos relevantes del pipeline.

#### 1.3.2 RBAC (Role-Based Access Control)

Sistema de roles con permisos y herencia para verificar acceso a comandos.

```typescript
class RBAC {
  constructor(config: RBACConfig);

  /** Resuelve todos los permisos para un contexto (roles + directos). */
  resolvePermissions(context: RBACContext): string[];

  /** Verifica si un rol existe en la configuracion. */
  hasRole(roleName: string): boolean;

  /** Retorna todos los nombres de roles registrados. */
  getRoles(): string[];

  /** Retorna los permisos directos de un rol (sin herencia). */
  getRolePermissions(roleName: string): string[];
}
```

**Tipos:**

```typescript
interface Role {
  name: string;
  permissions: string[];
  inherits?: string[];       // Roles padre de los que hereda permisos
}

interface RBACConfig {
  roles: Role[];
  defaultRole?: string;      // Rol asignado si no se especifica
}

interface RBACContext {
  roles: string[];           // Roles activos del contexto
  permissions?: string[];    // Permisos directos adicionales
}
```

**Herencia de roles:**

- La resolucion es recursiva con proteccion contra ciclos (visited set)
- Un rol hereda todos los permisos de sus roles padre
- Los permisos directos del contexto se suman a los heredados
- No se soporta herencia negativa (no se pueden revocar permisos heredados)

**Formato de permisos:**

- Formato: `namespace:action` (ej: `users:delete`, `admin:configure`)
- Wildcard: No soportado en v1.0 (evaluacion futura: `users:*`)

#### 1.3.3 Secret Detection & Masking

Funciones para detectar y ofuscar credenciales en valores arbitrarios.

```typescript
/** Reemplaza secretos con placeholders [REDACTED:tipo]. */
function maskSecrets(value: any, patterns?: SecretPattern[]): any;

/** Detecta si un valor contiene patrones de secretos. */
function containsSecret(value: any, patterns?: SecretPattern[]): boolean;
```

**Patrones por defecto (DEFAULT_SECRET_PATTERNS):**

| Nombre | Detecta | Replacement |
|--------|---------|-------------|
| `api-key-generic` | `api_key=...`, `apiKey: "..."` | `[REDACTED:api-key]` |
| `bearer-token` | `Bearer eyJ...` | `Bearer [REDACTED]` |
| `password-field` | `password=...`, `pwd: "..."` | `[REDACTED:password]` |
| `aws-key` | `AKIA...` (16 chars alfanum) | `[REDACTED:aws-key]` |
| `jwt` | `eyJ...eyJ...signature` | `[REDACTED:jwt]` |
| `private-key` | `-----BEGIN PRIVATE KEY-----` | `[REDACTED:private-key]` |
| `hex-secret-32plus` | `secret=a1b2c3...` (32+ hex) | `[REDACTED:secret]` |

**Comportamiento de `maskSecrets`:**

- Recorre recursivamente objetos y arrays
- Aplica todos los patrones sobre valores string
- Valores no-string (number, boolean, null) pasan sin modificar
- Retorna copia nueva (no muta el input)
- Los patrones regex usan flag `g` y resetean `lastIndex` antes de cada uso

**Integracion con ContextStore:**

- `ContextStore.recordCommand()` aplica `maskSecrets()` automaticamente a args y resultados antes de persistir en historial
- Config `secretDetection.mode`:
  - `'warn'`: Permite set pero emite warning
  - `'reject'`: Bloquea el set y retorna error

#### 1.3.4 EncryptedStorageAdapter

Decorator que encripta/desencripta datos antes de delegar a otro StorageAdapter.

```typescript
class EncryptedStorageAdapter implements StorageAdapter {
  constructor(inner: StorageAdapter, config: EncryptionConfig);

  readonly name: string;     // "encrypted(<inner.name>)"

  // Delega todas las operaciones al inner adapter,
  // encriptando en save() y desencriptando en load()
  initialize(session_id: string): Promise<void>;
  load(session_id: string): Promise<SessionStore | null>;
  save(session_id: string, store: SessionStore): Promise<void>;
  destroy(session_id: string): Promise<void>;
  healthCheck(): Promise<boolean>;
  dispose(): Promise<void>;
}
```

**Configuracion:**

```typescript
interface EncryptionConfig {
  key: Buffer;               // Clave de 32 bytes para AES-256
  algorithm?: string;        // Default: 'aes-256-gcm'
}
```

**Payload encriptado:**

```typescript
interface EncryptedPayload {
  _encrypted: true;          // Flag para backward compatibility
  iv: string;                // IV aleatorio (12 bytes, base64)
  tag: string;               // Authentication tag (base64)
  data: string;              // Ciphertext (base64)
}
```

**Caracteristicas:**

- Algoritmo: AES-256-GCM (AEAD - Authenticated Encryption with Associated Data)
- IV: 12 bytes aleatorios por operacion (`randomBytes(12)`)
- Authentication tag: Verifica integridad y autenticidad
- Backward compatible: Si `load()` encuentra datos sin `_encrypted: true`, los retorna sin descifrar
- Validacion: Lanza error si la clave no es exactamente 32 bytes

---

## 2. Que NO debe hacer (MUST NOT)

### 2.1 Fuera de Alcance

- No implementar autenticacion de usuarios (responsabilidad del gateway/transporte)
- No gestionar sesiones (responsabilidad del ContextStore)
- No ejecutar comandos ni aplicar politicas de bloqueo directamente (solo informar)
- No almacenar logs en disco (solo emitir eventos; la persistencia es responsabilidad del consumidor)
- No implementar key management o key rotation (la clave se provee externamente)
- No implementar rate limiting (responsabilidad del Executor)

### 2.2 Anti-patterns Prohibidos

- No usar singleton global para el AuditLogger -> Crear instancia por sesion
- No almacenar secretos en el AuditEvent.data -> Aplicar maskSecrets antes de emitir
- No cachear resultados de resolvePermissions -> Calcular en cada llamada (permisos pueden cambiar)
- No mutar patrones de secretos globales -> DEFAULT_SECRET_PATTERNS es constante
- No hardcodear claves de encriptacion -> Recibir via config inyectada
- No usar modos ECB o CBC sin autenticacion -> Solo GCM u otros modos AEAD

### 2.3 Restricciones de Implementacion

- Cero dependencias externas (solo `node:crypto` y `node:events`)
- No bloquear el event loop en operaciones de encriptacion (los datos de sesion son pequenos)
- No exponer la clave de encriptacion en logs, errores o eventos de auditoria
- Los patrones regex deben ser stateless (resetear `lastIndex` antes de cada uso)

---

## 3. Como se que esta bien (ACCEPTANCE)

### 3.1 Criterios de Aceptacion

```gherkin
Feature: AuditLogger

  Scenario: Emitir evento tipado
    DADO un AuditLogger con sessionId "sess-1"
    CUANDO llamo audit('command:executed', {command: 'users:list'})
    ENTONCES se emite un evento con type='command:executed'
    Y timestamp es un ISO 8601 valido
    Y sessionId es "sess-1"
    Y data contiene {command: 'users:list'}

  Scenario: Wildcard listener
    DADO un AuditLogger con listener en '*'
    CUANDO se emiten eventos de tipo 'command:executed' y 'command:failed'
    ENTONCES el listener '*' recibe ambos eventos

  Scenario: Listener tipado
    DADO un AuditLogger con listener en 'permission:denied'
    CUANDO se emite un evento 'command:executed'
    ENTONCES el listener NO es invocado

Feature: RBAC

  Scenario: Resolucion simple de permisos
    DADO un RBAC con rol 'viewer' = ['users:read', 'orders:read']
    Y un contexto con roles=['viewer']
    CUANDO llamo resolvePermissions(context)
    ENTONCES retorna ['users:read', 'orders:read']

  Scenario: Herencia de roles
    DADO un RBAC con:
      - rol 'viewer' = ['users:read']
      - rol 'editor' = ['users:write'], inherits=['viewer']
    Y un contexto con roles=['editor']
    CUANDO llamo resolvePermissions(context)
    ENTONCES retorna ['users:write', 'users:read']

  Scenario: Herencia circular (proteccion)
    DADO un RBAC con:
      - rol 'a' inherits=['b']
      - rol 'b' inherits=['a']
    Y un contexto con roles=['a']
    CUANDO llamo resolvePermissions(context)
    ENTONCES NO entra en loop infinito
    Y retorna los permisos de ambos roles

  Scenario: Permisos directos en contexto
    DADO un contexto con roles=['viewer'] y permissions=['admin:config']
    CUANDO llamo resolvePermissions(context)
    ENTONCES retorna permisos del rol viewer MAS 'admin:config'

  Scenario: Rol inexistente
    DADO un contexto con roles=['nonexistent']
    CUANDO llamo resolvePermissions(context)
    ENTONCES retorna array vacio (o solo permisos directos)

Feature: Secret Detection

  Scenario: Detectar API key
    DADO el valor "api_key=sk_live_abc123def456ghi789"
    CUANDO llamo containsSecret(value)
    ENTONCES retorna true

  Scenario: Masking de API key
    DADO el valor "config: api_key=sk_live_abc123def456ghi789"
    CUANDO llamo maskSecrets(value)
    ENTONCES retorna "config: [REDACTED:api-key]"

  Scenario: Masking recursivo en objeto
    DADO el valor {auth: "Bearer eyJtoken...", name: "John"}
    CUANDO llamo maskSecrets(value)
    ENTONCES auth es "Bearer [REDACTED]"
    Y name es "John" (sin modificar)

  Scenario: Valor sin secretos
    DADO el valor "hello world"
    CUANDO llamo containsSecret(value)
    ENTONCES retorna false

  Scenario: Patrones custom
    DADO patrones personalizados [{name: 'custom', pattern: /SECRET-\d+/g, ...}]
    CUANDO llamo maskSecrets("val: SECRET-12345", customPatterns)
    ENTONCES aplica el patron custom

Feature: EncryptedStorageAdapter

  Scenario: Encrypt y decrypt roundtrip
    DADO un EncryptedStorageAdapter con clave valida de 32 bytes
    CUANDO llamo save(sessionId, store) y luego load(sessionId)
    ENTONCES el store retornado es identico al original

  Scenario: Backward compatibility
    DADO datos sin flag _encrypted en el inner adapter
    CUANDO llamo load(sessionId)
    ENTONCES retorna los datos sin intentar descifrar

  Scenario: Clave invalida (no 32 bytes)
    CUANDO creo un EncryptedStorageAdapter con clave de 16 bytes
    ENTONCES lanza Error "Encryption key must be exactly 32 bytes for AES-256"

  Scenario: IV unico por operacion
    DADO dos llamadas consecutivas a save() con los mismos datos
    CUANDO inspecciono los payloads encriptados
    ENTONCES tienen IVs diferentes

  Scenario: Integridad (AEAD)
    DADO un payload encriptado almacenado
    CUANDO modifico un byte del campo 'data'
    ENTONCES load() lanza error de autenticacion
```

### 3.2 Casos de Prueba Requeridos

| ID | Componente | Escenario | Prioridad |
|----|-----------|-----------|-----------|
| T01 | AuditLogger | Emite evento con estructura correcta | Alta |
| T02 | AuditLogger | Wildcard '*' recibe todos los eventos | Alta |
| T03 | AuditLogger | Listener tipado solo recibe su tipo | Alta |
| T04 | AuditLogger | Multiples listeners en mismo tipo | Media |
| T05 | RBAC | Resolucion simple sin herencia | Alta |
| T06 | RBAC | Herencia de un nivel | Alta |
| T07 | RBAC | Herencia multinivel (A->B->C) | Alta |
| T08 | RBAC | Proteccion contra herencia circular | Alta |
| T09 | RBAC | Permisos directos en contexto | Alta |
| T10 | RBAC | Rol inexistente retorna vacio | Media |
| T11 | RBAC | hasRole/getRoles/getRolePermissions | Media |
| T12 | SecretPatterns | Detecta api-key-generic | Alta |
| T13 | SecretPatterns | Detecta bearer-token | Alta |
| T14 | SecretPatterns | Detecta password-field | Alta |
| T15 | SecretPatterns | Detecta aws-key (AKIA...) | Alta |
| T16 | SecretPatterns | Detecta JWT | Alta |
| T17 | SecretPatterns | Detecta private-key header | Media |
| T18 | SecretPatterns | Detecta hex-secret 32+ chars | Media |
| T19 | SecretPatterns | maskSecrets recursivo en objetos | Alta |
| T20 | SecretPatterns | maskSecrets en arrays | Alta |
| T21 | SecretPatterns | containsSecret retorna false para limpio | Alta |
| T22 | SecretPatterns | Patrones custom override | Media |
| T23 | EncryptedAdapter | Roundtrip encrypt/decrypt | Alta |
| T24 | EncryptedAdapter | Backward compatibility sin _encrypted | Alta |
| T25 | EncryptedAdapter | Error en clave != 32 bytes | Alta |
| T26 | EncryptedAdapter | IV diferente por operacion | Alta |
| T27 | EncryptedAdapter | AEAD detecta tamper | Alta |
| T28 | EncryptedAdapter | Delegate initialize/destroy/healthCheck/dispose | Media |

### 3.3 Metricas de Exito

- [ ] AuditLogger: Emision de evento < 0.1ms (no I/O)
- [ ] RBAC: Resolucion de permisos < 1ms para grafos de hasta 50 roles
- [ ] SecretPatterns: maskSecrets < 1ms para objetos de hasta 10KB
- [ ] EncryptedAdapter: Encrypt/decrypt < 5ms para stores de hasta 1MB
- [ ] 0 secretos expuestos en historial (100% masking en recordCommand)
- [ ] 0 datos no encriptados en storage cuando EncryptedAdapter esta activo

### 3.4 Definition of Done

- [ ] AuditLogger implementado con los 10 tipos de evento
- [ ] RBAC implementado con herencia recursiva y proteccion contra ciclos
- [ ] 7 patrones de secretos implementados y testeados
- [ ] maskSecrets recursivo para string/object/array
- [ ] containsSecret detecta al menos los 7 patrones default
- [ ] EncryptedStorageAdapter con AES-256-GCM y backward compatibility
- [ ] Todos los tests T01-T28 pasando
- [ ] Cobertura minima de tests: 90%
- [ ] Tipos exportados disponibles via `src/security/index.ts`
- [ ] Cero dependencias externas

---

## 4. Que pasa si falla (ERROR HANDLING)

### 4.1 Errores Esperados

| Componente | Error | Condicion | Comportamiento |
|-----------|-------|-----------|----------------|
| AuditLogger | EventEmitter error | Listener lanza excepcion | No afecta al caller; el error se propaga via EventEmitter 'error' |
| RBAC | Rol no encontrado | Nombre de rol no existe en config | Se ignora silenciosamente (no se suman permisos) |
| RBAC | Herencia circular | Rol A hereda B, B hereda A | Proteccion via visited set, no loop infinito |
| SecretPatterns | Regex catastrofica | Pattern con backtracking excesivo | Los patrones default estan optimizados; patrones custom son responsabilidad del usuario |
| EncryptedAdapter | Clave invalida | Buffer != 32 bytes | Throw Error en constructor (fail-fast) |
| EncryptedAdapter | Datos corruptos | Payload modificado post-cifrado | Error de autenticacion en decrypt (GCM tag mismatch) |
| EncryptedAdapter | Inner adapter falla | Backend subyacente no disponible | Propaga el error del inner adapter |

### 4.2 Estrategia de Fallback

- **AuditLogger**: Si un listener falla, los demas listeners no se afectan (EventEmitter default)
- **RBAC**: Si la config es vacia, resolvePermissions retorna solo permisos directos del contexto
- **SecretPatterns**: Si un patron individual falla (regex error), los demas patrones se siguen aplicando
- **EncryptedAdapter**: No hay fallback a unencrypted; si la desencriptacion falla, se propaga el error

### 4.3 Logging y Monitoreo

El modulo Security NO hace logging propio (para evitar dependencias circulares). Los consumidores (Executor, ContextStore) son responsables de loguear cuando interactuan con Security.

Metricas sugeridas para consumidores:
- `security.audit.events_total` (counter, por tipo)
- `security.rbac.denials_total` (counter)
- `security.secrets.detected_total` (counter)
- `security.encryption.operations_total` (counter, encrypt/decrypt)
- `security.encryption.errors_total` (counter)

---

## 5. Que supuestos tiene (ASSUMPTIONS)

### 5.1 Precondiciones

- [ ] La clave de encriptacion se provee externamente (no se genera internamente)
- [ ] Los patrones de secretos DEFAULT_SECRET_PATTERNS cubren los casos mas comunes
- [ ] El AuditLogger se instancia una vez por sesion y se inyecta al Executor
- [ ] La configuracion RBAC se carga al inicio y no cambia durante la vida del proceso
- [ ] Los datos a encriptar caben en memoria (< 10MB por sesion)

### 5.2 Dependencias

| Dependencia | Tipo | Critica | Notas |
|-------------|------|---------|-------|
| `node:crypto` | Runtime | Si | Para AES-256-GCM y randomBytes |
| `node:events` | Runtime | Si | Para EventEmitter del AuditLogger |
| StorageAdapter | Interface interna | Si | Inner adapter para EncryptedStorageAdapter |

### 5.3 Estado del Sistema

- El AuditLogger es stateless excepto por el sessionId (no acumula eventos)
- El RBAC es inmutable despues de la construccion (la config de roles no cambia)
- Los patrones de secretos son constantes (DEFAULT_SECRET_PATTERNS no se muta)
- El EncryptedStorageAdapter no mantiene estado propio (delega todo al inner)

---

## 6. Que limites tiene (CONSTRAINTS)

### 6.1 Limites Tecnicos

- Tamano maximo de datos a encriptar: Limitado por memoria disponible (recomendado < 10MB)
- Patrones de secretos: 7 patrones por defecto (extensible via config)
- Longitud minima para deteccion: 20 caracteres para API keys, 4 para passwords
- AES-256-GCM: IV de 12 bytes, tag de 16 bytes, clave de 32 bytes
- RBAC: Sin limite de roles o niveles de herencia (protegido contra ciclos)

### 6.2 Limites de Seguridad

- No se soporta key rotation automatica (cambio de clave requiere re-encriptar)
- Los patrones de secretos son heuristicos (pueden tener falsos positivos/negativos)
- El masking es unidireccional (no se puede recuperar el valor original)
- La clave de encriptacion no se valida contra debilidad (responsabilidad del generador)
- No hay proteccion contra timing attacks en la comparacion de tags (usa crypto nativo)

### 6.3 Limites de Alcance (Version 1.0)

- Esta version NO incluye:
  - Wildcards en permisos (`users:*`)
  - Permisos a nivel de recurso (`users:delete:123`)
  - Key rotation automatica
  - HSM/KMS integration para claves
  - Audit log persistence (solo EventEmitter in-memory)
  - Patrones de secretos configurables por sesion
  - Rate limiting (es del Executor)
  - Compliance reporting

---

## 7. Relacion con Otros Modulos

| Modulo | Relacion | Detalle |
|--------|----------|---------|
| Executor | Consume AuditLogger | Emite eventos en cada paso del pipeline |
| Executor | Consume RBAC | Verifica permisos en paso CHECK_PERMISSIONS |
| ContextStore | Consume maskSecrets | Aplica masking en recordCommand() |
| ContextStore | Consume containsSecret | Detecta secretos en set() segun config |
| ContextStore | Usa EncryptedStorageAdapter | Envuelve cualquier StorageAdapter con encriptacion |

---

## Anexos

### A. Glosario

| Termino | Definicion |
|---------|------------|
| AEAD | Authenticated Encryption with Associated Data - modo que provee confidencialidad e integridad |
| AES-256-GCM | Algoritmo de cifrado simetrico con modo Galois/Counter |
| IV | Initialization Vector - nonce aleatorio para cada operacion de cifrado |
| RBAC | Role-Based Access Control - control de acceso basado en roles |
| Masking | Proceso de reemplazar valores sensibles con placeholders |
| Decorator | Patron de diseno que envuelve un objeto agregando comportamiento |

### B. Referencias

- PRD Agent Shell: `docs/prd.md` - Seccion "Security como Gateway Centralizado"
- Roadmap: `docs/roadmap.md` - Fases 1-4 de seguridad
- ContextStore contract: `contracts/context-store.md`
- Executor contract: `contracts/executor.md`

### C. Historial de Cambios

| Version | Fecha | Autor | Cambios |
|---------|-------|-------|---------|
| 1.0 | 2026-01-23 | Specification Architect | Version inicial basada en implementacion real |

---

## 9. Estado de Implementación v1.0

### Implementado
- AuditLogger (EventEmitter con tipos de eventos)
- RBAC con addRole(), resolvePermissions(), hasRole(), getRoles(), getRolePermissions()
- Secret detection: containsSecret(), maskSecrets() con patrones configurables
- EncryptedStorageAdapter con AES-256-GCM, IV aleatorio, AEAD auth tag
- **Modulo permission-matcher** (adicional al contrato): matchPermission(), matchPermissions(), resolvePermission(), getMissingPermissions()
- Soporte para wildcards y permisos a nivel de recurso (namespace:action:resourceId)
- Metodos RBAC adicionales: checkPermission(), checkPermissions(), getMissingPermissions()

### Implementado (v1.1)
- defaultRole en RBAC ahora activo: si context.roles vacio, se usa defaultRole como fallback
- Tipado correcto de crypto: CipherGCM/DecipherGCM en vez de `as any` cast
- Type narrowing con `in` operator para EncryptedPayload detection

### Discrepancias con contrato
- EncryptedStorageAdapter ubicado en src/context-store/ (contrato dice src/security/)
- Wildcards y resource-level permissions implementados (contrato dice "No soportado en v1.0")

### Pendiente
- Exportar interface EncryptedPayload para type safety de consumidores
