# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
- 43 new tests (18 permission matcher + 25 pgvector adapter)

### Changed

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
