/**
 * @module just-bash/factory
 * @description Factory for creating shell adapters with automatic backend detection.
 *
 * Tries just-bash first (sandboxed), falls back to native (child_process).
 */

import { createRequire } from 'node:module';
import type { ShellAdapter, ShellAdapterConfig } from './types.js';
import { JustBashShellAdapter, NativeShellAdapter } from './adapter.js';

// This package builds to ESM only (tsup.config.ts: format: ['esm']). The bare
// `require` identifier doesn't exist at runtime in ESM, and bundlers rewrite a
// literal `require(...)` call into a shim that unconditionally throws ("Dynamic
// require of X is not supported") regardless of whether the package is actually
// installed — silently making the just-bash sandbox backend unreachable and
// forcing every caller onto NativeShellAdapter (real child_process/fs) without
// any indication. `createRequire` gives a real, working CJS require in ESM.
const require = createRequire(import.meta.url);

/** Check if just-bash is available as a peer dependency. */
export function isJustBashAvailable(): boolean {
  try {
    require('just-bash');
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates a ShellAdapter with automatic backend selection.
 *
 * @param config - Configuration options
 * @returns A ShellAdapter using just-bash (if available) or native child_process
 *
 * @example
 * ```typescript
 * // Auto-detect: just-bash if installed, native otherwise
 * const adapter = createShellAdapter();
 *
 * // Force just-bash (throws if not installed)
 * const adapter = createShellAdapter({ prefer: 'just-bash' });
 *
 * // Force native (child_process)
 * const adapter = createShellAdapter({ prefer: 'native' });
 *
 * // Just-bash with config
 * const adapter = createShellAdapter({
 *   prefer: 'just-bash',
 *   files: { '/data/input.txt': 'hello world' },
 *   network: { allowedUrlPrefixes: ['https://api.myapp.com/'] },
 * });
 * ```
 */
export function createShellAdapter(config?: ShellAdapterConfig): ShellAdapter {
  const prefer = config?.prefer ?? 'auto';

  // Force native
  if (prefer === 'native') {
    return new NativeShellAdapter();
  }

  // Force just-bash
  if (prefer === 'just-bash') {
    const Bash = loadJustBash();
    if (!Bash) {
      throw new Error(
        'just-bash backend requested but not available. Install with: npm install just-bash'
      );
    }
    return new JustBashShellAdapter(createBashInstance(Bash, config));
  }

  // Auto: try just-bash, fall back to native
  const Bash = loadJustBash();
  if (Bash) {
    try {
      return new JustBashShellAdapter(createBashInstance(Bash, config));
    } catch (err) {
      // just-bash available but failed to init — fallback
      warnFallback(`failed to initialize: ${(err as Error)?.message ?? err}`);
      return new NativeShellAdapter();
    }
  }

  warnFallback('package not installed');
  return new NativeShellAdapter();
}

function loadJustBash(): any {
  try {
    return require('just-bash').Bash;
  } catch {
    return null;
  }
}

/**
 * Logs which shell backend ended up active. `auto` silently degrading from
 * sandboxed to real-process execution is exactly the failure mode this
 * module exists to prevent — surface it instead of staying quiet.
 */
function warnFallback(reason: string): void {
  // eslint-disable-next-line no-console
  console.error(`[agent-shell] just-bash sandbox not available (${reason}); shell:exec will run against the real OS via child_process.`);
}

function createBashInstance(BashClass: any, config?: ShellAdapterConfig): any {
  const opts: any = {};

  if (config?.files) opts.files = config.files;
  if (config?.cwd) opts.cwd = config.cwd;
  if (config?.network) opts.network = config.network;
  if (config?.executionLimits) opts.executionLimits = config.executionLimits;

  return new BashClass(opts);
}
