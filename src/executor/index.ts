/**
 * @module executor
 * @description Motor de ejecucion central de Agent Shell.
 *
 * Recibe un ParseResult del Parser, resuelve el handler via Command Registry,
 * aplica el pipeline de ejecucion (validacion, permisos, modo, ejecucion,
 * historial) y retorna una respuesta estandarizada.
 */

import type { ExecutionResult, ExecutionError, ExecutionMeta, BatchResult, PipelineResult, PipelineStep, ExecutionContext } from './types.js';
import { maskSecrets } from '../security/secret-patterns.js';
import { matchPermissions } from '../security/permission-matcher.js';

export { type ExecutionResult, type ExecutionError, type ExecutionMeta, type BatchResult, type PipelineResult, type PipelineStep, type ExecutionContext, type ExecutorConfig, type HistoryStore } from './types.js';

/** Pending confirm tokens storage. */
interface PendingConfirm {
  namespace: string;
  command: string;
  args: Record<string, any>;
  registeredCommand: any;
  createdAt: number;
}

/**
 * Executor: motor de ejecucion con pipeline completo.
 *
 * @example
 * ```ts
 * const executor = new Executor(registry, context);
 * const result = await executor.execute(parseResult);
 * ```
 */
export class Executor {
  private registry: any;
  private context: ExecutionContext;
  private pendingConfirms: Map<string, PendingConfirm> = new Map();
  private rateLimitTimestamps: number[] = [];

  constructor(registry: any, context: ExecutionContext) {
    this.registry = registry;
    this.context = context;
  }

  /** Ejecuta un ParseResult (single, pipeline, o batch). */
  async execute(parseResult: any): Promise<ExecutionResult | BatchResult | PipelineResult> {
    this.cleanExpiredConfirms();

    // Deep-copy to avoid mutating input
    const pr = structuredClone(parseResult);

    if (pr.type === 'batch') {
      return this.executeBatch(pr);
    }
    if (pr.type === 'pipeline') {
      return this.executePipeline(pr);
    }
    return this.executeSingle(pr.commands[0]);
  }

  /** Ejecuta undo de un comando por su historyId. */
  async undo(historyId: string): Promise<ExecutionResult> {
    const entry = this.context.history.getById(historyId);
    if (!entry) {
      return this.errorResult(2, 'E_NOT_FOUND', `Command '${historyId}' not found in history`, 'normal', '');
    }

    // Check reversibility
    if (!entry.reversible) {
      return this.errorResult(1, 'E_UNDO_NOT_REVERSIBLE', `Command '${entry.command}' is not reversible`, 'normal', entry.command);
    }

    // Check TTL
    const elapsed = Date.now() - new Date(entry.executedAt).getTime();
    if (elapsed > this.context.config.undoTTL_ms) {
      return this.errorResult(1, 'E_UNDO_EXPIRED', `Undo expired: command was executed ${Math.round(elapsed / 1000)}s ago`, 'normal', entry.command);
    }

    // Resolve the command to get the undoHandler
    const resolved = this.registry.resolve(entry.command);
    if (resolved.ok && resolved.value.undoHandler) {
      const undoResult = await resolved.value.undoHandler(entry.args, entry.result);
      return this.successResult(undoResult, 'normal', entry.command, false);
    }

    return this.successResult({ reverted: historyId }, 'normal', entry.command, false);
  }

