/**
 * @module executor
 * @description Motor de ejecucion central de Agent Shell.
 *
 * Recibe un ParseResult del Parser, resuelve el handler via Command Registry,
 * aplica el pipeline de ejecucion (validacion, permisos, modo, ejecucion,
 * historial) y retorna una respuesta estandarizada.
 */

import type { ExecutionResult, ExecutionError, ExecutionMeta, BatchResult, PipelineResult, PipelineStep, ExecutionContext, ExecutorRegistry } from './types.js';
import { maskSecrets } from '../security/secret-patterns.js';
import { matchPermissions } from '../security/permission-matcher.js';
import { PendingConfirmStore } from '../shared/pending-confirm-store.js';
import { SlidingWindowRateLimiter } from '../shared/sliding-window-rate-limiter.js';
import { ENUM_TYPE_PATTERN, ARRAY_TYPE_PATTERN, parseEnumValues, parseConstraints } from '../command-registry/types.js';

export { type ExecutionResult, type ExecutionError, type ExecutionMeta, type BatchResult, type PipelineResult, type PipelineStep, type ExecutionContext, type ExecutorConfig, type HistoryStore, type ExecutorRegistry } from './types.js';

/** Pending confirm tokens storage. */
interface PendingConfirm {
  namespace: string;
  command: string;
  args: Record<string, any>;
  registeredCommand: any;
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
  private registry: ExecutorRegistry;
  private context: ExecutionContext;
  // Shared with Core's own confirm-token handling
  // (src/shared/pending-confirm-store.ts) so a future TTL/eviction fix
  // only has to happen once — found this exact pattern hand-duplicated
  // between the two engines while auditing for tech debt.
  private pendingConfirms: PendingConfirmStore<PendingConfirm>;
  private rateLimiter: SlidingWindowRateLimiter | null;

  constructor(registry: ExecutorRegistry, context: ExecutionContext) {
    this.registry = registry;
    this.context = context;
    this.pendingConfirms = new PendingConfirmStore(context.config.confirmTTL_ms ?? 300_000);
    this.rateLimiter = context.config.rateLimit
      ? new SlidingWindowRateLimiter({
          maxRequests: context.config.rateLimit.maxRequests,
          windowMs: context.config.rateLimit.windowMs,
          burstSize: context.config.rateLimit.burstSize,
          burstWindowMs: context.config.rateLimit.burstWindowMs,
        })
      : null;
  }

