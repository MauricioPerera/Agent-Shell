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
import { matchPermissions, isVisibleToAgent } from '../security/permission-matcher.js';
import { maskSecrets } from '../security/secret-patterns.js';
import { resolveAgentPermissions } from './agent-profiles.js';
import { PendingConfirmStore } from '../shared/pending-confirm-store.js';
import { SlidingWindowRateLimiter } from '../shared/sliding-window-rate-limiter.js';
import type { AuditLogger } from '../security/audit-logger.js';
import type { ParseResult, ParsedCommand, ParseError } from '../parser/index.js';
import type { CoreResponse, CoreConfig, CoreRegistry, CoreVectorIndex, CoreContextStore, LogEntry } from './types.js';

export { Core };
export { resolveAgentPermissions, AGENT_PROFILES } from './agent-profiles.js';
export type { AgentProfile } from './agent-profiles.js';
export type { CoreResponse, CoreConfig, CoreRegistry, CoreVectorIndex, CoreContextStore } from './types.js';

const LOG_LEVELS: Record<string, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

/** Calcula la profundidad maxima de un valor JSON. Ported from executor/index.ts's getJsonDepth. */
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
  batch [cmd1, cmd2, cmd3]         Execute multiple commands sequentially

== State ==
  context                          View current context
  context:set key value            Store value in context
  context:get key                  Get value from context

== History ==
  history                          View command history
  confirm <token>                  Execute a command previously requested with --confirm

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
/** A command resolved and permission-checked, stashed pending a confirm token. */
interface PendingConfirm {
  namespace: string;
  command: string;
  registeredCmd: any;
  handlerArgs: Record<string, any>;
  sessionId?: string;
}

class Core {
  private readonly config: CoreConfig;
  private readonly registry: CoreRegistry;
  private readonly vectorIndex: CoreVectorIndex | null;
  private readonly contextStore: CoreContextStore | null;
  private readonly auditLogger: AuditLogger | null;
  private readonly agentPermissions: string[] | null;
  private readonly logger: CoreLogger;
  private readonly history: Array<{ command: string; code: number; timestamp: string }> = [];
  private static readonly MAX_HISTORY = 10_000;
  private rateLimiter: SlidingWindowRateLimiter | null;
  // --confirm support: HELP_TEXT documents 'code 4: Requires confirmation'
  // and a 'confirm <token>' builtin, but executeCommand used to just tag
  // mode='confirm' and run the handler anyway — this store is what actually
  // makes the two-step preview-then-confirm workflow real. Not scoped by
  // sessionId (mirrors Executor's own equivalent store, which has no
  // session concept at all): the token itself is an unguessable UUID, so
  // the risk session-scoping would close (a caller guessing another
  // caller's identifier) doesn't apply the same way it did for
  // workspace:* state. Shared with Executor's own confirm-token handling
  // (src/shared/pending-confirm-store.ts) so a future TTL/eviction fix
  // only has to happen once.
  private readonly pendingConfirms: PendingConfirmStore<PendingConfirm>;

  constructor(config: CoreConfig) {
    this.config = config;
    this.pendingConfirms = new PendingConfirmStore(config.confirmTTL_ms ?? 300_000);
    this.rateLimiter = config.rateLimit
      ? new SlidingWindowRateLimiter({
          maxRequests: config.rateLimit.maxRequests ?? 120,
          windowMs: config.rateLimit.windowMs ?? 60_000,
          burstSize: config.rateLimit.burstSize ?? 20,
          burstWindowMs: 1000,
        })
      : null;
    this.registry = config.registry;
    this.vectorIndex = config.vectorIndex || null;
    this.contextStore = config.contextStore || null;
    this.auditLogger = config.auditLogger || null;
    this.agentPermissions = resolveAgentPermissions(config);
    this.logger = new CoreLogger(config.logging);
  }

  private checkRateLimit(): boolean {
    if (!this.rateLimiter) return true;
    return this.rateLimiter.tryAcquire();
  }