  /** Confirma un comando previamente pendiente con su token. */
  async confirm(token: string): Promise<ExecutionResult> {
    const pending = this.pendingConfirms.get(token);
    if (!pending) {
      return this.errorResult(2, 'E_CONFIRM_INVALID', 'Invalid or expired confirmation token', 'normal', '');
    }

    // Check TTL
    const ttl = this.context.config.confirmTTL_ms ?? 300_000;
    const elapsed = Date.now() - pending.createdAt;
    if (elapsed > ttl) {
      this.pendingConfirms.delete(token);
      this.context.auditLogger?.audit('confirm:expired', { command: `${pending.namespace}:${pending.command}`, token });
      return this.errorResult(2, 'E_CONFIRM_EXPIRED', `Confirmation token expired (${Math.round(elapsed / 1000)}s > ${ttl / 1000}s TTL)`, 'normal', `${pending.namespace}:${pending.command}`);
    }

    this.pendingConfirms.delete(token);

    // Execute the stored command
    const { registeredCommand, args } = pending;
    const startTime = Date.now();
    try {
      const data = await this.executeWithTimeout(registeredCommand.handler, args);
      const duration_ms = Date.now() - startTime;
      const command = `${pending.namespace}:${pending.command}`;
      const historyId = this.recordHistory(command, args, data, registeredCommand.definition.reversible);

      this.context.auditLogger?.audit('confirm:executed', { command, token, duration_ms });

      return {
        code: 0,
        success: true,
        data,
        error: null,
        meta: {
          command,
          mode: 'normal',
          duration_ms,
          timestamp: new Date().toISOString(),
          historyId,
          reversible: registeredCommand.definition.reversible,
        },
      };
    } catch (err: any) {
      this.context.auditLogger?.audit('error:handler', { command: `${pending.namespace}:${pending.command}`, error: err.message });
      return this.errorResult(1, 'E_HANDLER_ERROR', err.message || 'Handler execution failed', 'normal', `${pending.namespace}:${pending.command}`);
    }
  }

  // --- Private execution methods ---

  private async executeSingle(cmd: any, input?: any): Promise<ExecutionResult> {
    const startTime = Date.now();
    const fullName = `${cmd.namespace}:${cmd.command}`;

    // 0. RATE LIMIT
    if (!this.checkRateLimit()) {
      this.context.auditLogger?.audit('permission:denied', { command: fullName, reason: 'rate-limit' });
      return this.errorResult(3, 'E_RATE_LIMITED', `Rate limit exceeded: max ${this.context.config.rateLimit!.maxRequests} requests per ${this.context.config.rateLimit!.windowMs}ms`, this.getMode(cmd.flags), fullName);
    }

    // 1. RESOLVE
    const resolved = this.registry.resolve(fullName);
    if (!resolved.ok) {
      return this.errorResult(2, 'E_NOT_FOUND', `Command '${fullName}' not found`, this.getMode(cmd.flags), fullName);
    }

    const registeredCommand = resolved.value;
    const definition = registeredCommand.definition;

    // 2. VALIDATE ARGS
    const validationResult = this.validateArgs(cmd.args.named, definition.args || [], input);
    if (!validationResult.ok) {
      return this.errorResult(1, 'E_INVALID_ARGS', validationResult.message, this.getMode(cmd.flags), fullName);
    }
    const validatedArgs = validationResult.args;

    // 3. CHECK PERMISSIONS
    if (definition.requiredPermissions && definition.requiredPermissions.length > 0) {
      if (!this.hasPermissions(definition.requiredPermissions, validatedArgs)) {
        this.context.auditLogger?.audit('permission:denied', { command: fullName, required: definition.requiredPermissions });
        return this.errorResult(3, 'E_FORBIDDEN', `Permission denied: '${fullName}' requires [${definition.requiredPermissions.join(', ')}]`, this.getMode(cmd.flags), fullName);
      }
    }

    // 4. APPLY MODE
    const mode = this.getMode(cmd.flags);

    if (mode === 'validate') {
      return {
        code: 0,
        success: true,
        data: { valid: true, command: fullName, resolvedArgs: validatedArgs },
        error: null,
        meta: this.buildMeta(fullName, 'validate', Date.now() - startTime, null, definition.reversible),
      };
    }

    if (mode === 'dry-run') {
      return {
        code: 0,
        success: true,
        data: {
          wouldExecute: fullName,
          withArgs: validatedArgs,
          expectedEffect: definition.effect || definition.description,
        },
        error: null,
        meta: this.buildMeta(fullName, 'dry-run', Date.now() - startTime, null, definition.reversible),
      };
    }

    if (mode === 'confirm') {
      const confirmToken = crypto.randomUUID();
      this.pendingConfirms.set(confirmToken, {
        namespace: cmd.namespace,
        command: cmd.command,
        args: validatedArgs,
        registeredCommand,
        createdAt: Date.now(),
      });

      this.context.auditLogger?.audit('confirm:requested', { command: fullName, token: confirmToken });

      return {
        code: 4,
        success: false,
        data: {
          preview: {
            command: fullName,
            args: validatedArgs,
            effect: definition.effect || definition.description,
            reversible: definition.reversible,
          },
          confirmToken,
        },
        error: null,
        meta: this.buildMeta(fullName, 'confirm', Date.now() - startTime, null, definition.reversible),
      };
    }

    // 5. EXECUTE (normal mode)
    try {
      const data = await this.executeWithTimeout(registeredCommand.handler, validatedArgs, input);
      const duration_ms = Date.now() - startTime;

      // 6. RECORD HISTORY
      const historyId = this.recordHistory(fullName, validatedArgs, data, definition.reversible);

      this.context.auditLogger?.audit('command:executed', { command: fullName, duration_ms });

      // 7. RETURN
      return {
        code: 0,
        success: true,
        data,
        error: null,
        meta: this.buildMeta(fullName, 'normal', duration_ms, historyId, definition.reversible),
      };
    } catch (err: any) {
      const duration_ms = Date.now() - startTime;
      if (err.message === 'E_TIMEOUT') {
        this.context.auditLogger?.audit('error:timeout', { command: fullName, timeout_ms: this.context.config.timeout_ms });
        return this.errorResult(1, 'E_TIMEOUT', `Command '${fullName}' timed out after ${this.context.config.timeout_ms}ms`, 'normal', fullName);
      }
      this.context.auditLogger?.audit('error:handler', { command: fullName, error: err.message });
      return this.errorResult(1, 'E_HANDLER_ERROR', err.message || 'Handler execution failed', 'normal', fullName);
    }
  }

