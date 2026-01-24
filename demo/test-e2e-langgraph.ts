/**
 * Test end-to-end no interactivo para integracion LangGraph.
 * Verifica que el flujo completo funciona con Ollama + LangGraph.
 *
 * Uso: bun demo/test-e2e-langgraph.ts
 *
 * Requiere:
 *   - Ollama corriendo en localhost:11434
 *   - LangGraph server corriendo (LANGGRAPH_BASE_URL, default: localhost:8123)
 */

import { Core } from '../src/core/index.js';
import { VectorIndex } from '../src/vector-index/index.js';
import { ContextStore } from '../src/context-store/index.js';
import { OllamaEmbeddingAdapter } from './adapters/ollama-embedding.js';
import { MemoryVectorStorage } from './adapters/memory-vector-storage.js';
import { MemoryStorageAdapter } from './adapters/memory-storage.js';
import { demoCommands } from './commands.js';
import { createLangGraphCommands } from './langgraph-commands.js';
import { LangGraphApiAdapter } from './adapters/langgraph-api.js';

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
  console.log('=== Agent Shell + LangGraph E2E Test ===\n');

  // Setup LangGraph API
  const LANGGRAPH_BASE_URL = process.env.LANGGRAPH_BASE_URL || 'http://localhost:8123';
  const LANGGRAPH_API_KEY = process.env.LANGGRAPH_API_KEY || undefined;

  const langGraphApi = new LangGraphApiAdapter({
    baseUrl: LANGGRAPH_BASE_URL,
    apiKey: LANGGRAPH_API_KEY,
  });

  // Bootstrap
  const embeddingAdapter = new OllamaEmbeddingAdapter({ model: 'embeddinggemma' });
  const vectorStorage = new MemoryVectorStorage();
  const vectorIndex = new VectorIndex({ embeddingAdapter, storageAdapter: vectorStorage, defaultTopK: 5, defaultThreshold: 0.4 });

  const langGraphCommands = createLangGraphCommands(langGraphApi);
  const allCommands = [...demoCommands, ...langGraphCommands];

  console.log(`Indexando ${allCommands.length} comandos (${demoCommands.length} base + ${langGraphCommands.length} langgraph)...`);
  const t0 = Date.now();
  await vectorIndex.indexBatch(allCommands as any);
  console.log(`  ${allCommands.length} comandos indexados en ${Date.now() - t0}ms\n`);

  const registry = createRegistry(allCommands);
  const contextStore = new ContextStore(new MemoryStorageAdapter(), 'test-langgraph-session');
  const core = new Core({ registry, vectorIndex, contextStore });

  // --- Tests ---
  const tests = [
    // Semantic search tests - should discover langgraph commands
    { label: 'Search: run an AI agent', cmd: 'search run an AI agent graph' },
    { label: 'Search: list available agents', cmd: 'search list available AI agents or assistants' },
    { label: 'Search: check execution status', cmd: 'search check graph execution status' },
    { label: 'Search: streaming execution', cmd: 'search execute with real-time streaming updates' },
    { label: 'Search: create conversation', cmd: 'search create a new conversation session' },
    { label: 'Search: inspect state', cmd: 'search inspect current conversation state' },

    // Direct command execution tests
    { label: 'Exec: langgraph:health', cmd: 'langgraph:health' },
    { label: 'Exec: langgraph:assistants', cmd: 'langgraph:assistants' },
    { label: 'Exec: langgraph:threads', cmd: 'langgraph:threads' },

    // Describe commands (always works - reads from registry)
    { label: 'Describe: langgraph:run', cmd: 'describe langgraph:run' },
    { label: 'Describe: langgraph:stream', cmd: 'describe langgraph:stream' },
    { label: 'Describe: langgraph:state', cmd: 'describe langgraph:state' },
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
        console.log(`    ${data.length > 120 ? data.slice(0, 120) + '...' : data}`);
      }
    } else {
      console.log(`    ERROR: ${response.error}`);
    }
  }

  console.log(`\n═══ Resultado: ${passed}/${tests.length} tests pasaron ═══`);

  // Verify langgraph commands are discoverable
  console.log('\n--- Verificacion de descubrimiento semantico ---');
  const searchResult = await core.exec('search "run agent graph"');
  if (searchResult.code === 0) {
    const lgResults = (searchResult.data?.results || []).filter((r: any) =>
      r.commandId.startsWith('langgraph:')
    );
    if (lgResults.length > 0) {
      console.log(`✓ ${lgResults.length} comandos langgraph descubiertos via busqueda semantica`);
    } else {
      console.log('✗ Ningun comando langgraph descubierto via busqueda semantica');
    }
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
