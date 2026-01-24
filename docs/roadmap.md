# Agent Shell - Hoja de Ruta

## Estado Actual

El framework tiene su **roadmap 100% completado** (443 tests, 13 test files, 12 modulos). Cuenta con MCP Server, CLI, Command Builder SDK, SQLite adapters, pgvector adapter, CI/CD pipeline, modulo de seguridad completo (audit logging, RBAC con permisos a nivel de recurso, secret detection, encriptacion at-rest), rate limiting, confirm tokens con TTL, expiracion de sesiones y politicas de retencion.

**Todos los items del roadmap estan implementados.** Documentacion de adapters disponible en `docs/adapters.md`.

---

## Fase 1: Critico (Prerequisito para produccion) ✅ COMPLETADA

### 1.1 ~~Eliminar credenciales hardcodeadas del demo~~ ✅ IMPLEMENTADO

- **Estado**: El demo lee de `process.env.CLOUDFLARE_ACCOUNT_ID` y `process.env.CLOUDFLARE_API_TOKEN`
- **Ubicacion**: `demo/index.ts:71-74`
- **Validacion**: Verifica existencia de env vars antes de usarlos, termina con error claro si faltan

### 1.2 ~~Agregar `requiredPermissions` a CommandDefinition~~ ✅ IMPLEMENTADO

- **Estado**: Campo `requiredPermissions?: string[]` agregado a la interfaz
- **Ubicacion**: `src/command-registry/types.ts:24`
- **Impacto**: Los comandos declaran sus permisos requeridos de forma tipada

### 1.3 ~~TTL para tokens de confirmacion~~ ✅ IMPLEMENTADO

- **Estado**: Implementado via `confirmTTL_ms` en `ExecutorConfig`
- **Ubicacion**: `src/executor/index.ts`
- **Metodos**: `confirm(token)`, `revokeConfirm(token)`, `revokeAllConfirms()`

---

## Fase 2: Alta Prioridad (Seguridad operativa) ✅ COMPLETADA

### 2.1 ~~StorageAdapter con encriptacion opcional~~ ✅ IMPLEMENTADO

- **Estado**: Implementado como `EncryptedStorageAdapter` (decorator pattern)
- **Ubicacion**: `src/context-store/encrypted-storage-adapter.ts`
- **Algoritmo**: AES-256-GCM con IV aleatorio por operacion y AEAD tag
- **Caracteristica**: Backward-compatible con datos no encriptados

### 2.2 ~~Masking de secretos en historial~~ ✅ IMPLEMENTADO

- **Estado**: Implementado via `maskSecrets()` en `src/security/secret-patterns.ts`
- **Integracion**: `ContextStore.recordCommand()` aplica masking automatico a args y resultados
- **Patrones**: API keys, Bearer tokens, passwords, AWS keys, JWTs, private keys, hex secrets

### 2.3 ~~Audit logging~~ ✅ IMPLEMENTADO

- **Estado**: Implementado como `AuditLogger` (EventEmitter tipado)
- **Ubicacion**: `src/security/audit-logger.ts`
- **Eventos**: `command:executed`, `command:failed`, `permission:denied`, `confirm:requested`, `confirm:executed`, `confirm:expired`, `session:created`, `session:expired`, `error:handler`, `error:timeout`
- **Integracion**: Inyectable via `auditLogger` en `ExecutionContext`

### 2.4 ~~Expiracion de sesiones~~ ✅ IMPLEMENTADO

- **Estado**: Implementado via `ttl_ms` en `ContextStoreConfig`
- **Ubicacion**: `src/context-store/index.ts`
- **Caracteristica**: Cleanup automatico con callback `onExpired` configurable

---

## Fase 3: Prioridad Media (Hardening) ✅ COMPLETADA

### 3.1 ~~Rate limiting por sesion~~ ✅ IMPLEMENTADO

- **Estado**: Implementado con sliding window en Executor
- **Ubicacion**: `src/executor/index.ts`
- **Config**: `rateLimit: { maxRequests: number, windowMs: number }` en `ExecutorConfig`
- **Comportamiento**: Retorna code 3 (E_RATE_LIMITED) cuando se excede

### 3.2 ~~Limite de tamano pre-parser~~ ✅ IMPLEMENTADO (con nota)