  private async executePipeline(pr: any): Promise<PipelineResult> {
    const startTime = Date.now();
    const commands = pr.commands;

    // Check pipeline depth
    if (commands.length > this.context.config.maxPipelineDepth) {
      return {
        code: 1,
        success: false,
        data: null,
        error: { code: 1, type: 'E_PIPELINE_DEPTH', message: `Pipeline exceeds maximum depth of ${this.context.config.maxPipelineDepth} steps` },
        meta: { steps: [], duration_ms: Date.now() - startTime, failedAt: null },
      };
    }

    // Check if first command has dry-run flag (applies to all)
    const globalDryRun = commands[0]?.flags?.dryRun || false;

    const steps: PipelineStep[] = [];
    let previousOutput: any = undefined;

    for (let i = 0; i < commands.length; i++) {
      const cmd = { ...commands[i] };
      if (globalDryRun) {
        cmd.flags = { ...cmd.flags, dryRun: true };
      }

      // Resolve $input references in args
      if (previousOutput !== undefined && cmd.args?.named) {
        cmd.args = { ...cmd.args, named: this.resolveInputRefs(cmd.args.named, previousOutput) };
      }

      const stepStart = Date.now();
      const result = await this.executeSingle(cmd, previousOutput);
      const stepDuration = Date.now() - stepStart;

      steps.push({
        command: `${cmd.namespace}:${cmd.command}`,
        code: result.code,
        duration_ms: stepDuration,
        inputReceived: i > 0,
        mode: this.getMode(cmd.flags),
      });

      if (result.code !== 0) {
        return {
          code: result.code as any,
          success: false,
          data: null,
          error: result.error,
          meta: { steps, duration_ms: Date.now() - startTime, failedAt: i },
        };
      }

      previousOutput = result.data;
    }

    return {
      code: 0,
      success: true,
      data: previousOutput,
      error: null,
      meta: { steps, duration_ms: Date.now() - startTime, failedAt: null },
    };
  }

  private async executeBatch(pr: any): Promise<BatchResult> {
    const startTime = Date.now();
    const commands = pr.commands;

    // Enforce maxBatchSize
    if (commands.length > this.context.config.maxBatchSize) {
      return {
        code: 1,
        success: false,
        results: [],
        meta: { total: commands.length, succeeded: 0, failed: commands.length, duration_ms: Date.now() - startTime },
      };
    }

    if (commands.length === 0) {
      return {
        code: 1,
        success: false,
        results: [],
        meta: { total: 0, succeeded: 0, failed: 0, duration_ms: 0 },
      };
    }

    const results: ExecutionResult[] = [];

    for (const cmd of commands) {
      const result = await this.executeSingle(cmd);
      results.push(result);
    }

    const succeeded = results.filter(r => r.code === 0).length;
    const failed = results.length - succeeded;

    return {
      code: failed > 0 ? 1 : 0,
      success: failed === 0,
      results,
      meta: {
        total: results.length,
        succeeded,
        failed,
        duration_ms: Date.now() - startTime,
      },
    };
  }

  // --- Helper methods ---

