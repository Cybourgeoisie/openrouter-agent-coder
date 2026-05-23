import type { Usage } from '@openrouter/agent';

export type TokenUsage = Usage;

export type AgentCoreEventStatus = 'success' | 'max_turns' | 'max_budget' | 'error';

export type AgentCoreEvent =
  | { type: 'session_started'; sessionId: string }
  | { type: 'turn_start'; turnNumber: number }
  | { type: 'text_delta'; content: string }
  | { type: 'tool_call'; callId: string; name: string; input: unknown }
  | { type: 'tool_result'; callId: string; output: unknown; isError: boolean }
  | { type: 'turn_end'; turnNumber: number; usage: TokenUsage | null; costUsd: number }
  | {
      type: 'stream_complete';
      status: AgentCoreEventStatus;
      usage?: TokenUsage | null;
      costUsd?: number;
      durationMs?: number;
      reason?: string;
    }
  | { type: 'error'; message: string; cause?: unknown };

/**
 * Lifecycle hook event names fired by an {@link OpenRouterAgentRun}. Hooks are
 * audit-only — their return value cannot mutate the run, and exceptions thrown
 * inside a hook are logged and swallowed so they cannot break the agent.
 *
 * Fire order on the happy path:
 * `Setup` → `SessionStart` → (`PreToolUse`/`PostToolUse` pairs)* → `SessionEnd` → `Stop`.
 *
 * `Setup` and `Stop` always bracket the run — even when construction throws or
 * the run aborts before any model traffic. `Notification` is the only event
 * that is NOT fired by the runtime automatically: callers (library code or
 * custom tools via {@link ToolContext.notify}) emit it to push status updates
 * to subscribers.
 */
export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Stop'
  | 'Setup'
  | 'Notification';

/**
 * Discriminated union of hook payloads. The `event` field is the discriminator
 * — narrowing on it selects the correct payload shape.
 *
 * `usage` on `SessionEnd` is nullable: a run that aborts or fails before any
 * model response arrives has no usage to report. Consumers that want a numeric
 * fallback should treat null as zero.
 */
export type HookPayload =
  | { event: 'SessionStart'; sessionId: string; cwd: string; model: string }
  | {
      event: 'SessionEnd';
      sessionId: string;
      status: AgentCoreEventStatus;
      usage: TokenUsage | null;
      costUsd: number;
    }
  | { event: 'PreToolUse'; toolName: string; input: unknown; callId: string }
  | {
      event: 'PostToolUse';
      toolName: string;
      input: unknown;
      output: unknown;
      isError: boolean;
      callId: string;
    }
  /**
   * Fires once per {@link OpenRouterAgentRun} instance, BEFORE `SessionStart`.
   * Use for first-run resource provisioning (cache warmup, scratch dirs, etc.).
   * Lifetime semantics are per-run-instance, not per-process.
   */
  | { event: 'Setup'; sessionId: string; cwd: string }
  /**
   * Fires once per run, AFTER `SessionEnd`. Always the last hook event in the
   * run — even on abort or constructor-throw. `status` mirrors the final
   * {@link AgentCoreEventStatus}; `reason` carries an error message when one
   * is known (abort or thrown error).
   */
  | { event: 'Stop'; status: AgentCoreEventStatus; reason?: string }
  /**
   * Caller-emitted status update. The runtime never fires `Notification`
   * automatically; library code or custom tools push these via
   * {@link ToolContext.notify} (or by calling `onHook` directly) to surface
   * progress/errors to subscribers.
   */
  | {
      event: 'Notification';
      level: 'info' | 'warn' | 'error';
      message: string;
      context?: unknown;
    };

/**
 * Optional return value from a `PreToolUse` hook handler. Returning `void` (or
 * `undefined`) is equivalent to `{ action: 'continue' }` — the tool call
 * proceeds with the original input. The other two variants short-circuit or
 * mutate the call before `canUseTool` runs:
 *
 * - `block` — the tool is NOT executed. A synthetic denial result is surfaced
 *   as `tool_result.isError = true` with the same payload shape `canUseTool`'s
 *   deny path produces (`JSON.stringify({ error: reason, denied: true })`),
 *   and `PostToolUse` still fires with the synth output so audit consumers see
 *   a matched Pre/Post pair.
 * - `modify` — the substituted `input` becomes the effective input for the
 *   remainder of the call: `canUseTool` (if any) sees the modified input, and
 *   so does the tool's `execute`. The `tool_call` event already yielded to the
 *   consumer still reflects the ORIGINAL input — `modify` is invisible at the
 *   event-stream layer except via the eventual `tool_result`.
 *
 * Only the `PreToolUse` event reads this return value. Every other hook event
 * stays void-returning; the return type for the union widens just enough to
 * remain backward-compatible without forcing handlers to switch on `event`.
 */
export type PreToolUseAction =
  | { action: 'continue' }
  | { action: 'block'; reason: string }
  | { action: 'modify'; input: unknown };
