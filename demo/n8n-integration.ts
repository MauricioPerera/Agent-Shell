/**
 * Demo: Agent Shell + n8n Integration
 *
 * Demonstrates Strategy 2: n8n workflows as Agent Shell commands.
 *
 * This demo registers n8n API operations as commands in Agent Shell's
 * namespace system. Once indexed, AI agents can discover and execute
 * n8n workflows through natural language via semantic vector search.
 *
 * Example interactions (via an AI agent):
 *   Agent: "list all active automations"    → n8n:workflows --active true
 *   Agent: "run the email notification"     → n8n:trigger --id "xyz"
 *   Agent: "check automation health"        → n8n:health
 *   Agent: "show recent failed executions"  → n8n:executions --status error
 *
 * Requirements:
 *   - n8n instance with API enabled (Settings > API > Enable)
 *   - Ollama running locally (for embeddings) OR --cloudflare flag
 *
 * Environment variables:
 *   N8N_BASE_URL  - n8n instance URL (default: http://localhost:5678)
 *   N8N_API_KEY   - API key generated in n8n
 *
 * Usage:
 *   N8N_API_KEY=your-key bun demo/n8n-integration.ts
 *   N8N_API_KEY=your-key bun demo/n8n-integration.ts --cloudflare
 */

import { Core } from '../src/core/index.js';
import { VectorIndex } from '../src/vector-index/index.js';
import { ContextStore } from '../src/context-store/index.js';
import { OllamaEmbeddingAdapter } from './adapters/ollama-embedding.js';
import { CloudflareEmbeddingAdapter } from './adapters/cloudflare-embedding.js';
import { MemoryVectorStorage } from './adapters/memory-vector-storage.js';
import { MemoryStorageAdapter } from './adapters/memory-storage.js';
import { demoCommands } from './commands.js';
import { createN8nCommands } from './n8n-commands.js';
import { N8nApiAdapter } from './adapters/n8n-api.js';
import * as readline from 'node:readline';

// --- Configuration ---
const N8N_BASE_URL = process.env.N8N_BASE_URL || 'http://localhost:5678';
const N8N_API_KEY = process.env.N8N_API_KEY || '';

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
  console.log('=== Agent Shell + n8n Integration Demo ===\n');

  // 1. Validate n8n config
  console.log('[1/5] Verificando configuracion n8n...');
  if (!N8N_API_KEY) {
    console.error('  ✗ N8N_API_KEY no configurada');
    console.error('    Uso: N8N_API_KEY=your-key bun demo/n8n-integration.ts');
    console.error('    Genera tu API key en: n8n Settings > API > Create API Key');
    process.exit(1);
  }

  const n8nApi = new N8nApiAdapter({ baseUrl: N8N_BASE_URL, apiKey: N8N_API_KEY });
  const health = await n8nApi.healthCheck();

  if (health.status === 'unreachable') {
    console.error(`  ✗ n8n no disponible en ${N8N_BASE_URL}`);
    console.error('    Verifica que n8n este corriendo y la URL sea correcta');
    process.exit(1);
  }
  console.log(`  ✓ n8n conectado en ${N8N_BASE_URL}`);
  console.log(`  ✓ Estado: ${health.status}\n`);

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

  // 4. Create and index commands (demo + n8n)
  console.log('[4/5] Registrando comandos...');
  const n8nCommands = createN8nCommands(n8nApi);
  const allCommands = [...demoCommands, ...n8nCommands];

  console.log(`  → ${demoCommands.length} comandos base (users, notes, system, math)`);
  console.log(`  → ${n8nCommands.length} comandos n8n (workflows, trigger, executions...)`);
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
  const contextStore = new ContextStore(contextStorage, 'n8n-demo-session');
  const core = new Core({ registry, vectorIndex, contextStore });
  console.log('  ✓ Core listo\n');

  return core;
}

// --- REPL ---
async function startRepl(core: Core) {
  console.log('─'.repeat(60));
  console.log(' Agent Shell + n8n Integration REPL');
  console.log('─'.repeat(60));
  console.log('');
  console.log(' Comandos especiales:');
  console.log('   .help       → Protocolo de interaccion (cli_help)');
  console.log('   .quit       → Salir');
  console.log('   <comando>   → Ejecutar via cli_exec');
  console.log('');
  console.log(' Ejemplos n8n:');
  console.log('   search "list automations"');
  console.log('   n8n:health');
  console.log('   n8n:workflows --active true');
  console.log('   n8n:trigger --id "workflow-id" --payload \'{"key":"value"}\'');
  console.log('   n8n:executions --status error --limit 5');
  console.log('');
  console.log('─'.repeat(60));
  console.log('');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'agent-shell[n8n]> ',
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
