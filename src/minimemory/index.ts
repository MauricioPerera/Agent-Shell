/**
 * @module minimemory
 * @description Native minimemory integration for Agent Shell.
 *
 * Provides optional HNSW-based vector storage when minimemory is installed,
 * with graceful fallback to in-memory storage when it's not.
 *
 * @example
 * ```typescript
 * import { createVectorStorage, isMinimemoryAvailable } from 'agent-shell/minimemory';
 *
 * // Check availability
 * if (isMinimemoryAvailable()) {
 *   console.log('minimemory available - using HNSW');
 * }
 *
 * // Create storage with auto-selection
 * const { storage, backend } = await createVectorStorage({
 *   dimensions: 768,
 *   minimemory: { persistPath: './data.mmdb' }
 * });
 *
 * // Use with VectorIndex
 * const vectorIndex = new VectorIndex({
 *   embeddingAdapter,
 *   storageAdapter: storage,
 * });
 * ```
 */

// Factory functions
export {
  createVectorStorage,
  isMinimemoryAvailable,
  loadMinimemory,
} from './factory.js';

// Adapters (use these directly if you want explicit control)
export { MiniMemoryVectorStorage } from './vector-storage.js';

// Types
export type {
  // Config types
  MiniMemoryVectorStorageConfig,
  MiniMemoryApiConfig,
  StorageFactoryOptions,
  StorageFactoryResult,
  // Search types
  MiniMemorySearchResult,
  MiniMemoryHybridParams,
  MiniMemoryInsertParams,
  MiniMemoryFilterParams,
  MiniMemoryStats,
  // Agent memory types
  TaskEpisode,
  CodeSnippet,
  ErrorSolution,
  AgentMemoryStats,
  RecallResult,
  // Binding types (for advanced usage)
  MiniMemoryBinding,
  MiniMemoryVectorDB,
  MiniMemoryAgentMemory,
} from './types.js';
