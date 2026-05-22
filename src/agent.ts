import {
  OpenRouter,
  stepCountIs,
  maxCost,
  isTurnStartEvent,
  isTurnEndEvent,
  isToolCallOutputEvent,
  type Tool,
} from '@openrouter/agent';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { allTools } from './tools/index.js';
import { createServerToolsHooks } from './tools/server-tools.js';
import { type ToolContext } from './tools/context.js';
import { createFileStateAccessor } from './state/file-state.js';
import {
  createRequestId,
  createGenerationId,
  logRequest,
  logGeneration,
  logSessionStart,
} from './logging/logger.js';
import type {
  AgentCoreEvent,
  AgentCoreEventStatus,
  HookEvent,
  HookPayload,
  TokenUsage,
} from './events.js';

const DEFAULT_MODEL = '~anthropic/claude-sonnet-latest';
const DEFAULT_MAX_TURNS = 25;
const DEFAULT_MAX_BUDGET_USD = 1.0;
const DEFAULT_APP_TITLE = 'openrouter-agent-coder';
const ABORT_REASON = 'aborted';

/**
 * Default system instructions for the built-in code-editing agent. Exported so
 * library consumers can extend, prefix, or replace the string without
 * re-deriving it from source.
 */
export const DEFAULT_INSTRUCTIONS =
  'You are a code editing agent. You can read, write, and edit files, list directories, and run shell commands. Work step by step: read files to understand the codebase, then make changes. Always verify your changes.';

export type AgentLoggerLevel = 'debug' | 'info' | 'warn' | 'error';
export type AgentLogger = (
  level: AgentLoggerLevel,
  message: string,
  fields?: Record<string, unknown>,
) => void;

export type CanUseToolResult =
  | { behavior: 'allow'; updatedInput?: unknown }
  | { behavior: 'deny'; reason: string };

export type CanUseTool = (
  toolName: string,
  input: unknown,
) => Promise<CanUseToolResult> | CanUseToolResult;

/**
 * Lifecycle hook callback. Invoked with a {@link HookEvent} discriminator and
 * the matching {@link HookPayload} variant. Hooks are awaited but are
 * audit-only: thrown errors are logged via {@link AgentLogger} and swallowed,
 * the return value is discarded, and the agent run continues unmodified.
 */
export type OnHook = (event: HookEvent, payload: HookPayload) => void | Promise<void>;

export interface OpenRouterAgentRunOptions {
  /** OpenRouter API key. Required — no env fallback. */
  apiKey: string;
  /** Stable session id used for OR's server-side session tracking and on-disk state. */
  sessionId: string;
  /** The user prompt for this run. */
  prompt: string;
  /** System instructions. Defaults to {@link DEFAULT_INSTRUCTIONS}. */
  instructions?: string;
  /** Model alias or id. Defaults to `~anthropic/claude-sonnet-latest`. */
  model?: string;
  /** Working directory tools resolve relative paths against. Defaults to the host process's current directory. */
  cwd?: string;
  /** Max inner-loop turns. Defaults to 25. */
  maxTurns?: number;
  /** Max cumulative cost in USD. Defaults to 1.0. */
  maxBudgetUsd?: number;
  /**
   * Tool set passed to the model. Defaults to the built-in 5-client-tool set
   * bound to a {@link ToolContext} derived from the run's `cwd` and composite
   * AbortSignal; server tools (datetime/web_search/web_fetch) are injected via
   * hooks. Custom tools supplied here are NOT context-bound — callers are
   * responsible for their own cwd resolution and cancellation if needed.
   */
  tools?: readonly Tool[];
  /**
   * Permission gate invoked before each client tool's execute. Resolve to
   * `{ behavior: 'allow' }` to run the handler as-is, `{ behavior: 'allow',
   * updatedInput }` to substitute the handler's input, or `{ behavior:
   * 'deny', reason }` to skip the handler and surface a denial as the tool
   * result. Errors thrown from this callback are treated as denials using
   * the thrown message. Server-side tools (datetime/web_search/web_fetch)
   * execute on OpenRouter's servers and bypass this hook.
   */
  canUseTool?: CanUseTool;
  /**
   * Lifecycle hook callback. Fires `SessionStart` once after the
   * `session_started` event, `PreToolUse` before each client tool's
   * `canUseTool` decision (audit always fires, even when denied),
   * `PostToolUse` after each tool result is computed (with `isError` matching
   * the subsequent `tool_result.isError`), and `SessionEnd` once after
   * `stream_complete`. Hooks are awaited; thrown errors are logged via
   * {@link AgentLogger} and swallowed so they cannot break a run.
   */
  onHook?: OnHook;
  /**
   * External AbortSignal. When aborted, the run cancels the underlying OR
   * stream and propagates SIGTERM (then SIGKILL after a 250ms grace) to any
   * child process spawned by `run_command`. Combined internally with the
   * `abort()` method via `AbortSignal.any`.
   */
  signal?: AbortSignal;
  /** Override for the logs directory. Defaults to `<cwd>/logs`. */
  logsRoot?: string;
  /** Override the OpenRouter API base URL. */
  baseUrl?: string;
  /** App title sent in OR client metadata. Defaults to `'openrouter-agent-coder'`. */
  appTitle?: string;
  /** Optional diagnostic logger. No logger → silent. */
  logger?: AgentLogger;
}

