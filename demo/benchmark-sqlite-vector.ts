/**
 * Benchmark comparativo: 3 enfoques de vector storage.
 *
 * 1. MemoryVectorStorage (in-memory, sin persistencia)
 * 2. SqliteVectorStorage (SQLite persist + JS cosine search)
 * 3. SqliteNativeVectorStorage (SQLite persist + streaming iterator + min-heap)
 *
 * Ejecutar: bun run demo/benchmark-sqlite-vector.ts
 */

import { MemoryVectorStorage } from './adapters/memory-vector-storage.js';
import { SqliteVectorStorage } from './adapters/sqlite-vector-storage.js';
import { SqliteNativeVectorStorage } from './adapters/sqlite-native-vector-storage.js';
import type { VectorEntry, VectorSearchQuery, VectorStorageAdapter } from '../src/vector-index/types.js';
import { unlinkSync } from 'fs';

// --- Config ---
const DIMENSIONS = 768; // typical embedding size
const DATASET_SIZES = [100, 500, 1000, 5000];
const SEARCH_ITERATIONS = 50;
const TOP_K = 5;
const THRESHOLD = 0.0;

// --- Helpers ---
function randomVector(dims: number): number[] {
  const vec = new Array(dims);
  for (let i = 0; i < dims; i++) {
    vec[i] = Math.random() * 2 - 1;
  }
  return vec;
}

function generateEntries(count: number): VectorEntry[] {
  const entries: VectorEntry[] = [];
  for (let i = 0; i < count; i++) {
    entries.push({
      id: `cmd-${i}`,
      vector: randomVector(DIMENSIONS),
      metadata: {
        namespace: `ns-${i % 10}`,
        command: `command-${i}`,
        description: `Description for command ${i}`,
        signature: `command-${i} [options]`,
        parameters: ['--flag'],
        tags: ['test'],
        indexedAt: new Date().toISOString(),
        version: '1.0.0',
      },
    });
  }
  return entries;
}

interface BenchmarkResult {
  adapter: string;
  datasetSize: number;
  insertTimeMs: number;
  avgSearchTimeMs: number;
  minSearchTimeMs: number;
  maxSearchTimeMs: number;
  p95SearchTimeMs: number;
}

async function benchmarkAdapter(
  name: string,
  adapter: VectorStorageAdapter,
  entries: VectorEntry[],
): Promise<BenchmarkResult> {
  // Benchmark insert
  const insertStart = performance.now();
  await adapter.upsertBatch(entries);
  const insertTimeMs = performance.now() - insertStart;

  // Generate query vectors
  const queryVectors = Array.from({ length: SEARCH_ITERATIONS }, () => randomVector(DIMENSIONS));

  // Benchmark search
  const searchTimes: number[] = [];
  for (const qv of queryVectors) {
    const query: VectorSearchQuery = {
      vector: qv,
      topK: TOP_K,
      threshold: THRESHOLD,
    };
    const start = performance.now();
    await adapter.search(query);
    searchTimes.push(performance.now() - start);
  }

  searchTimes.sort((a, b) => a - b);
  const avgSearchTimeMs = searchTimes.reduce((s, t) => s + t, 0) / searchTimes.length;
  const minSearchTimeMs = searchTimes[0];
  const maxSearchTimeMs = searchTimes[searchTimes.length - 1];
  const p95SearchTimeMs = searchTimes[Math.floor(searchTimes.length * 0.95)];

  return {
    adapter: name,
    datasetSize: entries.length,
    insertTimeMs: Math.round(insertTimeMs * 100) / 100,
    avgSearchTimeMs: Math.round(avgSearchTimeMs * 100) / 100,
    minSearchTimeMs: Math.round(minSearchTimeMs * 100) / 100,
    maxSearchTimeMs: Math.round(maxSearchTimeMs * 100) / 100,
    p95SearchTimeMs: Math.round(p95SearchTimeMs * 100) / 100,
  };
}

function cleanupDb(path: string) {
  try { unlinkSync(path); } catch {}
  try { unlinkSync(path + '-wal'); } catch {}
  try { unlinkSync(path + '-shm'); } catch {}
}