- **Estado**: Implementado via `maxInputLength` en `CoreConfig` (default 10,000)
- **Ubicacion**: `src/core/index.ts:105`, `src/core/types.ts:30`
- **Nota**: Inconsistencia con el parser que limita a 4,096 chars. Core acepta hasta 10K pero parser rechaza a 4,096. Considerar alinear ambos valores.

### 3.3 ~~Validacion de profundidad en JSON.parse~~ ✅ IMPLEMENTADO

- **Estado**: Implementado via `getJsonDepth()` en el Executor con limite configurable
- **Ubicacion**: `src/executor/index.ts:448-460`, `src/executor/index.ts:617-627`
- **Config**: `maxDepth` por parametro (default: 10), retorna error si se excede

### 3.4 ~~Deteccion de patrones de secretos en ContextStore~~ ✅ IMPLEMENTADO

- **Estado**: Implementado via `secretDetection` en `ContextStoreConfig`
- **Modos**: `warn` (permite pero advierte) y `reject` (bloquea el set)
- **Patrones**: Usa `containsSecret()` de `src/security/secret-patterns.ts`

---

## Fase 4: Evolucion arquitectonica (Seguridad) ✅ COMPLETADA

### 4.1 ~~RBAC (Role-Based Access Control)~~ ✅ IMPLEMENTADO

- **Estado**: Implementado con soporte para herencia de roles
- **Ubicacion**: `src/security/rbac.ts`
- **API**: `addRole()`, `hasRole()`, `getRoles()`, `resolvePermissions()` (recursivo con herencia)

### 4.2 ~~Permisos a nivel de recurso~~ ✅ IMPLEMENTADO

- **Estado**: Implementado via `permission-matcher.ts` con soporte completo de 3 niveles
- **Ubicacion**: `src/security/permission-matcher.ts`, `src/security/rbac.ts`, `src/executor/index.ts`
- **Formato**: `namespace:action:resourceId` (ej. `users:delete:123`)
- **Wildcards**: `ns:action:*`, `ns:*`, `*` (jerarquia de matching)
- **Placeholders**: `$param` se resuelve contra args del comando (ej. `users:delete:$id`)
- **API**: `matchPermission()`, `matchPermissions()`, `resolvePermission()`, `getMissingPermissions()`
- **RBAC**: `checkPermission()`, `checkPermissions()`, `getMissingPermissions()` en clase RBAC
- **Tests**: 18 tests en `tests/security.test.ts` (T46-T63)

### 4.3 ~~Revocacion de tokens de confirmacion~~ ✅ IMPLEMENTADO

- **Estado**: Implementado en Executor
- **Ubicacion**: `src/executor/index.ts`
- **Metodos**: `revokeConfirm(token)`, `revokeAllConfirms()`, expiracion automatica via `confirmTTL_ms`

### 4.4 ~~Politicas de retencion de datos~~ ✅ IMPLEMENTADO

- **Estado**: Implementado via `retentionPolicy` en `ContextStoreConfig`
- **Config**: `{ maxAge_ms: number, maxEntries: number }`
- **Comportamiento**: Aplicada automaticamente en `recordCommand()`

---

## Fase 5: Distribucion y Consumo ✅ COMPLETADA

### 5.1 ~~MCP Server~~ ✅ IMPLEMENTADO

- **Estado**: Implementado como `McpServer` con JSON-RPC 2.0 sobre stdio
- **Ubicacion**: `src/mcp/server.ts`, `src/mcp/transport.ts`, `src/mcp/types.ts`
- **Tools**: Expone exactamente 2 tools: `cli_help` y `cli_exec`
- **Tests**: 20 tests en `tests/mcp-server.test.ts`
- **Dependencias**: Ninguna (protocolo implementado sin deps externas)

### 5.2 ~~CLI entry point~~ ✅ IMPLEMENTADO

- **Estado**: Entry point CLI con subcomandos
- **Ubicacion**: `src/cli/index.ts`
- **Config**: `bin.agent-shell` en `package.json`
- **Subcomandos**: `serve`, `help`, `version`

---

## Fase 6: Produccion ✅ COMPLETADA

