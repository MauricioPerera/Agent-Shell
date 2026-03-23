/**
 * @module core
 * @description Orquestador central de Agent Shell.
 *
 * Recibe comandos via exec(), coordina el ciclo de vida completo
 * delegando al Parser, Router, Executor, JQ Filter y Formatter,
 * y retorna respuestas en formato estandar.
 */

import { parse } from '../parser/index.js';
import { applyFilter } from '../jq-filter/index.js';
import { matchPermissions } from '../security/permission-matcher.js';
import { resolveAgentPermissions } from './agent-profiles.js';
import type { ParseResult, ParsedCommand, ParseError } from '../parser/index.js';
import type { CoreResponse, CoreConfig, CoreRegistry, CoreVectorIndex, CoreContextStore, LogEntry } from './types.js';

export { Core };
export { resolveAgentPermissions, AGENT_PROFILES } from './agent-profiles.js';
export type { AgentProfile } from './agent-profiles.js';
export type { CoreResponse, CoreConfig, CoreRegistry, CoreVectorIndex, CoreContextStore } from './types.js';

const LOG_LEVELS: Record<string, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

class CoreLogger {
  private readonly level: number;
  private readonly onLog: ((entry: LogEntry) => void) | null;

  constructor(config?: CoreConfig['logging']) {
    this.level = LOG_LEVELS[config?.level ?? 'INFO'] ?? 1;
    this.onLog = config?.onLog ?? null;
  }

  private shouldLog(level: string): boolean {
    return (LOG_LEVELS[level] ?? 0) >= this.level;
  }

  log(level: LogEntry['level'], module: string, message: string, data?: Record<string, any>): void {
    if (!this.shouldLog(level) || !this.onLog) return;
    this.onLog({ level, module, message, data, timestamp: new Date().toISOString() });
  }
}

/** Static interaction protocol returned by help(). */
const HELP_TEXT = `Agent Shell - Interaction Protocol

The LLM agent interacts with the system using exactly 2 tools:

1. cli_help() - Returns this interaction protocol
2. cli_exec(cmd: string) - Executes a command and returns structured response

== Discovery ==
  search <query>           Semantic command search
  describe <ns:cmd>        View command definition

== Execution ==
  namespace:command --arg value    Execute a registered command
  --dry-run                        Simulate without executing
  --validate                       Only validate arguments
  --confirm                        Preview before executing

== Filtering ==
  command | .field                 Extract field from result
  command | [.a, .b]              Multi-select fields

== Pagination ==
  --limit N                        Limit results
  --offset N                       Skip first N

== Composition ==
  cmd1 >> cmd2                     Pipeline: output of cmd1 as input of cmd2

== Batch ==
  batch [cmd1, cmd2, cmd3]         Execute multiple commands in parallel

== State ==
  context                          View current context
  context:set key value            Store value in context
  context:get key                  Get value from context

== History ==
  history                          View command history
  undo <id>                        Revert a command

== Output ==
  --format json|table|csv          Output format

== Error Codes ==
  code 0: Success
  code 1: Syntax / general error
  code 2: Command not found
  code 3: Permission denied / rate limit
  code 4: Requires confirmation
`;

/**
 * Core: orquestador central de Agent Shell.
 *
 * Expone exactamente 2 entry points publicos: help() y exec().
 */
class Core {
  private readonly config: CoreConfig;
  private readonly registry: CoreRegistry;
  private readonly vectorIndex: CoreVectorIndex | null;
  private readonly contextStore: CoreContextStore | null;
  private readonly agentPermissions: string[] | null;
  private readonly logger: CoreLogger;
  private readonly history: Array<{ command: string; code: number; timestamp: string }> = [];
  private static readonly MAX_HISTORY = 10_000;
  private rateLimitTimestamps: number[] = [];

  constructor(config: CoreConfig) {
    this.config = config;
    this.registry = config.registry;
    this.vectorIndex = config.vectorIndex || null;
    this.contextStore = config.contextStore || null;
    this.agentPermissions = resolveAgentPermissions(config);
    this.logger = new CoreLogger(config.logging);
  }

  private checkRateLimit(): boolean {
    const config = this.config.rateLimit;
    if (!config) return true;

    const now = Date.now();
    const windowMs = config.windowMs ?? 60_000;
    const maxRequests = config.maxRequests ?? 120;
    const burstSize = config.burstSize ?? 20;
    const windowStart = now - windowMs;

    this.rateLimitTimestamps = this.rateLimitTimestamps.filter(t => t > windowStart);

    // Check burst (requests in last 1 second)
    const burstWindowStart = now - 1000;
    const burstCount = this.rateLimitTimestamps.filter(t => t > burstWindowStart).length;
    if (burstCount >= burstSize) return false;

    // Check window limit
    if (this.rateLimitTimestamps.length >= maxRequests) return false;

    this.rateLimitTimestamps.push(now);
    return true;
  }

