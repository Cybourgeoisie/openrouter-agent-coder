import {
  OpenRouter,
  stepCountIs,
  maxCost,
  isTurnStartEvent,
  isTurnEndEvent,
  isToolCallOutputEvent,
  type Tool,
  type StateAccessor,
  type ConversationState,
} from '@openrouter/agent';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  COMPACTION_PROMPT,
  DEFAULT_KEEP_RECENT_TURNS,
  estimateMessagesCharLength,
  partitionMessages,
  resolveCompactionThresholdChars,
} from './compaction.js';
import { allTools } from './tools/index.js';
import { createServerToolsHooks } from './tools/server-tools.js';
import { type ToolContext } from './tools/context.js';
import type { OnAskUserQuestion } from './tools/ask-user-question.js';
import type { OnTasksChanged, TaskListRef } from './tools/tasks.js';
import { createFileStateAccessor } from './state/file-state.js';
import { createMemoryStateAccessor } from './state/memory-state.js';
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
  PreToolUseAction,
  TokenUsage,
} from './events.js';
import { permissionModeToCanUseTool, type PermissionMode } from './permission-modes.js';
import { buildToolFilterCanUseTool } from './tool-filters.js';
import { composeInstructions, type SettingSource } from './context-discovery.js';
import { aggregateMessages, type AgentMessage } from './messages.js';
import { forkSession, type ForkSessionResult } from './session-fork.js';
import {
  DEFAULT_MAX_SUBAGENT_DEPTH,
  DEFAULT_MAX_PARALLEL_SUBAGENTS,
  type SubagentRunner,
  type SubagentRunResult,
} from './tools/spawn-subagent.js';

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

/**
 * Phase 5.4: normalized reasoning-depth knob accepted by OpenRouter's
 * `reasoning.effort` field. OR maps the requested level to each provider's
 * native parameter (OpenAI `reasoning_effort`, Anthropic `thinking.budget_tokens`,
 * Gemini `thinkingConfig.thinkingLevel`, Qwen `thinking_budget`, xAI
 * `reasoning_effort`) and substitutes the nearest supported level when a model
 * lacks the requested one. Ignored by non-reasoning models.
 */
export type EffortLevel = 'xhigh' | 'high' | 'medium' | 'low' | 'minimal' | 'none';

export type CanUseTool = (
  toolName: string,
  input: unknown,
) => Promise<CanUseToolResult> | CanUseToolResult;

/**
 * Lifecycle hook callback. Invoked with a {@link HookEvent} discriminator and
 * the matching {@link HookPayload} variant. Hooks are awaited; thrown errors
 * are logged via {@link AgentLogger} and swallowed (a throw is NEVER treated
 * as a block — that would silently flip a working hook from "allow + recover"
 * to "deny" if the handler later starts throwing).
 *
 * For the `PreToolUse` event specifically, the handler MAY return a
 * {@link PreToolUseAction} to short-circuit (`block`) or rewrite (`modify`)
 * the tool call before {@link CanUseTool} runs. Returning `void`/`undefined`
 * (the historical contract) is equivalent to `{ action: 'continue' }` — the
 * tool call proceeds with the original input. Every other event's return
 * value is ignored.
 *
 * Order of evaluation per tool call when both `onHook` and `canUseTool` are
 * set:
 * 1. `PreToolUse` fires. `block` → synth-denial tool result, `PostToolUse`
 *    still fires with `isError: true`; `modify` → effective input becomes
 *    the substituted value.
 * 2. `canUseTool` runs against the (possibly modified) input.
 * 3. The underlying tool executes if both steps allow.
 *
 * Precedence: hook-`block` beats `canUseTool`-allow (canUseTool is never
 * consulted on block). `canUseTool`-`deny` beats hook-`continue`/`modify`
 * (deny short-circuits whatever the hook permitted).
 */
