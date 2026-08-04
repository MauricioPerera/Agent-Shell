/**
 * Tests for infrastructure completion: file ops, git, cron, secrets, process manager.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, existsSync, mkdirSync, statSync, readFileSync, chmodSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { CommandRegistry } from '../src/command-registry/index.js';
import { registerShellSkills } from '../src/skills/index.js';
import { command } from '../src/command-builder/index.js';
import { createFileCommands } from '../src/skills/shell-file.js';
import { gitCommands, createGitCommands } from '../src/skills/shell-git.js';
import { CronScheduler, createCronCommands, cronCommands } from '../src/skills/cron.js';
import { SecretStore, createSecretCommands } from '../src/skills/secret-store.js';
import { ProcessManager, createProcessCommands, processCommands } from '../src/skills/process-mgr.js';
import { NativeShellAdapter } from '../src/just-bash/adapter.js';
import type { SkillEntry } from '../src/skills/scaffold.js';
import type { ShellAdapter } from '../src/just-bash/types.js';

function findHandler(entries: SkillEntry[], ns: string, name: string): Function {
  const e = entries.find(e => e.definition.namespace === ns && e.definition.name === name);
  if (!e) throw new Error(`Not found: ${ns}:${name}`);
  return e.handler;
}

// ===========================================================================
// FILE OPS (mkdir, delete, rename, chmod)
// ===========================================================================

describe('File CRUD Operations', () => {
  const adapter = new NativeShellAdapter();
  const cmds = createFileCommands(adapter);
  let tempDir: string;

  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'fileops-')); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('FO01: file:mkdir creates directory recursively', async () => {
    const handler = findHandler(cmds, 'file', 'mkdir');
    const path = join(tempDir, 'a', 'b', 'c');
    const res = await handler({ path, recursive: true });
    expect(res.success).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  it('FO02: file:delete removes a file', async () => {
    const handler = findHandler(cmds, 'file', 'delete');
    const path = join(tempDir, 'todelete.txt');
    writeFileSync(path, 'bye');
    const res = await handler({ path });
    expect(res.success).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it('FO03: file:delete recursive removes directory', async () => {
    const handler = findHandler(cmds, 'file', 'delete');
    const dir = join(tempDir, 'subdir');
    mkdirSync(dir);
    writeFileSync(join(dir, 'file.txt'), 'data');
    const res = await handler({ path: dir, recursive: true });
    expect(res.success).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it('FO04: file:rename moves a file', async () => {
    const handler = findHandler(cmds, 'file', 'rename');
    const from = join(tempDir, 'old.txt');
    const to = join(tempDir, 'new.txt');
    writeFileSync(from, 'content');
    const res = await handler({ from, to });
    expect(res.success).toBe(true);
    expect(existsSync(to)).toBe(true);
    expect(existsSync(from)).toBe(false);
  });

  it('FO05: file:chmod changes permissions', async () => {
    if (process.platform === 'win32') return; // chmod not meaningful on Windows
    const handler = findHandler(cmds, 'file', 'chmod');
    const path = join(tempDir, 'script.sh');
    writeFileSync(path, '#!/bin/bash');
    const res = await handler({ path, mode: '755' });
    expect(res.success).toBe(true);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o755);
  });

  /**
   * Regresion: parseInt(args.mode, 8) con un mode no-octal (ej. 'abc',
   * '999', '') retornaba NaN, y NaN & 0o777 evalua a 0 en JS — un --mode
   * mal escrito no fallaba con un error, sino que borraba TODOS los
   * permisos del archivo en silencio en vez de rechazar el input invalido.
   */
  it('FO07: file:chmod rechaza un mode invalido en vez de dejar el archivo en 000', async () => {
    if (process.platform === 'win32') return; // chmod not meaningful on Windows
    const handler = findHandler(cmds, 'file', 'chmod');
    const path = join(tempDir, 'script2.sh');
    writeFileSync(path, '#!/bin/bash');
    chmodSync(path, 0o755);

    for (const badMode of ['abc', '999', '', '75']) {
      const res = await handler({ path, mode: badMode });
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/invalid mode/i);
    }

    // Permissions must be untouched by every rejected attempt.
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o755);
  });

  it('FO06: file:mkdir + file:write + file:read roundtrip', async () => {
    const mkdirH = findHandler(cmds, 'file', 'mkdir');
    const writeH = findHandler(cmds, 'file', 'write');
    const readH = findHandler(cmds, 'file', 'read');
    const dir = join(tempDir, 'project', 'src');
    await mkdirH({ path: dir });
    await writeH({ path: join(dir, 'index.ts'), content: 'export {}' });
    const res = await readH({ path: join(dir, 'index.ts') });
    expect(res.data.content).toBe('export {}');
  });

  it('FO07: all file commands have requiredPermissions', () => {
    for (const { definition } of cmds) {
      expect(definition.requiredPermissions).toBeDefined();
      expect(definition.requiredPermissions!.length).toBeGreaterThan(0);
    }
  });

  /**
   * Regresion (ronda 69 del audit, HIGH): ni file:read ni file:write tenian
   * cap de tamano en ningun punto de la cadena — un file:write con content
   * enorme (o un file:read sobre un archivo enorme) no encontraba limite ni
   * en el param, ni en el adapter, ni en fs.readFile/writeFile. Alcanzable
   * en particular via StdioTransport, que tampoco tiene limite de tamano de
   * request.
   */
  it('FO08: file:write rechaza content que excede el cap de 10MB, sin escribir nada a disco', async () => {
    const writeH = findHandler(cmds, 'file', 'write');
    const path = join(tempDir, 'toobig.txt');
    const oversized = 'a'.repeat(10 * 1024 * 1024 + 1);
    const res = await writeH({ path, content: oversized });
    expect(res.success).toBe(false);
    expect(res.error).toContain('exceeds maximum size');
    expect(existsSync(path)).toBe(false);
  });

  it('FO09: file:write acepta content justo por debajo del cap de 10MB', async () => {
    const writeH = findHandler(cmds, 'file', 'write');
    const path = join(tempDir, 'justfits.txt');
    const content = 'a'.repeat(1024); // pequeno y rapido; solo confirma que el guard no rechaza de mas
    const res = await writeH({ path, content });
    expect(res.success).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  it('FO10: file:read rechaza un archivo que excede el cap de 10MB sin cargarlo en memoria', async () => {
    const writeH = findHandler(cmds, 'file', 'write');
    const readH = findHandler(cmds, 'file', 'read');
    const path = join(tempDir, 'toobig-read.txt');
    // Escribe en pedazos via fs real (no via file:write, que ahora rechaza
    // el mismo tamano) para simular un archivo grande YA existente en disco.
    const chunk = 'a'.repeat(1024 * 1024); // 1MB
    for (let i = 0; i < 11; i++) {
      appendFileSync(path, chunk);
    }
    const res = await readH({ path });
    expect(res.success).toBe(false);
    expect(res.error).toContain('exceeds maximum size');
  });

  it('FO11: file:read normal (chico) sigue funcionando sin verse afectado por el cap', async () => {
    const writeH = findHandler(cmds, 'file', 'write');
    const readH = findHandler(cmds, 'file', 'read');
    const path = join(tempDir, 'small.txt');
    await writeH({ path, content: 'hello world' });
    const res = await readH({ path });
    expect(res.success).toBe(true);
    expect(res.data.content).toBe('hello world');
  });
});

// ===========================================================================
// FILE JAIL (optional path containment via createFileCommands(adapter, jailRoot))
// ===========================================================================