async function main() {
  console.log('=== Vector Storage Benchmark ===');
  console.log(`Dimensions: ${DIMENSIONS}, Search iterations: ${SEARCH_ITERATIONS}, TopK: ${TOP_K}\n`);

  const allResults: BenchmarkResult[] = [];

  for (const size of DATASET_SIZES) {
    console.log(`--- Dataset size: ${size} vectors ---`);
    const entries = generateEntries(size);

    // 1. Memory
    const memStorage = new MemoryVectorStorage();
    const memResult = await benchmarkAdapter('Memory (in-memory)', memStorage, entries);
    allResults.push(memResult);
    console.log(`  Memory:      insert=${memResult.insertTimeMs}ms, avg_search=${memResult.avgSearchTimeMs}ms, p95=${memResult.p95SearchTimeMs}ms`);

    // 2. SQLite + JS search
    const dbPathA = `./benchmark-a-${size}.db`;
    cleanupDb(dbPathA);
    const sqliteJs = new SqliteVectorStorage({ dbPath: dbPathA });
    const sqliteJsResult = await benchmarkAdapter('SQLite+JS', sqliteJs, entries);
    allResults.push(sqliteJsResult);
    sqliteJs.close();
    cleanupDb(dbPathA);
    console.log(`  SQLite+JS:   insert=${sqliteJsResult.insertTimeMs}ms, avg_search=${sqliteJsResult.avgSearchTimeMs}ms, p95=${sqliteJsResult.p95SearchTimeMs}ms`);

    // 3. SQLite + streaming iterator + min-heap
    const dbPathB = `./benchmark-b-${size}.db`;
    cleanupDb(dbPathB);
    const sqliteNative = new SqliteNativeVectorStorage({ dbPath: dbPathB });
    const sqliteNativeResult = await benchmarkAdapter('SQLite+Stream', sqliteNative, entries);
    allResults.push(sqliteNativeResult);
    sqliteNative.close();
    cleanupDb(dbPathB);
    console.log(`  SQLite+Stream: insert=${sqliteNativeResult.insertTimeMs}ms, avg_search=${sqliteNativeResult.avgSearchTimeMs}ms, p95=${sqliteNativeResult.p95SearchTimeMs}ms`);

    console.log();
  }

  // Summary table
  console.log('\n=== Summary Table ===');
  console.log('| Adapter       | Dataset | Insert(ms) | Avg Search(ms) | P95 Search(ms) | Max Search(ms) |');
  console.log('|---------------|---------|------------|----------------|----------------|----------------|');
  for (const r of allResults) {
    console.log(
      `| ${r.adapter.padEnd(13)} | ${String(r.datasetSize).padStart(7)} | ${String(r.insertTimeMs).padStart(10)} | ${String(r.avgSearchTimeMs).padStart(14)} | ${String(r.p95SearchTimeMs).padStart(14)} | ${String(r.maxSearchTimeMs).padStart(14)} |`
    );
  }

  // Correctness check: verify all adapters return same top result for same query
  console.log('\n=== Correctness Check ===');
  const checkEntries = generateEntries(100);
  const checkQuery = checkEntries[0].vector; // use first entry as query (should match itself with score=1.0)

  const memCheck = new MemoryVectorStorage();
  await memCheck.upsertBatch(checkEntries);

  const dbA = './benchmark-check-a.db';
  const dbB = './benchmark-check-b.db';
  cleanupDb(dbA);
  cleanupDb(dbB);

  const sqliteJsCheck = new SqliteVectorStorage({ dbPath: dbA });
  await sqliteJsCheck.upsertBatch(checkEntries);

  const sqliteNativeCheck = new SqliteNativeVectorStorage({ dbPath: dbB });
  await sqliteNativeCheck.upsertBatch(checkEntries);

  const q: VectorSearchQuery = { vector: checkQuery, topK: 3, threshold: 0 };
  const [rMem, rJs, rNative] = await Promise.all([
    memCheck.search(q),
    sqliteJsCheck.search(q),
    sqliteNativeCheck.search(q),
  ]);

  console.log(`  Memory top-1:      id=${rMem[0]?.id}, score=${rMem[0]?.score.toFixed(6)}`);
  console.log(`  SQLite+JS top-1:   id=${rJs[0]?.id}, score=${rJs[0]?.score.toFixed(6)}`);
  console.log(`  SQLite+Strm top-1: id=${rNative[0]?.id}, score=${rNative[0]?.score.toFixed(6)}`);

  const allMatch = rMem[0]?.id === rJs[0]?.id && rJs[0]?.id === rNative[0]?.id;
  console.log(`  All match: ${allMatch ? 'YES' : 'NO - MISMATCH!'}`);

  sqliteJsCheck.close();
  sqliteNativeCheck.close();
  cleanupDb(dbA);
  cleanupDb(dbB);
}

main().catch(console.error);
