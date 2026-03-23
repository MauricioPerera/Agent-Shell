/**
 * @module skills
 * @description Skills for Agent Shell.
 *
 * Two categories:
 * - **CLI Creation**: scaffold, wizard, registry admin (9 commands)
 * - **Shell**: http, json, file, shell exec, env (12 commands)
 *
 * @example
 * ```typescript
 * import { CommandRegistry, registerSkills, registerShellSkills } from 'agent-shell';
 *
 * const registry = new CommandRegistry();
 * registerSkills(registry);      // 9 CLI creation skills
 * registerShellSkills(registry); // 12 system shell skills
 * ```
 */

import type { CommandRegistry } from '../command-registry/index.js';
import { scaffoldCommands } from './scaffold.js';
import { wizardCommands } from './wizard.js';
import { registryAdminCommands } from './registry-admin.js';
import { httpCommands } from './shell-http.js';
import { jsonCommands } from './shell-json.js';
import { fileCommands } from './shell-file.js';
import { shellCommands } from './shell-exec.js';
import { envCommands } from './shell-env.js';

export type { SkillEntry } from './scaffold.js';
export { scaffoldCommands } from './scaffold.js';
export { wizardCommands } from './wizard.js';
export { registryAdminCommands } from './registry-admin.js';
export { httpCommands } from './shell-http.js';
export { jsonCommands } from './shell-json.js';
export { fileCommands } from './shell-file.js';
export { shellCommands } from './shell-exec.js';
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

/** Registers all system shell skills (12 commands): http, json, file, shell, env. */
export function registerShellSkills(registry: CommandRegistry): void {
  for (const { definition, handler } of httpCommands) {
    registry.register(definition, handler);
  }
  for (const { definition, handler } of jsonCommands) {
    registry.register(definition, handler);
  }
  for (const { definition, handler } of fileCommands) {
    registry.register(definition, handler);
  }
  for (const { definition, handler } of shellCommands) {
    registry.register(definition, handler);
  }
  for (const { definition, handler } of envCommands) {
    registry.register(definition, handler);
  }
}

/** Registers ALL skills (CLI creation + shell). */
export function registerAllSkills(registry: CommandRegistry): void {
  registerSkills(registry);
  registerShellSkills(registry);
}
