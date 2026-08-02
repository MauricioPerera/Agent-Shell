/**
 * Regresion (ronda 40 del audit): src/vector-index/similarity.ts no tenia
 * ningun test dedicado — cosineSimilarity()/cosineSimilaritySafe() solo se
 * ejercitaban indirectamente via otros modulos. Este archivo fija los 4
 * findings de esa ronda: dimension-mismatch sin validar (A), score sin
 * clampear a [0,1] (D), y el NaN-score que se cuela a resultados reales
 * via createInMemoryStorage (C) — el backend FALLBACK POR DEFECTO cuando
 * el paquete opcional `minimemory` no esta instalado.
 */

import { describe, it, expect } from 'vitest';
import { cosineSimilarity, cosineSimilaritySafe } from '../src/vector-index/similarity.js';
import { createVectorStorage } from '../src/minimemory/factory.js';
import type { CommandMetadata, VectorEntry } from '../src/vector-index/types.js';

function meta(overrides: Partial<CommandMetadata> = {}): CommandMetadata {
  return {
    namespace: 'test', command: 'cmd', description: 'desc', signature: 'test:cmd',
    parameters: [], tags: [], indexedAt: new Date().toISOString(), version: '1.0.0',
    ...overrides,
  };
}

describe('cosineSimilarity (raw, trunca en silencio — uso intencional en matryoshka.ts)', () => {
  it('vector cero contra cualquier cosa da 0, no NaN (division por magnitud 0)', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([0, 0, 0], [0, 0, 0])).toBe(0);
  });

  it('vector vacio ([]) da 0, mismo guard que vector cero', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('vectores identicos dan 1 (similitud maxima)', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  it('trunca al vector mas corto cuando las dimensiones difieren (comportamiento INTENCIONAL, no validado aca)', () => {
    // Documentado: esta es la version permisiva que matryoshka.ts necesita
    // para comparar vectores truncados a distinta resolucion a proposito.
    const a = [1, 0, 0, 0];
    const b = [1, 0]; // mismo prefijo, mas corto
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 10);
  });
});

describe('cosineSimilaritySafe (ronda 40 del audit, findings A+D)', () => {
  it('retorna null para vectores de distinta dimension, en vez de truncar en silencio', () => {
    const q384 = new Array(384).fill(0).map((_, i) => (i % 7) - 3);
    const v768 = new Array(768).fill(0).map((_, i) => (i % 5) - 2);
    expect(cosineSimilaritySafe(q384, v768)).toBeNull();
  });

  it('retorna null si el resultado da NaN (componente NaN en cualquiera de los dos vectores)', () => {
    expect(cosineSimilaritySafe([1, NaN, 0], [1, 2, 3])).toBeNull();
    expect(cosineSimilaritySafe([1, 2, 3], [1, NaN, 0])).toBeNull();
  });

  it('clampea a [0,1]: vectores opuestos (similitud coseno -1 cruda) dan 0, no negativo', () => {
    const a = [1, 0, 0];
    const b = [-1, 0, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 10); // la version cruda SI da negativo
    expect(cosineSimilaritySafe(a, b)).toBe(0); // la version safe clampea
  });

  it('vectores de la misma dimension y validos dan el mismo resultado que la version cruda (ya en rango)', () => {
    const a = [1, 2, 3];
    const b = [4, 5, 6];
    expect(cosineSimilaritySafe(a, b)).toBeCloseTo(cosineSimilarity(a, b), 10);
  });
});

describe('createInMemoryStorage (via createVectorStorage prefer:memory) — ronda 40 del audit, finding C', () => {
  /**
   * Regresion: el filtro de threshold era por EXCLUSION
   * ("saltar si score < threshold") — NaN < x siempre es false en JS, asi
   * que un candidato con score NaN NUNCA se excluia. Es el backend
   * FALLBACK POR DEFECTO (createVectorStorage sin minimemory instalado),
   * asi que esto afecta cualquier deployment que no instale el paquete
   * opcional.
   */
  it('excluye un candidato cuyo vector tiene un componente NaN, no lo deja colarse con score:null', async () => {
    const { storage } = await createVectorStorage({ dimensions: 3, prefer: 'memory' });

    const good: VectorEntry = { id: 'good:cmd', vector: [1, 0, 0], metadata: meta({ command: 'good' }) };
    const poisoned: VectorEntry = { id: 'poisoned:cmd', vector: [1, NaN, 0], metadata: meta({ command: 'poisoned' }) };
    await storage.upsert(good);
    await storage.upsert(poisoned);

    const results = await storage.search({ vector: [1, 0, 0], topK: 10, threshold: 0.3 });

    expect(results.map(r => r.id)).toEqual(['good:cmd']);
    expect(results.every(r => !Number.isNaN(r.score))).toBe(true);
  });

  it('excluye un candidato de dimension distinta a la query, en vez de compararlo truncado', async () => {
    const { storage } = await createVectorStorage({ dimensions: 3, prefer: 'memory' });

    const good: VectorEntry = { id: 'good:cmd', vector: [1, 0, 0], metadata: meta({ command: 'good' }) };
    // Vector de 5 dims guardado con un storage configurado para 3 —
    // escenario realista de un upgrade de modelo de embeddings sin
    // reindexar todo.
    const mismatched: VectorEntry = { id: 'mismatched:cmd', vector: [1, 0, 0, 0, 0], metadata: meta({ command: 'mismatched' }) };
    await storage.upsert(good);
    await storage.upsert(mismatched);

    const results = await storage.search({ vector: [1, 0, 0], topK: 10, threshold: 0 });

    expect(results.map(r => r.id)).toEqual(['good:cmd']);
  });

  it('scores devueltos siempre estan clampeados a [0,1], nunca negativos', async () => {
    const { storage } = await createVectorStorage({ dimensions: 3, prefer: 'memory' });

    const opposite: VectorEntry = { id: 'opposite:cmd', vector: [-1, 0, 0], metadata: meta({ command: 'opposite' }) };
    await storage.upsert(opposite);

    // threshold 0 (sin filtro real) para confirmar que el score en si esta
    // clampeado, no que el filtro lo esconda.
    const results = await storage.search({ vector: [1, 0, 0], topK: 10, threshold: -1 });

    expect(results).toHaveLength(1);
    expect(results[0].score).toBeGreaterThanOrEqual(0);
  });
});