### 6.1 ~~Adapters de persistencia oficiales~~ ✅ IMPLEMENTADO

- **Estado**: Implementados `SQLiteStorageAdapter` y `SQLiteRegistryAdapter`
- **Ubicacion**: `src/context-store/sqlite-storage-adapter.ts`, `src/command-registry/sqlite-registry-adapter.ts`
- **Interfaz**: Acepta cualquier objeto `SQLiteDatabase` (compatible con `bun:sqlite` y `better-sqlite3`)
- **Tests**: 35 tests en `tests/sqlite-adapters.test.ts`
- **Dependencias runtime**: Ninguna (interfaz inyectable)

### 6.2 ~~Configuracion de publicacion npm~~ ✅ IMPLEMENTADO

- **Estado**: Configurado en `package.json`
- **Agregado**: `files`, `license: MIT`, `bin`, `prepublishOnly: "npm run build"`, exports para MCP
- **Version actual**: 0.1.0

### 6.3 ~~Tests de integracion/E2E~~ ✅ IMPLEMENTADO

- **Estado**: 26 tests de integracion en `tests/integration.test.ts`
- **Cobertura**: Flujo completo Parser→Core→Executor, JQ filters, modos, pipeline, batch, discovery, context
- **Nota**: Usa mocks ligeros de VectorIndex (sin dependencia de servicios externos)

### 6.4 ~~Tests de seguridad dedicados~~ ✅ IMPLEMENTADO

- **Estado**: 45 tests en `tests/security.test.ts`
- **Cobertura**: AuditLogger (6), Secret Detection (10), Secret Masking (7), RBAC (12), EncryptedStorageAdapter (10)

---

## Fase 7: Automatizacion y Evolucion ✅ COMPLETADA

### 7.1 ~~CI/CD pipeline~~ ✅ IMPLEMENTADO

- **Estado**: GitHub Actions workflow con typecheck, test, build y publish (on tag)
- **Ubicacion**: `.github/workflows/ci.yml`
- **Trigger**: Push/PR a main + publish automatico en tags `v*`

### 7.2 ~~Adapter pgvector~~ ✅ IMPLEMENTADO

- **Estado**: Implementado como `PgVectorStorageAdapter`
- **Ubicacion**: `src/vector-index/pgvector-storage-adapter.ts`, `src/vector-index/pgvector-types.ts`
- **Interfaz**: Acepta cualquier objeto `PgClient` (compatible con `pg.Pool` y `pg.Client`)
- **Distancias**: Cosine (`<=>`), L2 (`<->`), Inner Product (`<#>`)
- **Indice**: HNSW con parametros configurables (m, ef_construction)
- **Tests**: 25 tests en `tests/pgvector-adapter.test.ts`
- **Dependencias runtime**: Ninguna (interfaz inyectable)

### 7.3 ~~Command builder SDK~~ ✅ IMPLEMENTADO

- **Estado**: Fluent builder pattern con `command()`, `CommandBuilder`, `ParamBuilder`
- **Ubicacion**: `src/command-builder/index.ts`
- **API**: `command('ns', 'cmd').description(...).param(...).build()`
- **Tests**: 26 tests en `tests/command-builder.test.ts`

### 7.4 ~~Documentacion de adapters~~ ✅ IMPLEMENTADO

- **Estado**: Guia completa con interfaces, ejemplos y patrones
- **Ubicacion**: `docs/adapters.md`
- **Cobertura**: StorageAdapter, EmbeddingAdapter, VectorStorageAdapter, SQLiteDatabase, PgClient
- **Ejemplos**: Redis, OpenAI, Ollama, Pinecone, better-sqlite3, bun:sqlite, pg

### 7.5 ~~Changelog y versionado~~ ✅ IMPLEMENTADO

- **Estado**: `CHANGELOG.md` creado con formato Keep a Changelog + Semver
- **Ubicacion**: `CHANGELOG.md`
- **Version actual**: 0.1.0

---

## Resumen de Estado

### Seguridad

