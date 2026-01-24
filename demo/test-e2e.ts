/**
 * Test end-to-end no interactivo.
 * Verifica que el flujo completo funciona con Ollama.
 *
 * Uso: bun demo/test-e2e.ts
 */

import { Core } from '../src/core/index.js';
import { VectorIndex } from '../src/vector-index/index.js';
import { ContextStore } from '../src/context-store/index.js';
import { OllamaEmbeddingAdapter } from './adapters/ollama-embedding.js';
import { MemoryVectorStorage } from './adapters/memory-vector-storage.js';
import { MemoryStorageAdapter } from './adapters/memory-storage.js';
import { demoCommands } from './commands.js';

function createRegistry(commands: any[]) {
  const cmdMap = new Map<string, any>();
  for (const cmd of commands) {
    cmdMap.set(`${cmd.namespace}:${cmd.name}`, cmd);
  }
  return {
    get(namespace: string, name: string) { return cmdMap.get(`${namespace}:${name}`) || null; },
    listAll() { return Array.from(cmdMap.values()); },
    listByNamespace(ns: string) { return Array.from(cmdMap.values()).filter((c: any) => c.namespace === ns); },
    getNamespaces() { return [...new Set(Array.from(cmdMap.values()).map((c: any) => c.namespace))]; },
  };
}

async function main() {
  console.log('=== Agent Shell E2E Test ===\n');

  // Bootstrap
  const embeddingAdapter = new OllamaEmbeddingAdapter({ model: 'embeddinggemma' });
  const vectorStorage = new MemoryVectorStorage();
  const vectorIndex = new VectorIndex({ embeddingAdapter, storageAdapter: vectorStorage, defaultTopK: 5, defaultThreshold: 0.4 });

  console.log('Indexando comandos...');
  const t0 = Date.now();
  await vectorIndex.indexBatch(demoCommands as any);
  console.log(`  ${demoCommands.length} comandos indexados en ${Date.now() - t0}ms\n`);

  const registry = createRegistry(demoCommands);
  const contextStore = new ContextStore(new MemoryStorageAdapter(), 'test-session');
  const core = new Core({ registry, vectorIndex, contextStore });

  // --- Tests ---
  const tests = [
    { label: 'Search: crear usuario', cmd: 'search crear un usuario nuevo' },
    { label: 'Search: listar notas', cmd: 'search ver todas las notas' },
    { label: 'Search: calcular', cmd: 'search operacion matematica' },
    { label: 'Search: eliminar', cmd: 'search borrar algo del sistema' },
    { label: 'Search: estado', cmd: 'search como esta el sistema' },
    { label: 'Exec: users:create', cmd: 'users:create --name "Ana Garcia" --email ana@demo.com --role editor' },
    { label: 'Exec: users:list', cmd: 'users:list' },
    { label: 'Exec: users:get | .name', cmd: 'users:get --id 1 | .name' },
    { label: 'Exec: notes:create', cmd: 'notes:create --title "Primera nota" --content "Contenido de prueba"' },
    { label: 'Exec: system:status', cmd: 'system:status' },
    { label: 'Exec: math:calc', cmd: 'math:calc --a 15 --b 7 --op mul' },
    { label: 'Describe: users:create', cmd: 'describe users:create' },
  ];

  let passed = 0;
  for (const test of tests) {
    const t1 = Date.now();
    const response = await core.exec(test.cmd);
    const elapsed = Date.now() - t1;

    const status = response.code === 0 ? '✓' : '✗';
    console.log(`${status} [${elapsed.toString().padStart(4)}ms] ${test.label}`);

    if (response.code === 0) {
      passed++;
      // Show search results compactly
      if (test.cmd.startsWith('search')) {
        const results = response.data?.results || [];
        results.slice(0, 3).forEach((r: any) => {
          console.log(`    ${r.score.toFixed(3)}  ${r.commandId} — ${r.description}`);
        });
      } else {
        const data = JSON.stringify(response.data);
        console.log(`    ${data.length > 100 ? data.slice(0, 100) + '...' : data}`);
      }
    } else {
      console.log(`    ERROR: ${response.error}`);
    }
  }

  console.log(`\n═══ Resultado: ${passed}/${tests.length} tests pasaron ═══`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
