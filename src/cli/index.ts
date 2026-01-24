#!/usr/bin/env node
/**
 * @module cli
 * @description Entry point CLI de Agent Shell.
 *
 * Subcomandos:
 *   serve   - Inicia el servidor MCP (stdio o http)
 *   help    - Muestra ayuda del CLI
 *   version - Muestra la version
 */

import { McpServer } from '../mcp/server.js';
import { HttpSseTransport } from '../mcp/http-transport.js';
import { Core } from '../core/index.js';

const VERSION = '0.1.0';

const USAGE = `
agent-shell - AI-first CLI framework (2 tools + vector discovery)

Usage:
  agent-shell <command> [options]

Commands:
  serve       Start MCP server (default: stdio transport)
  version     Show version
  help        Show this help message

Serve Options:
  --transport <stdio|http>  Transport to use (default: stdio)
  --port <number>           HTTP port (default: 3000, only with --transport http)
  --host <string>           HTTP host (default: 127.0.0.1, only with --transport http)
  --cors-origin <origin>    CORS origin (only with --transport http)

Options:
  --help, -h  Show help

Examples:
  agent-shell serve                          Start MCP server (stdio)
  agent-shell serve --transport http         Start HTTP/SSE server on port 3000
  agent-shell serve --transport http --port 8080
  agent-shell version                        Print version

For more info: https://github.com/anthropics/agent-shell
`.trim();

function showHelp(): void {
  console.log(USAGE);
}

function showVersion(): void {
  console.log(`agent-shell v${VERSION}`);
}

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return undefined;
}

function serve(config: { registry: any; vectorIndex?: any; contextStore?: any }): void {
  const core = new Core(config);
  const server = new McpServer({ core, version: VERSION });

  // Graceful shutdown
  process.on('SIGINT', () => {
    server.stop();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    server.stop();
    process.exit(0);
  });

  server.start();
}

async function serveHttp(args: string[]): Promise<void> {
  const port = parseInt(parseFlag(args, '--port') || '3000', 10);
  const host = parseFlag(args, '--host') || '127.0.0.1';
  const corsOrigin = parseFlag(args, '--cors-origin');

  // Programmatic registry setup required
  console.error('Error: "serve --transport http" requires a configured registry.');
  console.error('Use the HttpSseTransport API programmatically with your command registry.');
  console.error('');
  console.error('Example:');
  console.error('  import { Core, McpServer, HttpSseTransport } from "agent-shell";');
  console.error('  const core = new Core({ registry });');
  console.error('  const mcp = new McpServer({ core });');
  console.error(`  const transport = new HttpSseTransport({ port: ${port}, host: "${host}"${corsOrigin ? `, corsOrigin: "${corsOrigin}"` : ''} });`);
  console.error('  transport.onMessage((req) => mcp.handleMessage(req));');
  console.error('  await transport.start();');
  process.exit(1);
}

/** Punto de entrada principal del CLI. */
export function main(args: string[] = process.argv.slice(2)): void {
  const command = args[0];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    showHelp();
    return;
  }

  if (command === 'version' || command === '--version' || command === '-v') {
    showVersion();
    return;
  }

  if (command === 'serve') {
    const transport = parseFlag(args, '--transport') || 'stdio';

    if (transport === 'http') {
      serveHttp(args);
      return;
    }

    if (transport !== 'stdio') {
      console.error(`Unknown transport: ${transport}. Use "stdio" or "http".`);
      process.exit(1);
      return;
    }

    // In serve mode, the registry must be provided programmatically
    // or via a config file. For now, we start with an empty registry.
    // Users should use the API directly for custom setups.
    console.error('Error: "serve" requires a configured registry.');
    console.error('Use the McpServer API programmatically with your command registry.');
    console.error('');
    console.error('Example:');
    console.error('  import { Core, McpServer } from "agent-shell";');
    console.error('  const core = new Core({ registry });');
    console.error('  new McpServer({ core }).start();');
    process.exit(1);
    return;
  }

  console.error(`Unknown command: ${command}`);
  console.error('Run "agent-shell help" for usage information.');
  process.exit(1);
}

// Auto-execute when run directly
const isDirectExecution = process.argv[1]?.includes('agent-shell') ||
  process.argv[1]?.endsWith('/cli/index.js') ||
  process.argv[1]?.endsWith('\\cli\\index.js');

if (isDirectExecution) {
  main();
}
