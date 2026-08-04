/**
 * @module skills
 * @description Skills for Agent Shell.
 *
 * Two categories:
 * - **CLI Creation**: scaffold, wizard, registry admin (9 commands)
 * - **Shell**: http, json, file, shell exec, env, workspace, git, cron, secret, process (40 commands)
 *
 * Shell skills support pluggable backends via ShellAdapter:
 * - **just-bash**: sandboxed TypeScript interpreter (if installed)
 * - **native**: real child_process + fs (fallback)
 *
 * @example
 * ```typescript
 * import { CommandRegistry, registerSkills, registerShellSkills, createShellAdapter } from 'agent-shell';
 *
 * const registry = new CommandRegistry();
 * registerSkills(registry);
 *
 * // Auto-detect backend (just-bash if installed, native otherwise)
 * registerShellSkills(registry);
 *
 * // Or force sandboxed backend
 * const adapter = createShellAdapter({ prefer: 'just-bash', files: { '/data.json': '{}' } });
 * registerShellSkills(registry, adapter);
 * ```
 */

import type { CommandRegistry } from '../command-registry/index.js';
import type { SkillEntry } from './scaffold.js';
import type { ShellAdapter } from '../just-bash/types.js';
import { createShellAdapter } from '../just-bash/factory.js';
import { scaffoldCommands } from './scaffold.js';
import { wizardCommands } from './wizard.js';
import { registryAdminCommands } from './registry-admin.js';
import { httpCommands } from './shell-http.js';
import { jsonCommands } from './shell-json.js';
import { createFileCommands } from './shell-file.js';
import { createShellCommands } from './shell-exec.js';
import { envCommands } from './shell-env.js';
import { createWorkspaceCommands } from './workspace.js';
import { createGitCommands } from './shell-git.js';
import { createCronCommands, CronScheduler } from './cron.js';
import { createSecretCommands } from './secret-store.js';
import { createProcessCommands, ProcessManager } from './process-mgr.js';

export type { SkillEntry } from './scaffold.js';
export { scaffoldCommands } from './scaffold.js';
export { wizardCommands } from './wizard.js';
export { registryAdminCommands } from './registry-admin.js';
export { httpCommands } from './shell-http.js';
export { jsonCommands } from './shell-json.js';
export { fileCommands, createFileCommands } from './shell-file.js';
export { shellCommands, createShellCommands } from './shell-exec.js';
export { envCommands } from './shell-env.js';
export { workspaceCommands, createWorkspaceCommands, WorkspaceState } from './workspace.js';
export { gitCommands, createGitCommands } from './shell-git.js';
export { cronCommands, createCronCommands, CronScheduler } from './cron.js';
export { secretCommands, createSecretCommands, SecretStore } from './secret-store.js';
export { processCommands, createProcessCommands, ProcessManager } from './process-mgr.js';

/**
 * Registers every command in `commands`, failing LOUD on the first
 * collision instead of silently swallowing it.
 *
 * Regresion (ronda 35 del audit): registerSkills()/registerShellSkills()
 * called registry.register() in a bare loop and discarded its Result —
 * registry.register() itself correctly rejects an exact namespace:name:
 * version duplicate (COMMAND_ALREADY_EXISTS) rather than silently
 * overwriting, but nothing here ever surfaced that rejection. Today this
 * is inert (the 44 shipped namespace:name pairs are all unique, verified
 * during that audit), but a future skill module accidentally reusing an
 * existing pair would boot "successfully" with a missing/reduced command
 * and zero indication why — this throws instead, matching the pattern
 * scaffold.ts's own generateEntryPoint() already recommends to library
 * consumers.
 */
function registerAll(registry: CommandRegistry, commands: SkillEntry[]): void {
  for (const { definition, handler } of commands) {
    const result = registry.register(definition, handler);
    if (!result.ok) {
      throw new Error(`Failed to register command ${definition.namespace}:${definition.name}: ${result.error.message}`);
    }
  }
}

/**
 * Registers all CLI creation skills (9 commands).
 *
 * @param agentPermissions - The caller's resolved permission set (same shape
 *   Core computes via resolveAgentPermissions), used only to filter what
 *   registry:list/describe/export reveal. null/undefined = no enforcement,
 *   matching Core's own convention. Passing it here (at registration time)
 *   rather than per-call is deliberate: this codebase scopes one Core/agent
 *   per process for its whole lifetime, there's no per-request caller
 *   identity to thread through handlers.
 */
export function registerSkills(registry: CommandRegistry, agentPermissions?: string[] | null): void {
  registerAll(registry, scaffoldCommands);
  registerAll(registry, wizardCommands);
  registerAll(registry, registryAdminCommands(registry, agentPermissions));
}

/**
 * Registers all system shell skills (40 commands): http, json, file, shell, env,
 * workspace, git, cron, secret, process.
 *
 * @param registry - CommandRegistry to register into
 * @param shellAdapter - Optional ShellAdapter. If not provided, auto-detects
 *   just-bash (sandboxed) or falls back to native (child_process).
 * @param jailRoot - Optional path-containment root, forwarded to the
 *   file/git/workspace/process/cron skills (see security/path-jail.ts).
 *   Omitted = no jail, matching prior behavior. cli/index.ts and
 *   server/index.ts are the only real callers of this function and must
 *   forward their own jailRoot config through here for the containment
 *   checks to have any effect.
 * @param processManager - Optional ProcessManager instance for process:*.
 *   Omitted = a fresh internal instance (prior behavior — but then the
 *   caller has no reference to call destroy() on later). cli/index.ts and
 *   server/index.ts now construct one themselves and pass it in so their
 *   shutdown handlers can terminate spawned children instead of orphaning
 *   them (ronda 47 del audit, HIGH — ProcessManager.destroy() existed but
 *   was never reachable from any real shutdown path).
 * @param cronScheduler - Optional CronScheduler instance for cron:*. Same
 *   reasoning as processManager above — ronda 50 del audit, HIGH: this
 *   parameter didn't exist at all before, so there was no way for a
 *   caller to obtain the scheduler to stop its timers on shutdown, even
 *   if they wanted to.
 */
export function registerShellSkills(registry: CommandRegistry, shellAdapter?: ShellAdapter, jailRoot?: string, processManager?: ProcessManager, cronScheduler?: CronScheduler): void {
  const adapter = shellAdapter || createShellAdapter();

  registerAll(registry, httpCommands);
  registerAll(registry, jsonCommands);
  registerAll(registry, createFileCommands(adapter, jailRoot));
  registerAll(registry, createShellCommands(adapter, jailRoot));
  registerAll(registry, envCommands);
  registerAll(registry, createWorkspaceCommands(undefined, adapter, jailRoot));
  registerAll(registry, createGitCommands(jailRoot));
  registerAll(registry, createCronCommands(cronScheduler, adapter, jailRoot));
  registerAll(registry, createSecretCommands());
  registerAll(registry, createProcessCommands(processManager, jailRoot, adapter));
}

/** Registers ALL skills (CLI creation + shell). */
export function registerAllSkills(registry: CommandRegistry, shellAdapter?: ShellAdapter, agentPermissions?: string[] | null, jailRoot?: string): void {
  registerSkills(registry, agentPermissions);
  registerShellSkills(registry, shellAdapter, jailRoot);
}
