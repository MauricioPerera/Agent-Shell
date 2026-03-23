/**
 * @module skills
 * @description Skills for Agent Shell.
 *
 * Two categories:
 * - **CLI Creation**: scaffold, wizard, registry admin (9 commands)
 * - **Shell**: http, json, file, shell exec, env (12 commands)
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

export type { SkillEntry } from './scaffold.js';
export { scaffoldCommands } from './scaffold.js';
export { wizardCommands } from './wizard.js';
export { registryAdminCommands } from './registry-admin.js';
export { httpCommands } from './shell-http.js';
export { jsonCommands } from './shell-json.js';
export { fileCommands, createFileCommands } from './shell-file.js';
export { shellCommands, createShellCommands } from './shell-exec.js';
export { envCommands } from './shell-env.js';

/** Registers all CLI creation skills (9 commands). */
export function registerSkills(registry: CommandRegistry): void {
  for (const { definition, handler } of scaffoldCommands) {
    registry.register(definition, handler);
  }
  for (const { definition, handler } of wizardCommands) {
    registry.register(definition, handler);
  }
  for (const { definition, handler } of registryAdminCommands(registry)) {
    registry.register(definition, handler);
  }
}

/**
 * Registers all system shell skills (12 commands): http, json, file, shell, env.
 *
 * @param registry - CommandRegistry to register into
 * @param shellAdapter - Optional ShellAdapter. If not provided, auto-detects
 *   just-bash (sandboxed) or falls back to native (child_process).
 */
export function registerShellSkills(registry: CommandRegistry, shellAdapter?: ShellAdapter): void {
  const adapter = shellAdapter || createShellAdapter();

  for (const { definition, handler } of httpCommands) {
    registry.register(definition, handler);
  }
  for (const { definition, handler } of jsonCommands) {
    registry.register(definition, handler);
  }
  for (const { definition, handler } of createFileCommands(adapter)) {
    registry.register(definition, handler);
  }
  for (const { definition, handler } of createShellCommands(adapter)) {
    registry.register(definition, handler);
  }
  for (const { definition, handler } of envCommands) {
    registry.register(definition, handler);
  }
}

/** Registers ALL skills (CLI creation + shell). */
export function registerAllSkills(registry: CommandRegistry, shellAdapter?: ShellAdapter): void {
  registerSkills(registry);
  registerShellSkills(registry, shellAdapter);
}