  private validateArgs(
    named: Record<string, any>,
    argDefs: any[],
    input?: any
  ): { ok: true; args: Record<string, any> } | { ok: false; message: string } {
    const result: Record<string, any> = {};

    for (const def of argDefs) {
      const rawValue = named[def.name];

      if (rawValue === undefined || rawValue === null) {
        if (def.required) {
          if (def.default !== undefined) {
            result[def.name] = def.default;
          } else {
            return { ok: false, message: `Missing required argument '--${def.name}'` };
          }
        } else {
          if (def.default !== undefined) {
            result[def.name] = def.default;
          }
        }
        continue;
      }

      // Convert type
      const converted = this.convertType(rawValue, def);
      if (converted.error) {
        return { ok: false, message: converted.error };
      }
      result[def.name] = converted.value;
    }

    return { ok: true, args: result };
  }

  private convertType(value: any, def: any): { value?: any; error?: string } {
    // If already the right type (e.g., arrays passed directly)
    if (def.type === 'array') {
      const arr = Array.isArray(value) ? value : [value];
      if (def.constraints) {
        if (def.constraints.minItems !== undefined && arr.length < def.constraints.minItems) {
          return { error: `Argument '--${def.name}' violates constraint: minItems ${def.constraints.minItems}` };
        }
        if (def.constraints.maxItems !== undefined && arr.length > def.constraints.maxItems) {
          return { error: `Argument '--${def.name}' violates constraint: maxItems ${def.constraints.maxItems}` };
        }
      }
      return { value: arr };
    }

    if (def.type === 'string') {
      const str = String(value);
      if (def.constraints) {
        if (def.constraints.minLength !== undefined && str.length < def.constraints.minLength) {
          return { error: `Argument '--${def.name}' violates constraint: minLength ${def.constraints.minLength}` };
        }
        if (def.constraints.maxLength !== undefined && str.length > def.constraints.maxLength) {
          return { error: `Argument '--${def.name}' violates constraint: maxLength ${def.constraints.maxLength}` };
        }
      }
      return { value: str };
    }

    if (def.type === 'int') {
      const num = Number(value);
      if (isNaN(num) || !Number.isInteger(num)) {
        return { error: `Argument '--${def.name}' expects int, got '${value}'` };
      }
      // Check constraints
      if (def.constraints) {
        if (def.constraints.min !== undefined && num < def.constraints.min) {
          return { error: `Argument '--${def.name}' violates constraint: min ${def.constraints.min}` };
        }
        if (def.constraints.max !== undefined && num > def.constraints.max) {
          return { error: `Argument '--${def.name}' violates constraint: max ${def.constraints.max}` };
        }
      }
      return { value: num };
    }

    if (def.type === 'float') {
      const num = Number(value);
      if (isNaN(num)) {
        return { error: `Argument '--${def.name}' expects float, got '${value}'` };
      }
      if (def.constraints) {
        if (def.constraints.min !== undefined && num < def.constraints.min) {
          return { error: `Argument '--${def.name}' violates constraint: min ${def.constraints.min}` };
        }
        if (def.constraints.max !== undefined && num > def.constraints.max) {
          return { error: `Argument '--${def.name}' violates constraint: max ${def.constraints.max}` };
        }
      }
      return { value: num };
    }

    if (def.type === 'bool') {
      if (value === 'true' || value === true) return { value: true };
      if (value === 'false' || value === false) return { value: false };
      return { error: `Argument '--${def.name}' expects bool, got '${value}'` };
    }

    if (def.type === 'date') {
      const date = new Date(value);
      if (isNaN(date.getTime())) {
        return { error: `Argument '--${def.name}' expects date, got '${value}'` };
      }
      return { value: date };
    }

    if (def.type === 'json') {
      try {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        const maxDepth = def.constraints?.maxDepth ?? 10;
        const depth = getJsonDepth(parsed);
        if (depth > maxDepth) {
          return { error: `Argument '--${def.name}' JSON exceeds max depth of ${maxDepth} (found ${depth})` };
        }
        return { value: parsed };
      } catch {
        return { error: `Argument '--${def.name}' expects valid JSON` };
      }
    }

    if (def.type === 'enum') {
      const allowed = def.enumValues || [];
      if (!allowed.includes(value)) {
        return { error: `Argument '--${def.name}' must be one of: ${allowed.join(', ')}` };
      }
      return { value };
    }

    // Unknown type - pass through
    return { value };
  }

