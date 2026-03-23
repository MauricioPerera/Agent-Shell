/**
 * Tests for shell system skills: http, json, file, shell exec, env.
 *
 * Uses mocks for network, filesystem, and child_process to avoid
 * side effects in tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CommandRegistry } from '../src/command-registry/index.js';
import { httpCommands } from '../src/skills/shell-http.js';
import { jsonCommands } from '../src/skills/shell-json.js';
import { createFileCommands } from '../src/skills/shell-file.js';
import { createShellCommands } from '../src/skills/shell-exec.js';
import { envCommands } from '../src/skills/shell-env.js';
import { registerShellSkills } from '../src/skills/index.js';
import { NativeShellAdapter } from '../src/just-bash/adapter.js';
import type { SkillEntry } from '../src/skills/scaffold.js';

// Create adapter-bound commands for testing
const nativeAdapter = new NativeShellAdapter();
const shellCommands = createShellCommands(nativeAdapter);
const fileCommands = createFileCommands(nativeAdapter);

function findHandler(entries: SkillEntry[], namespace: string, name: string): Function {
  const entry = entries.find(e => e.definition.namespace === namespace && e.definition.name === name);
  if (!entry) throw new Error(`Handler not found: ${namespace}:${name}`);
  return entry.handler;
}

// ===========================================================================
// JSON Skills (no mocks needed — pure logic)
// ===========================================================================

describe('JSON Skills', () => {

  it('JS01: json:filter applies jq expression to input', async () => {
    const handler = findHandler(jsonCommands, 'json', 'filter');
    const result = await handler({
      expression: '.name',
      input: { name: 'Alice', age: 30 },
    });

    expect(result.success).toBe(true);
    expect(result.data).toBe('Alice');
  });

  it('JS02: json:filter works with pipeline input', async () => {
    const handler = findHandler(jsonCommands, 'json', 'filter');
    const result = await handler(
      { expression: '.users' },
      { users: [1, 2, 3] }, // pipeline input
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual([1, 2, 3]);
  });

  it('JS03: json:filter returns error without input', async () => {
    const handler = findHandler(jsonCommands, 'json', 'filter');
    const result = await handler({ expression: '.name' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('No input data');
  });

  it('JS04: json:filter parses JSON string input', async () => {
    const handler = findHandler(jsonCommands, 'json', 'filter');
    const result = await handler({
      expression: '.x',
      input: '{"x": 42}',
    });

    expect(result.success).toBe(true);
    expect(result.data).toBe(42);
  });

  it('JS05: json:parse parses valid JSON', async () => {
    const handler = findHandler(jsonCommands, 'json', 'parse');
    const result = await handler({ text: '{"key": "value", "num": 123}' });

    expect(result.success).toBe(true);
    expect(result.data.key).toBe('value');
    expect(result.data.num).toBe(123);
  });

  it('JS06: json:parse returns error for invalid JSON', async () => {
    const handler = findHandler(jsonCommands, 'json', 'parse');
    const result = await handler({ text: 'not json {' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid JSON');
  });
});

// ===========================================================================
// HTTP Skills (mock fetch)
// ===========================================================================

describe('HTTP Skills', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn(async (url: string, opts?: any) => ({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ url, method: opts?.method || 'GET' }),
      text: async () => JSON.stringify({ url, method: opts?.method || 'GET' }),
    })) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('HT01: http:get calls fetch with GET', async () => {
    const handler = findHandler(httpCommands, 'http', 'get');
    const result = await handler({ url: 'https://api.test.com/data' });

    expect(result.success).toBe(true);
    expect(result.data.status).toBe(200);
    expect(result.data.body.method).toBe('GET');
  });

  it('HT02: http:post calls fetch with POST', async () => {
    const handler = findHandler(httpCommands, 'http', 'post');
    const result = await handler({ url: 'https://api.test.com/data', body: { name: 'test' } });

    expect(result.success).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalled();
    const callArgs = (globalThis.fetch as any).mock.calls[0];
    expect(callArgs[1].method).toBe('POST');
  });

  it('HT03: http:request supports custom method', async () => {
    const handler = findHandler(httpCommands, 'http', 'request');
    const result = await handler({ url: 'https://api.test.com/data/1', method: 'DELETE' });

    expect(result.success).toBe(true);
    const callArgs = (globalThis.fetch as any).mock.calls[0];
    expect(callArgs[1].method).toBe('DELETE');
  });

  it('HT04: http:get handles fetch failure gracefully', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('Network error'); }) as any;

    const handler = findHandler(httpCommands, 'http', 'get');
    const result = await handler({ url: 'https://unreachable.com' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Network error');
  });
});

// ===========================================================================
// Env Skills (uses real process.env, safe to test)
// ===========================================================================

describe('Env Skills', () => {

  it('EV01: env:get returns existing variable', async () => {
    process.env.TEST_SHELL_VAR = 'hello123';
    const handler = findHandler(envCommands, 'env', 'get');
    const result = await handler({ name: 'TEST_SHELL_VAR' });

    expect(result.success).toBe(true);
    expect(result.data.value).toBe('hello123');
    expect(result.data.exists).toBe(true);
    delete process.env.TEST_SHELL_VAR;
  });

  it('EV02: env:get returns exists=false for missing variable', async () => {
    const handler = findHandler(envCommands, 'env', 'get');
    const result = await handler({ name: 'NONEXISTENT_VAR_XYZ' });

    expect(result.success).toBe(true);
    expect(result.data.exists).toBe(false);
  });

  it('EV03: env:get masks sensitive variables', async () => {
    process.env.MY_SECRET_TOKEN = 'super-secret-123';
    const handler = findHandler(envCommands, 'env', 'get');
    const result = await handler({ name: 'MY_SECRET_TOKEN' });

    expect(result.success).toBe(true);
    expect(result.data.value).toBe('***MASKED***');
    expect(result.data.exists).toBe(true);
    delete process.env.MY_SECRET_TOKEN;
  });

  it('EV04: env:list filters by prefix', async () => {
    process.env.ASHELL_TEST_A = '1';
    process.env.ASHELL_TEST_B = '2';
    const handler = findHandler(envCommands, 'env', 'list');
    const result = await handler({ prefix: 'ASHELL_TEST_' });

    expect(result.success).toBe(true);
    expect(result.data.count).toBe(2);
    expect(result.data.variables.ASHELL_TEST_A).toBe('1');
    delete process.env.ASHELL_TEST_A;
    delete process.env.ASHELL_TEST_B;
  });

  it('EV05: env:list masks sensitive keys', async () => {
    process.env.ASHELL_API_KEY = 'secret';
    process.env.ASHELL_NORMAL = 'visible';
    const handler = findHandler(envCommands, 'env', 'list');
    const result = await handler({ prefix: 'ASHELL_' });

    expect(result.data.variables.ASHELL_API_KEY).toBe('***MASKED***');
    expect(result.data.variables.ASHELL_NORMAL).toBe('visible');
    delete process.env.ASHELL_API_KEY;
    delete process.env.ASHELL_NORMAL;
  });
});

// ===========================================================================
// Shell Exec Skills (mock execSync)
// ===========================================================================

describe('Shell Exec Skills', () => {

  it('SH01: shell:which finds a common program', async () => {
    const handler = findHandler(shellCommands, 'shell', 'which');
    // 'node' should exist in any test environment
    const result = await handler({ program: 'node' });

    expect(result.success).toBe(true);
    expect(result.data.found).toBe(true);
    expect(result.data.program).toBe('node');
  });

  it('SH02: shell:which returns found=false for missing program', async () => {
    const handler = findHandler(shellCommands, 'shell', 'which');
    const result = await handler({ program: 'nonexistent-program-xyz-12345' });

    expect(result.success).toBe(true);
    expect(result.data.found).toBe(false);
  });

  it('SH03: shell:exec runs a simple command', async () => {
    const handler = findHandler(shellCommands, 'shell', 'exec');
    const result = await handler({ command: 'echo hello' });

    expect(result.success).toBe(true);
    expect(result.data.stdout).toContain('hello');
    expect(result.data.exitCode).toBe(0);
  });

  it('SH04: shell:exec captures exit code on failure', async () => {
    const handler = findHandler(shellCommands, 'shell', 'exec');
    const result = await handler({ command: 'exit 1', timeout: 5000 });

    expect(result.success).toBe(true); // command ran, even if failed
    expect(result.data.exitCode).not.toBe(0);
  });
});

// ===========================================================================
// File Skills (test with temp directory)
// ===========================================================================

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('File Skills', () => {

  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ashell-test-'));
    writeFileSync(join(tempDir, 'test.txt'), 'hello world');
    writeFileSync(join(tempDir, 'data.json'), '{"key":"value"}');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('FL01: file:read returns file content', async () => {
    const handler = findHandler(fileCommands, 'file', 'read');
    const result = await handler({ path: join(tempDir, 'test.txt') });

    expect(result.success).toBe(true);
    expect(result.data.content).toBe('hello world');
    expect(result.data.size).toBeGreaterThan(0);
  });

  it('FL02: file:read returns error for missing file', async () => {
    const handler = findHandler(fileCommands, 'file', 'read');
    const result = await handler({ path: join(tempDir, 'missing.txt') });

    expect(result.success).toBe(false);
    expect(result.error).toContain('file:read failed');
  });

  it('FL03: file:write creates a file', async () => {
    const handler = findHandler(fileCommands, 'file', 'write');
    const path = join(tempDir, 'output.txt');
    const result = await handler({ path, content: 'written content' });

    expect(result.success).toBe(true);
    expect(result.data.written).toBe(true);

    // Verify file was actually written
    expect(readFileSync(path, 'utf-8')).toBe('written content');
  });

  it('FL04: file:list returns directory entries', async () => {
    const handler = findHandler(fileCommands, 'file', 'list');
    const result = await handler({ path: tempDir });

    expect(result.success).toBe(true);
    expect(result.data.count).toBe(2);
    const names = result.data.entries.map((e: any) => e.name);
    expect(names).toContain('test.txt');
    expect(names).toContain('data.json');
  });

  it('FL05: file:list filters by pattern', async () => {
    const handler = findHandler(fileCommands, 'file', 'list');
    const result = await handler({ path: tempDir, pattern: '.json' });

    expect(result.success).toBe(true);
    expect(result.data.count).toBe(1);
    expect(result.data.entries[0].name).toBe('data.json');
  });
});

// ===========================================================================
// Integration: Registration
// ===========================================================================

describe('Shell Skills Registration', () => {

  it('INT01: registerShellSkills registers 12 commands', () => {
    const registry = new CommandRegistry();
    registerShellSkills(registry);

    const all = registry.listAll();
    expect(all).toHaveLength(12);
  });

  it('INT02: all shell skill definitions have requiredPermissions', () => {
    const allSkills = [...httpCommands, ...jsonCommands, ...fileCommands, ...shellCommands, ...envCommands];

    for (const { definition } of allSkills) {
      expect(definition.requiredPermissions).toBeDefined();
      expect(definition.requiredPermissions!.length).toBeGreaterThan(0);
    }
  });

  it('INT03: shell skills span 5 namespaces', () => {
    const registry = new CommandRegistry();
    registerShellSkills(registry);

    const namespaces = registry.getNamespaces();
    expect(namespaces).toContain('http');
    expect(namespaces).toContain('json');
    expect(namespaces).toContain('file');
    expect(namespaces).toContain('shell');
    expect(namespaces).toContain('env');
  });
});
