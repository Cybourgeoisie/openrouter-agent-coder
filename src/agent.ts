import {
  OpenRouter,
  stepCountIs,
  maxCost,
  isTurnStartEvent,
  isTurnEndEvent,
  isToolCallOutputEvent,
  type Tool,
} from '@openrouter/agent';
import { allTools } from './tools/index.js';
import { createServerToolsHooks } from './tools/server-tools.js';
import { createFileStateAccessor } from './state/file-state.js';
import {
  createRequestId,
  createGenerationId,
  logRequest,
  logGeneration,
} from './logging/logger.js';
import type { AgentCoreEvent, AgentCoreEventStatus, TokenUsage } from './events.js';

const DEFAULT_MODEL = '~anthropic/claude-sonnet-latest';
const DEFAULT_MAX_TURNS = 25;
const DEFAULT_MAX_BUDGET_USD = 1.0;
const DEFAULT_APP_TITLE = 'openrouter-agent-coder';
const DEFAULT_INSTRUCTIONS =
  'You are a code editing agent. You can read, write, and edit files, list directories, and run shell commands. Work step by step: read files to understand the codebase, then make changes. Always verify your changes.';
const ABORT_REASON = 'aborted';

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

export type OnHook = (eventName: string, payload: Record<string, unknown>) => void | Promise<void>;

export interface OpenRouterAgentRunOptions {
  /** OpenRouter API key. Required — no env fallback. */
  apiKey: string;
  /** Stable session id used for OR's server-side session tracking and on-disk state. */
  sessionId: string;
  /** The user prompt for this run. */
  prompt: string;
  /** System instructions (defaults to a code-editing-agent prompt). */
  instructions?: string;
  /** Model alias or id. Defaults to `~anthropic/claude-sonnet-latest`. */
  model?: string;
  /** Working directory tools should resolve paths against. TODO(phase 1.5): plumb through to tools. */
  cwd?: string;
  /** Max inner-loop turns. Defaults to 25. */
  maxTurns?: number;
  /** Max cumulative cost in USD. Defaults to 1.0. */
  maxBudgetUsd?: number;
  /**
   * Tool set passed to the model. Defaults to the built-in 5-client-tool set
   * (built with the run's composite AbortSignal); server tools
   * (datetime/web_search/web_fetch) are injected via hooks. Custom tools
   * supplied here are NOT signal-wrapped — callers are responsible for their
   * own cancellation if needed.
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
  /** Lifecycle hook callback. TODO(phase 1.7): wire into pre/post tool use events. */
  onHook?: OnHook;
  /**
   * External AbortSignal. When aborted, the run cancels the underlying OR
   * stream and propagates SIGTERM (then SIGKILL after a 250ms grace) to any
   * child process spawned by `run_command`. Combined internally with the
   * `abort()` method via `AbortSignal.any`.
   */
  signal?: AbortSignal;
  /** Override for the logs directory. TODO(phase 1.5): plumb into logger/state accessor. */
  logsRoot?: string;
  /** Override the OpenRouter API base URL. */
  baseUrl?: string;
  /** App title sent in OR client metadata. */
  appTitle?: string;
  /** Optional diagnostic logger. No logger → silent. */
  logger?: AgentLogger;
}

interface ResolvedOptions extends Required<Omit<OpenRouterAgentRunOptions, OptionalOnlyKeys>> {
  cwd?: string;
  canUseTool?: CanUseTool;
  onHook?: OnHook;
  signal?: AbortSignal;
  logsRoot?: string;
  baseUrl?: string;
  logger?: AgentLogger;
}

type OptionalOnlyKeys =
  | 'cwd'
  | 'canUseTool'
  | 'onHook'
  | 'signal'
  | 'logsRoot'
  | 'baseUrl'
  | 'logger';

function resolveOptions(opts: OpenRouterAgentRunOptions): ResolvedOptions {
  return {
    apiKey: opts.apiKey,
    sessionId: opts.sessionId,
    prompt: opts.prompt,
    instructions: opts.instructions ?? DEFAULT_INSTRUCTIONS,
    model: opts.model ?? DEFAULT_MODEL,
    maxTurns: opts.maxTurns ?? DEFAULT_MAX_TURNS,
    maxBudgetUsd: opts.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD,
    tools: opts.tools ?? [],
    appTitle: opts.appTitle ?? DEFAULT_APP_TITLE,
    cwd: opts.cwd,
    canUseTool: opts.canUseTool,
    onHook: opts.onHook,
    signal: opts.signal,
    logsRoot: opts.logsRoot,
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
      maxTurns,
      maxBudgetUsd,
      tools: userTools,
      appTitle,
      baseUrl,
      logger,
    } = this.opts;

    const startMs = Date.now();
    let maxTurnNumber = 0;
    let totalCostUsd = 0;
    let finalUsage: TokenUsage | null = null;
    const signal = this.compositeSignal;

    logger?.('debug', 'OpenRouterAgentRun starting', {
      sessionId,
      model,
      maxTurns,
      maxBudgetUsd,
    });

    // Pre-aborted at construction time → no session_started; jump straight to
    // a terminal stream_complete event.
    if (signal.aborted) {
      yield {
        type: 'stream_complete',
        status: 'error',
        durationMs: Date.now() - startMs,
        reason: ABORT_REASON,
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
      return;
    }

    yield { type: 'session_started', sessionId };

    const requestId = createRequestId();
    const state = createFileStateAccessor(sessionId);
    // Note: server-side tools (datetime/web_search/web_fetch) are injected
    // via OR SDK hooks and execute on OpenRouter's servers — they bypass this
    // wrapper, so canUseTool only ever sees client tools.
    const baseTools: readonly Tool[] = this.hasCustomTools ? userTools : allTools(signal);
    const toolsForRun = this.opts.canUseTool
      ? baseTools.map((t) => wrapToolWithPermission(t, this.opts.canUseTool!))
      : baseTools;

    // Use a holder so the abort listener can fire result.cancel() once the
    // call has been issued. result is undefined briefly before callModel().
    let resultHandle: { cancel(): Promise<void> } | undefined;
    const onAbort = (): void => {
      if (resultHandle) void resultHandle.cancel().catch(() => undefined);
    };
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      await logRequest({
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
          await logGeneration({
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
      await logGeneration({
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
    } finally {
      signal.removeEventListener('abort', onAbort);
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

function deriveCompletionStatus(input: DeriveCompletionInput): AgentCoreEventStatus {
  if (input.totalCostUsd >= input.maxBudgetUsd) return 'max_budget';
  // Turn numbers are 0-indexed (turn 0 = initial request). stepCountIs(n)
  // stops when the *step count* (1-indexed) reaches n, i.e. when turnNumber
  // hits n - 1. Treating "max turnNumber observed + 1 >= maxTurns" as the
  // step-count threshold matches that.
  if (input.maxTurnNumber + 1 >= input.maxTurns) return 'max_turns';
  return 'success';
}
