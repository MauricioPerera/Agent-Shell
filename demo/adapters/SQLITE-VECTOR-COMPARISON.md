# SQLite Vector Storage: Comparison

## Context

`sqlite-vec` no tiene binario para Windows. Se implementaron dos alternativas usando `bun:sqlite` puro (sin extensiones):

| | Option A: `SqliteVectorStorage` | Option B: `SqliteNativeVectorStorage` |
|---|---|---|
| Archivo | `sqlite-vector-storage.ts` | `sqlite-native-vector-storage.ts` |
| Estrategia | Load all + JS brute-force | Streaming iterator + min-heap |
| Memoria search | O(N) | O(K) |
| Persistencia | SQLite WAL | SQLite WAL + namespace index |

## Benchmark Results (768 dims, 50 queries, top-5)

| Vectores | Memory (ms) | SQLite+JS (ms) | SQLite+Stream (ms) |
|----------|-------------|-----------------|---------------------|
| 100 | 9.6 avg | 13.7 avg | 14.2 avg |
| 500 | 5.2 avg | 85.5 avg | 80.5 avg |
| 1,000 | 8.1 avg | 320.7 avg | 198.3 avg |
| 5,000 | 65.1 avg | 2,159.0 avg | 700.5 avg |

## Key Findings

1. **Memory** siempre gana en velocidad pura (sin I/O, sin serialization)
2. **SQLite+Stream** supera a **SQLite+JS** por ~3x en datasets grandes (5K+) gracias a:
   - No aloca array de N elementos
   - Min-heap mantiene solo K resultados en memoria
   - Solo parsea metadata JSON para candidatos que entran al top-K
3. **Insert** es el cuello de botella en SQLite (serializar Float32Array a BLOB)
4. **`bun:sqlite` no soporta `db.function()`** - no se pueden registrar funciones SQL custom

## When to Use What

- **< 1000 vectores**: `MemoryVectorStorage` (rapido, simple, pierde datos al reiniciar)
- **1K-10K con persistencia**: `SqliteNativeVectorStorage` (streaming, mejor memoria)
- **> 10K vectores**: Considerar sqlite-vec (Linux/Mac), pgvector, o un servicio dedicado

## Run Benchmark

```bash
bun run demo/benchmark-sqlite-vector.ts
```