describe('File Jail (opt-in path containment)', () => {
  const adapter = new NativeShellAdapter();
  let jailDir: string;
  let jailed: SkillEntry[];

  beforeEach(() => {
    // realpathSync: on Windows, tmpdir() can return an 8.3 short-name path
    // (e.g. ADMINI~1) that's really an alias for the canonical long-name
    // directory — createPathJail's symlink-resolution (ronda 36 del audit)
    // now canonicalizes this the same way it would a real symlink, so tests
    // comparing against jailDir need the same canonical form.
    jailDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'filejail-')));
    jailed = createFileCommands(adapter, jailDir);
  });
  afterEach(() => { rmSync(jailDir, { recursive: true, force: true }); });

  it('FJ01: ops inside the jail work normally (write + read)', async () => {
    const writeH = findHandler(jailed, 'file', 'write');
    const readH = findHandler(jailed, 'file', 'read');
    const target = join(jailDir, 'inside.txt');
    const w = await writeH({ path: target, content: 'hello-jail' });
    expect(w.success).toBe(true);
    const r = await readH({ path: target });
    expect(r.success).toBe(true);
    expect(r.data.content).toBe('hello-jail');
  });

  it('FJ02: relative traversal outside jail is blocked (file:read)', async () => {
    const readH = findHandler(jailed, 'file', 'read');
    const res = await readH({ path: '../../../../etc/passwd' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/jail|outside/i);
  });

  it('FJ03: absolute path outside jail is blocked for read/write/delete', async () => {
    const outsidePath = join(tmpdir(), 'outside-secret-' + Date.now() + '.txt');
    writeFileSync(outsidePath, 'secret');
    try {
      const readH = findHandler(jailed, 'file', 'read');
      const writeH = findHandler(jailed, 'file', 'write');
      const deleteH = findHandler(jailed, 'file', 'delete');

      const r = await readH({ path: outsidePath });
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/jail|outside/i);
      // Must not have leaked the contents.
      expect(r.data).toBeNull();

      const w = await writeH({ path: outsidePath, content: 'pwn' });
      expect(w.success).toBe(false);
      expect(w.error).toMatch(/jail|outside/i);

      const d = await deleteH({ path: outsidePath });
      expect(d.success).toBe(false);
      expect(d.error).toMatch(/jail|outside/i);
      // File must still exist (delete was blocked before touching fs).
      expect(existsSync(outsidePath)).toBe(true);
    } finally {
      rmSync(outsidePath, { recursive: true, force: true });
    }
  });

  it('FJ04: file:rename blocked when to is outside jail', async () => {
    const renameH = findHandler(jailed, 'file', 'rename');
    const from = join(jailDir, 'inner.txt');
    writeFileSync(from, 'data');
    const to = join(tmpdir(), 'escaped-' + Date.now() + '.txt');
    try {
      const res = await renameH({ from, to });
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/jail|outside/i);
      // Source must remain untouched.
      expect(existsSync(from)).toBe(true);
      expect(existsSync(to)).toBe(false);
    } finally {
      rmSync(to, { recursive: true, force: true });
    }
  });

  it('FJ05: file:rename blocked when from is outside jail', async () => {
    const renameH = findHandler(jailed, 'file', 'rename');
    const outside = join(tmpdir(), 'outside-src-' + Date.now() + '.txt');
    writeFileSync(outside, 'data');
    const to = join(jailDir, 'smuggled.txt');
    try {
      const res = await renameH({ from: outside, to });
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/jail|outside/i);
      expect(existsSync(outside)).toBe(true);
      expect(existsSync(to)).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('FJ06: without jailRoot, behavior is unrestricted (no blocking)', async () => {
    const free = createFileCommands(adapter);
    const readH = findHandler(free, 'file', 'read');
    // An absolute outside path is NOT blocked when no jail is configured.
    // We use a path that does not exist; the handler should attempt the read
    // and fail with the underlying fs error (not a jail error).
    const res = await readH({ path: join(tmpdir(), 'no-containment-here-' + Date.now() + '.txt') });
    expect(res.success).toBe(false);
    expect(res.error).not.toMatch(/jail|outside/i);
  });

  /**
   * Regresion (ronda 36 del audit, MEDIUM): createPathJail() era un check
   * puramente SINTACTICO (string startsWith), nunca resolvia symlinks — un
   * symlink que vive DENTRO del jail pero apunta AFUERA lo evadia por
   * completo, ya que el string resuelto seguia empezando con jailDir aunque
   * el destino real estuviera fuera. Ahora createPathJail resuelve symlinks
   * (via realpath) antes de comparar. Si crear el symlink falla por
   * politicas del SO (Windows exige privilegios elevados o Developer Mode
   * para symlinks reales; una junction de directorio no los requiere pero
   * puede seguir fallando en algunos entornos restringidos), el test se
   * salta en vez de reportar un falso negativo no relacionado con jailing.
   */
  it('FJ07: un symlink dentro del jail que apunta afuera es bloqueado (jail-escape)', async () => {
    const outsideSecretDir = mkdtempSync(join(tmpdir(), 'filejail-secret-'));
    const secretPath = join(outsideSecretDir, 'secret.txt');
    writeFileSync(secretPath, 'super-secret');
    const linkPath = join(jailDir, 'escape-link');

    try {
      symlinkSync(outsideSecretDir, linkPath, 'junction');
    } catch {
      rmSync(outsideSecretDir, { recursive: true, force: true });
      return;
    }

    try {
      const readH = findHandler(jailed, 'file', 'read');
      const res = await readH({ path: join(linkPath, 'secret.txt') });
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/jail|outside/i);
      expect(res.data).toBeNull();
    } finally {
      rmSync(linkPath, { force: true });
      rmSync(outsideSecretDir, { recursive: true, force: true });
    }
  });

  /**
   * Regresion (ronda 36 del audit, LOW): file:mkdir y file:chmod tenian el
   * MISMO gating (assertInsideJail antes de tocar el adapter) que
   * read/write/delete/rename, pero ningun test propio ejercitaba su
   * jail-escape — solo se sabia por lectura de codigo que el path era
   * identico, sin cobertura de regresion.
   */
  it('FJ08: file:mkdir fuera del jail es bloqueado', async () => {
    const mkdirH = findHandler(jailed, 'file', 'mkdir');
    const outsidePath = join(tmpdir(), 'escaped-mkdir-' + Date.now());
    try {
      const res = await mkdirH({ path: outsidePath });
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/jail|outside/i);
      expect(existsSync(outsidePath)).toBe(false);
    } finally {
      rmSync(outsidePath, { recursive: true, force: true });
    }
  });

  it('FJ09: file:chmod fuera del jail es bloqueado', async () => {
    const chmodH = findHandler(jailed, 'file', 'chmod');
    const outsidePath = join(tmpdir(), 'escaped-chmod-' + Date.now() + '.txt');
    writeFileSync(outsidePath, 'data');
    try {
      const res = await chmodH({ path: outsidePath, mode: '755' });
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/jail|outside/i);
    } finally {
      rmSync(outsidePath, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// GIT
// ===========================================================================

describe('Git Skills', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'git-test-'));
    execSync('git init', { cwd: tempDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: tempDir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: tempDir, stdio: 'pipe' });
    writeFileSync(join(tempDir, 'README.md'), '# Test');
    execSync('git add -A && git commit -m "init"', { cwd: tempDir, stdio: 'pipe' });
  });

  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('GI01: git:status shows clean repo', async () => {
    const handler = findHandler(gitCommands, 'git', 'status');
    const res = await handler({ cwd: tempDir });
    expect(res.success).toBe(true);
    expect(res.data.clean).toBe(true);
  });

  it('GI02: git:status detects changes', async () => {
    writeFileSync(join(tempDir, 'new.txt'), 'change');
    const handler = findHandler(gitCommands, 'git', 'status');
    const res = await handler({ cwd: tempDir });
    expect(res.data.clean).toBe(false);
  });

  it('GI03: git:diff shows changes', async () => {
    writeFileSync(join(tempDir, 'README.md'), '# Updated');
    const handler = findHandler(gitCommands, 'git', 'diff');
    const res = await handler({ cwd: tempDir });
    expect(res.data.stdout).toContain('Updated');
  });

  it('GI04: git:commit creates commit', async () => {
    writeFileSync(join(tempDir, 'file.txt'), 'new');
    const handler = findHandler(gitCommands, 'git', 'commit');
    const res = await handler({ message: 'add file', 'add-all': true, cwd: tempDir });
    expect(res.success).toBe(true);
  });

  it('GI05: all git commands have requiredPermissions', () => {
    for (const { definition } of gitCommands) {
      expect(definition.requiredPermissions).toBeDefined();
    }
  });

  it('GI06: git:commit message with command substitution is NOT executed', async () => {
    writeFileSync(join(tempDir, 'file.txt'), 'new');
    const proofPath = join(tempDir, 'pwned-proof.txt');
    expect(existsSync(proofPath)).toBe(false);
    const handler = findHandler(gitCommands, 'git', 'commit');
    const res = await handler({
      message: '$(touch pwned-proof.txt)',
      'add-all': true,
      cwd: tempDir,
    });
    // Commit must succeed (message is a literal string, no shell involved).
    expect(res.success).toBe(true);
    // The injected command substitution must NOT have run — no proof file created.
    expect(existsSync(proofPath)).toBe(false);
  });

  /**
   * Regresion: gitExec/gitExecArgs (usados por todos los handlers de git:*)
   * nunca pasaban `env` a execSync/execFileSync, asi que el proceso git (y
   * cualquier hook que corra) heredaba el environment del host sin filtrar
   * — el mismo hueco que shell:exec tenia antes de esta sesion, pero nunca
   * se propago a git:*. Un hook post-commit es un proceso hijo de git, asi
   * que si el env que le llega sigue teniendo el secreto, el fix no aplico.
   */
  it('GI07: git:* no filtra el env sensible hacia git ni sus hooks', async () => {
    const dumpPath = join(tempDir, 'env-dump.txt').replace(/\\/g, '/');
    const hooksDir = join(tempDir, '.git', 'hooks');
    const hookPath = join(hooksDir, 'post-commit');
    writeFileSync(hookPath, `#!/bin/sh\nenv > "${dumpPath}"\n`);
    chmodSync(hookPath, 0o755);

    const canary = 'leak-canary-' + Date.now();
    const prevToken = process.env.AGENT_SHELL_TEST_TOKEN;
    process.env.AGENT_SHELL_TEST_TOKEN = canary;
    try {
      writeFileSync(join(tempDir, 'file2.txt'), 'new');
      const handler = findHandler(gitCommands, 'git', 'commit');
      const res = await handler({ message: 'trigger hook', 'add-all': true, cwd: tempDir });
      expect(res.success).toBe(true);
    } finally {
      if (prevToken === undefined) delete process.env.AGENT_SHELL_TEST_TOKEN;
      else process.env.AGENT_SHELL_TEST_TOKEN = prevToken;
    }

    expect(existsSync(dumpPath)).toBe(true);
    const dumped = readFileSync(dumpPath, 'utf-8');
    // The hook actually ran and captured a real environment (not empty).
    expect(dumped.length).toBeGreaterThan(0);
    // The sensitive var must NOT have reached git's child process.
    expect(dumped).not.toContain(canary);
  });

  /**
   * Regresion (ronda 42 del audit, CRITICAL): --url/--remote/--branch
   * llegaban a git como argv bare positional, sin chequear si empezaban
   * con '-' y sin separador '--'/'--end-of-options' antes del operando.
   * Git interpreta un valor asi como una OPCION, no como dato — por
   * ejemplo git clone/pull aceptan --upload-pack=<cmd> (el programa que
   * usan para el fetch) y git push acepta --exec=<cmd>/--receive-pack=
   * <cmd> (el equivalente del lado push) — ambos logran ejecucion de
   * comandos arbitrarios LOCAL, sin necesitar red real para un clone/pull
   * de un path local. Estos tests prueban que el rechazo pasa ANTES de
   * que gitExecArgs() llegue a invocar git en absoluto (no hace falta un
   * --upload-pack real: alcanza con confirmar que el string se rechaza).
   */
  it('GI08: git:clone --url que empieza con "-" es rechazado (previene RCE via --upload-pack)', async () => {
    const handler = findHandler(gitCommands, 'git', 'clone');
    const target = join(tempDir, 'should-not-exist');
    const res = await handler({ url: '--upload-pack=touch pwned', path: target });
    expect(res.success).toBe(false);
    expect(res.error).toContain("must not start with '-'");
    expect(existsSync(target)).toBe(false);
  });

  it('GI09: git:clone de un path local normal sigue funcionando (el separador "--" agregado no rompe el caso comun)', async () => {
    const handler = findHandler(gitCommands, 'git', 'clone');
    const target = join(tempDir, '..', 'gi09-cloned-' + Date.now());
    try {
      const res = await handler({ url: tempDir, path: target });
      expect(res.success).toBe(true);
      expect(existsSync(join(target, 'README.md'))).toBe(true);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('GI10: git:push --remote que empieza con "-" es rechazado (previene RCE via --exec/--receive-pack)', async () => {
    const handler = findHandler(gitCommands, 'git', 'push');
    const res = await handler({ remote: '--exec=touch pwned', cwd: tempDir });
    expect(res.success).toBe(false);
    expect(res.error).toContain("must not start with '-'");
  });

  it('GI11: git:push --branch "--force" es rechazado (contradice el propio comentario "No --force is implemented")', async () => {
    const handler = findHandler(gitCommands, 'git', 'push');
    const res = await handler({ branch: '--force', cwd: tempDir });
    expect(res.success).toBe(false);
    expect(res.error).toContain("must not start with '-'");
  });

  it('GI12: git:pull --remote que empieza con "-" es rechazado (previene RCE via --upload-pack)', async () => {
    const handler = findHandler(gitCommands, 'git', 'pull');
    const res = await handler({ remote: '--upload-pack=touch pwned', cwd: tempDir });
    expect(res.success).toBe(false);
    expect(res.error).toContain("must not start with '-'");
  });

  /**
   * Regresion (ronda 68 del audit, CRITICAL): git:clone/push/pull aceptaban
   * una URL remota sin NINGUNA validacion de host/IP — a diferencia de
   * shell-http.ts (blocklist de rangos privados/reservados + endpoint de
   * metadata cloud), shell-git.ts nunca reutilizaba ese guard. Un agente
   * con solo git:write (sin http:read/write) podia alcanzar cualquier host
   * interno via `git:clone --url http://169.254.169.254/...` — git hace el
   * connect TCP real independientemente de si el target es un repo git de
   * verdad. Estos tests confirman que el bloqueo pasa ANTES de que
   * gitExecArgs() invoque a git en absoluto (no hace falta un servidor
   * real: alcanza con que el directorio destino nunca se cree).
   */
  it('GI13: git:clone --url apuntando al endpoint de metadata cloud (169.254.169.254) es rechazado', async () => {
    const handler = findHandler(gitCommands, 'git', 'clone');
    const target = join(tempDir, '..', 'gi13-should-not-exist');
    const res = await handler({ url: 'http://169.254.169.254/latest/meta-data/', path: target });
    expect(res.success).toBe(false);
    expect(res.error).toContain('Blocked');
    expect(existsSync(target)).toBe(false);
  });

  it('GI14: git:push --remote apuntando a una IP loopback (127.0.0.1) es rechazado', async () => {
    const handler = findHandler(gitCommands, 'git', 'push');
    const res = await handler({ remote: 'http://127.0.0.1:6379/repo.git', cwd: tempDir });
    expect(res.success).toBe(false);
    expect(res.error).toContain('Blocked');
  });

  it('GI15: git:pull --remote apuntando a una IP loopback (127.0.0.1) es rechazado', async () => {
    const handler = findHandler(gitCommands, 'git', 'pull');
    const res = await handler({ remote: 'http://127.0.0.1:6379/repo.git', cwd: tempDir });
    expect(res.success).toBe(false);
    expect(res.error).toContain('Blocked');
  });

  it('GI16: git:pull --remote con un nombre de remote normal ("origin") no dispara el chequeo SSRF', async () => {
    const handler = findHandler(gitCommands, 'git', 'pull');
    // 'origin' no es una URL remota (isRemoteGitUrl la descarta), asi que
    // el chequeo SSRF debe ser un no-op — el error (si lo hay) viene de
    // git mismo (sin remote configurado), nunca de "Blocked".
    const res = await handler({ remote: 'origin', cwd: tempDir });
    expect(res.error || '').not.toContain('Blocked');
  });
});

/**
 * Regresion: git:* aceptaba --cwd sin ninguna restriccion — un rol con
 * git:write pensado para "el repo del proyecto" podia apuntar a cualquier
 * otro repositorio del host via --cwd. createGitCommands(jailRoot) agrega
 * la misma contencion que file:* y workspace:* ya tienen.
 */
describe('Git Jail (opt-in path containment)', () => {
  let jailDir: string;
  let outsideRepo: string;
  let jailed: SkillEntry[];

  beforeEach(() => {
    // realpathSync: see the filejail beforeEach above for why this is needed.
    jailDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'gitjail-')));
    execSync('git init', { cwd: jailDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: jailDir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: jailDir, stdio: 'pipe' });
    writeFileSync(join(jailDir, 'README.md'), '# Jailed');
    execSync('git add -A && git commit -m "init"', { cwd: jailDir, stdio: 'pipe' });

    outsideRepo = mkdtempSync(join(tmpdir(), 'gitjail-outside-'));
    execSync('git init', { cwd: outsideRepo, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: outsideRepo, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: outsideRepo, stdio: 'pipe' });
    writeFileSync(join(outsideRepo, 'SECRET.md'), '# not yours');
    execSync('git add -A && git commit -m "init"', { cwd: outsideRepo, stdio: 'pipe' });

    jailed = createGitCommands(jailDir);
  });

  afterEach(() => {
    rmSync(jailDir, { recursive: true, force: true });
    rmSync(outsideRepo, { recursive: true, force: true });
  });

  it('GJ01: --cwd inside the jail works normally', async () => {
    const handler = findHandler(jailed, 'git', 'status');
    const res = await handler({ cwd: jailDir });
    expect(res.success).toBe(true);
    expect(res.data.clean).toBe(true);
  });

  it('GJ02: --cwd pointing at a repo outside the jail is blocked', async () => {
    const handler = findHandler(jailed, 'git', 'status');
    const res = await handler({ cwd: outsideRepo });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/jail|outside/i);
  });

  it('GJ03: no --cwd defaults inside the jail, not process.cwd()', async () => {
    const handler = findHandler(jailed, 'git', 'status');
    const res = await handler({});
    expect(res.success).toBe(true);
    expect(res.data.cwd).toBe(jailDir);
  });

  it('GJ04: git:commit --cwd outside the jail is blocked, does not touch the other repo', async () => {
    const handler = findHandler(jailed, 'git', 'commit');
    const before = execSync('git rev-parse HEAD', { cwd: outsideRepo, encoding: 'utf-8' }).trim();

    const res = await handler({ message: 'pwn', cwd: outsideRepo });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/jail|outside/i);

    const after = execSync('git rev-parse HEAD', { cwd: outsideRepo, encoding: 'utf-8' }).trim();
    expect(after).toBe(before);
  });

  it('GJ05: git:clone --path escaping the jail is blocked', async () => {
    const handler = findHandler(jailed, 'git', 'clone');
    const target = join(outsideRepo, 'cloned-here');
    const res = await handler({ url: jailDir, path: target });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/jail|outside/i);
    expect(existsSync(target)).toBe(false);
  });

  it('GJ06: without jailRoot, --cwd is unrestricted (legacy gitCommands export)', async () => {
    const handler = findHandler(gitCommands, 'git', 'status');
    const res = await handler({ cwd: outsideRepo });
    expect(res.success).toBe(true);
  });

  /**
   * Regresion (ronda 26 del audit): --path (destino) ya se validaba, pero
   * --url tambien puede ser un path local del filesystem (sin esquema
   * remoto) — sin este check, un caller con solo git:write podia clonar
   * CUALQUIER repo del host hacia adentro del jail, exfiltrando su
   * contenido (legible despues via file:read). Verificado en vivo antes
   * de este fix: clonar outsideRepo copiaba SECRET.md adentro del jail.
   */
  it('GJ07: git:clone --url apuntando a un path local fuera del jail es bloqueado', async () => {
    const handler = findHandler(jailed, 'git', 'clone');
    const target = join(jailDir, 'cloned-secret');
    const res = await handler({ url: outsideRepo, path: target });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/jail|outside/i);
    expect(existsSync(target)).toBe(false);
  });

  it('GJ08: git:clone --url con esquema remoto (http/ssh/git) no se trata como path local', async () => {
    const handler = findHandler(jailed, 'git', 'clone');
    // No hay red real en el test — solo verificamos que el chequeo de jail
    // NO dispara para esta forma de --url (git fallara por su cuenta al no
    // poder conectar). No usar /jail/i aca: el prefijo del tmpdir del test
    // ("gitjail-...") lo contiene incidentalmente — se chequea en cambio
    // el prefijo exacto que arma el chequeo sintetico de --url.
    const res = await handler({ url: 'https://example.invalid/repo.git', path: join(jailDir, 'remote-clone') });
    expect(res.error || '').not.toMatch(/^git:clone --url/);
  });
});