  private withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timerId: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timerId = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => {
      clearTimeout(timerId);
    });
  }

  /**
   * Retorna el protocolo de interaccion completo (estatico).
   */
  help(): string {
    return HELP_TEXT;
  }

  /**
   * Punto de entrada principal para toda interaccion con el sistema.
   * Nunca lanza excepciones - todo error se envuelve en CoreResponse.
   */
  async exec(cmd: string): Promise<CoreResponse> {
    const startTime = Date.now();
    let mode = 'execute';

    // Rate limit check
    if (!this.checkRateLimit()) {
      return this.buildResponse(3, null, 'Rate limit exceeded', cmd.slice(0, 50), mode, startTime);
    }

    // Input size pre-check
    const maxLen = this.config.maxInputLength ?? 10_000;
    if (cmd.length > maxLen) {
      return this.buildResponse(1, null, `Input exceeds maximum length of ${maxLen} characters`, cmd.slice(0, 50) + '...', mode, startTime);
    }

    // Wrap in global timeout
    const globalTimeout = this.config.timeouts?.global_ms ?? 30_000;
    try {
      return await this.withTimeout(this.execInternal(cmd, startTime), globalTimeout, 'Request');
    } catch (err: any) {
      return this.buildResponse(1, null, err.message || 'Request timed out', cmd.slice(0, 50), mode, startTime);
    }
  }

  private async execInternal(cmd: string, startTime: number): Promise<CoreResponse> {
    let mode = 'execute';
    this.logger.log('INFO', 'core', 'exec', { command: cmd.slice(0, 100) });

    try {
      // Parse
      const parseResult = parse(cmd);

      // Check parse error
      if ('errorType' in parseResult) {
        const parseError = parseResult as ParseError;
        return this.buildResponse(1, null, parseError.message, cmd, mode, startTime);
      }

      const result = parseResult as ParseResult;

      // Determine mode from first command's flags
      const firstCmd = result.commands[0];
      if (firstCmd?.flags.dryRun) mode = 'dry-run';
      if (firstCmd?.flags.validate) mode = 'validate';
      if (firstCmd?.flags.confirm) mode = 'confirm';

      // Route based on parse result type
      let data: any;

      if (result.type === 'pipeline') {
        data = await this.executePipeline(result.commands);
      } else if (result.type === 'batch') {
        data = await this.executeBatch(result.commands);
        // Batch code: 0 if all succeeded, 1 if any failed
        const batchFailed = data.some((r: any) => r.code !== 0);
        const code = batchFailed ? 1 : 0;
        this.recordHistory(cmd, code);
        return this.buildResponse(code, data, null, cmd, mode, startTime);
      } else {
        // Single command
        data = await this.executeCommand(firstCmd);
      }

      // Handle error responses from executeCommand
      if (data && typeof data === 'object' && '_error' in data) {
        const { code, error } = data._error;
        this.recordHistory(cmd, code);
        return this.buildResponse(code, null, error, cmd, mode, startTime);
      }

      // Apply JQ filter if present
      if (firstCmd?.jqFilter && data !== null && data !== undefined) {
        data = this.applyJqFilter(data, firstCmd.jqFilter.raw);
      }

      // Apply format if specified
      if (firstCmd?.flags.format && firstCmd.flags.format !== 'json') {
        data = this.applyFormat(data, firstCmd.flags.format);
      }

      // Apply pagination
      if (Array.isArray(data)) {
        data = this.applyPagination(data, firstCmd?.flags);
      }

      this.recordHistory(cmd, 0);
      return this.buildResponse(0, data, null, cmd, mode, startTime);
    } catch (err: any) {
      return this.buildResponse(1, null, err.message || 'Unknown error', cmd, mode, startTime);
    }
  }

  // --- Private methods ---

  private async executeCommand(parsed: ParsedCommand): Promise<any> {
    const { namespace, command, args, flags } = parsed;

    // Builtin commands (namespace is null)
    if (namespace === null) {
      return this.executeBuiltin(command, args);
    }

    // Context namespace special handling
    if (namespace === 'context') {
      return this.executeContext(command, args);
    }

    // Lookup in registry
    const registeredCmd = this.registry.get(namespace, command);
    if (!registeredCmd) {
      return { _error: { code: 2, error: `Command not found: ${namespace}:${command}` } };
    }

    // Check agent permissions
    if (this.agentPermissions && registeredCmd.requiredPermissions?.length) {
      if (!matchPermissions(this.agentPermissions, registeredCmd.requiredPermissions)) {
        return { _error: { code: 3, error: `Permission denied: ${namespace}:${command}` } };
      }
    }

    // Validate mode: check required params
    if (flags.validate) {
      return this.validateCommand(registeredCmd, args);
    }

    // Build handler args
    const handlerArgs: Record<string, any> = { ...args.named };
    // Map positional args to params
    if (registeredCmd.params) {
      registeredCmd.params.forEach((p: any, idx: number) => {
        if (args.positional[idx] !== undefined && !(p.name in handlerArgs)) {
          handlerArgs[p.name] = args.positional[idx];
        }
      });
    }

    // Dry-run mode: return simulated data without calling handler
    if (flags.dryRun) {
      return { dryRun: true, command: `${namespace}:${command}`, args: handlerArgs };
    }

    // Execute handler
    const result = await registeredCmd.handler(handlerArgs, null);
    return result.data;
  }

  private async executeBuiltin(command: string, args: any): Promise<any> {
    switch (command) {
      case 'search': {
        if (!this.vectorIndex) {
          return { _error: { code: 1, error: 'Search not available' } };
        }
        const query = args.positional.join(' ');
        const searchResult = await this.vectorIndex.search(query);
        // Filter results by agent permissions — hide commands the agent cannot access
        if (this.agentPermissions && searchResult.results) {
          searchResult.results = searchResult.results.filter((r: any) => {
            const cmd = this.registry.get(r.namespace, r.command);
            if (!cmd?.requiredPermissions?.length) return true;
            return matchPermissions(this.agentPermissions!, cmd.requiredPermissions);
          });
        }
        return searchResult;
      }

      case 'describe': {
        const target = args.positional[0] || '';
        const [ns, cmd] = target.includes(':') ? target.split(':') : [null, target];
        if (!ns || !cmd) {
          return { _error: { code: 1, error: 'Usage: describe namespace:command' } };
        }
        const definition = this.registry.get(ns, cmd);
        if (!definition) {
          return { _error: { code: 2, error: `Command not found: ${target}` } };
        }
        // Check agent permissions before revealing command definition
        if (this.agentPermissions && definition.requiredPermissions?.length) {
          if (!matchPermissions(this.agentPermissions, definition.requiredPermissions)) {
            return { _error: { code: 3, error: `Permission denied: cannot describe ${target}` } };
          }
        }
        return definition;
      }

      case 'context': {
        if (!this.contextStore) return {};
        const result = this.contextStore.getAll();
        return result.data ?? {};
      }

      case 'history': {
        return [...this.history];
      }

      case 'undo': {
        return { _error: { code: 1, error: 'Undo not implemented in core standalone mode' } };
      }

      case 'help': {
        return this.help();
      }

      default:
        return { _error: { code: 2, error: `Unknown builtin command: ${command}` } };
    }
  }

  private executeContext(command: string, args: any): any {
    if (!this.contextStore) {
      return { _error: { code: 1, error: 'Context store not available' } };
    }

    switch (command) {
      case 'set': {
        const key = args.positional[0];
        const value = args.positional[1];
        if (!key) return { _error: { code: 1, error: 'Usage: context:set <key> <value>' } };
        this.contextStore.set(key, value);
        return { key, value, status: 'set' };
      }

      case 'get': {
        const key = args.positional[0];
        if (!key) return { _error: { code: 1, error: 'Usage: context:get <key>' } };
        const result = this.contextStore.get(key);
        return result.data;
      }

      case 'delete': {
        const key = args.positional[0];
        if (!key) return { _error: { code: 1, error: 'Usage: context:delete <key>' } };
        this.contextStore.delete(key);
        return { key, status: 'deleted' };
      }

      default:
        return { _error: { code: 2, error: `Unknown context command: ${command}` } };
    }
  }

  private validateCommand(registeredCmd: any, args: any): any {
    const errors: string[] = [];

    if (registeredCmd.params) {
      for (const param of registeredCmd.params) {
        if (param.required && !(param.name in args.named) && !args.positional.length) {
          errors.push(`Missing required parameter: ${param.name}`);
        }
      }
    }

    if (errors.length > 0) {
      return { _error: { code: 1, error: errors.join('; ') } };
    }

    return { valid: true, command: `${registeredCmd.namespace}:${registeredCmd.name}` };
  }

  private async executePipeline(commands: ParsedCommand[]): Promise<any> {
    const maxDepth = 10;
    if (commands.length > maxDepth) {
      return { _error: { code: 1, error: `Pipeline exceeds maximum depth of ${maxDepth} commands` } };
    }

    let previousData: any = null;

    for (const cmd of commands) {
      const { namespace, command, args, flags } = cmd;

      if (!namespace) {
        return { _error: { code: 1, error: `Pipeline command must have namespace` } };
      }

      const registeredCmd = this.registry.get(namespace, command);
      if (!registeredCmd) {
        return { _error: { code: 2, error: `Command not found: ${namespace}:${command}` } };
      }

      // Check agent permissions for each pipeline step
      if (this.agentPermissions && registeredCmd.requiredPermissions?.length) {
        if (!matchPermissions(this.agentPermissions, registeredCmd.requiredPermissions)) {
          return { _error: { code: 3, error: `Permission denied at pipeline step: ${namespace}:${command}` } };
        }
      }

      const handlerArgs: Record<string, any> = { ...args.named };
      if (registeredCmd.params) {
        registeredCmd.params.forEach((p: any, idx: number) => {
          if (args.positional[idx] !== undefined && !(p.name in handlerArgs)) {
            handlerArgs[p.name] = args.positional[idx];
          }
        });
      }

      const result = await registeredCmd.handler(handlerArgs, previousData);
      if (!result.success) {
        return { _error: { code: 1, error: `Pipeline failed at ${namespace}:${command}` } };
      }

      previousData = result.data;
    }

    return previousData;
  }

  private async executeBatch(commands: ParsedCommand[]): Promise<any[]> {
    const maxBatchSize = 20;
    if (commands.length > maxBatchSize) {
      return [{ code: 1, data: null, error: `Batch exceeds maximum size of ${maxBatchSize} commands` }];
    }

    // Execute all commands in parallel
    const settled = await Promise.allSettled(
      commands.map(cmd => this.executeCommand(cmd))
    );

    return settled.map((outcome) => {
      if (outcome.status === 'rejected') {
        return { code: 1, data: null, error: (outcome.reason as Error)?.message || 'Unknown error' };
      }
      const data = outcome.value;
      if (data && typeof data === 'object' && '_error' in data) {
        return { code: data._error.code, data: null, error: data._error.error };
      }
      return { code: 0, data, error: null };
    });
  }

  private applyJqFilter(data: any, expression: string): any {
    const result = applyFilter(data, expression);
    if (result.success) {
      return result.result;
    }
    // If filter fails, return null (per contract: campo no encontrado no es error)
    return null;
  }

  private applyFormat(data: any, format: 'table' | 'csv'): string {
    if (!Array.isArray(data)) {
      if (typeof data === 'object' && data !== null) {
        data = [data];
      } else {
        return String(data);
      }
    }

    if (data.length === 0) return '';

    const keys = Object.keys(data[0]);

    if (format === 'csv') {
      const escapeCsv = (val: string): string => {
        if (val.includes(',') || val.includes('"') || val.includes('\n') || val.includes('\r')) {
          return '"' + val.replace(/"/g, '""') + '"';
        }
        return val;
      };
      const header = keys.map(escapeCsv).join(',');
      const rows = data.map((row: any) => keys.map(k => escapeCsv(String(row[k] ?? ''))).join(','));
      return [header, ...rows].join('\n');
    }

    // Table format
    const colWidths = keys.map(k => {
      const maxVal = Math.max(k.length, ...data.map((r: any) => String(r[k] ?? '').length));
      return maxVal;
    });

    const header = keys.map((k, i) => k.padEnd(colWidths[i])).join('  ');
    const separator = colWidths.map(w => '-'.repeat(w)).join('  ');
    const rows = data.map((row: any) =>
      keys.map((k, i) => String(row[k] ?? '').padEnd(colWidths[i])).join('  ')
    );

    return [header, separator, ...rows].join('\n');
  }

  private applyPagination(data: any[], flags?: any): any[] {
    if (!flags) return data;
    let result = data;

    const offset = flags.offset ?? 0;
    const limit = flags.limit;

    if (offset > 0) {
      result = result.slice(offset);
    }
    if (limit !== null && limit !== undefined) {
      result = result.slice(0, limit);
    }

    return result;
  }

  private recordHistory(command: string, code: number): void {
    this.history.push({
      command,
      code,
      timestamp: new Date().toISOString(),
    });
    // FIFO: evict oldest entries when exceeding max history
    while (this.history.length > Core.MAX_HISTORY) {
      this.history.shift();
    }
  }

  private buildResponse(
    code: number,
    data: any,
    error: string | null,
    command: string,
    mode: string,
    startTime: number
  ): CoreResponse {
    const duration_ms = Date.now() - startTime;

    if (error) {
      this.logger.log('ERROR', 'core', error, { command: command.slice(0, 100), code, duration_ms });
    } else if (duration_ms > 5000) {
      this.logger.log('WARN', 'core', 'Slow command execution', { command: command.slice(0, 100), duration_ms });
    }

    return {
      code,
      data: data ?? null,
      error: error ?? null,
      meta: {
        duration_ms,
        command,
        mode,
        timestamp: new Date().toISOString(),
      },
    };
  }
}
