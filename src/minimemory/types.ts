/**
 * @module minimemory/types
 * @description Type definitions for the minimemory integration module.
 *
 * These types define the interface between Agent Shell and the minimemory
 * Rust library (via napi-rs bindings). They are designed to be compatible
 * with both the actual binding and mock implementations for testing.
 */

// === VectorStorage Configuration ===

export interface MiniMemoryVectorStorageConfig {
  /** Vector dimensions (must match embedding model output) */
  dimensions: number;
  /** Distance metric: 'cosine' | 'euclidean' | 'dot_product' */
  distance?: 'cosine' | 'euclidean' | 'dot_product';
  /** Index type: 'flat' (exact) | 'hnsw' (approximate, faster) */
  indexType?: 'flat' | 'hnsw';
  /** HNSW parameter: max connections per node (default: 16) */
  hnswM?: number;
  /** HNSW parameter: construction search depth (default: 200) */
  hnswEfConstruction?: number;
  /** Quantization: 'none' | 'int8' | 'binary' */
  quantization?: 'none' | 'int8' | 'binary';
  /** Path for automatic persistence (optional) */
  persistPath?: string;
}

// === API Adapter Configuration ===

export interface MiniMemoryApiConfig {
  /** Vector dimensions (must match embedding model) */
  dimensions: number;
  /** Distance metric */
  distance?: 'cosine' | 'euclidean' | 'dot_product';
  /** Index type */
  indexType?: 'flat' | 'hnsw';
  /** Quantization type */
  quantization?: 'none' | 'int8' | 'binary';
  /** Full-text search fields */
  fulltextFields?: string[];
  /** File path for persistence */
  persistPath?: string;
}

// === Search Types ===

export interface MiniMemorySearchResult {
  id: string;
  distance: number;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface MiniMemoryHybridParams {
  vector?: number[];
  keywords?: string;
  filter?: Record<string, unknown>;
  topK: number;
  vectorWeight?: number;
  fusionK?: number;
}

export interface MiniMemoryInsertParams {
  id: string;
  vector?: number[];
  metadata?: Record<string, unknown>;
  content?: string;
}

export interface MiniMemoryFilterParams {
  field: string;
  operator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'starts_with';
  value: unknown;
}

export interface MiniMemoryStats {
  count: number;
  dimensions: number;
  distance: string;
  indexType: string;
  hasFulltext: boolean;
  quantization: string;
}

// === Agent Memory Types ===

export interface TaskEpisode {
  task: string;
  solution: string;
  outcome: 'success' | 'failure' | 'partial';
  learnings: string[];
}

export interface CodeSnippet {
  code: string;
  description: string;
  language: string;
  dependencies: string[];
  useCase: string;
  qualityScore: number;
  tags: string[];
}

export interface ErrorSolution {
  errorMessage: string;
  errorType: string;
  rootCause: string;
  solution: string;
  fixedCode?: string;
  language: string;
}

export interface AgentMemoryStats {
  totalEntries: number;
  episodes: number;
  codeSnippets: number;
  errorSolutions: number;
}

export interface RecallResult {
  id: string;
  relevance: number;
  priority?: string;
  transferLevel?: string;
  content: Record<string, unknown>;
}

// === Binding Interface ===

/** Interface for the minimemory native binding's VectorDB class */
export interface MiniMemoryBinding {
  VectorDB: new (config: Record<string, unknown>) => MiniMemoryVectorDB;
  AgentMemory?: new (config: Record<string, unknown>) => MiniMemoryAgentMemory;
}

/** Interface for VectorDB instance from the binding */
export interface MiniMemoryVectorDB {
  insert(id: string, vector: number[], metadata?: Record<string, unknown>): void;
  insert_document(id: string, vector: number[] | null, metadata?: Record<string, unknown>): void;
  update(id: string, vector: number[], metadata?: Record<string, unknown>): void;
  update_document(id: string, vector: number[] | null, metadata?: Record<string, unknown> | null): void;
  delete(id: string): void;
  contains(id: string): boolean;
  get(id: string): { vector: number[] | null; metadata: Record<string, unknown> } | null;
  search(vector: number[], topK: number): Array<{ id: string; distance: number; metadata?: Record<string, unknown> }>;
  keyword_search?(query: string, topK: number): Array<{ id: string; distance?: number; score?: number; metadata?: Record<string, unknown> }>;
  hybrid_search?(params: Record<string, unknown>): Array<{ id: string; distance?: number; score?: number; metadata?: Record<string, unknown> }>;
  filter_search?(filter: Record<string, unknown>, topK: number): Array<{ id: string; metadata?: Record<string, unknown> }>;
  list_ids?(): string[];
  len(): number;
  has_fulltext?(): boolean;
  save(path: string): void;
  load(path: string): void;
}

/** Interface for AgentMemory instance from the binding */
export interface MiniMemoryAgentMemory {
  learn_task(task: string, solution: string, outcome: string, learnings: string[]): void;
  learn_code(snippet: Record<string, unknown>): void;
  learn_error_solution(solution: Record<string, unknown>): void;
  recall_similar(query: string, topK: number): Array<Record<string, unknown>>;
  recall_code(query: string, topK: number): Array<Record<string, unknown>>;
  recall_error_solutions(query: string, topK: number): Array<Record<string, unknown>>;
  recall_successful(query: string, topK: number): Array<Record<string, unknown>>;
  with_working_context(callback: (ctx: WorkingContextBuilder) => void): void;
  working_context(): Record<string, unknown>;
  stats(): Record<string, unknown>;
  save(path: string): void;
  load(path: string): void;
  focus_project(project: string): void;
}

export interface WorkingContextBuilder {
  set_project(name: string): void;
  set_task(task: string): void;
  add_goal(goal: string): void;
}

// === Factory Types ===

export interface StorageFactoryOptions {
  /** Vector dimensions */
  dimensions: number;
  /** Preferred storage: 'minimemory' | 'memory' | 'auto' */
  prefer?: 'minimemory' | 'memory' | 'auto';
  /** MiniMemory specific config (used if minimemory is available) */
  minimemory?: Omit<MiniMemoryVectorStorageConfig, 'dimensions'>;
}

export interface StorageFactoryResult {
  /** The created storage adapter */
  storage: import('../vector-index/types.js').VectorStorageAdapter;
  /** Which backend was used */
  backend: 'minimemory' | 'memory';
  /** Whether minimemory binding is available */
  minimemoryAvailable: boolean;
}
