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