interface ResolvedOptions {
  apiKey: string;
  sessionId: string;
  prompt: string;
  instructions: string;
  model: string;
  cwd: string;
  maxTurns: number;
  maxBudgetUsd: number;
  tools: readonly Tool[];
  appTitle: string;
  logsRoot: string;
  canUseTool?: CanUseTool;
  onHook?: OnHook;
  signal?: AbortSignal;
  baseUrl?: string;
  logger?: AgentLogger;
}

function resolveOptions(opts: OpenRouterAgentRunOptions): ResolvedOptions {
  if (!opts.apiKey) {
    throw new Error('apiKey is required');
  }
  const cwd = opts.cwd ?? process.cwd();
  return {
    apiKey: opts.apiKey,
    sessionId: opts.sessionId,
    prompt: opts.prompt,
    instructions: opts.instructions ?? DEFAULT_INSTRUCTIONS,
    model: opts.model ?? DEFAULT_MODEL,
    cwd,
    maxTurns: opts.maxTurns ?? DEFAULT_MAX_TURNS,
    maxBudgetUsd: opts.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD,
    tools: opts.tools ?? [],
    appTitle: opts.appTitle ?? DEFAULT_APP_TITLE,
    logsRoot: opts.logsRoot ?? join(cwd, 'logs'),
    canUseTool: opts.canUseTool,
    onHook: opts.onHook,
    signal: opts.signal,
    baseUrl: opts.baseUrl,
    logger: opts.logger,
  };
}

/**
 * Single-shot async iterable that drives an OpenRouter agent turn-by-turn and
 * yields normalized {@link AgentCoreEvent}s. One instance per query. Construct,
 * `for await` the events, done.
 */
export class OpenRouterAgentRun implements AsyncIterable<AgentCoreEvent> {
  private readonly opts: ResolvedOptions;
  private readonly internalAbortController = new AbortController();
  private readonly compositeSignal: AbortSignal;
  /** True when caller supplied a custom `tools` array (signal not auto-wrapped). */
  private readonly hasCustomTools: boolean;
  private consumed = false;

  constructor(options: OpenRouterAgentRunOptions) {
    this.opts = resolveOptions(options);
    this.hasCustomTools = options.tools !== undefined;
    this.compositeSignal = options.signal
      ? AbortSignal.any([this.internalAbortController.signal, options.signal])
      : this.internalAbortController.signal;
  }

