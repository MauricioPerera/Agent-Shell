/**
 * @module vector-index/matryoshka
 * @description Matryoshka progressive multi-resolution vector search.
 *
 * Matryoshka-trained embedding models produce vectors where the first N
 * dimensions form a valid N-dimensional embedding. This enables a funnel
 * search strategy: start with low-dimensional (fast) comparisons to build
 * a large candidate pool, then progressively refine at higher dimensions.
 *
 * Typical funnel: 64d (50 candidates) → 128d (25) → 256d (10) → 768d (topK)
 */

import type {
  EmbeddingAdapter,
  EmbeddingResult,
  CommandMetadata,
  MatryoshkaConfig,
  MatryoshkaResolutionLayer,
  MatryoshkaStageInfo,
  SearchOptions,
} from './types.js';

export { MatryoshkaEmbeddingAdapter, funnelSearch, truncateVector, defaultMatryoshkaConfig };

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Truncates a vector to the given number of dimensions.
 * This is the core Matryoshka operation: for models trained with Matryoshka
 * loss, `vector.slice(0, N)` is a valid N-dimensional embedding.
 */
function truncateVector(vector: number[], dimensions: number): number[] {
  if (dimensions >= vector.length) return vector;
  return vector.slice(0, dimensions);
}

/**
 * Cosine similarity between two vectors of the same length.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ─────────────────────────────────────────────────────────────────────────────
// Funnel Search
// ─────────────────────────────────────────────────────────────────────────────

interface FunnelCandidate {
  id: string;
  vector: number[];
  metadata: CommandMetadata;
  score: number;
}

interface FunnelResult {
  results: { id: string; score: number; metadata: CommandMetadata }[];
  stages: MatryoshkaStageInfo[];
}

/**
 * Progressive multi-resolution funnel search.
 *
 * 1. Apply filters once to get initial candidate set
 * 2. For each layer (low → high dimension): truncate & score, keep top candidateTopK
 * 3. Final ranking at fullDimensions, return top finalTopK
 *
 * @param queryVector   Full-dimension query embedding
 * @param entries       Iterator of [id, {vector, metadata}] from the indexed Map
 * @param layers        Intermediate resolution layers (sorted low→high dim)
 * @param fullDimensions Native embedding dimension for final ranking
 * @param finalTopK     Number of final results to return
 * @param threshold     Minimum similarity score (applied at final stage)
 * @param options       Optional filters (namespace, tags, excludeIds)
 */
function funnelSearch(
  queryVector: number[],
  entries: Iterable<[string, { vector: number[]; metadata: CommandMetadata }]>,
  layers: MatryoshkaResolutionLayer[],
  fullDimensions: number,
  finalTopK: number,
  threshold: number,
  options?: SearchOptions,
): FunnelResult {
  // Step 0: Collect and filter candidates
  let candidates: FunnelCandidate[] = [];

  for (const [id, entry] of entries) {
    if (options?.namespace && entry.metadata.namespace !== options.namespace) continue;
    if (options?.tags && options.tags.length > 0) {
      const entryTags = entry.metadata.tags || [];
      if (!options.tags.every(t => entryTags.includes(t))) continue;
    }
    if (options?.excludeIds && options.excludeIds.includes(id)) continue;

    candidates.push({
      id,
      vector: entry.vector,
      metadata: entry.metadata,
      score: 0,
    });
  }

  const stages: MatryoshkaStageInfo[] = [];

  // Step 1: Progressive funnel through intermediate layers
  for (const layer of layers) {
    const dim = Math.min(layer.dimensions, queryVector.length);
    const queryTruncated = truncateVector(queryVector, dim);
    const candidatesIn = candidates.length;

    // Score each candidate at this resolution
    for (const c of candidates) {
      const candidateTruncated = truncateVector(c.vector, dim);
      c.score = cosineSimilarity(queryTruncated, candidateTruncated);
    }

    // Sort descending by score and keep top candidateTopK
    candidates.sort((a, b) => b.score - a.score);
    candidates = candidates.slice(0, layer.candidateTopK);

    stages.push({
      dimensions: dim,
      candidatesIn,
      candidatesOut: candidates.length,
    });
  }

  // Step 2: Final ranking at full dimensions
  const finalDim = Math.min(fullDimensions, queryVector.length);
  const queryFull = truncateVector(queryVector, finalDim);
  const candidatesIn = candidates.length;

  for (const c of candidates) {
    const candidateFull = truncateVector(c.vector, finalDim);
    c.score = cosineSimilarity(queryFull, candidateFull);
  }

  candidates.sort((a, b) => b.score - a.score);

  // Apply threshold at the final stage
  candidates = candidates.filter(c => c.score >= threshold);
  candidates = candidates.slice(0, finalTopK);

  stages.push({
    dimensions: finalDim,
    candidatesIn,
    candidatesOut: candidates.length,
  });

  return {
    results: candidates.map(c => ({
      id: c.id,
      score: c.score,
      metadata: c.metadata,
    })),
    stages,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Matryoshka Embedding Adapter (Decorator)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decorator that wraps any EmbeddingAdapter to support Matryoshka truncation.
 *
 * When `maxDimensions` is set, output vectors are truncated to that size.
 * When not set, the full native vector is preserved (pass-through mode).
 */
class MatryoshkaEmbeddingAdapter implements EmbeddingAdapter {
  private readonly inner: EmbeddingAdapter;
  private readonly maxDimensions: number | null;

  constructor(inner: EmbeddingAdapter, maxDimensions?: number) {
    this.inner = inner;
    this.maxDimensions = maxDimensions ?? null;
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const result = await this.inner.embed(text);
    return this.maybeTruncate(result);
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    const results = await this.inner.embedBatch(texts);
    return results.map(r => this.maybeTruncate(r));
  }

  getDimensions(): number {
    return this.maxDimensions ?? this.inner.getDimensions();
  }

  getModelId(): string {
    return this.inner.getModelId();
  }

  private maybeTruncate(result: EmbeddingResult): EmbeddingResult {
    if (this.maxDimensions === null || result.vector.length <= this.maxDimensions) {
      return result;
    }
    return {
      ...result,
      vector: result.vector.slice(0, this.maxDimensions),
      dimensions: this.maxDimensions,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Default Configuration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns a sensible default MatryoshkaConfig for the given native dimension.
 *
 * @param fullDimensions Native embedding dimension (default: 768 for Gemma)
 */
function defaultMatryoshkaConfig(fullDimensions: number = 768): MatryoshkaConfig {
  return {
    enabled: true,
    fullDimensions,
    layers: [
      { dimensions: 64, candidateTopK: 50 },
      { dimensions: 128, candidateTopK: 25 },
      { dimensions: 256, candidateTopK: 10 },
    ],
  };
}