  /** Ejecuta un ParseResult (single, pipeline, o batch). */
  async execute(parseResult: any): Promise<ExecutionResult | BatchResult | PipelineResult> {
    this.cleanExpiredConfirms();

    if (parseResult.type === 'batch') {
      return this.executeBatch(parseResult);
    }
    if (parseResult.type === 'pipeline') {
      return this.executePipeline(parseResult);
    }
    return this.executeSingle(parseResult.commands[0]);
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
    const resolved = this.pendingConfirms.resolve(token);
    if (resolved.status === 'not_found') {
      return this.errorResult(2, 'E_CONFIRM_INVALID', 'Invalid or expired confirmation token', 'normal', '');
    }
    if (resolved.status === 'expired') {
      const pending = resolved.payload;
      const command = `${pending.namespace}:${pending.command}`;
      // Audit gets the full detail (command, age, TTL) — internal/operator
      // visibility, not returned to the caller. The response itself now
      // matches Core's equivalent path exactly (src/core/index.ts's
      // resolveConfirmation): a caller resolving a foreign/stale token
      // learns nothing about WHAT was pending or WHEN it was created,
      // same as an outright bogus token. Previously this branch leaked
      // both — an oracle a not_found token never had.
      this.context.auditLogger?.audit('confirm:expired', { command, token, ageMs: resolved.ageMs, ttlMs: resolved.ttlMs });
      return this.errorResult(2, 'E_CONFIRM_EXPIRED', 'Invalid or expired confirmation token', 'normal', '');
    }

    const pending = resolved.payload;

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
    // `params` is the canonical field CommandRegistry/command-builder produce
    // (see CommandDefinition in src/command-registry/types.ts); `args` is
    // kept as a fallback for registries that define it directly. Positional
    // args are mapped onto their param name first, mirroring the same
    // mapping Core does, so `workspace:cd src/server` resolves identically
    // through either engine.
    const argDefs = definition.params || definition.args || [];
    const mergedNamed = { ...cmd.args.named };
    if (Array.isArray(cmd.args.positional)) {
      argDefs.forEach((def: any, idx: number) => {
        if (cmd.args.positional[idx] !== undefined && !(def.name in mergedNamed)) {
          mergedNamed[def.name] = cmd.args.positional[idx];
        }
      });
    }
    const validationResult = this.validateArgs(mergedNamed, argDefs, input);
    if (!validationResult.ok) {
      return this.errorResult(1, 'E_INVALID_ARGS', validationResult.message, this.getMode(cmd.flags), fullName);
    }
    const validatedArgs = validationResult.args;

    // 3. CHECK PERMISSIONS
    if (definition.requiredPermissions && definition.requiredPermissions.length > 0) {
      if (!this.hasPermissions(definition.requiredPermissions, validatedArgs)) {
        // Audit gets the full required-permissions list — internal/operator
        // visibility. The caller-facing message now matches Core's
        // equivalent path (src/core/index.ts: `Permission denied: ns:cmd`)
        // exactly: it confirms the command exists and is denied, without
        // disclosing the RBAC permission-string vocabulary that would fix
        // it — a caller iterating denied commands could otherwise
        // reconstruct that taxonomy one denial at a time.
        // Defense-in-depth (ronda 43 del audit, HIGH): AuditLogger.audit()
        // ya clona `data` internamente, pero pasar una copia superficial
        // aca tambien evita depender de esa unica capa — `definition` es
        // el objeto que devuelve CommandRegistry.resolve()/.get(), que NO
        // clona (a diferencia de register()), asi que sin esto cualquier
        // consumidor de este array seguiria compartiendo la referencia
        // viva del registry.
        this.context.auditLogger?.audit('permission:denied', { command: fullName, required: [...definition.requiredPermissions] });
        return this.errorResult(3, 'E_FORBIDDEN', `Permission denied: ${fullName}`, this.getMode(cmd.flags), fullName);
      }
    }

    // 4. APPLY MODE
    // definition.requiresConfirmation (documented in contracts/
    // command-registry.md as "Si requiere --confirm por defecto") upgrades
    // 'normal' mode to 'confirm' even when the caller never passed
    // --confirm — command authors opt a command into always previewing
    // first. validate/dry-run (more specific, explicitly requested by the
    // caller) still take priority, same ordering as before.
    let mode = this.getMode(cmd.flags);
    if (mode === 'normal' && definition.requiresConfirmation) {
      mode = 'confirm';
    }

    // Regresion (ronda 39 del audit, CRITICAL): validate/dry-run/confirm
    // echoaban validatedArgs SIN pasar por maskSecrets() — a diferencia
    // del command STRING crudo (ya masqueado en recordHistory), los args
    // tipo-convertidos nunca pasaban por ningun filtro. maskSecrets()
    // sigue sin detectar un valor arbitrario sin forma reconocible bajo
    // una key generica como --value (limitacion preexistente y
    // documentada) — pero SI cubre Bearer/JWT/AWS-key/password=/
    // hex-secret/url-credentials, la misma cobertura que ya tiene el
    // command string.
    if (mode === 'validate') {
      return {
        code: 0,
        success: true,
        data: { valid: true, command: fullName, resolvedArgs: maskSecrets(validatedArgs) },
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
          withArgs: maskSecrets(validatedArgs),
          expectedEffect: definition.effect || definition.description,
        },
        error: null,
        meta: this.buildMeta(fullName, 'dry-run', Date.now() - startTime, null, definition.reversible),
      };
    }

