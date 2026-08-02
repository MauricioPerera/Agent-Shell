/**
 * @module vector-index/similarity
 * @description Similaridad coseno entre dos vectores — extraida tras
 * encontrarla implementada de forma identica (salvo un detalle) en
 * vector-index/index.ts, vector-index/matryoshka.ts y minimemory/factory.ts.
 *
 * La version de matryoshka.ts usaba `Math.min(a.length, b.length)` en vez
 * de asumir `a.length === b.length` (necesario ahi porque el funnel search
 * compara vectores truncados a distinta resolucion) — se adopta como la
 * version canonica: es un superset seguro que no cambia el resultado
 * cuando ambos vectores ya tienen la misma longitud, como es el caso en
 * los otros dos call sites.
 */

/**
 * Calcula la similaridad coseno entre dos vectores.
 * Retorna un valor entre -1 y 1 (1 = identico, 0 = ortogonal, -1 = opuesto).
 *
 * Trunca al mas corto si las dimensiones difieren (Math.min) — INTENCIONAL
 * para matryoshka.ts (compara vectores truncados a distinta resolucion a
 * proposito). No usar esta version directamente para busqueda normal
 * query-vs-stored: ver cosineSimilaritySafe() abajo.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
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

/**
 * Version para busqueda: valida que ambos vectores tengan la MISMA
 * dimension (retorna `null` si no, en vez de comparar un score sin
 * sentido) y clampea el resultado a [0,1] antes de devolverlo.
 *
 * Regresion (ronda 40 del audit):
 * - Finding A (HIGH): cosineSimilarity() truncaba en silencio vectores de
 *   distinta dimension (Math.min) sin validar nada — nada en el codebase
 *   llama EmbeddingAdapter.getDimensions() para chequear consistencia
 *   antes de comparar. Un upgrade de modelo de embeddings (p.ej. 384 a
 *   768 dims) sin reindexar todo produce scores sin sentido, en silencio,
 *   para cada entrada vieja comparada contra una query nueva.
 * - Finding D (MEDIUM): pgvector y minimemory-HNSW clampean su score a
 *   [0,1] (documentado como parte del contrato), pero los callers de
 *   cosineSimilarity() en JS puro (VectorIndex.searchInMemory,
 *   createInMemoryStorage) devolvian el rango crudo [-1,1] sin clampear
 *   — dos paths similares divergiendo silenciosamente, el mismo patron
 *   de bug que este audit encuentra una y otra vez en este codebase.
 *
 * Tambien retorna `null` (en vez de propagar NaN) si el resultado da NaN
 * — un componente NaN en cualquiera de los dos vectores (embedding
 * corrupto/degradado) produce dot/norm NaN, que Math.min/Math.max NO
 * limpian (NaN se propaga a traves de ambos). Centralizar el chequeo aca
 * evita que cada caller tenga que repetirlo por separado.
 *
 * Callers deben tratar `null` como "candidato invalido, excluir" — no
 * como score 0 (que seria un match ortogonal legitimo).
 */
export function cosineSimilaritySafe(a: number[], b: number[]): number | null {
  if (a.length !== b.length) return null;
  const raw = cosineSimilarity(a, b);
  if (Number.isNaN(raw)) return null;
  return Math.max(0, Math.min(1, raw));
}
