/**
 * Demo: Agent Shell + minimemory Integration
 *
 * Demonstrates minimemory as both the vector storage backend AND as
 * first-class commands for agent memory and hybrid search.
 *
 * This demo does TWO things:
 *   1. Uses MiniMemoryVectorStorage as the vector backend for Agent Shell's
 *      command indexing (replaces MemoryVectorStorage with HNSW).
 *   2. Registers minimemory's AgentMemory and VectorDB operations as
 *      commands in the mm: namespace.
 *
 * This means the agent can:
 *   - Discover commands using HNSW search (faster than brute-force)
 *   - Learn from tasks, store code snippets, remember error solutions
 *   - Search with hybrid vector + keywords + metadata filters
 *   - Persist all memory to .mmdb files
 *
 * Example interactions (via an AI agent):
 *   Agent: "search how to store data"          → mm:insert
 *   Agent: "remember this auth pattern"        → mm:learn-code --code ...
 *   Agent: "find similar error solutions"      → mm:recall-errors --query ...
 *   Agent: "hybrid search for security docs"   → mm:hybrid --keywords "security" ...
 *   Agent: "save all memory to disk"           → mm:save
 *   Agent: "show memory statistics"            → mm:memory-stats
 *
 * Requirements:
 *   - minimemory Node.js binding: npm install minimemory
 *   - Ollama running locally (for embeddings) OR --cloudflare flag
 *
 * Environment variables:
 *   MINIMEMORY_PERSIST_PATH  - Path for .mmdb persistence (default: ./agent-shell.mmdb)
 *   MINIMEMORY_DIMENSIONS    - Vector dimensions (default: 768, matches embeddinggemma)
 *
 * Usage:
 *   bun demo/minimemory-integration.ts
 *   bun demo/minimemory-integration.ts --cloudflare
 *   MINIMEMORY_PERSIST_PATH=./my-data.mmdb bun demo/minimemory-integration.ts
 */

import { Core } from '../src/core/index.js';
import { VectorIndex } from '../src/vector-index/index.js';
import { ContextStore } from '../src/context-store/index.js';
import { OllamaEmbeddingAdapter } from './adapters/ollama-embedding.js';
import { CloudflareEmbeddingAdapter } from './adapters/cloudflare-embedding.js';
import { MiniMemoryVectorStorage } from './adapters/minimemory-vector-storage.js';
import { MiniMemoryApiAdapter } from './adapters/minimemory-api.js';
import { MemoryStorageAdapter } from './adapters/memory-storage.js';
import { demoCommands } from './commands.js';
import { createMiniMemoryCommands } from './minimemory-commands.js';
import * as readline from 'node:readline';

// --- Configuration ---
const PERSIST_PATH = process.env.MINIMEMORY_PERSIST_PATH || './agent-shell.mmdb';
const DIMENSIONS = Number(process.env.MINIMEMORY_DIMENSIONS) || 768;

// --- Registry adapter ---
function createRegistry(commands: any[]) {
  const cmdMap = new Map<string, any>();
  for (const cmd of commands) {
    cmdMap.set(`${cmd.namespace}:${cmd.name}`, cmd);
  }

  return {
    get(namespace: string, name: string) {
      return cmdMap.get(`${namespace}:${name}`) || null;
    },
    resolve(namespace: string, name: string) {
      return this.get(namespace, name);
    },
    listAll() {
      return Array.from(cmdMap.values());
    },
    listByNamespace(ns: string) {
      return Array.from(cmdMap.values()).filter(c => c.namespace === ns);
    },
    getNamespaces() {
      return [...new Set(Array.from(cmdMap.values()).map(c => c.namespace))];
    },
  };
}

