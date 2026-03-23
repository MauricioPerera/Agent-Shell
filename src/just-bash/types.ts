/**
 * @module just-bash/types
 * @description Shell adapter interfaces for pluggable execution backends.
 *
 * Two implementations:
 * - JustBashShellAdapter: sandboxed TypeScript interpreter (just-bash)
 * - NativeShellAdapter: real child_process + fs (fallback)
 */

/** Result of a shell command execution. */
export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Options for shell execution. */
export interface ShellExecOptions {
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
}

/** Directory entry from listing. */
export interface DirEntry {
  name: string;
  type: 'file' | 'directory';
  size: number;
}

/**
 * Abstract shell adapter interface.
 * Both just-bash and native backends implement this contract.
 */
export interface ShellAdapter {
  /** Name of the backend ('just-bash' or 'native'). */
  readonly backend: string;

  /** Execute a shell command and return stdout/stderr/exitCode. */
  exec(command: string, opts?: ShellExecOptions): Promise<ShellResult>;

  /** Check if a program exists. */
  which(program: string): Promise<{ program: string; path: string | null; found: boolean }>;

  /** Read a file's content. */
  readFile(path: string, encoding?: string): Promise<{ path: string; content: string; size: number }>;

  /** Write content to a file. */
  writeFile(path: string, content: string): Promise<{ path: string; size: number; written: boolean }>;

  /** List entries in a directory. */
  listDir(path: string, pattern?: string): Promise<{ path: string; entries: DirEntry[]; count: number }>;
}

/** Configuration for the shell adapter factory. */
export interface ShellAdapterConfig {
  /** Preferred backend: 'just-bash', 'native', or 'auto' (default). */
  prefer?: 'just-bash' | 'native' | 'auto';

  /** Initial virtual files (just-bash only). */
  files?: Record<string, string>;

  /** Working directory. */
  cwd?: string;

  /** Network allowlist (just-bash only). */
  network?: {
    allowedUrlPrefixes?: string[];
    allowedMethods?: string[];
  };

  /** Execution limits (just-bash only). */
  executionLimits?: {
    maxCommandCount?: number;
    maxLoopIterations?: number;
    maxCallDepth?: number;
  };
}