  private checkRateLimit(): boolean {
    const config = this.context.config.rateLimit;
    if (!config) return true;

    const now = Date.now();
    const windowStart = now - config.windowMs;
    this.rateLimitTimestamps = this.rateLimitTimestamps.filter(t => t > windowStart);

    if (this.rateLimitTimestamps.length >= config.maxRequests) {
      return false;
    }

    this.rateLimitTimestamps.push(now);
    return true;
  }

  private cleanExpiredConfirms(): void {
    const ttl = this.context.config.confirmTTL_ms ?? 300_000;
    const now = Date.now();
    for (const [token, pending] of this.pendingConfirms) {
      if (now - pending.createdAt > ttl) {
        this.pendingConfirms.delete(token);
      }
    }
  }

  private hasPermissions(required: string[], args?: Record<string, any>): boolean {
    return matchPermissions(this.context.permissions, required, { args });
  }

  private async executeWithTimeout(handler: Function, args: any, input?: any): Promise<any> {
    const timeout = this.context.config.timeout_ms;

    const handlerPromise = handler(args, input);
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('E_TIMEOUT')), timeout);
    });

    return Promise.race([handlerPromise, timeoutPromise]);
  }

  private resolveInputRefs(named: Record<string, any>, input: any): Record<string, any> {
    const resolved: Record<string, any> = {};
    for (const [key, value] of Object.entries(named)) {
      if (typeof value === 'string' && value.startsWith('$input.')) {
        const field = value.substring('$input.'.length);
        resolved[key] = input?.[field] !== undefined ? String(input[field]) : value;
      } else {
        resolved[key] = value;
      }
    }
    return resolved;
  }

  private getMode(flags: any): 'normal' | 'dry-run' | 'validate' | 'confirm' {
    if (flags?.validate) return 'validate';
    if (flags?.dryRun) return 'dry-run';
    if (flags?.confirm) return 'confirm';
    return 'normal';
  }

  private recordHistory(command: string, args: any, result: any, reversible: boolean): string | null {
    if (!this.context.config.enableHistory) return null;
    const id = crypto.randomUUID();
    this.context.history.append({
      id,
      command,
      args: maskSecrets(args),
      result,
      reversible,
      executedAt: new Date().toISOString(),
    });
    return id;
  }

  private buildMeta(command: string, mode: ExecutionMeta['mode'], duration_ms: number, historyId: string | null, reversible: boolean): ExecutionMeta {
    return { command, mode, duration_ms, timestamp: new Date().toISOString(), historyId, reversible };
  }

  private successResult(data: any, mode: ExecutionMeta['mode'], command: string, reversible: boolean): ExecutionResult {
    return {
      code: 0,
      success: true,
      data,
      error: null,
      meta: this.buildMeta(command, mode, 0, null, reversible),
    };
  }

  private errorResult(code: 1 | 2 | 3 | 4, type: string, message: string, mode: ExecutionMeta['mode'], command: string): ExecutionResult {
    return {
      code,
      success: false,
      data: null,
      error: { code, type, message },
      meta: this.buildMeta(command, mode, 0, null, false),
    };
  }

  /** Revoca un token de confirmacion pendiente. Retorna true si se revoco, false si no existia. */
  revokeConfirm(token: string): boolean {
    const pending = this.pendingConfirms.get(token);
    if (!pending) {
      return false;
    }
    this.pendingConfirms.delete(token);
    this.context.auditLogger?.audit('confirm:expired', { command: `${pending.namespace}:${pending.command}`, token, reason: 'revoked' });
    return true;
  }

  /** Revoca todos los tokens de confirmacion pendientes. Retorna el numero de tokens revocados. */
  revokeAllConfirms(): number {
    const count = this.pendingConfirms.size;
    this.pendingConfirms.clear();
    return count;
  }
}

/** Calcula la profundidad maxima de un valor JSON. */
function getJsonDepth(value: any, current: number = 0): number {
  if (value === null || typeof value !== 'object') return current;
  if (Array.isArray(value)) {
    if (value.length === 0) return current + 1;
    return Math.max(...value.map(item => getJsonDepth(item, current + 1)));
  }
  const keys = Object.keys(value);
  if (keys.length === 0) return current + 1;
  return Math.max(...keys.map(k => getJsonDepth(value[k], current + 1)));
}
