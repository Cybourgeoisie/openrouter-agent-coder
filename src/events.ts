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
