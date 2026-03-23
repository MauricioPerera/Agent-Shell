# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Matryoshka Progressive Search**: Multi-resolution funnel search (64d→128d→256d→768d) for faster vector discovery with Matryoshka-trained embedding models
- **MatryoshkaEmbeddingAdapter**: Adapter-agnostic decorator that truncates embeddings to configurable dimensions
- **`funnelSearch()` function**: Standalone, testable progressive search with configurable layers and diagnostics
- **`defaultMatryoshkaConfig()` factory**: Sensible defaults for 768d models (64→128→256→768 funnel)
- **`SearchResponse.matryoshkaStages`**: Optional diagnostics showing candidate narrowing per layer
- **CLI Creation Skills** (9 commands): `scaffold:init`, `scaffold:add-namespace`, `scaffold:add-command`, `wizard:create-command`, `wizard:create-namespace`, `registry:list`, `registry:describe`, `registry:stats`, `registry:export`
- **System Shell Skills** (18 commands): `http:get/post/request`, `json:filter/parse`, `file:read/write/list/mkdir/delete/rename/chmod`, `shell:exec/which`, `env:get/list`
- **Workspace Skills** (6 commands): `workspace:init/run/cd/env/status/reset` — persistent cwd, env, and command history across calls
- **Git Skills** (6 commands): `git:clone/status/diff/commit/push/pull` — typed git operations with per-command permissions
- **Cron Skills** (4 commands): `cron:schedule/list/cancel/history` — recurring tasks with shorthand (`30s`, `5m`, `1h`) and cron expressions
- **Secret Store** (4 commands): `secret:set/get/list/delete` — AES-256-CBC encrypted at rest, values never appear in logs
- **Process Manager** (4 commands): `process:spawn/list/kill/logs` — background processes with stdout/stderr buffer tracking
- **Agent Profiles**: Predefined permission profiles (`admin`, `operator`, `reader`, `restricted`) with `agentProfile` config on Core
- **Permission Enforcement in Core**: `executeCommand()`, `executePipeline()`, search filtering, and describe access control now check agent permissions
- **ShellAdapter Interface**: Pluggable backend for shell/file skills — `JustBashShellAdapter` (sandboxed, just-bash) or `NativeShellAdapter` (child_process, fallback)
- **just-bash Integration**: Optional peer dependency for sandboxed bash execution with virtual filesystem and 79 built-in Unix commands
- **`registerSkills()`**: One-call registration of all 9 CLI creation skills
- **`registerShellSkills()`**: One-call registration of all 12 system skills with optional `ShellAdapter` injection
- **`registerAllSkills()`**: Registers all 21 skills (CLI + shell)
- **`createShellAdapter()`**: Factory with auto-detection of just-bash availability
- **Env variable masking**: `env:get` and `env:list` mask variables with PASSWORD, SECRET, TOKEN, KEY patterns
- **Full system integration test**: 65-test battery validating the entire stack end-to-end
- **Scalability promise test**: 16 tests proving constant ~600 token footprint from 5 to 1000 commands
- **Bearer Token Auth**: `HttpTransportConfig.auth` with `bearerToken` + `excludePaths` for HTTP/SSE transport authentication
- **Production Server** (`src/server/index.ts`): Standalone entry point that bootstraps registry + skills + core + MCP with config from env vars or `agent-shell.config.json`
- **CLI `serve` command**: Now functional — `agent-shell serve --transport http --token <secret> --profile operator` starts authenticated HTTP server with all skills
- **Deployment Guide** (`docs/deployment.md`): VPS deployment with Nginx + Let's Encrypt + systemd + Claude Desktop config
- **Config file support**: `agent-shell.config.json` with env var overrides
- **MCP `initialize` enforcement**: Server now rejects `tools/list` and `tools/call` before `initialize` per MCP spec
- **MCP `notifications/initialized`**: Server handles client acknowledgement notification
- **Core history cap**: FIFO eviction at 10,000 entries prevents unbounded memory growth
- **Core Rate Limiting**: Sliding window (120 req/min) with burst control (20 req/s)
- **Core Timeouts**: Global 30s timeout + per-subsystem (parser 100ms, search 2s, executor 5s, jq 500ms)
- **Core Pipeline Depth Limit**: Max 10 commands per pipeline
- **Core Batch Size Limit**: Max 50 commands per batch
- **Core Logging**: CoreLogger class with level-based filtering (DEBUG/INFO/WARN/ERROR) and `onLog` callback
- **Parser JQ Validations**: Depth max 5, max 10 fields, field name regex, array index support (`.[0]`)
- **Parser Control Character Detection**: Rejects ASCII < 32 (except tab/newline/CR) with E_CONTROL_CHARACTER
- **Parser Nested Prevention**: E_NESTED_BATCH and E_PIPELINE_IN_BATCH errors
- **Executor Constraint Validations**: Float min/max, string minLength/maxLength, array minItems/maxItems
- **Executor Batch Size Enforcement**: maxBatchSize limit enforced before iteration
- **Context Store MAX_KEYS**: Enforced limit of 1000 keys per session
- **Context Store SessionExpiredError**: TTL expiry now throws typed error (code SESSION_EXPIRED)
- **Context Store Snapshot Cleanup**: Auto-slice at max 100 snapshots
- **Context Store API**: `getSessionId()` getter and `dispose()` method
- **Vector Index Filters**: Search by tags (every match) and excludeIds (skip)
- **Vector Index Config**: batchSize and indexableFields options
- **Vector Index Error Codes**: Typed E001-E010 with VectorIndexError class
- **Vector Index Circuit Breaker**: 5 failures → open, 30s cooldown → half-open, 3 successes → closed
- **Vector Index Batch Retry**: Buffer queue with chunked retry on batch failures
- **Vector Index Example Field**: SearchResultItem.example now populated from command metadata
- **Command Registry Validations**: namespace/name regex, semver format, description/example non-empty, handler callable
- **RBAC defaultRole**: Fallback role when context.roles is empty
- **Resource-Level Permissions**: `namespace:action:resourceId` format with wildcard matching (`ns:action:*`, `ns:*`, `*`) and `$param` placeholder resolution
- **Permission Matcher**: Standalone utilities `matchPermission()`, `matchPermissions()`, `resolvePermission()`, `getMissingPermissions()`
- **RBAC Methods**: `checkPermission()`, `checkPermissions()`, `getMissingPermissions()` on RBAC class
- **PgVector Adapter**: `PgVectorStorageAdapter` for PostgreSQL with pgvector extension (cosine, L2, inner product distances, HNSW index)
- **Adapter Documentation**: Comprehensive guide at `docs/adapters.md` covering all adapter interfaces with examples
- 975 total tests across 27 suites (from original 400)
- 65 full system tests, 32 infrastructure tests, 20 workspace tests, 16 scalability tests, 30 skills tests, 27 shell skills tests, 24 adapter tests, 22 permission tests, 14 matryoshka tests, 10 HTTP auth tests

