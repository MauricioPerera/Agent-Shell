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
import { cosineSimilaritySafe } from './similarity.js';

export { MatryoshkaEmbeddingAdapter, funnelSearch, truncateVector, defaultMatryoshkaConfig };

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Truncates a vector to the given number of dimensions.
 * This is the core Matryoshka operation: for models trained with Matryoshka
 * loss, `vector.slice(0, N)` is a valid N-dimensional embedding.
 *
 * Regresion (ronda 65 del audit, MEDIUM): sin el Math.max(0, ...), un
 * `dimensions` negativo (via MatryoshkaConfig.layers[].dimensions o
 * MatryoshkaEmbeddingAdapter's maxDimensions, ambos config de quien
 * despliega, no del atacante) llegaba intacto a Array.prototype.slice.
 * slice(0, N) con N negativo en JS significa "todo menos los ultimos |N|
 * elementos", no "trunca a N" — el mismo bug class que el topK negativo de
 * ronda 60 (vector-index/index.ts), nunca portado a este archivo. Como
 * query y candidato se truncan igual, las longitudes seguian coincidiendo,
 * asi que cosineSimilaritySafe() no lo detectaba: el stage de baja
 * resolucion terminaba comparando vectores casi completos, derrotando el
 * proposito del funnel sin tirar ningun error.
 */
function truncateVector(vector: number[], dimensions: number): number[] {
  const dim = Math.max(0, dimensions);
  if (dim >= vector.length) return vector;
  return vector.slice(0, dim);
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
      if (!options.tags.some(t => entryTags.includes(t))) continue;
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

    // Regresion (ronda 60 del audit, HIGH): la version anterior usaba
    // cosineSimilarity() (la variante cruda, Math.min-truncante) con la
    // premisa de que "queryTruncated y candidateTruncated siempre tienen
    // igual longitud por construccion" — falso en general:
    // truncateVector() solo trunca hacia ABAJO (linea 36: `if (dimensions
    // >= vector.length) return vector`), asi que un candidato cuyo vector
    // CRUDO ya es mas corto que `dim` (embedding truncado/corrupto, o
    // reindexado con un modelo de menor dimension sin sincronizar) queda
    // con longitud < queryTruncated.length, y cosineSimilarity() lo
    // compara igual (Math.min silencioso) produciendo un score sin
    // sentido en vez de excluir el candidato — exactamente el bug del
    // finding A de la ronda 40, nunca portado a este archivo. Ademas, un
    // componente NaN en cualquier vector (embedding degradado) se
    // propagaba a traves de Math.max/Math.min sin limpiarse, entrando al
    // comparator de candidates.sort() con NaN (comportamiento de sort()
    // no especificado con NaN, puede desordenar candidatos VALIDOS antes
    // de que el corrupto se filtre). cosineSimilaritySafe() (ya usada por
    // VectorIndex.searchInMemory para este mismo motivo) devuelve `null`
    // en AMBOS casos, excluyendo el candidato ANTES del sort en vez de
    // dejarlo corromper el ranking de los demas.
    const scored: FunnelCandidate[] = [];
    for (const c of candidates) {
      const candidateTruncated = truncateVector(c.vector, dim);
      const score = cosineSimilaritySafe(queryTruncated, candidateTruncated);
      if (score === null) continue;
      c.score = score;
      scored.push(c);
    }
    candidates = scored;

    // Sort descending by score and keep top candidateTopK.
    // Regresion (ronda 65 del audit, MEDIUM): mismo bug class que topK
    // negativo (ronda 60) — sin Math.max(0, ...), un candidateTopK
    // negativo hace que slice(0, N) devuelva "todo menos los ultimos |N|"
    // en vez de acotar, dejando pasar casi todo el candidate pool al
    // siguiente stage (mas caro) en vez de angostarlo.
    candidates.sort((a, b) => b.score - a.score);
    candidates = candidates.slice(0, Math.max(0, layer.candidateTopK));

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

  // Mismo motivo que en el loop de layers arriba (ronda 60 del audit, HIGH).
  const scoredFull: FunnelCandidate[] = [];
  for (const c of candidates) {
    const candidateFull = truncateVector(c.vector, finalDim);
    const score = cosineSimilaritySafe(queryFull, candidateFull);
    if (score === null) continue;
    c.score = score;
    scoredFull.push(c);
  }
  candidates = scoredFull;

  candidates.sort((a, b) => b.score - a.score);

  // Apply threshold at the final stage.
  // Regresion (ronda 65 del audit, MEDIUM): mismo guard que candidateTopK
  // arriba. VectorIndex.search() ya clampea el topK que le pasa aca (ronda
  // 60), pero funnelSearch() es API publica exportada directamente — un
  // caller que la invoca sin pasar por VectorIndex podia pasar un
  // finalTopK negativo y sufrir el mismo comportamiento invertido de slice.
  candidates = candidates.filter(c => c.score >= threshold);
  candidates = candidates.slice(0, Math.max(0, finalTopK));

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

  // Regresion (ronda 77 del audit, MEDIUM): la version truncada NO se
  // renormalizaba antes de devolverse — para comparaciones coseno esto es
  // matematicamente neutro (cosineSimilarity ya normaliza por la magnitud
  // de cada vector, truncado o no), pero el vector devuelto aca es lo que
  // VectorIndex.indexCommand() efectivamente PERSISTE, y storageAdapter es
  // pluggeable: con distanceType='inner_product' (pgvector-storage-adapter.ts,
  // ya documentado ahi como "dot product crudo, no normalizado") la
  // magnitud SI afecta el resultado. Truncar cambia la magnitud de forma
  // dependiente del contenido de cada vector (no es un escalado uniforme),
  // asi que dos comandos con embeddings originalmente comparables podian
  // terminar con magnitudes truncadas arbitrariamente distintas,
  // degradando el ranking de inner_product de forma evitable. Renormalizar
  // a norma unitaria aca es neutro para el path coseno (mayoria de casos)
  // y hace que el dot product crudo de inner_product vuelva a equivaler a
  // similaridad coseno para estos vectores especificamente.
  private maybeTruncate(result: EmbeddingResult): EmbeddingResult {
    if (this.maxDimensions === null || result.vector.length <= this.maxDimensions) {
      return result;
    }
    return {
      ...result,
      vector: normalizeVector(result.vector.slice(0, this.maxDimensions)),
      dimensions: this.maxDimensions,
    };
  }
}

/** L2-normaliza un vector a norma unitaria. Vector cero se devuelve intacto (evita division por 0). */
function normalizeVector(vector: number[]): number[] {
  let sumSquares = 0;
  for (const x of vector) sumSquares += x * x;
  const norm = Math.sqrt(sumSquares);
  if (norm === 0) return vector;
  return vector.map(x => x / norm);
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