// --- Bootstrap ---
async function bootstrap() {
  console.log('=== Agent Shell + minimemory Integration Demo ===\n');

  // 1. Init minimemory (both as storage backend and as command API)
  console.log('[1/5] Inicializando minimemory...');

  let miniMemoryStorage: MiniMemoryVectorStorage;
  let miniMemoryApi: MiniMemoryApiAdapter;

  try {
    // VectorStorageAdapter backed by minimemory HNSW
    miniMemoryStorage = new MiniMemoryVectorStorage({
      dimensions: DIMENSIONS,
      distance: 'cosine',
      indexType: 'hnsw',
      hnswM: 16,
      hnswEfConstruction: 200,
      persistPath: PERSIST_PATH,
    });

    // API adapter for mm: namespace commands
    miniMemoryApi = new MiniMemoryApiAdapter({
      dimensions: DIMENSIONS,
      distance: 'cosine',
      indexType: 'hnsw',
      fulltextFields: ['content', 'description', 'title'],
      persistPath: PERSIST_PATH.replace('.mmdb', '-memory.mmdb'),
    });

    const stats = miniMemoryApi.stats();
    console.log(`  ✓ minimemory inicializado (${stats.count} docs, ${DIMENSIONS}d, HNSW)`);
    console.log(`  ✓ Persistencia: ${PERSIST_PATH}`);
  } catch (error: any) {
    console.error(`  ✗ Error inicializando minimemory: ${error.message}`);
    console.error('');
    console.error('    Asegurate de tener el binding instalado:');
    console.error('      npm install minimemory');
    console.error('    O compilar desde fuente:');
    console.error('      git clone https://github.com/MauricioPerera/minimemory');
    console.error('      cd minimemory && npm run build');
    process.exit(1);
  }
  console.log('');

  // 2. Check embedding backend
  const useCloudflare = process.argv.includes('--cloudflare');
  if (useCloudflare) {
    console.log('[2/5] Usando Cloudflare Workers AI para embeddings...');
    if (!process.env.CLOUDFLARE_ACCOUNT_ID || !process.env.CLOUDFLARE_API_TOKEN) {
      console.error('  ✗ CLOUDFLARE_ACCOUNT_ID y CLOUDFLARE_API_TOKEN requeridos');
      process.exit(1);
    }
    console.log('  ✓ Cloudflare configurado\n');
  } else {
    console.log('[2/5] Verificando Ollama...');
    try {
      const resp = await fetch('http://localhost:11434/api/tags');
      if (!resp.ok) throw new Error('Ollama no disponible');
      console.log('  ✓ Ollama corriendo\n');
    } catch {
      console.error('  ✗ Ollama no disponible en localhost:11434');
      console.error('    Ejecuta: ollama serve');
      process.exit(1);
    }
  }

  // 3. Init embedding adapter
  console.log('[3/5] Inicializando embedding adapter...');
  const embeddingAdapter = useCloudflare
    ? new CloudflareEmbeddingAdapter({
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
        apiToken: process.env.CLOUDFLARE_API_TOKEN!,
      })
    : new OllamaEmbeddingAdapter({ model: 'embeddinggemma' });
  console.log(`  ✓ Embedding: ${useCloudflare ? 'Cloudflare Workers AI' : 'Ollama embeddinggemma'}\n`);

  // 4. Create and index commands (demo + minimemory)
  console.log('[4/5] Registrando comandos...');
  const mmCommands = createMiniMemoryCommands(miniMemoryApi);
  const allCommands = [...demoCommands, ...mmCommands];

  console.log(`  → ${demoCommands.length} comandos base (users, notes, system, math)`);
  console.log(`  → ${mmCommands.length} comandos minimemory (insert, search, hybrid, learn, recall...)`);
  console.log(`  = ${allCommands.length} comandos totales`);

  // Use minimemory HNSW as the vector storage backend!
  const vectorIndex = new VectorIndex({
    embeddingAdapter,
    storageAdapter: miniMemoryStorage,
    defaultTopK: 5,
    defaultThreshold: 0.4,
  });

  const indexResult = await vectorIndex.indexBatch(allCommands as any);
  console.log(`  ✓ ${indexResult.success}/${indexResult.total} comandos indexados (HNSW backend)\n`);

  // 5. Create Core
  console.log('[5/5] Creando Core...');
  const contextStorage = new MemoryStorageAdapter();
  const registry = createRegistry(allCommands);
  const contextStore = new ContextStore(contextStorage, 'minimemory-demo-session');
  const core = new Core({ registry, vectorIndex, contextStore });
  console.log('  ✓ Core listo\n');

  return core;
}

// --- REPL ---
async function startRepl(core: Core) {
  console.log('─'.repeat(60));
  console.log(' Agent Shell + minimemory Integration REPL');
  console.log('─'.repeat(60));
  console.log('');
  console.log(' Comandos especiales:');
  console.log('   .help       → Protocolo de interaccion (cli_help)');
  console.log('   .quit       → Salir');
  console.log('   <comando>   → Ejecutar via cli_exec');
  console.log('');
  console.log(' Ejemplos minimemory:');
  console.log('   search "store documents"');
  console.log('   mm:stats');
  console.log('   mm:insert --id "doc-1" --metadata \'{"title": "Test", "category": "demo"}\'');
  console.log('   mm:keywords --query "test demo"');
  console.log('   mm:hybrid --keywords "authentication" --top_k 5');
  console.log('   mm:learn --task "Setup auth" --solution "Used JWT" --outcome "success"');
  console.log('   mm:recall --query "authentication"');
  console.log('   mm:learn-code --code "fn verify()" --description "JWT verify" --language "rust" --use_case "auth"');
  console.log('   mm:recall-code --query "JWT verification"');
  console.log('   mm:learn-error --error_message "E0596" --error_type "borrow" --root_cause "missing mut" --solution "add mut" --language "rust"');
  console.log('   mm:recall-errors --query "borrow checker"');
  console.log('   mm:memory-stats');
  console.log('   mm:save --path "./my-data.mmdb"');
  console.log('');
  console.log('─'.repeat(60));
  console.log('');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'agent-shell[mm]> ',
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();

    if (!input) {
      rl.prompt();
      return;
    }

    if (input === '.quit' || input === '.exit') {
      console.log('Bye!');
      rl.close();
      process.exit(0);
    }

    if (input === '.help') {
      console.log('\n' + core.help());
      rl.prompt();
      return;
    }

    try {
      const start = Date.now();
      const response = await core.exec(input);
      const elapsed = Date.now() - start;

      if (response.code === 0) {
        console.log(`\n[OK] (${elapsed}ms)`);
        console.log(JSON.stringify(response.data, null, 2));
      } else {
        console.log(`\n[ERROR code=${response.code}] (${elapsed}ms)`);
        console.log(response.error);
      }
    } catch (err: any) {
      console.log(`\n[EXCEPTION] ${err.message}`);
    }

    console.log('');
    rl.prompt();
  });

  rl.on('close', () => {
    process.exit(0);
  });
}

// --- Main ---
bootstrap()
  .then(startRepl)
  .catch((err) => {
    console.error('Error fatal:', err.message);
    process.exit(1);
  });
