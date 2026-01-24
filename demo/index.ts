/**
 * Demo interactivo de Agent Shell.
 *
 * Inicializa el sistema con Ollama embeddings, indexa los comandos,
 * y expone un REPL interactivo para probar cli_help() y cli_exec().
 *
 * Uso: bun demo/index.ts
 */

import { Core } from '../src/core/index.js';
import { VectorIndex } from '../src/vector-index/index.js';
import { ContextStore } from '../src/context-store/index.js';
import { OllamaEmbeddingAdapter } from './adapters/ollama-embedding.js';
import { CloudflareEmbeddingAdapter } from './adapters/cloudflare-embedding.js';
import { MemoryVectorStorage } from './adapters/memory-vector-storage.js';
import { MemoryStorageAdapter } from './adapters/memory-storage.js';
import { demoCommands } from './commands.js';
import * as readline from 'node:readline';

// --- Registry adapter (bridges demo commands to Core expected interface) ---
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
  console.log('=== Agent Shell Demo ===\n');

  // 1. Check backend
  const useCloudflareFlag = process.argv.includes('--cloudflare');
  if (useCloudflareFlag) {
    console.log('[1/4] Usando Cloudflare Workers AI...');
    console.log('  ✓ Cloudflare API configurado\n');
  } else {
    console.log('[1/4] Verificando Ollama...');
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

  // 2. Init adapters
  console.log(`[2/4] Inicializando adapters (${useCloudflareFlag ? 'Cloudflare' : 'Ollama'})...`);

  if (useCloudflareFlag && (!process.env.CLOUDFLARE_ACCOUNT_ID || !process.env.CLOUDFLARE_API_TOKEN)) {
    console.error('  ✗ CLOUDFLARE_ACCOUNT_ID y CLOUDFLARE_API_TOKEN requeridos para modo --cloudflare');
    process.exit(1);
  }

  const embeddingAdapter = useCloudflareFlag
    ? new CloudflareEmbeddingAdapter({
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
        apiToken: process.env.CLOUDFLARE_API_TOKEN!,
      })
    : new OllamaEmbeddingAdapter({ model: 'embeddinggemma' });

  const vectorStorage = new MemoryVectorStorage();
  const contextStorage = new MemoryStorageAdapter();
  console.log(`  ✓ ${useCloudflareFlag ? 'Cloudflare' : 'Ollama'} EmbeddingAdapter (embeddinggemma, 768d)`);
  console.log('  ✓ MemoryVectorStorage');
  console.log('  ✓ MemoryStorageAdapter\n');

  // 3. Index commands
  console.log(`[3/4] Indexando ${demoCommands.length} comandos...`);
  const vectorIndex = new VectorIndex({
    embeddingAdapter,
    storageAdapter: vectorStorage,
    defaultTopK: 5,
    defaultThreshold: 0.4,
  });

  const indexResult = await vectorIndex.indexBatch(demoCommands as any);
  console.log(`  ✓ ${indexResult.success}/${indexResult.total} comandos indexados\n`);

  // 4. Create Core
  console.log('[4/4] Creando Core...');
  const registry = createRegistry(demoCommands);
  const contextStore = new ContextStore(contextStorage, 'demo-session');

  const core = new Core({ registry, vectorIndex, contextStore });
  console.log('  ✓ Core listo\n');

  return core;
}

// --- REPL ---
async function startRepl(core: Core) {
  console.log('─'.repeat(50));
  console.log('Agent Shell REPL');
  console.log('Comandos especiales:');
  console.log('  .help     → cli_help()');
  console.log('  .quit     → salir');
  console.log('  <comando> → cli_exec(comando)');
  console.log('─'.repeat(50));
  console.log('');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'agent-shell> ',
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

      // Format output
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