  /**
   * @param controller - Aborted when the timeout fires, so a running handler
   *   that reads the signal from its {@link HandlerContext} can cooperatively
   *   stop instead of running to completion after the caller already got a
   *   timeout response — mirrors Executor's existing timeout cancellation.
   */
  private withTimeout<T>(promise: Promise<T>, ms: number, label: string, controller?: AbortController): Promise<T> {
    let timerId: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timerId = setTimeout(() => {
        controller?.abort();
        reject(new Error(`${label} timed out after ${ms}ms`));
      }, ms);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => {
      clearTimeout(timerId);
    });
  }

  /**
   * Invokes a command handler, racing it against `timeouts.executor_ms`
   * when configured — a per-command budget separate from (and nested
   * inside) `exec()`'s single request-wide `timeouts.global_ms`.
   *
   * Regresion (ronda 37 del audit): CoreConfig.timeouts.executor_ms was
   * declared in core/types.ts but never read anywhere — Core only had the
   * one blunt request-wide global timeout wrapping parse+resolve+every
   * pipeline/batch step+jq+format+pagination as a single unit (`exec()`
   * above). Executor times out EACH handler invocation individually via
   * its own executeWithTimeout() — a single hung command in a batch/
   * pipeline killed the ENTIRE Core request (discarding any already-
   * succeeded results) instead of failing just that one command. Not
   * enabled by default (undefined = no per-command cap, same as before
   * this fix) — only wired when an operator explicitly opts in via
   * `timeouts.executor_ms`, to avoid silently changing behavior for
   * existing deployments that only ever relied on global_ms.
   *
   * Composes the per-command AbortController with the outer `signal`
   * (Core's own request-wide one) manually rather than via `AbortSignal.
   * any()` — that API needs Node 20.3+, and this package's `engines`
   * field supports Node >=18.
   */
  private async invokeHandler(
    handler: Function,
    args: any,
    input: any,
    sessionId: string | undefined,
    outerSignal: AbortSignal | undefined,
    label: string,
  ): Promise<any> {
    const perCommandTimeout = this.config.timeouts?.executor_ms;
    if (!perCommandTimeout) {
      return handler(args, input, { sessionId, signal: outerSignal });
    }

    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    if (outerSignal?.aborted) controller.abort();
    outerSignal?.addEventListener('abort', onOuterAbort);

    let timerId: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timerId = setTimeout(() => {
        controller.abort();
        reject(new Error(`${label} timed out after ${perCommandTimeout}ms`));
      }, perCommandTimeout);
    });

    // No dedicated 'error:timeout' audit here (unlike exec()'s outer
    // global-timeout catch) — the timeout Error thrown below propagates to
    // each call site's own error handling, which already converts it into
    // the normal `_error` shape and lets execInternal's generic block
    // audit it as 'error:handler' (message still says "timed out after
    // Xms"). A second, dedicated audit call here would double the event
    // for the same failure.
    try {
      return await Promise.race([
        Promise.resolve(handler(args, input, { sessionId, signal: controller.signal })),
        timeoutPromise,
      ]);
    } finally {
      clearTimeout(timerId!);
      outerSignal?.removeEventListener('abort', onOuterAbort);
    }
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
  /**
   * @param sessionId - Scopes per-session skill state (currently just
   *   workspace:*'s cwd/env/history) to this caller. Undefined means "the
   *   shared default session" — correct for stdio (one agent per process,
   *   no cross-tenant risk) and any direct/library caller that predates
   *   this parameter. HttpSseTransport always supplies one, since it's the
   *   transport where a single Core can serve multiple concurrent callers.
   */
  async exec(cmd: string, sessionId?: string): Promise<CoreResponse> {
    const startTime = Date.now();
    let mode = 'execute';

    // Rate limit check
    if (!this.checkRateLimit()) {
      this.auditLogger?.audit('permission:denied', { command: cmd.slice(0, 50), reason: 'rate-limit' }, sessionId);
      return this.buildResponse(3, null, 'Rate limit exceeded', cmd.slice(0, 50), mode, startTime);
    }

    // Input size pre-check
    const maxLen = this.config.maxInputLength ?? 10_000;
    if (cmd.length > maxLen) {
      return this.buildResponse(1, null, `Input exceeds maximum length of ${maxLen} characters`, cmd.slice(0, 50) + '...', mode, startTime);
    }

    // Wrap in global timeout
    const globalTimeout = this.config.timeouts?.global_ms ?? 30_000;
    const controller = new AbortController();
    try {
      return await this.withTimeout(this.execInternal(cmd, startTime, sessionId, controller.signal), globalTimeout, 'Request', controller);
    } catch (err: any) {
      this.auditLogger?.audit('error:timeout', { command: cmd.slice(0, 50), timeout_ms: globalTimeout }, sessionId);
      return this.buildResponse(1, null, err.message || 'Request timed out', cmd.slice(0, 50), mode, startTime);
    }
  }

  private async execInternal(cmd: string, startTime: number, sessionId?: string, signal?: AbortSignal): Promise<CoreResponse> {
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

      // Proactive sweep of stale pending-confirm tokens — skipped
      // specifically when THIS request is itself resolving a confirm token
      // (bare `confirm <token>`). The sweep and resolveConfirmation() use
      // the same Date.now()-based staleness check, and the sweep always
      // runs first in this single-threaded call chain, so leaving it
      // unconditional would make it impossible for resolveConfirmation()
      // to ever observe (and audit) an 'expired' token itself — it'd
      // always already be gone. resolveConfirmation() consumes (deletes)
      // whatever it resolves regardless of outcome, so skipping the sweep
      // here doesn't leave anything unswept for longer than one request.
      const isConfirmResolution = firstCmd?.namespace === null && firstCmd?.command === 'confirm';
      if (!isConfirmResolution) {
        this.cleanExpiredConfirms();
      }

      // Regresion (ronda 37 del audit): executePipeline() ahora audita cada
      // paso individualmente bajo SU PROPIO namespace:command (ver dentro
      // de ese metodo) — el bloque generico de abajo, que etiqueta con el
      // string COMPLETO del pipeline truncado a 100 chars, quedaria
      // duplicando esa señal con una etiqueta mucho menos precisa (ambigua
      // sobre CUAL paso de una cadena larga fallo/tuvo exito). Se salta
      // SOLO el auditLogger.audit (no el recordHistory, que sigue
      // grabando una unica entrada para el pipeline completo, igual que
      // ya hace executeBatch con el string del batch).
      const isPipeline = result.type === 'pipeline';

      // Route based on parse result type
      let data: any;

      if (result.type === 'pipeline') {
        data = await this.executePipeline(result.commands, sessionId, signal);
      } else if (result.type === 'batch') {
        data = await this.executeBatch(result.commands, sessionId, signal);
        // Batch code: 0 if all succeeded, 1 if any failed
        const batchFailed = data.some((r: any) => r.code !== 0);
        const code = batchFailed ? 1 : 0;
        this.recordHistory(cmd, code);
        return this.buildResponse(code, data, null, cmd, mode, startTime);
      } else {
        // Single command
        data = await this.executeCommand(firstCmd, sessionId, signal);
      }

      // Handle error responses from executeCommand
      if (data && typeof data === 'object' && '_error' in data) {
        const { code, error } = data._error;
        // Regresion (ronda 31 del audit): resolveConfirmation() ya audita
        // sus propios fallos (confirm:expired para token vencido; ver
        // tambien su rama de handler-failure) bajo el nombre REAL del
        // comando confirmado — este bloque generico volvia a auditar la
        // MISMA resolucion una segunda vez, etiquetada con el string
        // literal "confirm <token>" en vez del comando real. Se salta
        // aca (no para el resto de comandos/pipelines/batch, que no
        // tienen ningun otro punto de auditoria propio).
        if (!isConfirmResolution) {
          if (!isPipeline) {
            // code 3 is reserved exclusively for permission/rate-limit denial
            // across Core (see HELP_TEXT: "code 3: Permission denied / rate
            // limit") — every other code here is a lookup/handler failure.
            this.auditLogger?.audit(code === 3 ? 'permission:denied' : 'error:handler', { command: cmd.slice(0, 100), code, error }, sessionId);
          }
          this.recordHistory(cmd, code);
        }
        return this.buildResponse(code, null, error, cmd, mode, startTime);
      }

      // Handle --confirm: not an error, but not a completed execution either.
      // code 4 (documented in HELP_TEXT) signals "pending" so callers can
      // tell it apart from a normal success without inspecting response
      // shape. Skips jq/format/pagination below — those apply to a real
      // result, not a preview of one.
      if (data && typeof data === 'object' && data.confirmRequired === true) {
        // `mode` was set from flags.confirm above; a command auto-upgraded
        // to the confirm flow via requiresConfirmation (no --confirm flag
        // passed) would otherwise still report meta.mode: 'execute'.
        mode = 'confirm';
        this.recordHistory(cmd, 4);
        return this.buildResponse(4, data, null, cmd, mode, startTime);
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

      // Same reasoning as the error branch above: resolveConfirmation()
      // already recorded history and audited confirm:executed under the
      // real resolved command name — don't double it here under the
      // literal "confirm <token>" string.
      if (!isConfirmResolution) {
        this.recordHistory(cmd, 0);
        if (!isPipeline) {
          this.auditLogger?.audit('command:executed', { command: cmd.slice(0, 100), duration_ms: Date.now() - startTime }, sessionId);
        }
      }
      return this.buildResponse(0, data, null, cmd, mode, startTime);
    } catch (err: any) {
      this.auditLogger?.audit('error:handler', { command: cmd.slice(0, 100), error: err.message }, sessionId);
      return this.buildResponse(1, null, err.message || 'Unknown error', cmd, mode, startTime);
    }
  }

  // --- Private methods ---

  private async executeCommand(parsed: ParsedCommand, sessionId?: string, signal?: AbortSignal): Promise<any> {
    const { namespace, command, args, flags } = parsed;

    // Builtin commands (namespace is null)
    if (namespace === null) {
      // 'history' and 'context' expose everything unconditionally (unlike
      // 'search'/'describe', which already filter their own results
      // per-item by agentPermissions) — gate them the same way a
      // registered command's requiredPermissions would, using the exact
      // permission strings AGENT_PROFILES already lists for them.
      if ((command === 'history' || command === 'context') && this.agentPermissions) {
        if (!matchPermissions(this.agentPermissions, [command])) {
          return { _error: { code: 3, error: `Permission denied: ${command}` } };
        }
      }
      return this.executeBuiltin(command, args, signal, sessionId);
    }

    // Context namespace special handling
    if (namespace === 'context') {
      if (this.agentPermissions && !matchPermissions(this.agentPermissions, ['context'])) {
        return { _error: { code: 3, error: `Permission denied: context:${command}` } };
      }
      return this.executeContext(command, args, sessionId);
    }

    // Lookup in registry
    const lookupResult = this.registry.get(namespace, command);
    if (!lookupResult.ok) {
      return { _error: { code: 2, error: `Command not found: ${namespace}:${command}` } };
    }
    // Flatten: merge definition fields with handler for backward compat
    const registeredCmd = { ...lookupResult.value.definition, handler: lookupResult.value.handler };

    // Check agent permissions
    if (!isVisibleToAgent(registeredCmd.requiredPermissions, this.agentPermissions)) {
      return { _error: { code: 3, error: `Permission denied: ${namespace}:${command}` } };
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

    // Convert declared param types and check constraints (min/max/enum/
    // etc.) — unconditional, same as Executor: a bad type/constraint is an
    // error regardless of mode, not just under --validate.
    const typeCheck = registeredCmd.params ? this.convertArgTypes(handlerArgs, registeredCmd.params) : { ok: true as const, args: handlerArgs };
    if (!typeCheck.ok) {
      return { _error: { code: 1, error: typeCheck.error } };
    }
    const typedArgs = typeCheck.args;

    // Validate mode: check required params (types already checked above)
    if (flags.validate) {
      return this.validateCommand(registeredCmd, args, typedArgs);
    }

    // Dry-run mode: return simulated data without calling handler
    if (flags.dryRun) {
      return { dryRun: true, command: `${namespace}:${command}`, args: typedArgs };
    }

    // Confirm mode: stash the resolved handler+args (already permission-
    // checked above) and return a preview + token instead of running it —
    // the caller must re-submit via the `confirm <token>` builtin to
    // actually execute. Only single commands and batch items go through
    // this method; executePipeline has its own separate loop with the same
    // check applied to each step (see executePipeline()) — dryRun/validate
    // are NOT checked there, only confirm, since dry-run/validate semantics
    // don't obviously generalize to a multi-step chain (a pre-existing,
    // narrower gap left out of scope here).
    //
    // registeredCmd.requiresConfirmation (documented in contracts/
    // command-registry.md as "Si requiere --confirm por defecto") makes
    // this trigger even when the CALLER never passed --confirm — command
    // authors (e.g. file:delete, tagged 'dangerous') opt a command into
    // always previewing first. Before this, the field was persisted
    // end-to-end (command-builder, sqlite-registry-adapter) but nothing
    // ever read it: only the caller-supplied --confirm flag had any effect.
    if (flags.confirm || registeredCmd.requiresConfirmation) {
      return this.requestConfirmation(namespace, command, registeredCmd, typedArgs, sessionId);
    }

    // Execute handler. Every skill handler follows the { success, data, error }
    // convention — on failure, propagate it as the same _error shape the caller
    // (execInternal) already checks for lookup/permission failures, instead of
    // silently discarding `error` and reporting success with null data.
    // invokeHandler() races it against timeouts.executor_ms when configured
    // (ronda 37 del audit) — a timeout throws, caught below and converted to
    // the same _error shape a business-logic failure already uses.
    let result: any;
    try {
      result = await this.invokeHandler(registeredCmd.handler, typedArgs, null, sessionId, signal, `${namespace}:${command}`);
    } catch (err: any) {
      return { _error: { code: 1, error: err.message || `Command failed: ${namespace}:${command}` } };
    }
    if (result && typeof result === 'object' && result.success === false) {
      return { _error: { code: 1, error: result.error || `Command failed: ${namespace}:${command}` } };
    }
    return result.data;
  }

  /** Stashes an already permission-checked command and returns its preview + confirm token. */
  private requestConfirmation(
    namespace: string,
    command: string,
    registeredCmd: any,
    handlerArgs: Record<string, any>,
    sessionId?: string
  ): any {
    const token = this.pendingConfirms.create({ namespace, command, registeredCmd, handlerArgs, sessionId });
    this.auditLogger?.audit('confirm:requested', { command: `${namespace}:${command}`, token }, sessionId);

    return {
      confirmRequired: true,
      preview: {
        command: `${namespace}:${command}`,
        args: handlerArgs,
        effect: registeredCmd.longDescription || registeredCmd.description,
        reversible: registeredCmd.reversible === true,
      },
      confirmToken: token,
    };
  }

  /** Looks up a pending confirmation by token and, if still valid, runs the stashed command. */
  private async resolveConfirmation(token: string, signal?: AbortSignal): Promise<any> {
    const resolved = this.pendingConfirms.resolve(token);
    if (resolved.status === 'expired') {
      const pending = resolved.payload;
      this.auditLogger?.audit('confirm:expired', { command: `${pending.namespace}:${pending.command}`, token }, pending.sessionId);
      return { _error: { code: 2, error: 'Invalid or expired confirmation token' } };
    }
    if (resolved.status !== 'ok') {
      return { _error: { code: 2, error: 'Invalid or expired confirmation token' } };
    }
    const pending = resolved.payload;
    const resolvedCommand = `${pending.namespace}:${pending.command}`;

    // invokeHandler() races the handler against timeouts.executor_ms when
    // configured (ronda 37 del audit) — a timeout throws, caught below and
    // funneled into the SAME audited error:handler + _error path the
    // result.success===false branch already uses, since this method (unlike
    // executeCommand/executePipeline) owns its own audit entirely and can't
    // rely on execInternal's generic block, which skips confirm resolutions.
    let result: any;
    try {
      result = await this.invokeHandler(pending.registeredCmd.handler, pending.handlerArgs, null, pending.sessionId, signal, resolvedCommand);
    } catch (err: any) {
      const timeoutError = err.message || `Command failed: ${resolvedCommand}`;
      this.auditLogger?.audit('error:handler', { command: resolvedCommand, error: timeoutError }, pending.sessionId);
      return { _error: { code: 1, error: timeoutError } };
    }
    if (result && typeof result === 'object' && result.success === false) {
      const failError = result.error || `Command failed: ${resolvedCommand}`;
      // The generic execInternal post-processing skips its own audit for
      // isConfirmResolution (see comment there) — record the failure here
      // instead, under the resolved command's real name, so this signal
      // isn't silently dropped.
      this.auditLogger?.audit('error:handler', { command: resolvedCommand, error: failError }, pending.sessionId);
      return { _error: { code: 1, error: failError } };
    }
    this.auditLogger?.audit('confirm:executed', { command: resolvedCommand, token }, pending.sessionId);
    // Record under the CONFIRMED command's name, not the literal typed
    // "confirm <token>" string — matches Executor's confirm() (round 31 of
    // the audit: previously execInternal's generic post-processing also
    // recorded this request into history, mislabeled as "confirm <token>",
    // AND audited a second, redundant command:executed event for the
    // same resolution. That generic path is now skipped entirely for
    // confirm resolutions (see execInternal's isConfirmResolution check).
    this.recordHistory(resolvedCommand, 0);
    return result.data;
  }

  /** Evicts confirm tokens older than confirmTTL_ms (default 5 min). Runs once per exec() call. */
  private cleanExpiredConfirms(): void {
    const swept = this.pendingConfirms.sweepExpired();
    for (const { token, payload, ageMs } of swept) {
      this.auditLogger?.audit('confirm:expired', { command: `${payload.namespace}:${payload.command}`, token, reason: 'ttl-sweep', ageMs }, payload.sessionId);
    }
  }

  private async executeBuiltin(command: string, args: any, signal?: AbortSignal, sessionId?: string): Promise<any> {
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
            const lookupResult = this.registry.get(r.namespace, r.command);
            // Fail-closed: if the command isn't in the registry, exclude it
            if (!lookupResult.ok) return false;
            return isVisibleToAgent(lookupResult.value.definition.requiredPermissions, this.agentPermissions);
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
        const lookupResult = this.registry.get(ns, cmd);
        if (!lookupResult.ok) {
          return { _error: { code: 2, error: `Command not found: ${target}` } };
        }
        const definition = lookupResult.value.definition;
        // Check agent permissions before revealing command definition
        if (!isVisibleToAgent(definition.requiredPermissions, this.agentPermissions)) {
          return { _error: { code: 3, error: `Permission denied: cannot describe ${target}` } };
        }
        return definition;
      }

      case 'context': {
        if (!this.contextStore) return {};
        const result = await this.contextStore.getAll(sessionId);
        return result.data ?? {};
      }

      case 'history': {
        return [...this.history];
      }

      case 'confirm': {
        const token = args.positional[0] || '';
        if (!token) return { _error: { code: 1, error: 'Usage: confirm <token>' } };
        return this.resolveConfirmation(token, signal);
      }

      case 'help': {
        return this.help();
      }

      default:
        return { _error: { code: 2, error: `Unknown builtin command: ${command}` } };
    }
  }

  private async executeContext(command: string, args: any, sessionId?: string): Promise<any> {
    if (!this.contextStore) {
      return { _error: { code: 1, error: 'Context store not available' } };
    }

    switch (command) {
      case 'set': {
        const key = args.positional[0];
        const value = args.positional[1];
        if (!key) return { _error: { code: 1, error: 'Usage: context:set <key> <value>' } };
        const result = await this.contextStore.set(key, value, sessionId);
        if (result.error) return { _error: { code: 1, error: result.error.message } };
        return { key, value, status: 'set' };
      }

      case 'get': {
        const key = args.positional[0];
        if (!key) return { _error: { code: 1, error: 'Usage: context:get <key>' } };
        const result = await this.contextStore.get(key, sessionId);
        if (result.error) return { _error: { code: 2, error: result.error.message } };
        return result.data;
      }

      case 'delete': {
        const key = args.positional[0];
        if (!key) return { _error: { code: 1, error: 'Usage: context:delete <key>' } };
        const result = await this.contextStore.delete(key, sessionId);
        if (result.error) return { _error: { code: 1, error: result.error.message } };
        return { key, status: 'deleted' };
      }

      default:
        return { _error: { code: 2, error: `Unknown context command: ${command}` } };
    }
  }

  /**
   * Converts a raw (string/boolean, as parsed from CLI args) value to its
   * declared param type and checks constraints (min/max/minLength/enum/
   * etc.) — documented in contracts/executor.md and already implemented by
   * Executor, but Core (the engine cli/index.ts and server/index.ts
   * actually construct) never read param.type/constraints/enumValues at
   * all: a param declared type:'int' with constraints {min,max}, or
   * type:'enum', passed straight through to the handler as a raw string.
   * Ported verbatim from Executor.convertType. Several skill handlers
   * (shell-http.ts, workspace.ts, wizard.ts, scaffold.ts) already guard
   * their 'json' params with `typeof x === 'string' ? JSON.parse(x) : x`,
   * anticipating exactly this — pre-parsing here is a no-op for them, not
   * a behavior change.
   */
  private convertType(value: any, def: any): { value?: any; error?: string } {
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

  /**
   * Runs convertType() over every param present in handlerArgs, leaving
   * absent params untouched (Core doesn't apply param.default anywhere —
   * a separate, pre-existing gap out of scope here).
   *
   * Regresion (ronda 31 del audit): required-param presence solo se
   * chequeaba bajo --validate (validateCommand()) — un caller normal (sin
   * --validate) que omitia un param requerido pasaba directo al handler
   * con ese arg en undefined, en vez de rechazar con E_INVALID_ARGS como
   * ya hace Executor (validateArgs(), incondicional en todo modo). Ahora
   * se enforce aca tambien, no solo bajo --validate.
   */
  private convertArgTypes(handlerArgs: Record<string, any>, params: any[]): { ok: true; args: Record<string, any> } | { ok: false; error: string } {
    const result: Record<string, any> = { ...handlerArgs };
    for (const def of params) {
      const rawValue = handlerArgs[def.name];
      if (rawValue === undefined || rawValue === null) {
        if (def.required) {
          return { ok: false, error: `Missing required parameter: ${def.name}` };
        }
        continue;
      }
      const converted = this.convertType(rawValue, def);
      if (converted.error) {
        return { ok: false, error: converted.error };
      }
      result[def.name] = converted.value;
    }
    return { ok: true, args: result };
  }

  /**
   * `resolvedArgs` is the already type-converted/constraint-checked args
   * object (executeCommand()/executePipeline() compute this moments
   * earlier via convertArgTypes() and previously discarded it here) —
   * Executor's equivalent (E_validate branch) includes it, matching
   * contracts/executor.md's documented {valid, command, resolvedArgs}
   * shape. Regresion (ronda 37 del audit): Core's version omitted it
   * entirely, so a pipeline step under --validate fed the NEXT step a
   * {valid, command} object with no fields to resolve $input.field
   * against — e.g. `users:get --id 1 --validate >> orders:list --user-id
   * $input.id` left $input.id unresolved under Core (Executor resolves it
   * via resolvedArgs.id).
   */
  private validateCommand(registeredCmd: any, args: any, resolvedArgs: Record<string, any>): any {
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

    return { valid: true, command: `${registeredCmd.namespace}:${registeredCmd.name}`, resolvedArgs };
  }

  /**
   * Resolves `$input.field` string references in a pipeline step's named
   * args against the previous step's output — documented in
   * contracts/executor.md/parser.md and already implemented by Executor,
   * but Core (the engine cli/index.ts and server/index.ts actually wire
   * up) never read it: a pipeline like `users:get --id 1 >> orders:list
   * --user-id $input.id` sent the literal string "$input.id" to the
   * second step instead of the resolved id. Mirrors Executor's exact
   * behavior, including its fallback: a missing/undefined field on the
   * input leaves the literal "$input.field" string in place rather than
   * erroring (Executor doesn't emit E_INPUT_RESOLUTION for this case
   * either, despite the contract naming it).
   */
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

  private async executePipeline(commands: ParsedCommand[], sessionId?: string, signal?: AbortSignal): Promise<any> {
    const maxDepth = 10;
    if (commands.length > maxDepth) {
      return { _error: { code: 1, error: `Pipeline exceeds maximum depth of ${maxDepth} commands` } };
    }

    // Regresion (ronda 31 del audit): --dry-run/--validate en el primer
    // comando de un pipeline se leian en execInternal solo para setear
    // meta.mode de la respuesta final — este metodo nunca los chequeaba,
    // asi que `cmd1 >> file:delete --dry-run` reportaba mode:'dry-run'
    // mientras file:delete corria de verdad. Mismo tratamiento que ya
    // hace Executor: --dry-run en el primer comando se propaga a TODOS
    // los pasos (simula el pipeline entero, no solo el primer token);
    // --validate NO se propaga globalmente (misma asimetria que
    // Executor) — un paso solo valida si SU PROPIO flag trae --validate.
    const globalDryRun = commands[0]?.flags.dryRun || false;

    let previousData: any = null;
    let isFirstStep = true;

    // Regresion (ronda 37 del audit): executePipeline() nunca llamaba
    // this.auditLogger directamente — cada paso exitoso/fallido caia al
    // bloque generico de execInternal, que audita UN SOLO evento etiquetado
    // con el string COMPLETO del pipeline (truncado a 100 chars), ambiguo
    // sobre cual paso especifico fallo/tuvo exito en una cadena larga.
    // executeBatch() ya audita cada item individualmente desde la ronda 28
    // — este metodo ahora hace lo mismo por paso, bajo su propio
    // namespace:command, y execInternal salta su propio audit generico
    // para pipelines (ver isPipeline ahi) para no duplicar la señal.
    const auditStep = (type: 'permission:denied' | 'error:handler' | 'command:executed', stepLabel: string, extra?: Record<string, any>) => {
      this.auditLogger?.audit(type, { command: stepLabel, ...extra }, sessionId);
    };

    for (const cmd of commands) {
      const { namespace, command, args } = cmd;
      const flags = globalDryRun ? { ...cmd.flags, dryRun: true } : cmd.flags;

      if (!namespace) {
        return { _error: { code: 1, error: `Pipeline command must have namespace` } };
      }

      const stepLabel = `${namespace}:${command}`;

      const lookupResult = this.registry.get(namespace, command);
      if (!lookupResult.ok) {
        auditStep('error:handler', stepLabel, { code: 2, error: `Command not found: ${namespace}:${command}` });
        return { _error: { code: 2, error: `Command not found: ${namespace}:${command}` } };
      }
      const registeredCmd = { ...lookupResult.value.definition, handler: lookupResult.value.handler };

      // Check agent permissions for each pipeline step
      if (!isVisibleToAgent(registeredCmd.requiredPermissions, this.agentPermissions)) {
        auditStep('permission:denied', stepLabel, { code: 3, error: `Permission denied at pipeline step: ${namespace}:${command}` });
        return { _error: { code: 3, error: `Permission denied at pipeline step: ${namespace}:${command}` } };
      }

      const namedArgs = isFirstStep ? args.named : this.resolveInputRefs(args.named, previousData);
      const handlerArgs: Record<string, any> = { ...namedArgs };
      if (registeredCmd.params) {
        registeredCmd.params.forEach((p: any, idx: number) => {
          if (args.positional[idx] !== undefined && !(p.name in handlerArgs)) {
            handlerArgs[p.name] = args.positional[idx];
          }
        });
      }

      // Convert declared param types and check constraints — same as the
      // single-command path (executeCommand), applied per pipeline step.
      const typeCheck = registeredCmd.params ? this.convertArgTypes(handlerArgs, registeredCmd.params) : { ok: true as const, args: handlerArgs };
      if (!typeCheck.ok) {
        const typeErrMsg = `Pipeline failed at ${namespace}:${command}: ${typeCheck.error}`;
        auditStep('error:handler', stepLabel, { code: 1, error: typeErrMsg });
        return { _error: { code: 1, error: typeErrMsg } };
      }

      // Validate mode — same check executeCommand() applies, previously
      // skipped entirely inside a pipeline (see the round-31 comment
      // above executePipeline). A missing-required-param failure aborts
      // the whole pipeline here, same as any other step failure; a
      // successful validation continues the chain using its {valid,
      // command} shape as the next step's $input, mirroring Executor's
      // identical continue-through-validate pipeline semantics.
      if (flags.validate) {
        previousData = this.validateCommand(registeredCmd, { named: namedArgs, positional: args.positional }, typeCheck.args);
        if (previousData && previousData._error) {
          auditStep('error:handler', stepLabel, { code: previousData._error.code, error: previousData._error.error });
          return previousData;
        }
        auditStep('command:executed', stepLabel, { mode: 'validate' });
        isFirstStep = false;
        continue;
      }

      // Dry-run mode (own flag, or propagated from the pipeline's first
      // command — see globalDryRun above) — simulate this step without
      // invoking its handler, then continue the chain using the
      // simulated shape as the next step's $input, mirroring Executor's
      // identical whole-pipeline-simulation semantics. Previously this
      // flag was read nowhere in this method: a step tagged --dry-run
      // still ran its handler for real.
      if (flags.dryRun) {
        previousData = { dryRun: true, command: `${namespace}:${command}`, args: typeCheck.args };
        auditStep('command:executed', stepLabel, { mode: 'dry-run' });
        isFirstStep = false;
        continue;
      }

      // Confirm gate — same check executeCommand() applies, previously
      // missing here entirely: a step tagged requiresConfirmation (e.g.
      // file:delete) executed immediately with no preview when reached via
      // a pipeline, silently bypassing the exact protection that flag
      // exists for (`cmd1 >> file:delete --path important --recursive
      // true` ran unconfirmed). Aborts the pipeline here — same as any
      // other mid-pipeline failure — rather than trying to resume the
      // remaining steps after a separate confirm: pendingConfirms stashes
      // only this one step's resolved args, not "the rest of the pipeline
      // plus its accumulated previousData", so a later-confirmed token
      // re-runs just this step, matching single-command confirm semantics.
      if (flags.confirm || registeredCmd.requiresConfirmation) {
        return this.requestConfirmation(namespace, command, registeredCmd, typeCheck.args, sessionId);
      }

      // invokeHandler() races the handler against timeouts.executor_ms when
      // configured (ronda 37 del audit) — a timeout throws, caught below
      // and funneled into the same per-step audit + _error path a normal
      // handler failure already uses, so ONE hung step no longer kills the
      // whole pipeline's already-succeeded prior steps' results silently.
      let result: any;
      try {
        result = await this.invokeHandler(registeredCmd.handler, typeCheck.args, previousData, sessionId, signal, stepLabel);
      } catch (err: any) {
        const timeoutErrMsg = err.message || `Pipeline failed at ${namespace}:${command}`;
        auditStep('error:handler', stepLabel, { code: 1, error: timeoutErrMsg });
        return { _error: { code: 1, error: timeoutErrMsg } };
      }
      if (!result.success) {
        const detail = result.error ? `: ${result.error}` : '';
        const handlerErrMsg = `Pipeline failed at ${namespace}:${command}${detail}`;
        auditStep('error:handler', stepLabel, { code: 1, error: handlerErrMsg });
        return { _error: { code: 1, error: handlerErrMsg } };
      }

      auditStep('command:executed', stepLabel);
      previousData = result.data;
      isFirstStep = false;
    }

    return previousData;
  }

  private async executeBatch(commands: ParsedCommand[], sessionId?: string, signal?: AbortSignal): Promise<any[]> {
    const maxBatchSize = 20;
    if (commands.length > maxBatchSize) {
      return [{ code: 1, data: null, error: `Batch exceeds maximum size of ${maxBatchSize} commands` }];
    }

    // Execute commands sequentially, in order (index 0, 1, 2...) — per contract v1
    const results: any[] = [];
    for (const cmd of commands) {
      // Batch previously routed every item through executeCommand() without
      // ever touching auditLogger — the same permission-denied/handler-error/
      // command-executed checks execInternal() applies to the single-command
      // and pipeline paths (lines ~293-337 above) were silently skipped for
      // every batched command, a total audit blind spot in Core (the engine
      // cli/index.ts and server/index.ts actually construct).
      const label = cmd.meta.rawSegment.slice(0, 100);
      try {
        const data = await this.executeCommand(cmd, sessionId, signal);
        if (data && typeof data === 'object' && '_error' in data) {
          const { code, error } = data._error;
          this.auditLogger?.audit(code === 3 ? 'permission:denied' : 'error:handler', { command: label, code, error }, sessionId);
          results.push({ code, data: null, error });
        } else if (data && typeof data === 'object' && data.confirmRequired === true) {
          results.push({ code: 4, data, error: null });
        } else {
          this.auditLogger?.audit('command:executed', { command: label }, sessionId);
          results.push({ code: 0, data, error: null });
        }
      } catch (err) {
        const error = (err as Error)?.message || 'Unknown error';
        this.auditLogger?.audit('error:handler', { command: label, error }, sessionId);
        results.push({ code: 1, data: null, error });
      }
    }
    return results;
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
    // Stores the RAW command string an agent typed (e.g. `secret:set --name
    // DB_PASSWORD --value hunter2`), which the 'history' builtin above now
    // gates behind the 'history' permission — but that only stops OTHER
    // agents/callers from reading it. maskSecrets() catches known secret
    // shapes (Bearer tokens, JWTs, password=/token=/secret= pairs, AWS
    // keys, ...) as defense-in-depth for whatever ends up persisting or
    // exporting this array beyond the agent that typed it. It won't catch
    // an arbitrary value under an unrecognized flag name (e.g. --value)
    // that doesn't itself look like a known secret shape — that's a
    // limitation shared with Executor's identical args masking.
    this.history.push({
      command: maskSecrets(command),
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