export type OnHook = (
  event: HookEvent,
  payload: HookPayload,
) => void | PreToolUseAction | Promise<void | PreToolUseAction>;

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
   * Tool set passed to the model. Defaults to the built-in 12-client-tool set
   * bound to a {@link ToolContext} derived from the run's `cwd` and composite
   * AbortSignal; server tools (datetime/web_search/web_fetch) are injected via
   * hooks. Custom tools supplied here are NOT context-bound — callers are
   * responsible for their own cwd resolution and cancellation if needed.
   */
  tools?: readonly Tool[];
  /**
   * Host callback that powers the built-in `ask_user_question` tool. The
   * callback receives a {@link UserQuestionRequest} (UUID `questionId`,
   * question text, options with auto-assigned ids `a`/`b`/`c`…, optional
   * `allowFreeText` flag) and must resolve with a {@link UserQuestionResponse}
   * carrying the user's choice. When omitted, the tool surfaces an
   * `{ error: 'no host handler registered for ask_user_question' }` tool
   * result so the model can recover gracefully. Ignored when a custom `tools`
   * array is supplied (callers wire their own `ask_user_question` if needed).
   *
   * The same request payload is also pushed via the `Notification` hook
   * (level `'info'`, message `'ask_user_question'`, context = the request),
   * so subscribers that only listen on `onHook` still observe the question.
   */
  onAskUserQuestion?: OnAskUserQuestion;
  /**
   * Convenience callback fired after every `task_create` / `task_update`
   * mutation with the full latest task list (defensive shallow-copy — safe
   * to retain). Equivalent to filtering the `Notification` hook on
   * `message === 'tasks_changed'`; supply this when the host doesn't want to
   * subscribe to every Notification just to render the task list. Threaded
   * into the default tool bundle only — ignored when a custom `tools` array
   * is supplied (callers wire their own `task_create` / `task_update` if
   * needed).
   */
  onTasksChanged?: OnTasksChanged;
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
   * Named permission preset translated into a {@link CanUseTool} internally.
   * See {@link PermissionMode} for the per-mode allow/deny matrix. When both
   * `permissionMode` and an explicit `canUseTool` are supplied, `canUseTool`
   * wins (explicit > implicit) and a `'warn'`-level log is emitted via
   * {@link AgentLogger}. Omit to default to "allow all" (parity with the prior
   * release).
   */
  permissionMode?: PermissionMode;
  /**
   * Pre-approve list of tool invocations. Entries are either a plain tool name
   * (`'read_file'`, also accepts the Claude-SDK-style alias `'Read'`) or a
   * scoped rule (e.g. `'Bash(npm *)'` or `'Edit(src/handlers.ts)'`; globs
   * support `*` and `**`). A matching rule short-circuits the
   * {@link permissionMode} gate to allow that call. Rules are validated at
   * construction — malformed input throws immediately.
   *
   * When `disallowedTools` matches the same call, the denial wins. Explicit
   * `canUseTool` overrides both lists entirely.
   */
  allowedTools?: readonly string[];
  /**
   * Deny list of tool invocations using the same grammar as
   * {@link allowedTools}. Denials win over both {@link allowedTools} matches
   * and the {@link permissionMode} gate. Explicit `canUseTool` overrides this
   * list entirely.
   */
  disallowedTools?: readonly string[];
  /**
   * Lifecycle hook callback. Fire order on the happy path:
   *
   * `Setup` (once, before any other hook — useful for first-run resource
   * provisioning) → `SessionStart` (after the `session_started` event yields,
   * with `sessionId`/`cwd`/`model`) → for each tool call: `PreToolUse`
   * (audit, fires even when `canUseTool` denies) → `PostToolUse` (with
   * `isError` matching the subsequent `tool_result.isError`) → `SessionEnd`
   * (after `stream_complete`, with final status/usage/cost) → `Stop` (last
   * hook in the run, carries the final status + an optional `reason` on
   * abort or thrown-error paths).
   *
   * `Notification` is the only hook event that is NOT auto-fired. Library
   * code or custom tools push it via {@link ToolContext.notify} (or by
   * calling `onHook` directly) to surface progress/errors to subscribers.
   *
   * `Setup` and `Stop` always bracket the run — including when the OR
   * client constructor throws or the run is aborted before any model
   * traffic. Hooks are awaited; thrown errors are logged via
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
  /**
   * Opt-in context-discovery sources. When non-empty, the agent walks each
   * source on the first iteration and **prepends** the discovered CLAUDE.md
   * content to {@link instructions} (or {@link DEFAULT_INSTRUCTIONS} when
   * unset). Final composed order is: `user` → `project` → `local` →
   * constructor `instructions`.
   *
   * Sources:
   * - `'project'` — walks up from `cwd`, picking up `<dir>/CLAUDE.md` and
   *   `<dir>/.claude/CLAUDE.md` at each level. Stops at the first directory
   *   containing `.git`, or at the filesystem root. Walk depth capped at 10.
   * - `'user'` — `<os.homedir()>/.claude/CLAUDE.md`.
   * - `'local'` — `<cwd>/.claude/CLAUDE.local.md`.
   *
   * Missing or unreadable files are silently skipped. The composed
   * instructions are capped at ~50k characters; on overflow the agent drops
   * contributions from the oldest source (user → project → local) and emits
   * a `'warn'`-level log via {@link logger}.
   *
   * Defaults to `[]` (back-compat: no discovery, no FS reads).
   */
  settingSources?: readonly SettingSource[];
  /**
   * When `false`, the run uses an in-memory {@link StateAccessor} and skips
   * every write under {@link logsRoot} — no `session.json`, no per-request
   * `request.json`, no per-generation `response.json`, no `state.json`. The
   * session is still tracked server-side via `sessionId`, hooks still fire,
   * and the event stream is byte-identical to a persisted run.
   *
   * Trade-offs: no resume across processes (the next process won't see
   * anything for this sessionId under `logsRoot`), and external readers of
   * the on-disk log (e.g. {@link readSessionLog} from Phase 1.6) will get
   * ENOENT for that sessionId.
   *
   * Defaults to `true` (back-compat: persist everything).
   */
  persistSession?: boolean;
  /**
   * Phase 4.6: when `true`, the built-in `write_file` and `edit_file` tools
   * snapshot their target path into the session's `checkpoints/` directory
   * **before** mutating it. Per-tool-call `checkpoint` field on those tools'
   * input schemas overrides this default. Defaults to `false` — no
   * auto-checkpointing.
   *
   * When the run is constructed with `persistSession: false`, requested
   * checkpoints become a NO-OP (in-memory sessions have no disk path to
   * persist snapshots to). The library emits a `'warn'`-level log via
   * {@link logger} when a checkpoint is requested but skipped, and the
   * underlying write proceeds normally.
   *
   * Ignored when the caller supplies a custom `tools` array — checkpointing
   * is a built-in-tools-only convenience.
   */
  checkpoint?: boolean;
  /**
   * Set when this run continues a session that was forked from another
   * (Phase 4.5). Threaded into the `session.json` that {@link logSessionStart}
   * writes, and surfaced on the `session_started` event payload so consumers
   * can render the lineage. Defaults to undefined — the field is omitted from
   * both on-disk and event payloads for root sessions.
   *
   * The library does NOT itself look up or validate the parent. Callers can
   * pair this with {@link forkSession} (or the {@link OpenRouterAgentRun.fork}
   * helper) to mint a child session id, then construct the next run with
   * `parentSessionId: <source>`.
   */
  parentSessionId?: string;
  /**
   * Phase 4.7: opt the built-in `spawn_subagent` tool into the default tool
   * bundle. When `true`, the agent appends `spawn_subagent` to the bundle
   * and wires an internal `SubagentRunner` that constructs child
   * {@link OpenRouterAgentRun}s with the parent's `apiKey` / `baseUrl` /
   * `appTitle` / `logsRoot` / `logger` / `onHook` / `model` / `cwd` /
   * `persistSession` inherited. Each child gets a fresh session id
   * (`<parentSessionId>:sub:<uuid>`) and `currentSubagentDepth =
   * parent + 1`.
   *
   * Defaults to `false` — subagent spawning stays an explicit, opt-in
   * feature (NOT in the default bundle). Ignored when the caller supplies
   * a custom `tools` array (callers wire their own `spawn_subagent` via
   * {@link spawnSubagentTool} if they need it).
   */
  enableSubagents?: boolean;
  /**
   * Maximum chain depth for subagent recursion (root counts as `0`).
   * Default {@link DEFAULT_MAX_SUBAGENT_DEPTH} = 3 — `spawn_subagent` is
   * allowed from depths `0`, `1`, `2` and rejects from depth `3`,
   * yielding a chain of at most three levels (parent → sub → sub-sub →
   * reject 4th). Threaded into every spawned subagent so the cap is
   * uniform across the whole chain.
   */
  maxSubagentDepth?: number;
  /**
   * Phase 4.7: this run's own position in the subagent chain (root = `0`,
   * first subagent = `1`, …). Set internally by the `spawn_subagent` tool
   * when constructing a child run — external callers should leave this
   * undefined (the default `0`).
   */
  currentSubagentDepth?: number;
  /**
   * Phase 4.9: maximum number of subagents allowed in-flight at once for a
   * single `spawn_subagents` (plural) invocation. Default
   * {@link DEFAULT_MAX_PARALLEL_SUBAGENTS} = 4 — picked as a balance
   * between OR API back-pressure (each child opens its own stream) and
   * meaningful parallelism on typical fan-outs. The plural tool's array
   * may be longer than the cap; excess specs queue and are submitted in
   * order as workers free up. Threaded into every spawned subagent so the
   * cap propagates uniformly down the chain (a depth-N subagent's own
   * plural spawns honor the same value). Ignored when the caller supplies
   * a custom `tools` array.
   */
  maxParallelSubagents?: number;
  /**
   * Phase 5.4: per-run reasoning-depth override. Forwarded into the OR
   * `callModel` call as `reasoning: { effort }` ONLY when set — omitted runs
   * never send a `reasoning` payload, preserving each model's default behavior.
   * See {@link EffortLevel} for the enum semantics and per-provider mapping.
   */
  effort?: EffortLevel;
  /**
   * Phase 5.1: character-count threshold that triggers an auto-compaction
   * pass once the persisted `ConversationState.messages` array crosses it.
   * Defaults to `getModelContextWindow(model) * 4 * 0.8` — i.e. ~80% of the
   * model's token-budget converted to a conservative chars-per-token
   * estimate. Pass an explicit number to override the default for the run
   * (interpreted as a raw character count, not a token count). Honoured only
   * when {@link autoCompact} is not `false`.
   */
  compactionThreshold?: number;
  /**
   * Phase 5.1: number of trailing messages (NOT strict turns — see
   * {@link partitionMessages} JSDoc for the granularity note) preserved
   * verbatim during compaction. Everything older is condensed into a single
   * `developer`-role summary message. Defaults to
   * {@link DEFAULT_KEEP_RECENT_TURNS} = 5.
   */
  keepRecentTurns?: number;
  /**
   * Phase 5.1: when `false`, suppresses the post-`stream_complete`
   * threshold check that automatically fires compaction between runs that
   * share a `sessionId`. The manual {@link OpenRouterAgentRun.compact}
   * method still works regardless of this setting — `autoCompact: false`
   * gates ONLY the implicit trigger. Defaults to `true`.
   */
  autoCompact?: boolean;
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
  onAskUserQuestion?: OnAskUserQuestion;
  onTasksChanged?: OnTasksChanged;
  signal?: AbortSignal;
  baseUrl?: string;
  logger?: AgentLogger;
  settingSources: readonly SettingSource[];
  persistSession: boolean;
  checkpoint: boolean;
  parentSessionId?: string;
  enableSubagents: boolean;
  maxSubagentDepth: number;
  currentSubagentDepth: number;
  maxParallelSubagents: number;
  /**
   * Phase 4.8: preserved here so the subagent runner can inherit the parent's
   * already-resolved `permissionMode` when a spawn call omits its own
   * override. The composed {@link canUseTool} is what actually gates the
   * parent's own tool calls — this field is only the inheritance source for
   * children.
   */
  permissionMode?: PermissionMode;
  /** Phase 4.8: same as {@link permissionMode}, but for `allowedTools`. */
  allowedTools?: readonly string[];
  /** Phase 4.8: same as {@link permissionMode}, but for `disallowedTools`. */
  disallowedTools?: readonly string[];
  /**
   * Phase 5.4: resolved per-run effort override. Forwarded into the OR
   * `callModel` call as `reasoning: { effort }` ONLY when defined (omitted →
   * no `reasoning` field in the request body), and inherited by spawned
   * subagents when their spec omits an override.
   */
  effort?: EffortLevel;
  /** Phase 5.1: explicit caller-supplied threshold (chars). `undefined` → derived from {@link model}. */
  compactionThreshold?: number;
  /** Phase 5.1: resolved trailing-message count to preserve verbatim. */
  keepRecentTurns: number;
  /** Phase 5.1: resolved auto-trigger toggle. */
  autoCompact: boolean;
}

