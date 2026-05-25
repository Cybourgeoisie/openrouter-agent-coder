// Transcript shapes captured by the comparative-parity harness.
//
// One transcript per SDK per scenario run. Each transcript is an append-only
// array of events in fire order — order is load-bearing for 6.4's exact-mode
// comparator. We mask the obvious nondeterminism (timestamps, request/session
// UUIDs, sequence numbers) at capture time so transcripts are human-diffable
// on inspection; the canonicalization sweep for the comparator is 6.4's job.
//
// 6.4 will consume `OrTranscript` + `AnthropicTranscript` and assert
// equivalence after a final canonicalization pass. Do not bake comparator
// assertions in here — that scope creep is precisely what the dual-mode
// harness exists to keep out of the harness.

import type { AgentCoreEvent } from '../../events.js';

/**
 * Append-only event log from `OpenRouterAgentRun`. We capture every
 * `AgentCoreEvent` the run yields, in order. The `wire` discriminator lets
 * 6.4 select the right canonicalization rules without inspecting the events.
 */
export type OrTranscript = {
  readonly wire: 'openrouter';
  readonly events: ReadonlyArray<AgentCoreEvent>;
  /**
   * Captured only when the run itself threw (vs. emitted an `error` event).
   * The harness never re-raises — the comparator decides if the throw is a
   * scenario failure or expected. Stringified with `error.stack` if present.
   */
  readonly thrown?: string;
  /**
   * Phase 6.7: sum of `costUsd` observed on this side's events. Live-mode
   * smoke runs use this for the per-scenario budget cap and for workflow
   * aggregate reporting. Emulated runs report 0 (the emulator never charges).
   */
  readonly costUsd?: number;
};

/**
 * Append-only message log from `@anthropic-ai/claude-agent-sdk`'s `query()`.
 * The SDK's `Query` is an `AsyncGenerator<SDKMessage>`; we capture every
 * message as a structurally-cloned plain object so the consumer can JSON-serialize
 * the transcript without worrying about non-cloneable fields.
 *
 * SDKMessage union (from the SDK) is wide — assistant / user / result / system
 * / partial-assistant / hook lifecycle / compact-boundary / status / rate-limit
 * / etc. We capture them all and let 6.4 decide which subset to project for
 * the comparator. Masking is limited to fields the SDK populates with
 * obvious-nondeterminism values (uuid, session_id, durations).
 */
export type AnthropicTranscript = {
  readonly wire: 'anthropic';
  readonly messages: ReadonlyArray<Record<string, unknown>>;
  readonly thrown?: string;
  /**
   * Phase 6.7: sum of `total_cost_usd` observed on Anthropic-side `result`
   * messages. Live-mode smoke runs use this for the per-scenario budget cap
   * and for workflow aggregate reporting. Emulated runs report 0.
   */
  readonly costUsd?: number;
};

export type ScenarioTranscripts = {
  readonly orTranscript: OrTranscript;
  readonly anthropicTranscript: AnthropicTranscript;
  /**
   * Phase 6.7: set to `true` when the harness observed a `maxCostUsd` breach
   * mid-run and aborted both SDKs. Live-mode smoke drivers surface this as a
   * "flaky-scenario" warning (not a hard fail). Always `false` in emulated
   * mode (no cost incurred).
   */
  readonly costBreach?: boolean;
};

// ----- Masking helpers (capture-time nondeterminism scrubbers) -----

const MASKED_KEYS = new Set([
  'uuid',
  'session_id',
  'sessionId',
  'request_id',
  'requestId',
  'message_id',
  'messageId',
  'created',
  'created_at',
  'createdAt',
  'duration_ms',
  'duration_api_ms',
  'durationMs',
  'ttft_ms',
  'timestamp',
  'sequenceNumber',
  'sequence_number',
]);

/**
 * Deep-clone the input while substituting masked values for any keys named in
 * {@link MASKED_KEYS}. Pure — never mutates the input. Used at capture time
 * so the in-memory transcript is already scrubbed; on-disk dumps and
 * comparator input both inherit the mask without a second pass.
 *
 * Masking semantics:
 *   - String values → `'<masked:<key>>'`
 *   - Number values → `0`
 *   - Boolean / null / undefined → preserved (no observable nondeterminism)
 *   - Objects / arrays → recursed
 *
 * Anything outside the JSON-cloneable subset (functions, symbols, etc.) is
 * coerced via `String(value)` so the transcript stays JSON-serializable.
 */
export function maskNondeterminism<T>(value: T): T {
  return maskInner(value) as T;
}

function maskInner(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(maskInner);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (MASKED_KEYS.has(k)) {
        if (typeof v === 'string') out[k] = `<masked:${k}>`;
        else if (typeof v === 'number') out[k] = 0;
        else out[k] = maskInner(v);
      } else {
        out[k] = maskInner(v);
      }
    }
    return out;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return String(value);
}
