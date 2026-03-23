/**
 * @module just-bash
 * @description Pluggable shell adapter for Agent Shell.
 *
 * Supports two backends:
 * - **just-bash**: Sandboxed TypeScript bash interpreter with virtual filesystem
 *   and 79 built-in Unix commands. Safe by design — no real processes.
 * - **native**: Real child_process + fs. Full system access. Fallback.
 *
 * @example
 * ```typescript
 * import { createShellAdapter } from 'agent-shell';
 *
 * // Auto-detect: just-bash if installed, native otherwise
 * const adapter = createShellAdapter();
 * console.log(`Using ${adapter.backend} backend`);
 *
 * const result = await adapter.exec('echo hello | grep hello');
 * console.log(result.stdout); // "hello"
 * ```
 */

export type { ShellAdapter, ShellResult, ShellExecOptions, DirEntry, ShellAdapterConfig } from './types.js';
export { JustBashShellAdapter, NativeShellAdapter } from './adapter.js';
export { createShellAdapter, isJustBashAvailable } from './factory.js';
