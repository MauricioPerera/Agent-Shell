/**
 * @module skills
 * @description CLI creation skills for Agent Shell.
 *
 * Three categories of skills:
 * - **Scaffold**: Generate project structure, namespaces, and command files
 * - **Wizard**: Interactive command/namespace creation with validation
 * - **Registry Admin**: Runtime introspection and export of registered commands
 *
 * @example
 * ```typescript
 * import { CommandRegistry, registerSkills } from 'agent-shell';
 *
 * const registry = new CommandRegistry();
 * registerSkills(registry); // Registers all 9 skill commands
 * ```
 */

import type { CommandRegistry } from '../command-registry/index.js';
import { scaffoldCommands } from './scaffold.js';
import { wizardCommands } from './wizard.js';
import { registryAdminCommands } from './registry-admin.js';

export type { SkillEntry } from './scaffold.js';
export { scaffoldCommands } from './scaffold.js';
export { wizardCommands } from './wizard.js';
export { registryAdminCommands } from './registry-admin.js';

/**
 * Registers all CLI creation skills (9 commands) into a CommandRegistry.
 *
 * Skills registered:
 * - scaffold:init, scaffold:add-namespace, scaffold:add-command
 * - wizard:create-command, wizard:create-namespace
 * - registry:list, registry:describe, registry:stats, registry:export
 */
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
