#!/usr/bin/env node
/**
 * @module server
 * @description Production-ready Agent Shell HTTP server.
 *
 * Reads configuration from environment variables or agent-shell.config.json,
 * bootstraps the full stack (registry + skills + vectorIndex + core + MCP),
 * and starts the HTTP/SSE transport with Bearer token auth.
 *
 * Usage:
 *   AGENT_SHELL_TOKEN=my-secret npx tsx src/server/index.ts
 *
 * Or with config file:
 *   Create agent-shell.config.json in the working directory
 */

import { CommandRegistry } from '../command-registry/index.js';
import { Core } from '../core/index.js';
import { McpServer } from '../mcp/server.js';
import { HttpSseTransport } from '../mcp/http-transport.js';
import { registerSkills, registerShellSkills } from '../skills/index.js';
import { createShellAdapter } from '../just-bash/factory.js';
import type { AgentProfile } from '../core/agent-profiles.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface ServerConfig {
  port: number;
  host: string;
  auth: { bearerToken: string } | null;
  agentProfile: AgentProfile | null;
  permissions: string[] | null;
  corsOrigin: string | string[];
  skills: { cli: boolean; shell: boolean };
  shellAdapter: 'native' | 'just-bash' | 'auto';
}

function loadConfig(): ServerConfig {
  // Defaults
  const config: ServerConfig = {
    port: 3000,
    host: '0.0.0.0',
    auth: null,
    agentProfile: null,
    permissions: null,
    corsOrigin: '*',
    skills: { cli: true, shell: true },
    shellAdapter: 'auto',
  };

  // Try config file
  const configPath = resolve(process.cwd(), 'agent-shell.config.json');
  if (existsSync(configPath)) {
    try {
      const fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (fileConfig.port) config.port = fileConfig.port;
      if (fileConfig.host) config.host = fileConfig.host;
      if (fileConfig.auth?.bearerToken) config.auth = { bearerToken: fileConfig.auth.bearerToken };
      if (fileConfig.agentProfile) config.agentProfile = fileConfig.agentProfile;
      if (fileConfig.permissions) config.permissions = fileConfig.permissions;
      if (fileConfig.corsOrigin) config.corsOrigin = fileConfig.corsOrigin;
      if (fileConfig.skills) config.skills = { ...config.skills, ...fileConfig.skills };
      if (fileConfig.shellAdapter) config.shellAdapter = fileConfig.shellAdapter;
    } catch (err) {
      console.error(`Warning: Failed to parse ${configPath}:`, (err as Error).message);
    }
  }

  // Env vars override file config
  if (process.env.AGENT_SHELL_PORT) config.port = parseInt(process.env.AGENT_SHELL_PORT, 10);
  if (process.env.AGENT_SHELL_HOST) config.host = process.env.AGENT_SHELL_HOST;
  if (process.env.AGENT_SHELL_TOKEN) config.auth = { bearerToken: process.env.AGENT_SHELL_TOKEN };
  if (process.env.AGENT_SHELL_PROFILE) config.agentProfile = process.env.AGENT_SHELL_PROFILE as AgentProfile;
  if (process.env.AGENT_SHELL_CORS_ORIGIN) config.corsOrigin = process.env.AGENT_SHELL_CORS_ORIGIN;
  if (process.env.AGENT_SHELL_ADAPTER) config.shellAdapter = process.env.AGENT_SHELL_ADAPTER as any;

  return config;
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function main() {
  const config = loadConfig();

  console.log('Agent Shell Server starting...');
  console.log(`  Port: ${config.port}`);
  console.log(`  Host: ${config.host}`);
  console.log(`  Auth: ${config.auth ? 'Bearer token enabled' : 'DISABLED (not recommended)'}`);
  console.log(`  Profile: ${config.agentProfile || 'none (unrestricted)'}`);
  console.log(`  Shell adapter: ${config.shellAdapter}`);

  if (!config.auth) {
    console.warn('\n  WARNING: No authentication configured. Server is open to anyone.');
    console.warn('  Set AGENT_SHELL_TOKEN=<token> or add auth.bearerToken to config.\n');
  }

  // Registry
  const registry = new CommandRegistry();

  // Skills
  if (config.skills.cli) {
    registerSkills(registry);
    console.log('  CLI skills: 9 commands registered');
  }
  if (config.skills.shell) {
    const adapter = createShellAdapter({ prefer: config.shellAdapter });
    registerShellSkills(registry, adapter);
    console.log(`  Shell skills: 12 commands registered (${adapter.backend} backend)`);
  }

  const totalCommands = registry.listAll().length;
  console.log(`  Total commands: ${totalCommands}`);

  // Core
  const coreConfig: any = { registry };
  if (config.agentProfile) coreConfig.agentProfile = config.agentProfile;
  if (config.permissions) coreConfig.permissions = config.permissions;
  const core = new Core(coreConfig);

  // MCP Server
  const mcpServer = new McpServer({ core, name: 'agent-shell', version: '0.1.0' });

  // HTTP Transport
  const transport = new HttpSseTransport({
    port: config.port,
    host: config.host,
    corsOrigin: config.corsOrigin,
    auth: config.auth || undefined,
  });

  transport.onMessage(async (msg) => {
    const response = await mcpServer.handleMessage(msg);
    return response;
  });

  await transport.start();

  console.log(`\nAgent Shell Server running at http://${config.host}:${config.port}`);
  console.log(`  RPC endpoint: POST http://${config.host}:${config.port}/rpc`);
  console.log(`  SSE endpoint: GET  http://${config.host}:${config.port}/sse`);
  console.log(`  Health check: GET  http://${config.host}:${config.port}/health`);

  if (config.auth) {
    console.log(`\nClaude Desktop config:`);
    console.log(JSON.stringify({
      mcpServers: {
        'agent-shell': {
          url: `http://${config.host === '0.0.0.0' ? 'YOUR-VPS-IP' : config.host}:${config.port}/sse`,
          headers: { Authorization: `Bearer ${config.auth.bearerToken}` },
        },
      },
    }, null, 2));
  }

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await transport.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await transport.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Failed to start:', err.message);
  process.exit(1);
});