| Aspecto | Estado | Fase |
|:---|:---|:---|
| Credenciales en codigo | ✅ Resuelto (env vars) | Fase 1 |
| Tipos de permisos | ✅ Resuelto (`requiredPermissions`) | Fase 1 |
| Token expiration | ✅ Implementado (`confirmTTL_ms`) | Fase 1 |
| Encriptacion at-rest | ✅ Implementado (`EncryptedStorageAdapter`) | Fase 2 |
| Secret masking | ✅ Implementado (`maskSecrets()`) | Fase 2 |
| Audit logging | ✅ Implementado (`AuditLogger`) | Fase 2 |
| Session expiry | ✅ Implementado (`ttl_ms`) | Fase 2 |
| Rate limiting | ✅ Implementado (sliding window) | Fase 3 |
| Input size pre-check | ✅ Implementado (`maxInputLength`, ver nota 3.2) | Fase 3 |
| JSON depth limits | ✅ Implementado (`getJsonDepth`, default 10) | Fase 3 |
| Secret detection | ✅ Implementado (`secretDetection` config) | Fase 3 |
| RBAC | ✅ Implementado (con herencia) | Fase 4 |
| Resource-level perms | ✅ Implementado (`permission-matcher`) | Fase 4 |
| Token revocation | ✅ Implementado (`revokeConfirm`) | Fase 4 |
| Data retention | ✅ Implementado (`retentionPolicy`) | Fase 4 |

### Distribucion y Produccion

| Aspecto | Estado | Fase |
|:---|:---|:---|
| MCP Server | ✅ Implementado (JSON-RPC stdio) | Fase 5 |
| CLI entry point | ✅ Implementado (`bin.agent-shell`) | Fase 5 |
| SQLite adapters | ✅ Implementado (Storage + Registry) | Fase 6 |
| Config npm publish | ✅ Configurado (files, license, bin) | Fase 6 |
| Tests integracion | ✅ Implementado (26 tests) | Fase 6 |
| Tests seguridad | ✅ Implementado (63 tests) | Fase 6 |
| CI/CD | ✅ Implementado (GitHub Actions) | Fase 7 |
| Adapter pgvector | ✅ Implementado (`PgVectorStorageAdapter`) | Fase 7 |
| Command builder SDK | ✅ Implementado (fluent API) | Fase 7 |
| Docs adapters | ✅ Implementado (`docs/adapters.md`) | Fase 7 |
| Changelog | ✅ Creado (Keep a Changelog) | Fase 7 |

---

## Lo que YA funciona bien

- Validacion de input (parser: longitud, formato, tipos)
- Type coercion estricta en Executor (int, float, bool, date, enum, json)
- Key validation en ContextStore (regex pattern, longitud maxima)
- Timeout de handlers (`Promise.race` configurable)
- Deep-copy con `structuredClone()` (previene mutacion)
- Error handling estructurado (codigos 0-4, sin excepciones raw)
- Aislamiento de sesiones (historial y contexto por sessionId)
- Modos no-destructivos (dry-run, validate) que nunca ejecutan handlers
- Encriptacion at-rest (AES-256-GCM con IV aleatorio y AEAD tag)
- Audit logging tipado (EventEmitter con 10 tipos de evento)
- RBAC con herencia de roles
- Deteccion y masking de secretos (API keys, tokens, passwords, AWS, JWT)
- Rate limiting por sesion (sliding window configurable)
- TTL de tokens de confirmacion con revocacion
- Expiracion de sesiones con callback
- Politicas de retencion de historial (por edad y cantidad)
- Busqueda semantica vectorial con adapters pluggables
- Demo funcional con Ollama y Cloudflare Workers AI
- MCP Server (JSON-RPC 2.0 sobre stdio, 2 tools: cli_help, cli_exec)
- CLI entry point con subcomandos (serve, help, version)
- Command Builder SDK (fluent API para definir comandos)
- SQLite adapters (StorageAdapter + RegistryAdapter, zero deps)
- Permisos a nivel de recurso (namespace:action:resourceId con wildcards y $param)
- PgVector adapter (PostgreSQL + pgvector, HNSW index, cosine/L2/IP)
- CI/CD pipeline (GitHub Actions: typecheck, test, build, publish)
- Documentacion de adapters (guia con interfaces, ejemplos, patrones)
- 443 tests pasando (13 test files: 7 unit + 1 MCP + 1 security + 1 integration + 1 SQLite + 1 builder + 1 pgvector)
