import { tool } from '@openrouter/agent';
import { z } from 'zod/v4';
import { randomUUID } from 'node:crypto';
import { DEFAULT_TOOL_CONTEXT, type ToolContext } from './context.js';
import type {
  AgentCoreEventStatus,
  HookEvent,
  HookPayload,
  SubagentResultSummary,
  TokenUsage,
} from '../events.js';
import type { PermissionMode } from '../permission-modes.js';

/**
 * Default cap on the subagent chain depth (root counts as `0`). With the
 * default, `spawn_subagent` is allowed from runs at depth `0`, `1`, and `2`,
 * and rejects from depth `3` onward — yielding a chain of at most three
 * levels (parent → sub → sub-sub → reject 4th).
 *
 * Tunable per-run via `OpenRouterAgentRunOptions.maxSubagentDepth`.
 */
export const DEFAULT_MAX_SUBAGENT_DEPTH = 3;

/**
 * Config the {@link SubagentRunner} closure receives from the
 * `spawn_subagent` tool's execute. Carries the prompt + optional restrictions
 * already parsed/validated from the model's tool input, plus the composite
 * abort signal and the chain depth the new run should run at.
 */
export interface SubagentRunConfig {
  sessionId: string;
  prompt: string;
  instructions?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** Optional whitelist of tool names — subagent's pool narrows to these only. */
  toolNames?: readonly string[];
  /**
   * Phase 4.8: per-subagent overrides. Each field, when set, REPLACES the
   * corresponding parent-resolved value on the child run's constructor args
   * (override wins; child does not COMPOSE with the parent's filters). When
   * omitted, the runner falls back to the parent's already-resolved value.
   */
  model?: string;
  permissionMode?: PermissionMode;
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
  /**
   * Pass-through to {@link OpenRouterAgentRunOptions.effort}. Currently a
   * no-op — the field is stored on the child run's opts but not consumed by
   * the OR call (`effort` wiring lands in Phase 5.4).
   */
  effort?: string;
  /** Composite abort signal that fires when either the parent or the subagent itself aborts. */
  signal: AbortSignal;
  /** Chain depth of the new subagent (root = 0, first subagent = 1, …). */
  depth: number;
}

/**
 * Result envelope handed back to the `spawn_subagent` tool by the runner.
 * Shape-identical to {@link SubagentResultSummary} — the runner drains the
 * subagent's event stream and produces this summary.
 */
export type SubagentRunResult = SubagentResultSummary;

/**
 * Closure injected at factory construction time. Builds and drives a new
 * `OpenRouterAgentRun` for the subagent, drains its event stream, and
 * resolves with the captured summary. The factory itself stays free of any
 * dependency on `agent.ts` (no import cycle).
 */
export type SubagentRunner = (config: SubagentRunConfig) => Promise<SubagentRunResult>;

/**
 * Lifecycle-emitter signature used by the factory to fire `SubagentStart`
 * and `SubagentEnd` on the parent's `onHook`. Wired by `agent.ts` to forward
 * straight into the run's `safeFireHook`. Optional — when omitted, the
 * `spawn_subagent` tool still works, but `SubagentStart`/`SubagentEnd` are
 * dropped (the inherited per-event hooks on the subagent itself still fire).
 */
export type SubagentLifecycleEmitter = (
  event: Extract<HookEvent, 'SubagentStart' | 'SubagentEnd'>,
  payload: Extract<HookPayload, { event: 'SubagentStart' | 'SubagentEnd' }>,
) => void | Promise<void>;

export interface SpawnSubagentToolOptions {
  /** Parent run's session id — threaded into the derived subagent session id and the hook payloads. */
  parentSessionId: string;
  /** Parent run's chain depth (root = 0). Defaults to `0`. */
  currentDepth?: number;
  /** Max allowed chain depth (see {@link DEFAULT_MAX_SUBAGENT_DEPTH}). */
  maxDepth?: number;
  /** Builds and drives a subagent run; resolves with the summary returned as the tool result. */
  runSubagent: SubagentRunner;
  /** Optional hook emitter for the parent's `SubagentStart`/`SubagentEnd` lifecycle events. */
  onSubagentLifecycle?: SubagentLifecycleEmitter;
}

