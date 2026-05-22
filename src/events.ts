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
 */
export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'SessionStart' | 'SessionEnd';

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
    };
