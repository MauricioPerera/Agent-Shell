#!/usr/bin/env node
/**
 * @module cli
 * @description Entry point CLI de Agent Shell.
 *
 * Subcomandos:
 *   serve   - Inicia el servidor MCP (stdio)
 *   help    - Muestra ayuda del CLI
 *   version - Muestra la version
 */

import { McpServer } from '../mcp/server.js';
import { Core } from '../core/index.js';

const VERSION = '0.1.0';

const USAGE = `
agent-shell - AI-first CLI framework (2 tools + vector discovery)

Usage:
  agent-shell <command> [options]

Commands:
  serve       Start MCP server (stdio transport)
  version     Show version
  help        Show this help message

Options:
  --help, -h  Show help

Examples:
  agent-shell serve              Start MCP server for LLM consumption
  agent-shell version            Print version

For more info: https://github.com/anthropics/agent-shell
`.trim();

function showHelp(): void {
  console.log(USAGE);
}

function showVersion(): void {
  console.log(`agent-shell v${VERSION}`);
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