/**
 * Result payload returned by the `spawn_subagent` tool's `execute`. The
 * happy-path variant carries the subagent's session id + the captured
 * result summary so the calling model can read what its child agent
 * produced; the error variant is reserved for depth-cap rejections and
 * runner throws (the subagent never started or never completed cleanly).
 */
export interface SpawnSubagentToolResult {
  /** Subagent session id (`<parentSessionId>:sub:<uuid>`). Present on both success and error paths so the host can correlate hook payloads with the surfaced tool result. */
  subagentSessionId: string;
  /** Final status reported by the subagent's `stream_complete`. Omitted only on a depth-cap rejection (the subagent never ran). */
  status?: AgentCoreEventStatus;
  /** Concatenated assistant text from every `text_delta` the subagent yielded. Omitted on the depth-cap rejection path. */
  text?: string;
  usage?: TokenUsage | null;
  costUsd?: number;
  durationMs?: number;
  reason?: string;
  /** Populated on a depth-cap rejection or a runner throw; otherwise omitted. */
  error?: string;
}

/**
 * Factory for the built-in `spawn_subagent` tool (Phase 4.7). Lets the
 * parent model delegate a focused subtask to a child `OpenRouterAgentRun`
 * with its own session id and (optionally) a narrowed tool whitelist. The
 * parent waits for the subagent to complete and receives a single
 * {@link SpawnSubagentToolResult} as the tool_result — the subagent's own
 * event stream is captured inside `runSubagent` and does NOT bleed into
 * the parent's `for await`.
 *
 * The factory has no dependency on `OpenRouterAgentRun` — the agent wires
 * a `runSubagent` closure that captures the parent's `apiKey` / `baseUrl`
 * / `logsRoot` / `logger` / `onHook` / `model` / `appTitle` / `cwd` /
 * `persistSession` and constructs the child run at call time.
 *
 * Tool input shape (zod):
 * - `description: string` — the prompt handed to the subagent.
 * - `tools?: string[]` — optional whitelist of tool names. Unknown names
 *   are dropped silently (runner-side); omit to inherit the parent's
 *   full tool pool.
 * - `instructions?: string` — system instructions override; omit to
 *   inherit the parent's.
 * - `max_turns?: number` — per-subagent override; omit to inherit.
 * - `max_budget_usd?: number` — per-subagent override; omit to inherit.
 * - `model?: string` — per-subagent model override (Phase 4.8); omit to
 *   inherit the parent's resolved `model`.
 * - `permission_mode?: PermissionMode` — per-subagent permission preset
 *   (`'default'` / `'acceptEdits'` / `'bypassPermissions'` / `'plan'`)
 *   (Phase 4.8); omit to inherit the parent's `permissionMode`.
 * - `allowed_tools?: string[]` — per-subagent allow list using the
 *   Phase 3.2 rule grammar (Phase 4.8). REPLACES the parent's list —
 *   parent's `allowedTools` does NOT bleed into the child.
 * - `disallowed_tools?: string[]` — per-subagent deny list using the
 *   Phase 3.2 rule grammar (Phase 4.8). Also REPLACES rather than
 *   COMPOSES.
 * - `effort?: string` — per-subagent effort override (Phase 4.8).
 *   Currently stored-but-no-op (consumed in Phase 5.4).
 *
 * Composition layers (innermost → outermost):
 * 1. `tools` (Phase 4.7) narrows the inherited tool *pool* by name.
 * 2. `permission_mode` (Phase 3.1) gates each call by tool name.
 * 3. `allowed_tools` / `disallowed_tools` (Phase 3.2) layer scoped rules
 *    on top of the mode gate.
 * 4. An optional caller-supplied `canUseTool` is the final word.
 *
 * The override semantics: each field, when supplied on the spawn call,
 * REPLACES the parent's resolved value on the child run's constructor.
 * Parent's mode/lists do NOT bleed in. (Composing would surprise users
 * — see the 4.8 PR body for the rationale.)
 *
 * The keys above are snake_case to match the model-facing tool-call
 * convention; they are mapped to camelCase on the child run's
 * constructor args.
 *
 * Recursion cap: the check `parent.depth + 1 >= maxDepth` fires before
 * the runner is invoked. On rejection the tool resolves with
 * `{ error: 'max subagent depth (<n>) exceeded', subagentSessionId }`
 * and a `SubagentEnd` (status `'error'`, reason matching) is still
 * emitted so audit consumers see a Start/End pair.
 *
 * Abort cascade: the subagent's abort signal is composed via
 * `AbortSignal.any([parentSignal, subagentInternalSignal])`, so the
 * parent's `abort()` (or any external signal threaded through `ctx.signal`)
 * propagates straight into the child without an explicit hand-off.
 */