  /**
   * Abort the in-flight run. Fires the run's internal AbortController, which
   * triggers cancellation of the OR stream and any in-flight tool execution.
   * Idempotent — safe to call multiple times. Calling before the iterator is
   * consumed causes the first yielded event to be a `stream_complete` with
   * `reason: 'aborted'` (no `session_started`).
   */
  abort(): void {
    if (!this.internalAbortController.signal.aborted) {
      this.internalAbortController.abort();
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentCoreEvent> {
    if (this.consumed) {
      throw new Error('OpenRouterAgentRun is single-shot and has already been consumed');
    }
    this.consumed = true;
    return this.iterate();
  }

  private async *iterate(): AsyncGenerator<AgentCoreEvent> {
    const {
      apiKey,
      sessionId,
      prompt,
      instructions,
      model,
      cwd,
      maxTurns,
      maxBudgetUsd,
      tools: userTools,
      appTitle,
      logsRoot,
      baseUrl,
      logger,
      onHook,
    } = this.opts;

    const startMs = Date.now();
    let maxTurnNumber = 0;
    let totalCostUsd = 0;
    let finalUsage: TokenUsage | null = null;
    const signal = this.compositeSignal;
    // Captured at every stream_complete yield site so the outer finally can
    // fire exactly one SessionEnd hook with matching status/usage/cost. Null
    // when the run somehow exits without yielding stream_complete (should be
    // unreachable — every path ends in a stream_complete).
    let sessionEndPayload: Extract<HookPayload, { event: 'SessionEnd' }> | null = null;

    const safeFireHook = async (event: HookEvent, payload: HookPayload): Promise<void> => {
      if (!onHook) return;
      try {
        await onHook(event, payload);
      } catch (err) {
        logger?.('error', 'Hook threw', { event, error: err });
      }
    };

    logger?.('debug', 'OpenRouterAgentRun starting', {
      sessionId,
      model,
      maxTurns,
      maxBudgetUsd,
      cwd,
      logsRoot,
    });

    // Use a holder so the abort listener can fire result.cancel() once the
    // call has been issued. result is undefined briefly before callModel().
    let resultHandle: { cancel(): Promise<void> } | undefined;
    const onAbort = (): void => {
      if (resultHandle) void resultHandle.cancel().catch(() => undefined);
    };
    let abortListenerInstalled = false;

    try {
      // Pre-aborted at construction time → no session_started, no SessionStart
      // hook; jump straight to a terminal stream_complete event. SessionEnd
      // still fires (it bookends stream_complete, not session_started).
      if (signal.aborted) {
        yield {
          type: 'stream_complete',
          status: 'error',
          durationMs: Date.now() - startMs,
          reason: ABORT_REASON,
        };
        sessionEndPayload = {
          event: 'SessionEnd',
          sessionId,
          status: 'error',
          usage: null,
          costUsd: 0,
        };
        return;
      }

      let client: OpenRouter;
      try {
        client = new OpenRouter({
          apiKey,
          ...(baseUrl && { serverURL: baseUrl }),
          appTitle,
          hooks: createServerToolsHooks(),
        } as ConstructorParameters<typeof OpenRouter>[0]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        yield { type: 'error', message, cause: err };
        yield {
          type: 'stream_complete',
          status: 'error',
          durationMs: Date.now() - startMs,
          reason: message,
        };
        sessionEndPayload = {
          event: 'SessionEnd',
          sessionId,
          status: 'error',
          usage: null,
          costUsd: 0,
        };
        return;
      }

      await logSessionStart(logsRoot, sessionId, cwd);

      yield { type: 'session_started', sessionId };
      await safeFireHook('SessionStart', { event: 'SessionStart', sessionId, cwd, model });

      const requestId = createRequestId();
      const state = createFileStateAccessor(logsRoot, sessionId);
      // Note: server-side tools (datetime/web_search/web_fetch) are injected
      // via OR SDK hooks and execute on OpenRouter's servers — they bypass this
      // wrapper, so canUseTool only ever sees client tools.
      const ctx: ToolContext = { cwd, signal };
      // Order of wraps (innermost → outermost): ctx-bound execute, then
      // canUseTool gate, then hook wrapper. The hook wrapper is outermost so
      // PreToolUse fires before the canUseTool decision (audit always fires,
      // even on deny), and PostToolUse fires after the inner result/error is
      // resolved — including the synth-deny payload from a canUseTool denial.
      const baseTools: readonly Tool[] = this.hasCustomTools ? userTools : allTools(ctx);
      const permissionedTools = this.opts.canUseTool
        ? baseTools.map((t) => wrapToolWithPermission(t, this.opts.canUseTool!))
        : baseTools;
      const toolsForRun = onHook
        ? permissionedTools.map((t) => wrapToolWithHooks(t, safeFireHook))
        : permissionedTools;

      signal.addEventListener('abort', onAbort, { once: true });
      abortListenerInstalled = true;

      await logRequest(logsRoot, {
        sessionId,
        requestId,
        prompt,
        timestamp: new Date().toISOString(),
      });

      const result = client.callModel({
        model,
        sessionId,
        input: [{ role: 'user' as const, content: prompt }],
        instructions,
        tools: toolsForRun,
        state,
        stopWhen: [stepCountIs(maxTurns), maxCost(maxBudgetUsd)],
        onTurnEnd: async (_ctx, response) => {
          const generationId = createGenerationId();
          await logGeneration(logsRoot, {
            sessionId,
            requestId,
            generationId,
            response,
            timestamp: new Date().toISOString(),
          });
          totalCostUsd += response.usage?.cost ?? 0;
        },
      });
      resultHandle = result;
      // Late-aborted between callModel and stream attach.
      if (signal.aborted) void result.cancel().catch(() => undefined);

      for await (const event of result.getFullResponsesStream()) {
        // Tool results emitted as part of an aborted run are still useful — they
        // carry the cancellation observability for the consumer — so they are
        // forwarded even after abort. Everything else (text deltas, turn
        // start/end, tool_call announcements) is dropped post-abort.
        if (isTurnStartEvent(event)) {
          if (signal.aborted) continue;
          const turnNumber = event.turnNumber;
          if (turnNumber > maxTurnNumber) maxTurnNumber = turnNumber;
          yield { type: 'turn_start', turnNumber };
          continue;
        }
        if (isTurnEndEvent(event)) {
          if (signal.aborted) continue;
          yield {
            type: 'turn_end',
            turnNumber: event.turnNumber,
            usage: finalUsage,
            costUsd: totalCostUsd,
          };
          continue;
        }
        if (isToolCallOutputEvent(event)) {
          const out = event.output;
          const isError = out.status === 'incomplete';
          yield {
            type: 'tool_result',
            callId: out.callId,
            output: out.output,
            isError,
          };
          // After an abort, surface the tool result then stop iterating.
          if (signal.aborted) break;
          continue;
        }
        if ('type' in event && event.type === 'response.output_text.delta') {
          if (signal.aborted) continue;
          const delta = (event as { type: string; delta: string }).delta;
          if (delta) {
            yield { type: 'text_delta', content: delta };
          }
          continue;
        }
        if ('type' in event && event.type === 'response.output_item.done') {
          if (signal.aborted) continue;
          const item = (event as { type: string; item: { type: string } }).item;
          if (item.type === 'function_call') {
            const fnItem = item as {
              type: 'function_call';
              callId: string;
              name: string;
              arguments: string;
            };
            let input: unknown;
            try {
              input = JSON.parse(fnItem.arguments);
            } catch {
              input = fnItem.arguments;
            }
            yield {
              type: 'tool_call',
              callId: fnItem.callId,
              name: fnItem.name,
              input,
            };
          }
          continue;
        }
      }

      if (signal.aborted) {
        yield {
          type: 'stream_complete',
          status: 'error',
          usage: finalUsage,
          costUsd: totalCostUsd,
          durationMs: Date.now() - startMs,
          reason: ABORT_REASON,
        };
        sessionEndPayload = {
          event: 'SessionEnd',
          sessionId,
          status: 'error',
          usage: finalUsage,
          costUsd: totalCostUsd,
        };
        return;
      }

      const response = await result.getResponse();
      finalUsage = response.usage ?? null;
      const finalCost = response.usage?.cost ?? 0;
      // Guard against double-counting: only adopt the final cost if no
      // per-turn onTurnEnd callback fired (e.g. single-shot no-tool-call case).
      if (totalCostUsd === 0 && finalCost > 0) {
        totalCostUsd = finalCost;
      }

      const finalGenId = createGenerationId();
      await logGeneration(logsRoot, {
        sessionId,
        requestId,
        generationId: finalGenId,
        response,
        timestamp: new Date().toISOString(),
      });

      const status = deriveCompletionStatus({
        totalCostUsd,
        maxBudgetUsd,
        maxTurnNumber,
        maxTurns,
      });

      yield {
        type: 'stream_complete',
        status,
        usage: finalUsage,
        costUsd: totalCostUsd,
        durationMs: Date.now() - startMs,
      };
      sessionEndPayload = {
        event: 'SessionEnd',
        sessionId,
        status,
        usage: finalUsage,
        costUsd: totalCostUsd,
      };
    } catch (err) {
      if (signal.aborted) {
        yield {
          type: 'stream_complete',
          status: 'error',
          usage: finalUsage,
          costUsd: totalCostUsd,
          durationMs: Date.now() - startMs,
          reason: ABORT_REASON,
        };
        sessionEndPayload = {
          event: 'SessionEnd',
          sessionId,
          status: 'error',
          usage: finalUsage,
          costUsd: totalCostUsd,
        };
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      logger?.('error', 'OpenRouterAgentRun stream errored', { message });
      yield { type: 'error', message, cause: err };
      yield {
        type: 'stream_complete',
        status: 'error',
        usage: finalUsage,
        costUsd: totalCostUsd,
        durationMs: Date.now() - startMs,
        reason: message,
      };
      sessionEndPayload = {
        event: 'SessionEnd',
        sessionId,
        status: 'error',
        usage: finalUsage,
        costUsd: totalCostUsd,
      };
    } finally {
      if (abortListenerInstalled) {
        signal.removeEventListener('abort', onAbort);
      }
      if (sessionEndPayload) {
        await safeFireHook('SessionEnd', sessionEndPayload);
      }
    }
  }
}

interface DeriveCompletionInput {
  totalCostUsd: number;
  maxBudgetUsd: number;
  maxTurnNumber: number;
  maxTurns: number;
}

/**
 * Wrap a Tool's execute with a canUseTool permission check. The original
 * tool is shallow-cloned (preserving inputSchema, description, etc.) and only
 * `execute` is replaced. On `deny`, the wrapper throws an Error whose message
 * is `JSON.stringify({ error, denied: true })`, which the OR SDK turns into a
 * tool-call output with status `'incomplete'` (surfaced as `isError: true`).
 * Consumers wanting to distinguish denial from generic failure can
 * `JSON.parse(toolResult.output)` and check `denied === true`.
 */
function wrapToolWithPermission(t: Tool, canUseTool: CanUseTool): Tool {
  const fn = t.function as { name: string; execute?: (i: unknown, c?: unknown) => unknown };
  const name = fn.name;
  const originalExecute = fn.execute;
  // Tools without a local execute (e.g. SDK "manual" or generator forms) run
  // outside our wrapper; pass them through unchanged.
  if (typeof originalExecute !== 'function') return t;
  const wrappedExecute = async (input: unknown, ctx?: unknown): Promise<unknown> => {
    let decision: CanUseToolResult;
    try {
      decision = await canUseTool(name, input);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(JSON.stringify({ error: reason, denied: true }), { cause: err });
    }
    if (decision.behavior === 'deny') {
      throw new Error(JSON.stringify({ error: decision.reason, denied: true }));
    }
    const effectiveInput = decision.updatedInput !== undefined ? decision.updatedInput : input;
    return originalExecute(effectiveInput, ctx);
  };
  return {
    ...t,
    function: {
      ...t.function,
      execute: wrappedExecute,
    },
  } as Tool;
}

/**
 * Wrap a Tool's execute with PreToolUse / PostToolUse hook firings. Composed
 * OUTSIDE {@link wrapToolWithPermission} so that PreToolUse fires before the
 * canUseTool decision (audit always fires, even on deny) and PostToolUse fires
 * after the inner execute resolves — propagating any thrown error (including
 * the synth-deny payload from a permission denial) as the PostToolUse output.
 *
 * The OR SDK's `ToolExecuteContext` carries the live `FunctionCallItem` on
 * `ctx.toolCall`, so the SDK-issued call id is preferred. When that is absent
 * (custom tools wired without the standard SDK context, or tests that pass a
 * bare `{}`), a synthetic UUID is generated for the hook payload — the two
 * payloads of a single Pre/Post pair always share the same id.
 */
function wrapToolWithHooks(
  t: Tool,
  safeFireHook: (event: HookEvent, payload: HookPayload) => Promise<void>,
): Tool {
  const fn = t.function as { name: string; execute?: (i: unknown, c?: unknown) => unknown };
  const name = fn.name;
  const originalExecute = fn.execute;
  if (typeof originalExecute !== 'function') return t;
  const wrappedExecute = async (input: unknown, ctx?: unknown): Promise<unknown> => {
    const sdkCallId = (ctx as { toolCall?: { callId?: unknown } } | undefined)?.toolCall?.callId;
    const callId = typeof sdkCallId === 'string' && sdkCallId.length > 0 ? sdkCallId : randomUUID();
    await safeFireHook('PreToolUse', { event: 'PreToolUse', toolName: name, input, callId });
    try {
      const output = await originalExecute(input, ctx);
      await safeFireHook('PostToolUse', {
        event: 'PostToolUse',
        toolName: name,
        input,
        output,
        isError: false,
        callId,
      });
      return output;
    } catch (err) {
      const output = err instanceof Error ? err.message : String(err);
      await safeFireHook('PostToolUse', {
        event: 'PostToolUse',
        toolName: name,
        input,
        output,
        isError: true,
        callId,
      });
      throw err;
    }
  };
  return {
    ...t,
    function: {
      ...t.function,
      execute: wrappedExecute,
    },
  } as Tool;
}

function deriveCompletionStatus(input: DeriveCompletionInput): AgentCoreEventStatus {
  if (input.totalCostUsd >= input.maxBudgetUsd) return 'max_budget';
  // Turn numbers are 0-indexed (turn 0 = initial request). stepCountIs(n)
  // stops when the *step count* (1-indexed) reaches n, i.e. when turnNumber
  // hits n - 1. Treating "max turnNumber observed + 1 >= maxTurns" as the
  // step-count threshold matches that.
  if (input.maxTurnNumber + 1 >= input.maxTurns) return 'max_turns';
  return 'success';
}