### Changed

- **Strong typing**: Replaced `any` dependencies in Core, Executor, and McpServer with concrete interfaces (`CoreRegistry`, `CoreVectorIndex`, `CoreContextStore`, `McpCore`, `ExecutorRegistry`)
- **Batch parallel execution**: Both Core and Executor now use `Promise.allSettled()` for true parallel batch execution (was sequential `for...of`)
- **VectorIndex native search**: `search()` now delegates to `storageAdapter.search()` for native backend performance (pgvector HNSW, minimemory), with in-memory cosine fallback
- **Timer leak fix**: `withTimeout()` in Core and Executor now clears `setTimeout` via `.finally()` to prevent orphaned timers
- **CSV escape**: Output format `csv` now correctly escapes values containing commas, quotes, and newlines (RFC 4180)
- **Batch limit aligned**: Core batch limit changed from 50 to 20, consistent with parser's `MAX_BATCH_SIZE`
- **HELP_TEXT in English**: Unified interaction protocol to English for consistency with all other messages
- **Executor**: Removed unnecessary `structuredClone()` on every execution
- **minimemory type fixes**: Fixed 8 TypeScript errors from `CommandMetadata` vs `Record<string, unknown>` incompatibility using proper type casts at the Rust binding boundary
- **minimemory test fixes**: Tests now use injected mock bindings via constructor parameter instead of fragile `require()` cache patching
- **Demo adapters**: `MiniMemoryVectorStorage` and `MiniMemoryApiAdapter` constructors now accept optional `binding` parameter for testability
- **Shell skills refactored**: `shell:exec`, `shell:which`, `file:read`, `file:write`, `file:list` now use `ShellAdapter` injection instead of direct `child_process`/`fs` imports
- **Agent profiles on operator/reader**: Include shell skill permissions (`http:*`, `json:*`, `file:read`, `shell:exec`, `env:read`)
- **CLI rewrite**: `agent-shell serve` now bootstraps full stack with skills, reads config from env vars/file, supports `--token`, `--profile`, `--no-cli-skills`, `--no-shell-skills`
- **tsup build**: Added `src/server/index.ts` as additional entry point
- **Executor `revokeConfirm()`**: Now returns `boolean` (true if revoked, false if not found)
- **Executor `revokeAllConfirms()`**: Now returns `number` (count of revoked tokens)
- **EncryptedStorageAdapter**: Removed `as any` casts, proper CipherGCM/DecipherGCM typing with type narrowing

## [0.1.0] - 2026-01-23

### Added

- **Core**: Central orchestrator with `exec()` and `help()` entry points
- **Parser**: Tokenizer and AST parser for commands, pipelines, batch, JQ filters
- **CommandRegistry**: Versioned command catalog with semver resolution
- **Executor**: Execution engine with validation, permissions, timeout, pipeline, batch, rate limiting, confirm tokens
- **VectorIndex**: Semantic search over command catalog with pluggable embedding/storage adapters
- **ContextStore**: Session state store with history, undo snapshots, TTL, secret detection, retention policies
- **JQ Filter**: JSON filtering with jq-subset syntax (field access, array indexing, iteration, multi-select)
- **Security**: AuditLogger, RBAC with inheritance, secret detection/masking, EncryptedStorageAdapter (AES-256-GCM)
- **MCP Server**: JSON-RPC 2.0 server over stdio exposing `cli_help` and `cli_exec` tools
- **CLI**: Entry point binary (`agent-shell serve|help|version`)
- **Command Builder**: Fluent builder pattern for defining commands
- **SQLite Adapters**: `SQLiteStorageAdapter` for ContextStore, `SQLiteRegistryAdapter` for CommandRegistry persistence
- **CI/CD**: GitHub Actions workflow (typecheck, test, build, publish on tag)
- 400 tests across 12 test files
- Demo with Ollama and Cloudflare Workers AI embedding adapters
- Zero external runtime dependencies
