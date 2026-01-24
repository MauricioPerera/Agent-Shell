/**
 * Demo: Agent Shell + VoltAgent Integration
 *
 * Demonstrates VoltAgent agents and workflows as Agent Shell commands.
 *
 * This demo registers VoltAgent API operations (agents, chat, workflows,
 * conversations) as commands in Agent Shell's namespace system. Once indexed,
 * AI agents can discover and orchestrate multi-agent workflows through
 * natural language via semantic vector search.
 *
 * Example interactions (via an AI agent):
 *   Agent: "list available AI agents"          → voltagent:agents
 *   Agent: "send a message to support"         → voltagent:send --agent_id ...
 *   Agent: "chat with the RAG agent"           → voltagent:chat --agent_id ...
 *   Agent: "run the approval workflow"         → voltagent:run-workflow --workflow_id ...
 *   Agent: "show conversation history"         → voltagent:conversations --agent_id ...
 *   Agent: "resume the suspended workflow"     → voltagent:resume-workflow ...
 *
 * Requirements:
 *   - VoltAgent server running (default: http://localhost:3141)
 *   - Ollama running locally (for embeddings) OR --cloudflare flag
 *
 * Environment variables:
 *   VOLTAGENT_BASE_URL  - VoltAgent server URL (default: http://localhost:3141)
 *   VOLTAGENT_API_KEY   - API key (optional, for authenticated servers)
 *
 * Usage:
 *   bun demo/voltagent-integration.ts
 *   VOLTAGENT_API_KEY=xxx bun demo/voltagent-integration.ts
 *   bun demo/voltagent-integration.ts --cloudflare
 */

import { Core } from '../src/core/index.js';
import { VectorIndex } from '../src/vector-index/index.js';
import { ContextStore } from '../src/context-store/index.js';
import { OllamaEmbeddingAdapter } from './adapters/ollama-embedding.js';
import { CloudflareEmbeddingAdapter } from './adapters/cloudflare-embedding.js';
import { MemoryVectorStorage } from './adapters/memory-vector-storage.js';
import { MemoryStorageAdapter } from './adapters/memory-storage.js';
import { demoCommands } from './commands.js';
import { createVoltAgentCommands } from './voltagent-commands.js';
import { VoltAgentApiAdapter } from './adapters/voltagent-api.js';
import * as readline from 'node:readline';

// --- Configuration ---
const VOLTAGENT_BASE_URL = process.env.VOLTAGENT_BASE_URL || 'http://localhost:3141';
const VOLTAGENT_API_KEY = process.env.VOLTAGENT_API_KEY || undefined;

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
  console.log('=== Agent Shell + VoltAgent Integration Demo ===\n');

  // 1. Validate VoltAgent config
  console.log('[1/5] Verificando configuracion VoltAgent...');

  const voltAgentApi = new VoltAgentApiAdapter({
    baseUrl: VOLTAGENT_BASE_URL,
    apiKey: VOLTAGENT_API_KEY,
  });

  const health = await voltAgentApi.healthCheck();

  if (health.status === 'unreachable') {
    console.error(`  ✗ VoltAgent no disponible en ${VOLTAGENT_BASE_URL}`);
    console.error('    Verifica que el servidor este corriendo:');
    console.error('      npm run dev   (en tu proyecto VoltAgent)');
    console.error('      # El servidor debe estar en http://localhost:3141');
    process.exit(1);
  }
  console.log(`  ✓ VoltAgent conectado en ${VOLTAGENT_BASE_URL}`);
  console.log(`  ✓ Estado: ${health.status}`);
  if (VOLTAGENT_API_KEY) {
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

  // 4. Create and index commands (demo + voltagent)
  console.log('[4/5] Registrando comandos...');
  const voltAgentCommands = createVoltAgentCommands(voltAgentApi);
  const allCommands = [...demoCommands, ...voltAgentCommands];

  console.log(`  → ${demoCommands.length} comandos base (users, notes, system, math)`);
  console.log(`  → ${voltAgentCommands.length} comandos voltagent (agents, send, chat, workflows...)`);
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
  const contextStore = new ContextStore(contextStorage, 'voltagent-demo-session');
  const core = new Core({ registry, vectorIndex, contextStore });
  console.log('  ✓ Core listo\n');

  return core;
}

// --- REPL ---
async function startRepl(core: Core) {
  console.log('─'.repeat(60));
  console.log(' Agent Shell + VoltAgent Integration REPL');
  console.log('─'.repeat(60));
  console.log('');
  console.log(' Comandos especiales:');
  console.log('   .help       → Protocolo de interaccion (cli_help)');
  console.log('   .quit       → Salir');
  console.log('   <comando>   → Ejecutar via cli_exec');
  console.log('');
  console.log(' Ejemplos VoltAgent:');
  console.log('   search "send message to AI agent"');
  console.log('   voltagent:health');
  console.log('   voltagent:agents');
  console.log('   voltagent:send --agent_id "my-agent" --input "Hello!"');
  console.log('   voltagent:chat --agent_id "my-agent" --input "Tell me a joke"');
  console.log('   voltagent:workflows');
  console.log('   voltagent:run-workflow --workflow_id "approval" --input \'{"amount": 100}\'');
  console.log('   voltagent:conversations --agent_id "my-agent"');
  console.log('');
  console.log('─'.repeat(60));
  console.log('');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'agent-shell[voltagent]> ',
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
