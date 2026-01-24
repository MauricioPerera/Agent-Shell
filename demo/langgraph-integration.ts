/**
 * Demo: Agent Shell + LangGraph Integration
 *
 * Demonstrates LangGraph server operations as Agent Shell commands.
 *
 * This demo registers LangGraph API operations (assistants, threads, runs)
 * as commands in Agent Shell's namespace system. Once indexed, AI agents
 * can discover and orchestrate stateful graph-based workflows through
 * natural language via semantic vector search.
 *
 * Example interactions (via an AI agent):
 *   Agent: "list available AI agents"       → langgraph:assistants
 *   Agent: "create a conversation thread"   → langgraph:threads
 *   Agent: "run the support agent"          → langgraph:run --thread_id ... --assistant_id ...
 *   Agent: "check graph execution status"   → langgraph:runs --thread_id ...
 *   Agent: "inspect thread state"           → langgraph:state --thread_id ...
 *
 * Requirements:
 *   - LangGraph server running (langgraph up / docker)
 *   - Ollama running locally (for embeddings) OR --cloudflare flag
 *
 * Environment variables:
 *   LANGGRAPH_BASE_URL  - LangGraph server URL (default: http://localhost:8123)
 *   LANGGRAPH_API_KEY   - API key (optional, for authenticated servers)
 *
 * Usage:
 *   bun demo/langgraph-integration.ts
 *   LANGGRAPH_API_KEY=lgk_xxx bun demo/langgraph-integration.ts
 *   bun demo/langgraph-integration.ts --cloudflare
 */

import { Core } from '../src/core/index.js';
import { VectorIndex } from '../src/vector-index/index.js';
import { ContextStore } from '../src/context-store/index.js';
import { OllamaEmbeddingAdapter } from './adapters/ollama-embedding.js';
import { CloudflareEmbeddingAdapter } from './adapters/cloudflare-embedding.js';
import { MemoryVectorStorage } from './adapters/memory-vector-storage.js';
import { MemoryStorageAdapter } from './adapters/memory-storage.js';
import { demoCommands } from './commands.js';
import { createLangGraphCommands } from './langgraph-commands.js';
import { LangGraphApiAdapter } from './adapters/langgraph-api.js';
import * as readline from 'node:readline';

// --- Configuration ---
const LANGGRAPH_BASE_URL = process.env.LANGGRAPH_BASE_URL || 'http://localhost:8123';
const LANGGRAPH_API_KEY = process.env.LANGGRAPH_API_KEY || undefined;

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
  console.log('=== Agent Shell + LangGraph Integration Demo ===\n');

  // 1. Validate LangGraph config
  console.log('[1/5] Verificando configuracion LangGraph...');

  const langGraphApi = new LangGraphApiAdapter({
    baseUrl: LANGGRAPH_BASE_URL,
    apiKey: LANGGRAPH_API_KEY,
  });

  const health = await langGraphApi.healthCheck();

  if (health.status === 'unreachable') {
    console.error(`  ✗ LangGraph no disponible en ${LANGGRAPH_BASE_URL}`);
    console.error('    Verifica que el servidor este corriendo:');
    console.error('      langgraph up');
    console.error('      # o docker run ...');
    process.exit(1);
  }
  console.log(`  ✓ LangGraph conectado en ${LANGGRAPH_BASE_URL}`);
  console.log(`  ✓ Estado: ${health.status}`);
  if (LANGGRAPH_API_KEY) {
    console.log('  ✓ API key configurada');
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

  // 3. Init adapters
  console.log('[3/5] Inicializando adapters...');
  const embeddingAdapter = useCloudflare
    ? new CloudflareEmbeddingAdapter({
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
        apiToken: process.env.CLOUDFLARE_API_TOKEN!,
      })
    : new OllamaEmbeddingAdapter({ model: 'embeddinggemma' });

  const vectorStorage = new MemoryVectorStorage();
  const contextStorage = new MemoryStorageAdapter();
  console.log('  ✓ Adapters inicializados\n');

  // 4. Create and index commands (demo + langgraph)
  console.log('[4/5] Registrando comandos...');
  const langGraphCommands = createLangGraphCommands(langGraphApi);
  const allCommands = [...demoCommands, ...langGraphCommands];

  console.log(`  → ${demoCommands.length} comandos base (users, notes, system, math)`);
  console.log(`  → ${langGraphCommands.length} comandos langgraph (assistants, threads, run...)`);
  console.log(`  = ${allCommands.length} comandos totales`);

  const vectorIndex = new VectorIndex({
    embeddingAdapter,
    storageAdapter: vectorStorage,
    defaultTopK: 5,
    defaultThreshold: 0.4,
  });

  const indexResult = await vectorIndex.indexBatch(allCommands as any);
  console.log(`  ✓ ${indexResult.success}/${indexResult.total} comandos indexados\n`);

  // 5. Create Core
  console.log('[5/5] Creando Core...');
  const registry = createRegistry(allCommands);
  const contextStore = new ContextStore(contextStorage, 'langgraph-demo-session');
  const core = new Core({ registry, vectorIndex, contextStore });
  console.log('  ✓ Core listo\n');

  return core;
}

// --- REPL ---
async function startRepl(core: Core) {
  console.log('─'.repeat(60));
  console.log(' Agent Shell + LangGraph Integration REPL');
  console.log('─'.repeat(60));
  console.log('');
  console.log(' Comandos especiales:');
  console.log('   .help       → Protocolo de interaccion (cli_help)');
  console.log('   .quit       → Salir');
  console.log('   <comando>   → Ejecutar via cli_exec');
  console.log('');
  console.log(' Ejemplos LangGraph:');
  console.log('   search "run an AI agent"');
  console.log('   langgraph:health');
  console.log('   langgraph:assistants');
  console.log('   langgraph:threads --metadata \'{"user":"demo"}\'');
  console.log('   langgraph:run --thread_id "t-1" --assistant_id "a-1" --input \'{"messages":[...]}\'');
  console.log('   langgraph:state --thread_id "t-1"');
  console.log('   langgraph:runs --thread_id "t-1" --status error');
  console.log('');
  console.log('─'.repeat(60));
  console.log('');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'agent-shell[langgraph]> ',
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
