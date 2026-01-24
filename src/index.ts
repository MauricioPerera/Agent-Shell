export { parse } from './parser/index.js';
export type {
  ParseResult,
  ParsedCommand,
  ParseError,
  CommandArgs,
  GlobalFlags,
  JqFilter,
  ParseMeta,
} from './parser/index.js';

export { applyFilter } from './jq-filter/index.js';
export type {
  FilterResult,
  FilterSuccess,
  FilterError,
} from './jq-filter/index.js';

export { ContextStore } from './context-store/index.js';
export type {
  StorageAdapter,
  OperationResult,
  HistoryEntry,
  UndoSnapshot,
  SessionStore,
} from './context-store/index.js';

export { CommandRegistry } from './command-registry/index.js';
export type {
  CommandDefinition,
  CommandParam,
  RegisteredCommand,
  RegistryError,
} from './command-registry/index.js';

export { Executor } from './executor/index.js';
export type {
  ExecutionResult,
  ExecutionError,
  ExecutionMeta,
  BatchResult,
  PipelineResult,
  ExecutionContext,
  ExecutorConfig,
} from './executor/index.js';

export { Core } from './core/index.js';
export type {
  CoreResponse,
  CoreConfig,
} from './core/index.js';

export { VectorIndex, PgVectorStorageAdapter } from './vector-index/index.js';
export type {
  EmbeddingAdapter,
  VectorStorageAdapter,
  CommandDefinition as VectorCommandDefinition,
  CommandMetadata,
  VectorEntry,
  IndexResult,
  BatchIndexResult,
  SearchResponse,
  SearchResultItem,
  SearchOptions,
  SyncReport,
  IndexStats,
  HealthStatus,
  VectorIndexConfig,
  PgClient,
  PgVectorConfig,
  PgQueryResult,
} from './vector-index/index.js';

export { AuditLogger, maskSecrets, containsSecret, RBAC, matchPermission, matchPermissions, resolvePermission, getMissingPermissions } from './security/index.js';
export type { AuditEvent, AuditEventType, SecretPattern, Role, RBACConfig, RBACContext, PermissionMatchOptions } from './security/index.js';

export { EncryptedStorageAdapter, SQLiteStorageAdapter } from './context-store/index.js';
export type { ContextStoreConfig, EncryptionConfig, SQLiteDatabase, SQLiteStorageConfig } from './context-store/index.js';

export { SQLiteRegistryAdapter } from './command-registry/sqlite-registry-adapter.js';
export type { SQLiteRegistryConfig } from './command-registry/sqlite-registry-adapter.js';

export { command, CommandBuilder, ParamBuilder } from './command-builder/index.js';

export { McpServer, StdioTransport, HttpSseTransport } from './mcp/index.js';
export type { McpServerConfig, JsonRpcRequest, JsonRpcResponse, HttpTransportConfig } from './mcp/index.js';