function resolveOptions(opts: OpenRouterAgentRunOptions): ResolvedOptions {
  if (!opts.apiKey) {
    throw new Error('apiKey is required');
  }
  const cwd = opts.cwd ?? process.cwd();
  // Resolve the canUseTool gate in this precedence order:
  //   1. explicit canUseTool — wins outright; permissionMode + allowed/disallowed lists are ignored.
  //   2. allowedTools / disallowedTools — composed via buildToolFilterCanUseTool, with
  //      permissionMode (if set) supplied as the fallback gate.
  //   3. permissionMode alone — translated to a CanUseTool via permissionModeToCanUseTool.
  //   4. nothing — undefined gate, every tool runs (back-compat default).
  // When the explicit canUseTool collides with either of the higher-level
  // options, a single warn log mentioning all three names fires so the
  // conflict is visible to whoever is reading the log.
  const filterListsSet = opts.allowedTools !== undefined || opts.disallowedTools !== undefined;
  const sources: string[] = [];
  if (opts.canUseTool !== undefined) sources.push('canUseTool');
  if (opts.permissionMode !== undefined) sources.push('permissionMode');
  if (filterListsSet) sources.push('allowedTools/disallowedTools');

  let canUseTool: CanUseTool | undefined;
  if (opts.canUseTool !== undefined) {
    canUseTool = opts.canUseTool;
    if (sources.length > 1) {
      opts.logger?.(
        'warn',
        'Explicit canUseTool was supplied alongside higher-level permission options (permissionMode, allowedTools/disallowedTools); canUseTool wins and the others are ignored',
        { permissionMode: opts.permissionMode, sources },
      );
    }
  } else if (filterListsSet) {
    const modeGate =
      opts.permissionMode !== undefined
        ? permissionModeToCanUseTool(opts.permissionMode)
        : undefined;
    canUseTool = buildToolFilterCanUseTool({
      allowedTools: opts.allowedTools,
      disallowedTools: opts.disallowedTools,
      modeGate,
    });
  } else if (opts.permissionMode !== undefined) {
    canUseTool = permissionModeToCanUseTool(opts.permissionMode);
  }
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
    canUseTool,
    onHook: opts.onHook,
    onAskUserQuestion: opts.onAskUserQuestion,
    onTasksChanged: opts.onTasksChanged,
    signal: opts.signal,
    baseUrl: opts.baseUrl,
    logger: opts.logger,
    settingSources: opts.settingSources ?? [],
    persistSession: opts.persistSession ?? true,
    checkpoint: opts.checkpoint ?? false,
    parentSessionId: opts.parentSessionId,
    enableSubagents: opts.enableSubagents ?? false,
    maxSubagentDepth: opts.maxSubagentDepth ?? DEFAULT_MAX_SUBAGENT_DEPTH,
    currentSubagentDepth: opts.currentSubagentDepth ?? 0,
    maxParallelSubagents: opts.maxParallelSubagents ?? DEFAULT_MAX_PARALLEL_SUBAGENTS,
    ...(opts.permissionMode !== undefined && { permissionMode: opts.permissionMode }),
    ...(opts.allowedTools !== undefined && { allowedTools: opts.allowedTools }),
    ...(opts.disallowedTools !== undefined && { disallowedTools: opts.disallowedTools }),
    ...(opts.effort !== undefined && { effort: opts.effort }),
    ...(opts.compactionThreshold !== undefined && {
      compactionThreshold: opts.compactionThreshold,
    }),
    keepRecentTurns: opts.keepRecentTurns ?? DEFAULT_KEEP_RECENT_TURNS,
    autoCompact: opts.autoCompact ?? true,
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
  /**
   * Shared task list both `task_create` / `task_update` factories mutate.
   * Ephemeral per run — never persisted to `state.json`. Survives across
   * turns inside this run instance.
   */
  private readonly taskListRef: TaskListRef = { tasks: [] };
  /**
   * Snapshot of `persistSession` captured at construction. Used by
   * {@link fork} to short-circuit the in-memory rejection path without
   * touching the filesystem (and without exposing the full resolved-opts
   * struct on the instance).
   */
  private readonly persistSession: boolean;
  /**
   * Phase 5.1: state accessor created once at construction so the public
   * {@link compact} method can read/write the persisted
   * {@link ConversationState} without depending on whether {@link iterate}
   * has been driven yet. File-backed when `persistSession !== false`,
   * otherwise an in-memory mirror sharing the same load/save contract.
   */
  private readonly stateAccessor: StateAccessor;
  private consumed = false;

  constructor(options: OpenRouterAgentRunOptions) {
    this.opts = resolveOptions(options);
    this.hasCustomTools = options.tools !== undefined;
    this.persistSession = this.opts.persistSession;
    this.compositeSignal = options.signal
      ? AbortSignal.any([this.internalAbortController.signal, options.signal])
      : this.internalAbortController.signal;
    this.stateAccessor = this.persistSession
      ? createFileStateAccessor(this.opts.logsRoot, this.opts.sessionId)
      : createMemoryStateAccessor();
  }

  /**
   * Build a fresh OpenRouter client with the run's apiKey / baseUrl /
   * appTitle. Used by both the main {@link iterate} loop and the public
   * {@link compact} method — compaction needs its own short-lived client
   * because it may be called outside an active iteration.
   */
  private createOpenRouterClient(): OpenRouter {
    return new OpenRouter({
      apiKey: this.opts.apiKey,
      ...(this.opts.baseUrl && { serverURL: this.opts.baseUrl }),
      appTitle: this.opts.appTitle,
      hooks: createServerToolsHooks(),
    } as ConstructorParameters<typeof OpenRouter>[0]);
  }

  /**
   * Invoke the run's `onHook` handler with the given event/payload, returning
   * the handler's raw return value (or `undefined` when no handler is set or
   * the handler throws). Throws are logged via {@link AgentLogger} and
   * swallowed — never re-raised — so a handler cannot break the run. Used
   * by both {@link iterate} (via a thin local closure that forwards into
   * here) and {@link compact} (directly).
   */
  private async safeFireHook(event: HookEvent, payload: HookPayload): Promise<unknown> {
    const { onHook, logger } = this.opts;
    if (!onHook) return undefined;
    try {
      return await onHook(event, payload);
    } catch (err) {
      logger?.('error', 'Hook threw', { event, error: err });
      return undefined;
    }
  }

  /**
   * Phase 5.1: condense the older portion of this run's persisted message
   * history into a single `developer`-role summary message, replacing the
   * prefix on disk. Loads {@link ConversationState} via the run's
   * {@link StateAccessor}, fires the {@link HookEvent} `PreCompact` audit
   * hook with the slice about to be summarized, spawns an isolated
   * single-shot `callModel` (session id `<sessionId>:compact:<uuid>`, no
   * tools) to produce the summary text, then writes back a new
   * `ConversationState` where:
   *
   * - `messages` is `[summary, ...lastKeepRecentTurns]`
   * - `previousResponseId` is cleared (the server cannot splice a stale
   *   response chain onto a rewritten message array; see spike 5.S1 §2d).
   * - In-flight bookkeeping fields (`pendingToolCalls`,
   *   `unsentToolResults`, `partialResponse`) are cleared.
   *
   * No-ops (resolved promise, no hook fired, no state mutation) when the
   * accessor has no saved state, when `messages` is empty, or when the
   * history is shorter than {@link OpenRouterAgentRunOptions.keepRecentTurns}.
   *
   * **Contract — mid-run safety.** Designed to be called between runs that
   * share a `sessionId`, NOT mid-`for await`. The run iterator is
   * single-shot and the SDK manages the in-memory `ConversationState` while
   * a stream is active; calling `compact()` while {@link iterate} is still
   * yielding will race with the SDK's own `state.save()` calls and may
   * corrupt the persisted JSON. Auto-compaction (`autoCompact: true`) sites
   * the trigger AFTER the run's terminal `stream_complete` event for
   * exactly this reason — the SDK has finished writing by then.
   *
   * Audit-only failures (PreCompact hook throw) are swallowed via the
   * existing {@link safeFireHook} convention. A failed summarizer call
   * leaves the original state untouched and re-throws so the caller can
   * decide how to recover.
   */
  async compact(reason: 'auto' | 'manual' = 'manual'): Promise<void> {
    const state = await this.stateAccessor.load();
    if (!state) return;
    const rawMessages = (state as { messages?: unknown }).messages;
    if (!Array.isArray(rawMessages) || rawMessages.length === 0) return;
    const { summarize, keep } = partitionMessages(rawMessages, this.opts.keepRecentTurns);
    if (summarize.length === 0) return;

    await this.safeFireHook('PreCompact', {
      event: 'PreCompact',
      messages: summarize,
      keepRecentTurns: this.opts.keepRecentTurns,
      reason,
    });

    const client = this.createOpenRouterClient();
    const compactSessionId = `${this.opts.sessionId}:compact:${randomUUID()}`;
    const result = client.callModel({
      model: this.opts.model,
      sessionId: compactSessionId,
      input: JSON.stringify(summarize),
      instructions: COMPACTION_PROMPT,
    } as Parameters<typeof client.callModel>[0]);

    let summaryText = '';
    for await (const event of result.getFullResponsesStream()) {
      if (
        typeof event === 'object' &&
        event !== null &&
        'type' in event &&
        (event as { type: unknown }).type === 'response.output_text.delta'
      ) {
        const delta = (event as { delta?: unknown }).delta;
        if (typeof delta === 'string') summaryText += delta;
      }
    }

    const summaryMessage = {
      type: 'message' as const,
      role: 'developer' as const,
      content: `[Compacted prior context]\n${summaryText}`,
    };

    const nextState: ConversationState = {
      ...state,
      messages: [summaryMessage, ...keep] as ConversationState['messages'],
      updatedAt: Date.now(),
    };
    // The SDK uses `undefined` to mean "absent" for these optional fields;
    // deleting them keeps the on-disk JSON tidy and lets a re-load via the
    // accessor yield the same shape the SDK would build from scratch.
    delete (nextState as { previousResponseId?: unknown }).previousResponseId;
    delete (nextState as { pendingToolCalls?: unknown }).pendingToolCalls;
    delete (nextState as { unsentToolResults?: unknown }).unsentToolResults;
    delete (nextState as { partialResponse?: unknown }).partialResponse;

    await this.stateAccessor.save(nextState);
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

  /**
   * Aggregated message-level view of the run. Drains the underlying
   * {@link AgentCoreEvent} stream and yields typed
   * {@link AgentMessage}s — `SystemMessage(session_start)` → per-turn
   * `AssistantMessage` / `UserMessage` → `ResultMessage` →
   * `SystemMessage(session_end)`.
   *
   * **One consumer per run.** A single {@link OpenRouterAgentRun} instance is
   * single-shot; iterating it via `for await (... of run)` AND via
   * `run.messages()` is unsupported (the second call throws). Pick whichever
   * view you need — the message stream is an opt-in alternative, not a
   * supplement, to the raw event stream.
   *
   * See {@link aggregateMessages} for the precise event → message rules.
   */
  messages(): AsyncIterable<AgentMessage> {
    return aggregateMessages(this, this.opts.sessionId);
  }

  /**
   * Fork this run's session — copy the on-disk `state.json` to a new session
   * directory under the same `logsRoot`, and stamp a fresh `session.json` with
   * `parentSessionId` set to this run's session id. Convenience wrapper around
   * {@link forkSession} that reuses the run's already-resolved `logsRoot`.
   *
   * Rejects with the documented in-memory error when this run was constructed
   * with `persistSession: false` — there is no `state.json` to copy. The check
   * is local (no FS touch), so callers don't pay an I/O round-trip just to
   * learn the run was ephemeral.
   *
   * Note: forking after construction but before iteration is technically legal
   * — it will reject with the in-memory error path because no `state.json`
   * has been written yet, regardless of `persistSession`. The intended call
   * site is post-iteration, once the run has persisted at least one turn.
   */
  fork(opts: { newSessionId?: string } = {}): Promise<ForkSessionResult> {
    if (!this.persistSession) {
      return Promise.reject(
        new Error(
          `cannot fork in-memory session: ${this.opts.sessionId} has no on-disk state at ${join(this.opts.logsRoot, this.opts.sessionId, 'state.json')}`,
        ),
      );
    }
    return forkSession({
      sessionId: this.opts.sessionId,
      logsRoot: this.opts.logsRoot,
      ...(opts.newSessionId !== undefined && { newSessionId: opts.newSessionId }),
    });
  }

  private async *iterate(): AsyncGenerator<AgentCoreEvent> {
    const {
      apiKey,
      sessionId,
      prompt,
      instructions: baseInstructions,
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
      settingSources,
      persistSession,
      onAskUserQuestion,
      onTasksChanged,
      parentSessionId,
    } = this.opts;
    // Discovery happens here (not in resolveOptions) so the constructor stays
    // synchronous and the public API shape is unchanged. When settingSources
    // is empty, composeInstructions short-circuits without any FS reads.
    const instructions =
      settingSources.length > 0
        ? await composeInstructions({ cwd, settingSources, instructions: baseInstructions, logger })
        : baseInstructions;

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
    // Mirrors sessionEndPayload but for the trailing Stop hook. Stop fires
    // last regardless of completion status; reason is populated on abort or
    // thrown-error paths so subscribers can distinguish clean from dirty exit.
    let stopPayload: Extract<HookPayload, { event: 'Stop' }> = { event: 'Stop', status: 'error' };

    // Thin forwarder around the class-level safeFireHook so the existing
    // closures in this generator (subagent lifecycle emitters,
    // wrapToolWithHooks plumbing, etc.) keep their original call signature.
    // The class-level method exists so {@link compact} can fire PreCompact
    // outside this generator without duplicating the try/catch.
    const safeFireHook = (event: HookEvent, payload: HookPayload): Promise<unknown> =>
      this.safeFireHook(event, payload);

    // Setup fires once per OpenRouterAgentRun instance, before any other hook
    // (including SessionStart). It precedes the pre-abort short-circuit and
    // the OR client constructor so abort-at-construction and
    // OR-constructor-throw paths still emit a Setup → ... → Stop bracket.
    await safeFireHook('Setup', { event: 'Setup', sessionId, cwd });

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
        stopPayload = { event: 'Stop', status: 'error', reason: ABORT_REASON };
        return;
      }

      let client: OpenRouter;
      try {
        client = this.createOpenRouterClient();
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
        stopPayload = { event: 'Stop', status: 'error', reason: message };
        return;
      }

      if (persistSession) {
        await logSessionStart(logsRoot, sessionId, cwd, parentSessionId);
      }

      yield {
        type: 'session_started',
        sessionId,
        ...(parentSessionId !== undefined && { parentSessionId }),
      };
      await safeFireHook('SessionStart', { event: 'SessionStart', sessionId, cwd, model });

      const requestId = createRequestId();
      // Phase 5.1: the accessor is created in the constructor so {@link compact}
      // can reach the same in-memory cache (when `persistSession: false`) or
      // the same on-disk path (when persisted) without duplicating
      // construction. Captured here only to satisfy the local `state` name
      // the SDK passes through.
      const state = this.stateAccessor;
      // Note: server-side tools (datetime/web_search/web_fetch) are injected
      // via OR SDK hooks and execute on OpenRouter's servers — they bypass this
      // wrapper, so canUseTool only ever sees client tools.
      // ctx.notify is injected at tool-execute time by wrapToolWithHooks (so
      // both built-in and custom tools receive it via the SDK ToolExecuteContext
      // they get at call time), not here at factory time. Built-in tool
      // factories close over this ctx for cwd/signal only.
      const ctx: ToolContext = {
        cwd,
        signal,
        sessionId,
        logsRoot,
        checkpoint: this.opts.checkpoint,
        persistSession,
        ...(logger && { logger }),
      };
      // Subagent runner closure (Phase 4.7). Inherits the parent's
      // `apiKey` / `baseUrl` / `appTitle` / `logsRoot` / `logger` / `onHook`
      // / `model` / `cwd` / `persistSession` and constructs a child
      // OpenRouterAgentRun with a fresh session id, the spawn-supplied
      // prompt + optional overrides, and the composite abort signal the
      // factory built. Builds the child's tool pool itself (with
      // `spawn_subagent` at the next depth for further recursion) and
      // passes it via the `tools` arg — the child run sees
      // `hasCustomTools=true` and skips its own default-bundle path.
      const runSubagent: SubagentRunner = async (config) => {
        const childCtx: ToolContext = {
          cwd,
          signal: config.signal,
          sessionId: config.sessionId,
          logsRoot,
          checkpoint: this.opts.checkpoint,
          persistSession,
          ...(logger && { logger }),
        };
        const childTaskListRef: TaskListRef = { tasks: [] };
        const childAllTools = allTools(childCtx, {
          ...(onAskUserQuestion && { onAskUserQuestion }),
          ...(onTasksChanged && { onTasksChanged }),
          taskListRef: childTaskListRef,
          spawnSubagent: {
            parentSessionId: config.sessionId,
            currentDepth: config.depth,
            maxDepth: this.opts.maxSubagentDepth,
            runSubagent,
            onSubagentLifecycle: async (event, payload) => {
              await safeFireHook(event, payload);
            },
          },
          spawnSubagents: {
            parentSessionId: config.sessionId,
            currentDepth: config.depth,
            maxDepth: this.opts.maxSubagentDepth,
            maxParallel: this.opts.maxParallelSubagents,
            runSubagent,
            onSubagentLifecycle: async (event, payload) => {
              await safeFireHook(event, payload);
            },
          },
        });
        const toolNames = config.toolNames;
        const childTools =
          toolNames !== undefined
            ? childAllTools.filter((t) => toolNames.includes(t.function.name))
            : childAllTools;
        // Phase 4.8: per-subagent overrides REPLACE the parent's resolved
        // value (instead of composing). The parent's `permissionMode` /
        // `allowedTools` / `disallowedTools` / `model` / `effort` only flow
        // into the child when the spawn call omits its own override. This
        // mirrors the documented semantics in the `spawn_subagent` Zod
        // schema's doc comment — keep the two in sync if either changes.
        const childModel = config.model ?? this.opts.model;
        const childPermissionMode = config.permissionMode ?? this.opts.permissionMode;
        const childAllowedTools = config.allowedTools ?? this.opts.allowedTools;
        const childDisallowedTools = config.disallowedTools ?? this.opts.disallowedTools;
        const childEffort = config.effort ?? this.opts.effort;
        const child = new OpenRouterAgentRun({
          apiKey,
          sessionId: config.sessionId,
          prompt: config.prompt,
          instructions: config.instructions ?? baseInstructions,
          model: childModel,
          cwd,
          maxTurns: config.maxTurns ?? maxTurns,
          maxBudgetUsd: config.maxBudgetUsd ?? maxBudgetUsd,
          appTitle,
          logsRoot,
          persistSession,
          tools: childTools,
          signal: config.signal,
          maxParallelSubagents: this.opts.maxParallelSubagents,
          ...(baseUrl && { baseUrl }),
          ...(logger && { logger }),
          ...(onHook && { onHook }),
          ...(childPermissionMode !== undefined && { permissionMode: childPermissionMode }),
          ...(childAllowedTools !== undefined && { allowedTools: childAllowedTools }),
          ...(childDisallowedTools !== undefined && { disallowedTools: childDisallowedTools }),
          ...(childEffort !== undefined && { effort: childEffort }),
        });
        let text = '';
        let summary: SubagentRunResult = {
          status: 'error',
          text: '',
          reason: 'subagent produced no stream_complete event',
        };
        for await (const ev of child) {
          if (ev.type === 'text_delta') {
            text += ev.content;
          } else if (ev.type === 'stream_complete') {
            summary = {
              status: ev.status,
              text,
              ...(ev.usage !== undefined && { usage: ev.usage }),
              ...(ev.costUsd !== undefined && { costUsd: ev.costUsd }),
              ...(ev.durationMs !== undefined && { durationMs: ev.durationMs }),
              ...(ev.reason !== undefined && { reason: ev.reason }),
            };
          }
        }
        return summary;
      };
      // Order of wraps (innermost → outermost): ctx-bound execute, then
      // canUseTool gate, then hook wrapper. The hook wrapper is outermost so
      // PreToolUse fires before the canUseTool decision (audit always fires,
      // even on deny), and PostToolUse fires after the inner result/error is
      // resolved — including the synth-deny payload from a canUseTool denial.
      const baseTools: readonly Tool[] = this.hasCustomTools
        ? userTools
        : allTools(ctx, {
            onAskUserQuestion,
            onTasksChanged,
            taskListRef: this.taskListRef,
            ...(this.opts.enableSubagents && {
              spawnSubagent: {
                parentSessionId: sessionId,
                currentDepth: this.opts.currentSubagentDepth,
                maxDepth: this.opts.maxSubagentDepth,
                runSubagent,
                onSubagentLifecycle: async (event, payload) => {
                  await safeFireHook(event, payload);
                },
              },
              spawnSubagents: {
                parentSessionId: sessionId,
                currentDepth: this.opts.currentSubagentDepth,
                maxDepth: this.opts.maxSubagentDepth,
                maxParallel: this.opts.maxParallelSubagents,
                runSubagent,
                onSubagentLifecycle: async (event, payload) => {
                  await safeFireHook(event, payload);
                },
              },
            }),
          });
      const permissionedTools = this.opts.canUseTool
        ? baseTools.map((t) => wrapToolWithPermission(t, this.opts.canUseTool!))
        : baseTools;
      const toolsForRun = onHook
        ? permissionedTools.map((t) => wrapToolWithHooks(t, safeFireHook, logger))
        : permissionedTools;

      signal.addEventListener('abort', onAbort, { once: true });
      abortListenerInstalled = true;

      if (persistSession) {
        await logRequest(logsRoot, {
          sessionId,
          requestId,
          prompt,
          timestamp: new Date().toISOString(),
        });
      }

      const result = client.callModel({
        model,
        sessionId,
        input: [{ role: 'user' as const, content: prompt }],
        instructions,
        tools: toolsForRun,
        state,
        stopWhen: [stepCountIs(maxTurns), maxCost(maxBudgetUsd)],
        ...(this.opts.effort !== undefined && { reasoning: { effort: this.opts.effort } }),
        onTurnEnd: async (_ctx, response) => {
          if (persistSession) {
            const generationId = createGenerationId();
            await logGeneration(logsRoot, {
              sessionId,
              requestId,
              generationId,
              response,
              timestamp: new Date().toISOString(),
            });
          }
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
        stopPayload = { event: 'Stop', status: 'error', reason: ABORT_REASON };
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

      if (persistSession) {
        const finalGenId = createGenerationId();
        await logGeneration(logsRoot, {
          sessionId,
          requestId,
          generationId: finalGenId,
          response,
          timestamp: new Date().toISOString(),
        });
      }

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

      // Phase 5.1: post-stream auto-compaction check. Runs only on the happy
      // path (status === 'success' covers max_turns/max_budget exits via the
      // 'success' arm too — those still produced a useful turn worth
      // condensing). Errors from the summarizer call are caught here so the
      // SessionEnd / Stop hook bracket below still fires.
      if (this.opts.autoCompact && status === 'success') {
        try {
          const persistedState = await this.stateAccessor.load();
          const messages = (persistedState as { messages?: unknown } | null)?.messages;
          const chars = estimateMessagesCharLength(messages);
          const thresholdChars = resolveCompactionThresholdChars(
            this.opts.compactionThreshold,
            this.opts.model,
          );
          if (chars >= thresholdChars) {
            await this.compact('auto');
          }
        } catch (err) {
          logger?.('error', 'Auto-compaction failed', { error: err });
        }
      }

      sessionEndPayload = {
        event: 'SessionEnd',
        sessionId,
        status,
        usage: finalUsage,
        costUsd: totalCostUsd,
      };
      stopPayload = { event: 'Stop', status };
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
        stopPayload = { event: 'Stop', status: 'error', reason: ABORT_REASON };
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
      stopPayload = { event: 'Stop', status: 'error', reason: message };
    } finally {
      if (abortListenerInstalled) {
        signal.removeEventListener('abort', onAbort);
      }
      if (sessionEndPayload) {
        await safeFireHook('SessionEnd', sessionEndPayload);
      }
      // Stop is the last hook event in the run. Fires regardless of how we
      // exited iterate(); when the run somehow exited without setting
      // stopPayload, the default 'error' captured at init time is used.
      await safeFireHook('Stop', stopPayload);
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
 * the synth-deny payload from a permission denial OR a hook `block`) as the
 * PostToolUse output.
 *
 * Phase 3.7: `PreToolUse` may return a {@link PreToolUseAction}.
 *
 * - `block` synthesises the same `{ error, denied: true }` JSON shape used by
 *   {@link wrapToolWithPermission}, throws it (so the OR SDK marks the tool
 *   result as `status: 'incomplete'`), and lets the catch arm fire a single
 *   `PostToolUse` carrying the synth output. `canUseTool` is NEVER consulted
 *   on block — precedence: hook-block > canUseTool-allow.
 * - `modify` substitutes the input that flows into `originalExecute` (which
 *   IS the `canUseTool` wrapper when one is wired), so the modified input is
 *   what `canUseTool` decides on and what the underlying tool runs against.
 *   The `tool_call` event the consumer sees is unchanged — `modify` is
 *   invisible at the event-stream layer except for the eventual
 *   `tool_result`. `PreToolUse.input` reflects the ORIGINAL input (the hook
 *   already decided to modify; echoing the change is redundant);
 *   `PostToolUse.input` also stays original for symmetry with how
 *   `canUseTool`'s `updatedInput` is invisible there.
 * - `continue` (or a `void` / `undefined` return — the historical contract)
 *   leaves the call unchanged.
 *
 * Precedence the other way round — `canUseTool` may still deny after the
 * hook returns `continue`/`modify`; that deny wins, the hook's intent is
 * overridden, and the consumer sees the canUseTool reason in the tool result.
 *
 * The OR SDK's `ToolExecuteContext` carries the live `FunctionCallItem` on
 * `ctx.toolCall`, so the SDK-issued call id is preferred. When that is absent
 * (custom tools wired without the standard SDK context, or tests that pass a
 * bare `{}`), a synthetic UUID is generated for the hook payload — the two
 * payloads of a single Pre/Post pair always share the same id.
 */
function wrapToolWithHooks(
  t: Tool,
  safeFireHook: (event: HookEvent, payload: HookPayload) => Promise<unknown>,
  logger?: AgentLogger,
): Tool {
  const fn = t.function as { name: string; execute?: (i: unknown, c?: unknown) => unknown };
  const name = fn.name;
  const originalExecute = fn.execute;
  if (typeof originalExecute !== 'function') return t;
  const wrappedExecute = async (input: unknown, ctx?: unknown): Promise<unknown> => {
    const sdkCallId = (ctx as { toolCall?: { callId?: unknown } } | undefined)?.toolCall?.callId;
    const callId = typeof sdkCallId === 'string' && sdkCallId.length > 0 ? sdkCallId : randomUUID();
    // Merge ctx.notify onto the SDK-supplied ToolExecuteContext so tools
    // (built-in or custom) can emit Notification hooks. Object.assign tolerates
    // a missing source ctx (returns just the notify-bearing object), so there's
    // no need to branch on ctx shape — the wrapper is only ever applied when
    // onHook is wired, so notify is always present in the merged result.
    const ctxWithNotify = Object.assign({}, ctx as object | undefined, {
      notify: (
        level: 'info' | 'warn' | 'error',
        message: string,
        context?: unknown,
      ): Promise<unknown> =>
        safeFireHook('Notification', { event: 'Notification', level, message, context }),
    });
    const preResult = await safeFireHook('PreToolUse', {
      event: 'PreToolUse',
      toolName: name,
      input,
      callId,
    });
    const preAction = parsePreToolUseAction(preResult, name, logger);
    const effectiveInput = preAction.action === 'modify' ? preAction.input : input;
    try {
      if (preAction.action === 'block') {
        // Throw with the same JSON shape canUseTool's deny path uses so the
        // synth `tool_result` payload is shape-identical between the two
        // denial sources. The catch arm fires PostToolUse with the JSON as
        // output, then re-throws so the SDK marks the tool result incomplete.
        throw new Error(JSON.stringify({ error: preAction.reason, denied: true }));
      }
      const output = await originalExecute(effectiveInput, ctxWithNotify);
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

/**
 * Validate the raw value returned by a `PreToolUse` handler into a
 * {@link PreToolUseAction}. `null`/`undefined`/`void` returns (the
 * backward-compat path) become `continue`. Malformed objects (wrong shape,
 * unrecognised `action`, missing `reason`/`input`) also become `continue`,
 * with a `warn`-level log so the misuse is visible. This keeps the run alive
 * — silently degrading to "tool executes" is safer than translating a
 * malformed return into an accidental block.
 */
function parsePreToolUseAction(
  raw: unknown,
  toolName: string,
  logger?: AgentLogger,
): PreToolUseAction {
  if (raw == null) return { action: 'continue' };
  if (typeof raw !== 'object') {
    logger?.('warn', 'PreToolUse handler returned a non-object; treating as continue', {
      toolName,
      returned: raw,
    });
    return { action: 'continue' };
  }
  const obj = raw as { action?: unknown; reason?: unknown; input?: unknown };
  if (obj.action === 'continue') return { action: 'continue' };
  if (obj.action === 'block') {
    if (typeof obj.reason === 'string') return { action: 'block', reason: obj.reason };
    logger?.('warn', 'PreToolUse block action missing string `reason`; treating as continue', {
      toolName,
    });
    return { action: 'continue' };
  }
  if (obj.action === 'modify') {
    if ('input' in obj) return { action: 'modify', input: obj.input };
    logger?.('warn', 'PreToolUse modify action missing `input` field; treating as continue', {
      toolName,
    });
    return { action: 'continue' };
  }
  logger?.('warn', 'PreToolUse handler returned unrecognised action; treating as continue', {
    toolName,
    action: obj.action,
  });
  return { action: 'continue' };
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