    if (mode === 'confirm') {
      // Regresion (ronda 63 del audit, HIGH): mismo fix que Core — ver el
      // comentario de MAX_PENDING_PER_SESSION en pending-confirm-store.ts.
      const confirmToken = this.pendingConfirms.create({
        namespace: cmd.namespace,
        command: cmd.command,
        args: validatedArgs,
        registeredCommand,
      }, this.context.sessionId);

      this.context.auditLogger?.audit('confirm:requested', { command: fullName, token: confirmToken });

      return {
        code: 4,
        success: false,
        data: {
          preview: {
            command: fullName,
            // maskSecrets() on the PREVIEW copy only — the stashed
            // pendingConfirms entry above keeps the real, unmasked
            // validatedArgs, since the actual handler invocation on
            // confirm needs the real value. maskSecrets() returns a new
            // object, never mutates its input.
            args: maskSecrets(validatedArgs),
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

    // Execute commands sequentially, in order (index 0, 1, 2...) — per contract v1
    const results: ExecutionResult[] = [];
    for (const cmd of commands) {
      try {
        results.push(await this.executeSingle(cmd));
      } catch (err) {
        results.push(this.errorResult(1, 'E_HANDLER_ERROR', (err as Error)?.message || 'Unknown error', 'normal', ''));
      }
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
        if (def.default !== undefined) {
          // Regresion (ronda 59 del audit, MEDIUM): mismo fix que
          // Core.convertArgTypes — `def.default` se aplicaba directo sin
          // pasar por convertType(), dejando que un default mal tipado
          // (ej. optionalParam('limit', 'int', 'not-a-number')) derrote en
          // silencio la garantia de tipo. `null` se deja pasar sin
          // convertir (mismo motivo que en Core: sentinel de "sin valor"
          // usado por varios skills shipeados con type 'json').
          if (def.default === null) {
            result[def.name] = null;
          } else {
            const convertedDefault = this.convertType(def.default, def);
            if (convertedDefault.error) {
              return { ok: false, message: `Invalid default for '--${def.name}': ${convertedDefault.error}` };
            }
            result[def.name] = convertedDefault.value;
          }
        } else if (def.required) {
          return { ok: false, message: `Missing required argument '--${def.name}'` };
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

  // Regresion (ronda 54 del audit, MEDIUM-HIGH): esta funcion comparaba
  // `def.type === 'array'`/`'enum'` (tipos literales que ningun param real
  // tiene — el command-builder publico solo produce 'array<T>'/
  // 'enum(a,b,c)', ver ARRAY_TYPE_PATTERN/ENUM_TYPE_PATTERN) y leia
  // `def.constraints.min` etc. directamente sobre un STRING
  // ('min:0,max:100', el unico formato que ParamBuilder.constraints()
  // produce) — un string no tiene esas propiedades. Las tres ramas nunca
  // disparaban para ningun param declarado via el builder publico:
  // array/enum caian a "Unknown type - pass through" sin wrappear/
  // validar, y CUALQUIER tipo con constraints las ignoraba en silencio.
  // parseConstraints()/parseEnumValues()/*_TYPE_PATTERN
  // (command-registry/types.ts) son ahora la unica fuente de verdad.
  private convertType(value: any, def: any): { value?: any; error?: string } {
    const constraints = parseConstraints(def.constraints);

    // If already the right type (e.g., arrays passed directly)
    if (def.type === 'array' || ARRAY_TYPE_PATTERN.test(def.type)) {
      const arr = Array.isArray(value) ? value : [value];
      if (constraints.minItems !== undefined && arr.length < constraints.minItems) {
        return { error: `Argument '--${def.name}' violates constraint: minItems ${constraints.minItems}` };
      }
      if (constraints.maxItems !== undefined && arr.length > constraints.maxItems) {
        return { error: `Argument '--${def.name}' violates constraint: maxItems ${constraints.maxItems}` };
      }
      return { value: arr };
    }

    if (def.type === 'string') {
      const str = String(value);
      if (constraints.minLength !== undefined && str.length < constraints.minLength) {
        return { error: `Argument '--${def.name}' violates constraint: minLength ${constraints.minLength}` };
      }
      if (constraints.maxLength !== undefined && str.length > constraints.maxLength) {
        return { error: `Argument '--${def.name}' violates constraint: maxLength ${constraints.maxLength}` };
      }
      return { value: str };
    }

    if (def.type === 'int') {
      const num = Number(value);
      if (isNaN(num) || !Number.isInteger(num)) {
        return { error: `Argument '--${def.name}' expects int, got '${value}'` };
      }
      // Check constraints
      if (constraints.min !== undefined && num < constraints.min) {
        return { error: `Argument '--${def.name}' violates constraint: min ${constraints.min}` };
      }
      if (constraints.max !== undefined && num > constraints.max) {
        return { error: `Argument '--${def.name}' violates constraint: max ${constraints.max}` };
      }
      return { value: num };
    }

    if (def.type === 'float') {
      const num = Number(value);
      if (isNaN(num)) {
        return { error: `Argument '--${def.name}' expects float, got '${value}'` };
      }
      if (constraints.min !== undefined && num < constraints.min) {
        return { error: `Argument '--${def.name}' violates constraint: min ${constraints.min}` };
      }
      if (constraints.max !== undefined && num > constraints.max) {
        return { error: `Argument '--${def.name}' violates constraint: max ${constraints.max}` };
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
        const maxDepth = constraints.maxDepth ?? 10;
        const depth = getJsonDepth(parsed);
        if (depth > maxDepth) {
          return { error: `Argument '--${def.name}' JSON exceeds max depth of ${maxDepth} (found ${depth})` };
        }
        return { value: parsed };
      } catch {
        return { error: `Argument '--${def.name}' expects valid JSON` };
      }
    }

    if (def.type === 'enum' || ENUM_TYPE_PATTERN.test(def.type)) {
      const allowed = def.enumValues || parseEnumValues(def.type);
      if (!allowed.includes(value)) {
        return { error: `Argument '--${def.name}' must be one of: ${allowed.join(', ')}` };
      }
      return { value };
    }

    // Unknown type - pass through
    return { value };
  }

  private checkRateLimit(): boolean {
    if (!this.rateLimiter) return true;
    return this.rateLimiter.tryAcquire();
  }

  private cleanExpiredConfirms(): void {
    const swept = this.pendingConfirms.sweepExpired();
    for (const { token, payload, ageMs } of swept) {
      this.context.auditLogger?.audit('confirm:expired', { command: `${payload.namespace}:${payload.command}`, token, reason: 'ttl-sweep', ageMs });
    }
  }

  private hasPermissions(required: string[], args?: Record<string, any>): boolean {
    return matchPermissions(this.context.permissions, required, { args });
  }

  private async executeWithTimeout(handler: Function, args: any, input?: any): Promise<any> {
    const timeout = this.context.config.timeout_ms;

    // Handlers that accept a 3rd (HandlerContext) arg can read sessionId
    // and/or cooperatively stop work once the timeout fires; handlers that
    // ignore it behave exactly as before. Cancellation does not force-kill
    // non-cooperative handlers (JS has no such primitive), but it gives the
    // executor a real cancellation channel instead of none at all.
    const controller = new AbortController();
    let timerId: ReturnType<typeof setTimeout>;
    const handlerPromise = Promise.resolve(handler(args, input, { sessionId: this.context.sessionId, signal: controller.signal }));
    const timeoutPromise = new Promise((_, reject) => {
      timerId = setTimeout(() => {
        controller.abort();
        reject(new Error('E_TIMEOUT'));
      }, timeout);
    });

    return Promise.race([handlerPromise, timeoutPromise]).finally(() => {
      clearTimeout(timerId!);
    });
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
      args: maskSecrets(redactSecretValueField(command, args)),
      result: maskSecrets(redactSecretValueField(command, result)),
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
    const pending = this.pendingConfirms.revoke(token);
    if (!pending) {
      return false;
    }
    this.context.auditLogger?.audit('confirm:expired', { command: `${pending.namespace}:${pending.command}`, token, reason: 'revoked' });
    return true;
  }

  /** Revoca todos los tokens de confirmacion pendientes. Retorna el numero de tokens revocados. */
  revokeAllConfirms(): number {
    return this.pendingConfirms.revokeAll();
  }
}

/**
 * Regresion (ronda 63 del audit, HIGH): maskSecrets() solo redacta valores
 * con "forma" de secreto conocida — un valor arbitrario sin esa forma (ej.
 * 'hunter2') bajo la key `value` de secret:set/secret:get pasaba en texto
 * plano a recordHistory(), pese a que ese campo es ESTRUCTURALMENTE
 * material secreto para esos 2 comandos especificos (secret:set's arg
 * `value`, secret:get's resultado `value`) — a diferencia de cualquier
 * otro campo `value` generico del resto del sistema. Fuerza el redactado
 * de esa key ANTES de que maskSecrets() intente su deteccion por patron.
 */
function redactSecretValueField(command: string, obj: any): any {
  if (command !== 'secret:set' && command !== 'secret:get') return obj;
  if (obj && typeof obj === 'object' && !Array.isArray(obj) && 'value' in obj) {
    return { ...obj, value: '[REDACTED]' };
  }
  return obj;
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