// ===========================================================================
// CRON
// ===========================================================================

describe('Cron Skills', () => {
  let scheduler: CronScheduler;
  let cmds: SkillEntry[];

  beforeEach(() => {
    scheduler = new CronScheduler();
    cmds = createCronCommands(scheduler);
  });

  afterEach(() => { scheduler.destroy(); });

  /**
   * Regresion: sin bound, cron:schedule bajo nombres unicos crecia el Map
   * para siempre — y cada entrada evictada sin clearInterval() dejaria un
   * timer huerfano re-ejecutando su comando indefinidamente. Mismo patron
   * que ProcessManager (MAX_PROCESSES) y SecretStore (MAX_SECRETS).
   */
  it('CR00: acota la cantidad de tareas programadas (evict del mas viejo, deteniendo su timer)', () => {
    for (let i = 0; i < 205; i++) {
      const res = scheduler.schedule(`task-${i}`, 'echo hi', '1h');
      expect(res.success).toBe(true);
    }
    const names = scheduler.list().map(t => t.name);
    expect(names.length).toBeLessThanOrEqual(200);
    expect(names).not.toContain('task-0');
    expect(names).toContain('task-204');
    // The evicted task's name must be free again (its timer was actually
    // stopped, not just dropped) — re-scheduling under it should succeed,
    // not fail with "already exists" from a stale reference elsewhere.
    const reschedule = scheduler.schedule('task-0', 'echo hi', '1h');
    expect(reschedule.success).toBe(true);
  });

  it('CR01: cron:schedule creates task', async () => {
    const handler = findHandler(cmds, 'cron', 'schedule');
    const res = await handler({ name: 'test', command: 'echo hi', interval: '30s' });
    expect(res.success).toBe(true);
    expect(res.data.scheduled).toBe(true);
  });

  it('CR02: cron:list shows active tasks', async () => {
    const schedule = findHandler(cmds, 'cron', 'schedule');
    await schedule({ name: 'a', command: 'echo a', interval: '1m' });
    await schedule({ name: 'b', command: 'echo b', interval: '5m' });

    const list = findHandler(cmds, 'cron', 'list');
    const res = await list({});
    expect(res.data.count).toBe(2);
  });

  /**
   * Regresion (ronda 39 del audit, HIGH): mismo finding que PM02b, en el
   * gemelo de ProcessManager — cron:list() exponia el command guardado sin
   * masquear a cualquier sesion con solo cron:read. A diferencia de
   * ProcessManager, aca el masking tiene que pasar en la LECTURA (list()),
   * no al guardar: executeTask() re-lee task.command en cada tick para
   * ejecutarlo de verdad.
   */
  it('CR02b: cron:list enmascara valores con forma de secreto en el command guardado', async () => {
    const schedule = findHandler(cmds, 'cron', 'schedule');
    await schedule({ name: 'leaky', command: 'curl --auth "Bearer abcdefghijklmnopqrstuvwxyz1234567890"', interval: '1m' });

    const list = findHandler(cmds, 'cron', 'list');
    const res = await list({});
    expect(res.data.tasks[0].command).toContain('Bearer [REDACTED]');
    expect(res.data.tasks[0].command).not.toContain('abcdefghijklmnopqrstuvwxyz1234567890');
  });

  it('CR03: cron:cancel removes task', async () => {
    const schedule = findHandler(cmds, 'cron', 'schedule');
    await schedule({ name: 'temp', command: 'echo temp', interval: '10s' });

    const cancel = findHandler(cmds, 'cron', 'cancel');
    const res = await cancel({ name: 'temp' });
    expect(res.success).toBe(true);
    expect(res.data.cancelled).toBe(true);

    const list = findHandler(cmds, 'cron', 'list');
    expect((await list({})).data.count).toBe(0);
  });

  it('CR04: cron:schedule rejects duplicate name', async () => {
    const handler = findHandler(cmds, 'cron', 'schedule');
    await handler({ name: 'dup', command: 'echo', interval: '1m' });
    const res = await handler({ name: 'dup', command: 'echo', interval: '2m' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('already exists');
  });

  it('CR05: cron:schedule rejects invalid interval', async () => {
    const handler = findHandler(cmds, 'cron', 'schedule');
    const res = await handler({ name: 'bad', command: 'echo', interval: 'invalid' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('Invalid interval');
  });

  /**
   * Regresion (ronda 38 del audit, finding #1 CRITICAL): setInterval usa un
   * entero de 32 bits para el delay — un valor por encima del maximo NO se
   * rechaza en Node, se clampea EN SILENCIO a 1ms (TimeoutOverflowWarning),
   * asi que un intervalo perfectamente razonable como '25d' terminaba
   * re-ejecutando el comando miles de veces por segundo en vez de una vez
   * cada 25 dias. schedule() solo chequeaba `ms < 1000` — ahora tambien
   * rechaza `ms > MAX_INTERVAL_MS`.
   */
  it('CR10: cron:schedule rechaza un intervalo que excede el maximo de 32 bits de setInterval', async () => {
    const handler = findHandler(cmds, 'cron', 'schedule');
    const res = await handler({ name: 'too-long', command: 'echo', interval: '25d' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('exceeds the maximum supported interval');

    // Un intervalo justo por debajo del limite sigue aceptandose.
    const ok = await handler({ name: 'ok-interval', command: 'echo', interval: '24d' });
    expect(ok.success).toBe(true);
  });

  it('CR06: cron:schedule parses shorthand intervals', async () => {
    const handler = findHandler(cmds, 'cron', 'schedule');
    for (const interval of ['10s', '5m', '1h', '1d']) {
      const res = await handler({ name: `t-${interval}`, command: 'echo', interval });
      expect(res.success).toBe(true);
    }
  });

  it('CR07: cron:history returns empty initially', async () => {
    const handler = findHandler(cmds, 'cron', 'history');
    const res = await handler({});
    expect(res.data.count).toBe(0);
  });
});

/**
 * Regresion: cron:schedule soportaba un --cwd de facto (CronScheduler.schedule()
 * ya tomaba un 4to parametro cwd, usado en executeTask), pero scheduleDef no
 * exponia --cwd en absoluto — la unica forma de usarlo era llamando
 * CronScheduler.schedule() directamente, no via el comando. Al exponerlo se
 * agrega el mismo containment que file:*, git:*, workspace:* y process:* ya
 * tienen: executeTask corre task.command por el mismo sink que process:spawn,
 * asi que dejar --cwd sin jail hubiera reabierto el escape que process:spawn
 * ya cerro.
 */
describe('Cron Jail (opt-in path containment)', () => {
  let execMock: ReturnType<typeof vi.fn>;
  let fakeAdapter: ShellAdapter;
  let scheduler: CronScheduler;
  let jailDir: string;
  let outsideDir: string;
  let jailed: SkillEntry[];

  beforeEach(() => {
    vi.useFakeTimers();
    execMock = vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    fakeAdapter = {
      backend: 'test',
      exec: execMock,
      which: vi.fn().mockResolvedValue({ program: '', path: null, found: false }),
      readFile: vi.fn().mockResolvedValue({ path: '', content: '', size: 0 }),
      writeFile: vi.fn().mockResolvedValue({ path: '', size: 0, written: true }),
      listDir: vi.fn().mockResolvedValue({ path: '', entries: [], count: 0 }),
    };
    scheduler = new CronScheduler(fakeAdapter);
    // realpathSync: see the filejail beforeEach above for why this is needed.
    jailDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cronjail-')));
    outsideDir = mkdtempSync(join(tmpdir(), 'cronjail-outside-'));
    jailed = createCronCommands(scheduler, undefined, jailDir);
  });

  afterEach(() => {
    scheduler.destroy();
    vi.useRealTimers();
    rmSync(jailDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it('CJ01: --cwd inside the jail is accepted', async () => {
    const handler = findHandler(jailed, 'cron', 'schedule');
    const res = await handler({ name: 'inside', command: 'echo hi', interval: '1s', cwd: jailDir });
    expect(res.success).toBe(true);
  });

  it('CJ02: --cwd pointing outside the jail is blocked', async () => {
    const handler = findHandler(jailed, 'cron', 'schedule');
    const res = await handler({ name: 'escape', command: 'echo hi', interval: '1s', cwd: outsideDir });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/jail|outside/i);

    const list = findHandler(jailed, 'cron', 'list');
    expect((await list({})).data.count).toBe(0);
  });

  it('CJ03: relative --cwd traversal outside the jail is blocked', async () => {
    const handler = findHandler(jailed, 'cron', 'schedule');
    const res = await handler({ name: 'traverse', command: 'echo hi', interval: '1s', cwd: '../../../../etc' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/jail|outside/i);
  });

  it('CJ04: no --cwd defaults inside the jail, not process.cwd()', async () => {
    const handler = findHandler(jailed, 'cron', 'schedule');
    const res = await handler({ name: 'default-cwd', command: 'echo hi', interval: '1s' });
    expect(res.success).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);

    expect(execMock).toHaveBeenCalledWith('echo hi', { cwd: jailDir, timeout: 60_000 });
  });

  it('CJ05: without jailRoot, --cwd is unrestricted (legacy cronCommands export)', async () => {
    // cronCommands is a module-level singleton with its own real
    // CronScheduler + NativeShellAdapter (not this describe block's fake
    // one) — cancel the task afterward so it doesn't leave a real
    // setInterval running for the rest of the suite.
    const name = 'unrestricted-' + Date.now();
    const handler = findHandler(cronCommands, 'cron', 'schedule');
    const cancel = findHandler(cronCommands, 'cron', 'cancel');
    const res = await handler({ name, command: 'echo hi', interval: '1m', cwd: outsideDir });
    try {
      expect(res.success).toBe(true);
    } finally {
      await cancel({ name });
    }
  });
});

// ===========================================================================
// CRON SANDBOX ADAPTER INJECTION (GLM-FIX-SANDBOX-BYPASS)
// ===========================================================================

describe('Cron Sandbox Adapter Injection', () => {
  let execMock: ReturnType<typeof vi.fn>;
  let fakeAdapter: ShellAdapter;
  let scheduler: CronScheduler;
  let cmds: SkillEntry[];

  beforeEach(() => {
    vi.useFakeTimers();
    execMock = vi.fn().mockResolvedValue({ stdout: 'CRON_FAKE', stderr: '', exitCode: 0 });
    fakeAdapter = {
      backend: 'test',
      exec: execMock,
      which: vi.fn().mockResolvedValue({ program: '', path: null, found: false }),
      readFile: vi.fn().mockResolvedValue({ path: '', content: '', size: 0 }),
      writeFile: vi.fn().mockResolvedValue({ path: '', size: 0, written: true }),
      listDir: vi.fn().mockResolvedValue({ path: '', entries: [], count: 0 }),
    };
    scheduler = new CronScheduler(fakeAdapter);
    cmds = createCronCommands(scheduler);
  });

  afterEach(() => {
    scheduler.destroy();
    vi.useRealTimers();
  });

  it('CR08: CronScheduler uses injected adapter to execute tasks', async () => {
    const schedule = findHandler(cmds, 'cron', 'schedule');
    const res = await schedule({ name: 'injected', command: 'echo via-adapter', interval: '1s' });
    expect(res.success).toBe(true);

    // Fire the interval 3 times. Minimum valid interval is 1000ms ('1s').
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    // The task ran through the injected adapter, not a real execSync.
    expect(execMock).toHaveBeenCalledTimes(3);
    expect(execMock).toHaveBeenCalledWith('echo via-adapter', { cwd: undefined, timeout: 60_000 });

    // History reflects the (fake) adapter exit code, recorded each run.
    const history = findHandler(cmds, 'cron', 'history');
    const histRes = await history({ name: 'injected' });
    expect(histRes.data.count).toBe(3);
    for (const entry of histRes.data.history) {
      expect(entry.exitCode).toBe(0);
    }
  });

  it('CR09: CronScheduler records non-zero exit code from injected adapter', async () => {
    execMock.mockResolvedValue({ stdout: '', stderr: 'failed', exitCode: 99 });

    const schedule = findHandler(cmds, 'cron', 'schedule');
    await schedule({ name: 'failing', command: 'exit 99', interval: '1s' });

    await vi.advanceTimersByTimeAsync(1000);

    expect(execMock).toHaveBeenCalledTimes(1);
    const history = findHandler(cmds, 'cron', 'history');
    const histRes = await history({ name: 'failing' });
    expect(histRes.data.history[0].exitCode).toBe(99);
  });

  /**
   * Regresion (ronda 38 del audit, finding #2 HIGH): sin guard de
   * concurrencia, un tick que llega mientras la corrida anterior sigue
   * activa (comando mas lento que su propio intervalo) disparaba OTRA
   * ejecucion superpuesta, sin limite de cuantas podian acumularse. Este
   * test deja el primer exec() colgado (nunca resuelve) y avanza el timer
   * dos ticks mas — el adapter debe seguir habiendo sido llamado UNA sola
   * vez mientras la corrida sigue activa.
   */
  it('CR11: un tick que llega mientras la corrida anterior sigue activa se salta (no se superpone)', async () => {
    let resolveFirst: (v: any) => void;
    execMock.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }));

    const schedule = findHandler(cmds, 'cron', 'schedule');
    await schedule({ name: 'slow', command: 'sleep-forever', interval: '1s' });

    await vi.advanceTimersByTimeAsync(1000); // dispara la 1ra corrida, queda colgada
    await vi.advanceTimersByTimeAsync(1000); // 2do tick: debe saltarse
    await vi.advanceTimersByTimeAsync(1000); // 3er tick: debe saltarse tambien

    expect(execMock).toHaveBeenCalledTimes(1);

    // Los ticks salteados quedan visibles en history (exitCode -1), no
    // desaparecen en silencio.
    const history = findHandler(cmds, 'cron', 'history');
    const beforeResolve = await history({ name: 'slow' });
    expect(beforeResolve.data.count).toBe(2);
    expect(beforeResolve.data.history.every((h: any) => h.exitCode === -1)).toBe(true);

    // Al resolver la corrida colgada, el siguiente tick vuelve a ejecutar
    // normalmente.
    resolveFirst!({ stdout: '', stderr: '', exitCode: 0 });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(execMock).toHaveBeenCalledTimes(2);
  });

  /**
   * Regresion (ronda 38 del audit, finding #3 MEDIUM): CronScheduler acepta
   * cualquier ShellAdapter inyectado (no solo los 2 builtin, que nunca
   * rechazan) — un adapter que rechaza su promesa disparaba una unhandled
   * rejection en cada tick, y no hay ningun handler de unhandledRejection
   * en todo el repo. Ahora degrada a una corrida fallida en history, no
   * tumba el proceso.
   */
  it('CR12: un adapter inyectado que rechaza no tumba el scheduler, degrada a exitCode -1', async () => {
    execMock.mockRejectedValueOnce(new Error('adapter exploded'));

    const schedule = findHandler(cmds, 'cron', 'schedule');
    await schedule({ name: 'throws', command: 'echo', interval: '1s' });

    await vi.advanceTimersByTimeAsync(1000);

    const history = findHandler(cmds, 'cron', 'history');
    const histRes = await history({ name: 'throws' });
    expect(histRes.data.history[0].exitCode).toBe(-1);

    // El scheduler sigue vivo: el siguiente tick corre normalmente.
    execMock.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
    await vi.advanceTimersByTimeAsync(1000);
    const histRes2 = await history({ name: 'throws' });
    expect(histRes2.data.count).toBe(2);
    expect(histRes2.data.history[1].exitCode).toBe(0);
  });

  /**
   * Complementa CR02b: el masking de cron:list() (ronda 39 del audit) es
   * SOLO en la lectura — confirma que executeTask() sigue ejecutando el
   * comando REAL (sin enmascarar) via el adapter, no el placeholder
   * redactado que ahora ve cron:list().
   */
  it('CR13: la ejecucion real de una tarea sigue usando el comando SIN enmascarar, aunque cron:list() lo muestre redactado', async () => {
    const schedule = findHandler(cmds, 'cron', 'schedule');
    await schedule({ name: 'real-exec', command: 'curl --auth "Bearer abcdefghijklmnopqrstuvwxyz1234567890"', interval: '1s' });

    const list = findHandler(cmds, 'cron', 'list');
    const listRes = await list({});
    expect(listRes.data.tasks[0].command).toContain('[REDACTED]');

    await vi.advanceTimersByTimeAsync(1000);
    expect(execMock).toHaveBeenCalledWith('curl --auth "Bearer abcdefghijklmnopqrstuvwxyz1234567890"', { cwd: undefined, timeout: 60_000 });
  });

  /**
   * Regresion (ronda 50 del audit, HIGH): cancel() borraba la entrada del
   * Map incondicionalmente, incluso con una ejecucion en curso — el
   * ShellAdapter no expone forma de abortar esa ejecucion (sin
   * AbortSignal en su contrato), asi que el comando seguia corriendo
   * contra un objeto huerfano que nadie podia ver: su resultado
   * (exit code, duracion) se perdia en silencio. Ahora cancel() detiene
   * los ticks FUTUROS de inmediato (sin superponerse mas), pero deja la
   * entrada viva — visible en cron:list() como `cancelling:true` — hasta
   * que la ejecucion en curso termine y su resultado quede en history,
   * recien ahi desaparece de verdad.
   */
  it('CR14: cron:cancel sobre una tarea en ejecucion no descarta su resultado en silencio', async () => {
    let resolveRun: (v: any) => void;
    execMock.mockImplementationOnce(() => new Promise((resolve) => { resolveRun = resolve; }));

    const schedule = findHandler(cmds, 'cron', 'schedule');
    await schedule({ name: 'cancel-while-running', command: 'sleep-forever', interval: '1s' });

    await vi.advanceTimersByTimeAsync(1000); // dispara la corrida, queda colgada

    const cancel = findHandler(cmds, 'cron', 'cancel');
    const cancelRes = await cancel({ name: 'cancel-while-running' });
    expect(cancelRes.success).toBe(true);
    expect(cancelRes.data.cancelled).toBe(true);
    expect(cancelRes.data.note).toBeDefined();

    // La tarea sigue viva en cron:list() (con la ejecucion en curso),
    // marcada como cancelling — no desaparecio de inmediato.
    const list = findHandler(cmds, 'cron', 'list');
    const listRes = await list({});
    expect(listRes.data.count).toBe(1);
    expect(listRes.data.tasks[0].cancelling).toBe(true);

    // Ningun tick futuro dispara (el timer ya fue detenido por cancel()).
    await vi.advanceTimersByTimeAsync(5000);
    expect(execMock).toHaveBeenCalledTimes(1);

    // Al resolver la corrida colgada, su resultado SI queda registrado en
    // history — no se perdio — y la entrada recien ahi desaparece.
    resolveRun!({ stdout: '', stderr: '', exitCode: 0 });
    await vi.advanceTimersByTimeAsync(0);

    const history = findHandler(cmds, 'cron', 'history');
    const histRes = await history({ name: 'cancel-while-running' });
    expect(histRes.data.count).toBe(1);
    expect(histRes.data.history[0].exitCode).toBe(0);

    const listAfter = await list({});
    expect(listAfter.data.count).toBe(0);
  });

  /**
   * Regresion (ronda 62 del audit, HIGH): la eviccion por MAX_TASKS en
   * schedule() borraba la entrada mas vieja del Map INCONDICIONALMENTE,
   * incluso con una ejecucion en curso — exactamente el mismo bug que
   * cancel() tenia antes de la ronda 50 (ver CR14 arriba), pero nunca se
   * le aplico el mismo fix. El comando de la tarea evictada seguia
   * corriendo del lado del adapter contra un objeto `task` huerfano: al
   * terminar, su resultado se perdia en silencio (sin aparecer ni en
   * cron:list() ni en cron:history()) — un comando quedaba corriendo
   * como un "zombie" invisible para el operador.
   */
  it('CR15: evictar por MAX_TASKS una tarea en ejecucion no descarta su resultado en silencio', async () => {
    let resolveRun: (v: any) => void;
    execMock.mockImplementationOnce(() => new Promise((resolve) => { resolveRun = resolve; }));

    const schedule = findHandler(cmds, 'cron', 'schedule');
    await schedule({ name: 'oldest-running', command: 'sleep-forever', interval: '1s' });

    await vi.advanceTimersByTimeAsync(1000); // dispara la corrida, queda colgada (isRunning=true)

    // Llenar hasta MAX_TASKS (200) — la entrada 200 disparara la eviccion
    // de la MAS VIEJA (oldest-running, todavia corriendo).
    for (let i = 0; i < 199; i++) {
      const res = await schedule({ name: `filler-${i}`, command: 'echo hi', interval: '1h' });
      expect(res.success).toBe(true);
    }
    const triggerRes = await schedule({ name: 'trigger-eviction', command: 'echo hi', interval: '1h' });
    expect(triggerRes.success).toBe(true);

    // oldest-running sigue viva en cron:list() (su ejecucion en curso NO
    // fue abortada, el adapter no expone forma de hacerlo) — pero marcada
    // como cancelling, mismo patron que cancel() sobre una tarea corriendo
    // (CR14): el timer ya esta detenido (ningun tick futuro), y la entrada
    // desaparece recien cuando esa corrida termina.
    const list = findHandler(cmds, 'cron', 'list');
    const listRes = await list({});
    const evicted = listRes.data.tasks.find((t: any) => t.name === 'oldest-running');
    expect(evicted).toBeDefined();
    expect(evicted.cancelling).toBe(true);

    // Su ejecucion en curso SI queda registrada en history al terminar,
    // en vez de perderse.
    resolveRun!({ stdout: '', stderr: '', exitCode: 0 });
    await vi.advanceTimersByTimeAsync(0);

    const history = findHandler(cmds, 'cron', 'history');
    const histRes = await history({ name: 'oldest-running' });
    expect(histRes.data.count).toBe(1);
    expect(histRes.data.history[0].exitCode).toBe(0);
  });
});

// ===========================================================================
// SECRET STORE
// ===========================================================================

describe('Secret Store Skills', () => {
  let store: SecretStore;
  let cmds: SkillEntry[];

  beforeEach(() => {
    store = new SecretStore('test-encryption-key-32chars!!!');
    cmds = createSecretCommands(store);
  });

  /**
   * Regresion: sin bound, secret:set bajo nombres unicos crecia el Map para
   * siempre durante la vida del proceso. Mismo patron que ProcessManager
   * (MAX_PROCESSES), WorkspaceSessionStore/SessionScopedContextStore
   * (MAX_SESSIONS).
   */
  it('SE00: acota la cantidad de secretos en memoria (evict del mas viejo)', () => {
    for (let i = 0; i < 205; i++) {
      store.set(`SECRET_${i}`, `value-${i}`);
    }
    expect(store.size).toBeLessThanOrEqual(200);
    expect(store.has('SECRET_0')).toBe(false);
    expect(store.has('SECRET_204')).toBe(true);
  });

  it('SE00b: sobreescribir un nombre existente no dispara eviction', () => {
    for (let i = 0; i < 200; i++) {
      store.set(`SECRET_${i}`, `value-${i}`);
    }
    expect(store.size).toBe(200);
    store.set('SECRET_0', 'updated-value'); // overwrite, not a new key
    expect(store.size).toBe(200);
    expect(store.has('SECRET_0')).toBe(true);
    expect(store.get('SECRET_0')).toBe('updated-value');
  });

  it('SE01: secret:set + secret:get roundtrip', async () => {
    const set = findHandler(cmds, 'secret', 'set');
    const get = findHandler(cmds, 'secret', 'get');

    await set({ name: 'DB_PASS', value: 'supersecret123' });
    const res = await get({ name: 'DB_PASS' });
    expect(res.success).toBe(true);
    expect(res.data.value).toBe('supersecret123');
  });

  it('SE02: secret:list shows names without values', async () => {
    const set = findHandler(cmds, 'secret', 'set');
    await set({ name: 'KEY_A', value: 'val1' });
    await set({ name: 'KEY_B', value: 'val2' });

    const list = findHandler(cmds, 'secret', 'list');
    const res = await list({});
    expect(res.data.names).toContain('KEY_A');
    expect(res.data.names).toContain('KEY_B');
    expect(res.data.count).toBe(2);
    // Values should NOT be in the response
    expect(JSON.stringify(res.data)).not.toContain('val1');
  });

  it('SE03: secret:delete removes secret', async () => {
    const set = findHandler(cmds, 'secret', 'set');
    await set({ name: 'TEMP', value: 'temp' });

    const del = findHandler(cmds, 'secret', 'delete');
    const res = await del({ name: 'TEMP' });
    expect(res.success).toBe(true);

    const get = findHandler(cmds, 'secret', 'get');
    const res2 = await get({ name: 'TEMP' });
    expect(res2.success).toBe(false);
  });

  it('SE04: secret:get returns error for missing secret', async () => {
    const get = findHandler(cmds, 'secret', 'get');
    const res = await get({ name: 'NONEXISTENT' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('not found');
  });

  it('SE05: secrets are encrypted at rest', () => {
    store.set('PASS', 'mysecret');
    // Internal storage should NOT contain the plaintext
    const internal = (store as any).secrets.get('PASS');
    expect(internal.encrypted).not.toContain('mysecret');
    expect(internal.iv).toBeDefined();
  });

  it('SE06: secret:set overwrites existing', async () => {
    const set = findHandler(cmds, 'secret', 'set');
    const get = findHandler(cmds, 'secret', 'get');
    await set({ name: 'KEY', value: 'old' });
    await set({ name: 'KEY', value: 'new' });
    const res = await get({ name: 'KEY' });
    expect(res.data.value).toBe('new');
  });

  it('SE07: internal storage uses GCM (has auth tag)', () => {
    store.set('GCM', 'taggedvalue');
    const internal = (store as any).secrets.get('GCM');
    // GCM payload shape: iv (12 bytes / 24 hex), tag, encrypted
    expect(internal.tag).toBeDefined();
    expect(typeof internal.tag).toBe('string');
    expect(internal.iv).toBeDefined();
    expect(internal.encrypted).not.toContain('taggedvalue');
    // 12-byte IV -> 24 hex chars
    expect(internal.iv.length).toBe(24);
  });

  it('SE08: tampered ciphertext or auth tag fails decryption (integrity verified)', () => {
    store.set('TAMPER', 'integritymatters');
    const internal = (store as any).secrets.get('TAMPER') as { iv: string; tag: string; encrypted: string };

    // Flip a bit of the ciphertext
    const tamperedEnc = internal.encrypted.slice(0, -2) +
      (internal.encrypted.slice(-2) === '00' ? '01' : '00');
    (store as any).secrets.set('TAMPER', { ...internal, encrypted: tamperedEnc });
    expect(() => store.get('TAMPER')).toThrow();

    // Restore and flip a bit of the auth tag instead
    (store as any).secrets.set('TAMPER', internal);
    const tamperedTag = internal.tag.slice(0, -2) +
      (internal.tag.slice(-2) === '00' ? '01' : '00');
    (store as any).secrets.set('TAMPER', { ...internal, tag: tamperedTag });
    expect(() => store.get('TAMPER')).toThrow();
  });

  /**
   * Regresion: set()/get() no ligaban el ciphertext al nombre via AAD, la
   * misma laguna que EncryptedStorageAdapter tenia con session_id (ver
   * tests/security.test.ts T45b) hasta que se le agrego setAAD(session_id).
   * Un entry de "SECRET_A" que terminara guardado bajo la clave "SECRET_B"
   * del Map (p.ej. por un bug futuro de import/restore masivo) desencriptaba
   * "con exito" bajo el nombre equivocado en vez de fallar el auth tag.
   */
  it('SE09: un entry leido bajo OTRO nombre falla el auth tag (AAD)', () => {
    store.set('SECRET_A', 'value-of-a');
    const rawA = (store as any).secrets.get('SECRET_A');

    // Simula el entry de SECRET_A terminando guardado bajo SECRET_B.
    (store as any).secrets.set('SECRET_B', rawA);

    expect(() => store.get('SECRET_B')).toThrow();
    // El nombre correcto sigue funcionando normalmente.
    expect(store.get('SECRET_A')).toBe('value-of-a');
  });

  it('SE09: distinct encryptionKeys cannot read each other secrets', () => {
    const storeA = new SecretStore('key-for-store-a-aaaaaaaaaa');
    const storeB = new SecretStore('key-for-store-b-bbbbbbbbbb');
    storeA.set('SHARED', 'onlyAcanRead');
    const entry = (storeA as any).secrets.get('SHARED') as { iv: string; tag: string; encrypted: string };
    // Inject storeA's ciphertext into storeB: must fail to decrypt (different key)
    (storeB as any).secrets.set('SHARED', { ...entry });
    expect(() => storeB.get('SHARED')).toThrow();
    // storeA still roundtrips fine
    expect(storeA.get('SHARED')).toBe('onlyAcanRead');
  });
});

// ===========================================================================
// PROCESS MANAGER
// ===========================================================================

describe('Process Manager Skills', () => {
  let pm: ProcessManager;
  let cmds: SkillEntry[];

  beforeEach(() => {
    pm = new ProcessManager();
    cmds = createProcessCommands(pm);
  });

  afterEach(async () => { await pm.destroy(); });

  /**
   * Regresion (ronda 21 del audit): process:spawn alcanza el mismo sink de
   * ejecucion que shell:exec (child_process.spawn con shell:true), pero
   * solo exigia process:write — mismo patron ya corregido para
   * cron:schedule (ver cron.ts) y workspace:run.
   */
  it('PM00b: process:spawn exige tambien shell:exec, no solo process:write', () => {
    const spawnDef = cmds.find(c => c.definition.name === 'spawn')!.definition;
    expect(spawnDef.requiredPermissions).toEqual(expect.arrayContaining(['process:write', 'shell:exec']));
  });

  /**
   * Regresion: sin bound, spawnear procesos bajo nombres unicos (timestamps/
   * UUIDs, un patron normal de devops) dejaba una entrada en memoria para
   * siempre — kill()/close nunca borraban del Map, solo re-spawnear el MISMO
   * nombre lo hacia. Mismo patron que WorkspaceSessionStore/
   * SessionScopedContextStore (MAX_SESSIONS=200).
   */
  it('PM00: acota la cantidad de procesos rastreados (evict del mas viejo)', async () => {
    for (let i = 0; i < 205; i++) {
      const res = pm.spawn(`job-${i}`, 'echo hi');
      expect(res.success).toBe(true);
    }
    const list = pm.list();
    expect(list.length).toBeLessThanOrEqual(200);
    // The earliest jobs should have been evicted.
    expect(list.some(p => p.name === 'job-0')).toBe(false);
    // The most recent ones should still be tracked.
    expect(list.some(p => p.name === 'job-204')).toBe(true);
  });

  it('PM01: process:spawn starts a process', async () => {
    const handler = findHandler(cmds, 'process', 'spawn');
    const isWindows = process.platform === 'win32';
    const cmd = isWindows ? 'ping -n 10 127.0.0.1' : 'sleep 10';
    const res = await handler({ name: 'sleeper', command: cmd });
    expect(res.success).toBe(true);
    expect(res.data.pid).toBeGreaterThan(0);
  });

  it('PM02: process:list shows running processes', async () => {
    const spawn = findHandler(cmds, 'process', 'spawn');
    const isWindows = process.platform === 'win32';
    await spawn({ name: 'proc1', command: isWindows ? 'ping -n 10 127.0.0.1' : 'sleep 10' });

    const list = findHandler(cmds, 'process', 'list');
    const res = await list({});
    expect(res.data.count).toBe(1);
    expect(res.data.processes[0].name).toBe('proc1');
    expect(res.data.processes[0].running).toBe(true);
  });

  /**
   * Regresion (ronda 39 del audit, HIGH): ManagedProcess.command guardaba
   * el string crudo, expuesto sin masquear via process:list() a CUALQUIER
   * sesion con solo process:read — cross-session, ya que ProcessManager es
   * una unica instancia compartida por todo el proceso.
   */
  it('PM02b: process:list enmascara valores con forma de secreto en el command guardado', async () => {
    const spawn = findHandler(cmds, 'process', 'spawn');
    const isWindows = process.platform === 'win32';
    const base = isWindows ? 'ping -n 10 127.0.0.1' : 'sleep 10';
    await spawn({ name: 'leaky', command: `${base} --auth "Bearer abcdefghijklmnopqrstuvwxyz1234567890"` });

    const list = findHandler(cmds, 'process', 'list');
    const res = await list({});
    expect(res.data.processes[0].command).toContain('Bearer [REDACTED]');
    expect(res.data.processes[0].command).not.toContain('abcdefghijklmnopqrstuvwxyz1234567890');
  });

  it('PM03: process:kill stops a process', async () => {
    const spawn = findHandler(cmds, 'process', 'spawn');
    const isWindows = process.platform === 'win32';
    await spawn({ name: 'tokill', command: isWindows ? 'ping -n 100 127.0.0.1' : 'sleep 100' });

    const kill = findHandler(cmds, 'process', 'kill');
    const res = await kill({ name: 'tokill' });
    expect(res.success).toBe(true);
  });

  it('PM04: process:spawn rejects duplicate running name', async () => {
    const spawn = findHandler(cmds, 'process', 'spawn');
    const isWindows = process.platform === 'win32';
    const cmd = isWindows ? 'ping -n 10 127.0.0.1' : 'sleep 10';
    await spawn({ name: 'dup', command: cmd });
    const res = await spawn({ name: 'dup', command: cmd });
    expect(res.success).toBe(false);
    expect(res.error).toContain('already running');
  });

  it('PM05: process:logs returns output', async () => {
    const spawn = findHandler(cmds, 'process', 'spawn');
    await spawn({ name: 'echoer', command: 'echo hello-from-process' });
    // Wait for process to finish
    await new Promise(r => setTimeout(r, 500));

    const logs = findHandler(cmds, 'process', 'logs');
    const res = await logs({ name: 'echoer' });
    expect(res.success).toBe(true);
    expect(res.data.stdout).toContain('hello-from-process');
  });

  /**
   * Regresion: ProcessManager.spawn() nunca pasaba `env` a child_process.spawn(),
   * asi que el proceso heredaba el environment del host sin filtrar — el
   * mismo hueco que shell:exec tenia antes de esta sesion (env:* solo
   * enmascara sus propias lecturas; un proceso spawneado con acceso crudo
   * al env era una via lateral sin enmascarar), nunca propagado a process:*.
   */
  it('PM06: process:spawn no filtra el env sensible hacia el proceso hijo', async () => {
    // Un archivo .js en vez de `node -e "..."` inline evita todo problema de
    // quoting entre cmd.exe (Windows) y sh (POSIX) para el script en si.
    const scriptDir = mkdtempSync(join(tmpdir(), 'pm-env-leak-'));
    const scriptPath = join(scriptDir, 'dump-env.js').replace(/\\/g, '/');
    writeFileSync(scriptPath, 'console.log(process.env.AGENT_SHELL_TEST_TOKEN || "MISSING")');

    const canary = 'leak-canary-' + Date.now();
    const prevToken = process.env.AGENT_SHELL_TEST_TOKEN;
    process.env.AGENT_SHELL_TEST_TOKEN = canary;

    const spawn = findHandler(cmds, 'process', 'spawn');
    const logs = findHandler(cmds, 'process', 'logs');
    try {
      const res = await spawn({ name: 'env-leak-check', command: `node "${scriptPath}"` });
      expect(res.success).toBe(true);

      await new Promise(r => setTimeout(r, 500));
      const logRes = await logs({ name: 'env-leak-check' });
      expect(logRes.success).toBe(true);
      expect(logRes.data.stdout).toContain('MISSING');
      expect(logRes.data.stdout).not.toContain(canary);
    } finally {
      if (prevToken === undefined) delete process.env.AGENT_SHELL_TEST_TOKEN;
      else process.env.AGENT_SHELL_TEST_TOKEN = prevToken;
      rmSync(scriptDir, { recursive: true, force: true });
    }
  });

  /**
   * Regresion (ronda 47 del audit, MEDIUM F2): kill() era fire-and-forget —
   * enviaba SIGTERM y retornaba `true` de inmediato, sin esperar el evento
   * 'close' (que llega en un tick posterior). Un caller que revisara
   * process:list() apenas kill() resolvia podia ver el proceso TODAVIA
   * corriendo. kill() ahora es async y espera la muerte real (via el mismo
   * terminate() que destroy() y la evicción de MAX_PROCESSES usan).
   */
  it('PM07: kill() espera a que el proceso realmente muera antes de resolver', async () => {
    const spawn = findHandler(cmds, 'process', 'spawn');
    const isWindows = process.platform === 'win32';
    await spawn({ name: 'kill-wait-check', command: isWindows ? 'ping -n 100 127.0.0.1' : 'sleep 100' });

    const kill = findHandler(cmds, 'process', 'kill');
    const res = await kill({ name: 'kill-wait-check' });
    expect(res.success).toBe(true);

    const list = findHandler(cmds, 'process', 'list');
    const listRes = await list({});
    const entry = listRes.data.processes.find((p: any) => p.name === 'kill-wait-check');
    expect(entry.running).toBe(false);
  });

  /**
   * Regresion (ronda 47 del audit, MEDIUM F2): ningun path de este archivo
   * escalaba a SIGKILL — un proceso que ignora SIGTERM (trap '' TERM)
   * seguia corriendo para siempre. Solo POSIX: en Windows, ChildProcess.kill()
   * ya es forzoso sin importar el signal pasado (comportamiento documentado
   * de Node en ese platform), asi que no hay nada que "escalar" ahi.
   */
  it.skipIf(process.platform === 'win32')(
    'PM08: destroy() escala a SIGKILL si el proceso ignora SIGTERM',
    async () => {
      const spawn = findHandler(cmds, 'process', 'spawn');
      await spawn({ name: 'ignores-term', command: "trap '' TERM; sleep 100" });

      await pm.destroy();

      expect(pm.list().length).toBe(0);
    },
    10_000,
  );

  /**
   * Regresion (ronda 47 del audit, MEDIUM F3): el cap anterior (200 chunks)
   * acotaba la CANTIDAD de eventos 'data', no los bytes — un solo chunk
   * podia ser de cualquier tamano. Este test genera bastante mas que el
   * cap de 10MB en un solo proceso y confirma que lo capturado quedo
   * acotado, no el total real emitido.
   */
  it('PM09: acota stdout/stderr por BYTES, no por cantidad de chunks', async () => {
    const scriptDir = mkdtempSync(join(tmpdir(), 'pm-bigout-'));
    const scriptPath = join(scriptDir, 'big-output.js').replace(/\\/g, '/');
    // 15 chunks de 1MB = 15MB, bien por encima del cap de 10MB.
    writeFileSync(scriptPath, `
      const chunk = 'x'.repeat(1024 * 1024);
      for (let i = 0; i < 15; i++) process.stdout.write(chunk);
    `);

    const spawn = findHandler(cmds, 'process', 'spawn');
    const logs = findHandler(cmds, 'process', 'logs');
    try {
      const res = await spawn({ name: 'big-output', command: `node "${scriptPath}"` });
      expect(res.success).toBe(true);

      // Espera a que el proceso termine de escribir y cerrar.
      for (let i = 0; i < 40; i++) {
        const list = pm.list();
        const entry = list.find(p => p.name === 'big-output');
        if (entry && !entry.running) break;
        await new Promise(r => setTimeout(r, 250));
      }

      const logRes = await logs({ name: 'big-output' });
      expect(logRes.success).toBe(true);
      const capturedBytes = Buffer.byteLength(logRes.data.stdout, 'utf-8');
      // Se escribieron 15MB reales; lo capturado debe quedar bien por
      // debajo (acotado a ~10MB + el ultimo chunk que empujo el total
      // por encima del cap antes de que la evicción lo recortara).
      expect(capturedBytes).toBeLessThan(12 * 1024 * 1024);
    } finally {
      rmSync(scriptDir, { recursive: true, force: true });
    }
  }, 15_000);
});

/**
 * Regresion: process:spawn aceptaba --cwd sin ninguna restriccion — a
 * diferencia de file:*, git:* y workspace:*, que ya soportan
 * createXCommands(..., jailRoot), createProcessCommands() no tomaba
 * jailRoot en absoluto. Un caller con solo process:write podia spawnear un
 * comando con --cwd apuntando a cualquier directorio del host, evadiendo
 * por completo un jail configurado para el resto de las skills.
 */
describe('Process Jail (opt-in path containment)', () => {
  let pm: ProcessManager;
  let jailDir: string;
  let outsideDir: string;
  let jailed: SkillEntry[];

  beforeEach(() => {
    pm = new ProcessManager();
    // realpathSync: see the filejail beforeEach above for why this is needed.
    jailDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'processjail-')));
    outsideDir = mkdtempSync(join(tmpdir(), 'processjail-outside-'));
    jailed = createProcessCommands(pm, jailDir);
  });

  afterEach(async () => {
    await pm.destroy();
    rmSync(jailDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it('PJ01: --cwd inside the jail works normally', async () => {
    const handler = findHandler(jailed, 'process', 'spawn');
    const res = await handler({ name: 'inside', command: 'echo hi', cwd: jailDir });
    expect(res.success).toBe(true);
  });

  it('PJ02: --cwd pointing outside the jail is blocked', async () => {
    const handler = findHandler(jailed, 'process', 'spawn');
    const res = await handler({ name: 'escape', command: 'echo hi', cwd: outsideDir });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/jail|outside/i);
  });

  it('PJ03: no --cwd defaults inside the jail, not process.cwd()', async () => {
    // Uses node's own process.cwd() rather than a shell builtin (pwd/cd):
    // spawn's shell:true runs via the OS default shell (cmd.exe on native
    // Windows, not a POSIX shell), and shell-builtin output formatting
    // (short paths, drive-letter quoting) is a confound this test isn't
    // about — node's process.cwd() reflects the spawn `cwd` option exactly.
    const handler = findHandler(jailed, 'process', 'spawn');
    const logs = findHandler(jailed, 'process', 'logs');
    const res = await handler({ name: 'default-cwd', command: 'node -e "console.log(process.cwd())"' });
    expect(res.success).toBe(true);
    await new Promise(r => setTimeout(r, 500));
    const logRes = await logs({ name: 'default-cwd' });
    expect(logRes.data.stdout.trim().toLowerCase()).toBe(jailDir.toLowerCase());
  });

  it('PJ04: relative --cwd traversal outside the jail is blocked', async () => {
    const handler = findHandler(jailed, 'process', 'spawn');
    const res = await handler({ name: 'traverse', command: 'echo hi', cwd: '../../../../etc' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/jail|outside/i);
  });

  it('PJ05: without jailRoot, --cwd is unrestricted (legacy processCommands export)', async () => {
    // processCommands is a module-level singleton with its own untracked
    // ProcessManager (not this describe block's `pm`), so afterEach's
    // pm.destroy() never reaches it — a still-running child holding
    // outsideDir as its cwd would keep Windows from deleting the directory.
    const handler = findHandler(processCommands, 'process', 'spawn');
    const kill = findHandler(processCommands, 'process', 'kill');
    const res = await handler({ name: 'unrestricted', command: 'echo hi', cwd: outsideDir });
    try {
      expect(res.success).toBe(true);
    } finally {
      await kill({ name: 'unrestricted' });
      // kill() only sends SIGTERM; give Windows a moment to actually
      // terminate the process and release its lock on outsideDir before
      // afterEach's rmSync runs.
      await new Promise(r => setTimeout(r, 500));
    }
  });
});

// ===========================================================================
// REGISTRATION
// ===========================================================================

describe('Infrastructure Registration', () => {

  it('REG01: registerShellSkills registers all 40 commands', () => {
    const registry = new CommandRegistry();
    registerShellSkills(registry);
    const all = registry.listAll();
    // 7 file + 2 shell + 3 http + 2 json + 2 env + 6 workspace + 6 git + 4 cron + 4 secret + 4 process = 40
    expect(all.length).toBe(40);
  });

  it('REG02: all new namespaces are registered', () => {
    const registry = new CommandRegistry();
    registerShellSkills(registry);
    const ns = registry.getNamespaces();
    expect(ns).toContain('file');
    expect(ns).toContain('git');
    expect(ns).toContain('cron');
    expect(ns).toContain('secret');
    expect(ns).toContain('process');
  });

  /**
   * Regresion (ronda 35 del audit): registerShellSkills() llamaba
   * registry.register() en un loop desnudo, descartando el Result — si
   * algun comando colisionaba con uno ya registrado (mismo namespace:
   * name:version), registry.register() lo rechazaba correctamente
   * (COMMAND_ALREADY_EXISTS) pero eso nunca llegaba a ningun lado: el
   * proceso "bootaba bien" con un comando faltante y cero indicacion del
   * porque. Ahora falla fuerte (throw) en vez de tragarse el error.
   */
  it('REG03: registerShellSkills lanza (no se traga el error) si un comando ya esta registrado', () => {
    const registry = new CommandRegistry();
    // Pre-registra un 'file:read@1.0.0' de mentira, ocupando exactamente
    // la misma clave namespace:name:version que el file:read real que
    // registerShellSkills intenta registrar despues.
    const fakeDef = command('file', 'read').version('1.0.0').description('fake, ocupa el slot').example('file:read --path x').build();
    const preRegister = registry.register(fakeDef, async () => ({ success: true, data: null }));
    expect(preRegister.ok).toBe(true);

    expect(() => registerShellSkills(registry)).toThrow(/file:read/);
  });
});