export function spawnSubagentTool(
  opts: SpawnSubagentToolOptions,
  ctx: ToolContext = DEFAULT_TOOL_CONTEXT,
) {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_SUBAGENT_DEPTH;
  const parentDepth = opts.currentDepth ?? 0;
  return tool({
    name: 'spawn_subagent',
    description:
      "Delegate a focused subtask to a child agent with its own session and (optionally) a narrowed tool whitelist. The parent waits for the subagent to complete and receives the subagent's final assistant text plus status/cost as a single tool result. Use sparingly — only when the subtask has a clean, self-contained scope (research a question, refactor a file, run a verification pass). Returns `{ subagentSessionId, status, text, costUsd?, durationMs?, reason? }` on success or `{ error, subagentSessionId }` when the depth cap rejects or the runner throws.",
    inputSchema: z.object({
      description: z
        .string()
        .min(1)
        .describe('Prompt handed to the subagent — describe the subtask plainly.'),
      tools: z
        .array(z.string())
        .optional()
        .describe(
          "Optional whitelist of tool names the subagent may use (e.g. ['read_file', 'grep_files']). Unknown names are silently dropped. Omit to inherit the parent's full tool pool.",
        ),
      instructions: z
        .string()
        .optional()
        .describe("System instructions override. Omit to inherit the parent's."),
      max_turns: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Per-subagent turn cap. Omit to inherit the parent's `maxTurns`."),
      max_budget_usd: z
        .number()
        .positive()
        .optional()
        .describe("Per-subagent cost cap in USD. Omit to inherit the parent's `maxBudgetUsd`."),
      model: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Per-subagent model override (e.g. `'~anthropic/claude-sonnet-latest'`). Omit to inherit the parent's resolved `model`.",
        ),
      permission_mode: z
        .enum(['default', 'acceptEdits', 'bypassPermissions', 'plan'])
        .optional()
        .describe("Per-subagent permission preset. Omit to inherit the parent's `permissionMode`."),
      allowed_tools: z
        .array(z.string())
        .optional()
        .describe(
          "Per-subagent allow list using the same rule grammar as `OpenRouterAgentRun.allowedTools` (plain names or `Tool(pattern)`). REPLACES — does not compose with — the parent's allow list.",
        ),
      disallowed_tools: z
        .array(z.string())
        .optional()
        .describe(
          "Per-subagent deny list using the same rule grammar as `OpenRouterAgentRun.disallowedTools`. REPLACES — does not compose with — the parent's deny list.",
        ),
      effort: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Per-subagent effort override. Currently a no-op pass-through stored on the child run (full wiring lands in Phase 5.4).',
        ),
    }),
    execute: async (
      {
        description,
        tools,
        instructions,
        max_turns,
        max_budget_usd,
        model,
        permission_mode,
        allowed_tools,
        disallowed_tools,
        effort,
      },
      execCtx,
    ): Promise<SpawnSubagentToolResult> => {
      const subagentSessionId = `${opts.parentSessionId}:sub:${randomUUID()}`;
      const childDepth = parentDepth + 1;

      // Recursion cap — fire SubagentStart/End so audit consumers still see a
      // matched pair, then resolve with the depth-cap error. The runner is
      // never invoked on this path.
      if (childDepth >= maxDepth) {
        const reason = `max subagent depth (${maxDepth}) exceeded`;
        await opts.onSubagentLifecycle?.('SubagentStart', {
          event: 'SubagentStart',
          parentSessionId: opts.parentSessionId,
          subagentSessionId,
          depth: childDepth,
          prompt: description,
          ...(tools !== undefined && { toolNames: tools }),
        });
        const errResult: SubagentResultSummary = { status: 'error', reason, text: '' };
        await opts.onSubagentLifecycle?.('SubagentEnd', {
          event: 'SubagentEnd',
          parentSessionId: opts.parentSessionId,
          subagentSessionId,
          depth: childDepth,
          result: errResult,
        });
        return { error: reason, subagentSessionId };
      }

      // Compose the subagent's abort signal from the parent's (carried on
      // ctx.signal — usually the live SDK ToolExecuteContext doesn't expose
      // it, so we fall back to the factory-time ctx) and a subagent-internal
      // controller. The internal controller is unused here (no surface to
      // call abort() on it from outside), but it is documented for the
      // 4.9 parallel-subagent phase that will need finer-grained control.
      const subagentInternalCtl = new AbortController();
      const parentSignal = (execCtx as { signal?: AbortSignal } | undefined)?.signal ?? ctx.signal;
      const signal = parentSignal
        ? AbortSignal.any([parentSignal, subagentInternalCtl.signal])
        : subagentInternalCtl.signal;

      await opts.onSubagentLifecycle?.('SubagentStart', {
        event: 'SubagentStart',
        parentSessionId: opts.parentSessionId,
        subagentSessionId,
        depth: childDepth,
        prompt: description,
        ...(tools !== undefined && { toolNames: tools }),
      });

      let result: SubagentRunResult;
      try {
        result = await opts.runSubagent({
          sessionId: subagentSessionId,
          prompt: description,
          ...(instructions !== undefined && { instructions }),
          ...(max_turns !== undefined && { maxTurns: max_turns }),
          ...(max_budget_usd !== undefined && { maxBudgetUsd: max_budget_usd }),
          ...(tools !== undefined && { toolNames: tools }),
          ...(model !== undefined && { model }),
          ...(permission_mode !== undefined && { permissionMode: permission_mode }),
          ...(allowed_tools !== undefined && { allowedTools: allowed_tools }),
          ...(disallowed_tools !== undefined && { disallowedTools: disallowed_tools }),
          ...(effort !== undefined && { effort }),
          signal,
          depth: childDepth,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const errResult: SubagentResultSummary = { status: 'error', reason: message, text: '' };
        await opts.onSubagentLifecycle?.('SubagentEnd', {
          event: 'SubagentEnd',
          parentSessionId: opts.parentSessionId,
          subagentSessionId,
          depth: childDepth,
          result: errResult,
        });
        return { error: message, subagentSessionId };
      }

      await opts.onSubagentLifecycle?.('SubagentEnd', {
        event: 'SubagentEnd',
        parentSessionId: opts.parentSessionId,
        subagentSessionId,
        depth: childDepth,
        result,
      });

      const out: SpawnSubagentToolResult = {
        subagentSessionId,
        status: result.status,
        text: result.text,
      };
      if (result.usage !== undefined) out.usage = result.usage;
      if (result.costUsd !== undefined) out.costUsd = result.costUsd;
      if (result.durationMs !== undefined) out.durationMs = result.durationMs;
      if (result.reason !== undefined) out.reason = result.reason;
      return out;
    },
  });
}
