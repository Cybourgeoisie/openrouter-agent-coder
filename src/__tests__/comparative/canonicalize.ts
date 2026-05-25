// Transcript projection for the Phase 6.4 comparator.
//
// The two SDKs' transcripts have different shapes by design (Anthropic
// `messages` vs. OR `AgentCoreEvent[]`). The comparator never compares them
// raw — it projects each side to a SHARED `CanonicalEvent[]` sequence plus a
// small bag of aggregates (final text, tool calls, token usage, terminal
// status), and compares the projections.
//
// === What "canonicalization" does (load-bearing) ===
//
//   1. Strip every nondeterministic field documented in `transcript.ts`'s
//      `MASKED_KEYS` (the harness already masked these at capture time — this
//      module's mask pass is a defensive second sweep that ALSO honors the
//      scenario-level `ignore` extension).
//   2. Strip every `toolu_*` / `call_*` ID anywhere in the tree. These vary
//      between SDKs and provide no parity signal.
//   3. Project each transcript to an ordered `CanonicalEvent[]` whose
//      vocabulary is identical across sides. Order is meaningful — the
//      comparator's exact-mode equality is positional.
//   4. Extract aggregates (final text concat, tool-call list, token usage,
//      terminal status, hook event order) that the tolerant comparator's
//      band/predicate logic operates on.
//
// Tolerance bands and final-text predicates are NOT applied here — they're
// the comparator's job in tolerant mode. This module produces deterministic
// projections; the comparator decides which fields get exact-vs-tolerant
// treatment.
//
// TODO(6.5): scenario-declared deterministic-irrelevant ordering (e.g.
//   parallel-subagent kickoff order) — v1 always treats order as meaningful.
// TODO(6.5+): hook-stream projection. v1 derives "hook firing order" from
//   the structural stream events (`session_start` ≈ SessionStart,
//   `turn_start` ≈ PreToolUse-bracket, `terminal` ≈ SessionEnd/Stop), per
//   the 6.3 harness header note that hooks-as-such aren't separately
//   captured. When 6.5 grows the harness to capture the hook stream, this
//   projector should fold it in alongside the stream events.

import type { AgentCoreEvent } from '../../events.js';

import type { AnthropicTranscript, OrTranscript } from './transcript.js';

/**
 * Canonical event vocabulary the comparator operates on. Both SDKs project
 * down to this — the field set is intentionally minimal so projection is
 * lossy in only one direction (toward "is this the same shape of run").
 *
 * `tool_call.args` is the structurally-cloned input (with `toolu_*`/`call_*`
 * IDs stripped and nondeterministic keys masked). `terminal.usage` is the
 * normalized `{ input, output }` token pair extracted from whichever shape
 * the SDK exposes (`input_tokens`/`output_tokens` on Anthropic; `Usage`
 * fields on OR).
 */
export type CanonicalEvent =
  | { type: 'session_start' }
  | { type: 'turn_start'; turnNumber: number }
  | { type: 'text'; text: string }
  | { type: 'tool_call'; name: string; args: unknown }
  | { type: 'tool_result'; isError: boolean }
  | { type: 'turn_end' }
  | {
      type: 'terminal';
      status: string;
      usage: { input: number; output: number } | null;
    }
  | { type: 'error'; message: string };

export interface Projection {
  /** Ordered canonical event sequence — positional equality is meaningful. */
  events: CanonicalEvent[];
  /** Final assistant text (concatenation of every text event, in order). */
  finalText: string;
  /** Tool calls in invocation order. `args` is the masked input. */
  toolCalls: Array<{ name: string; args: unknown }>;
  /** Normalized token usage (zeros when the SDK never emitted a result). */
  tokenUsage: { input: number; output: number };
  /** Terminal status string (e.g. `'success'`, `'end_turn'`, `'error'`). */
  terminalStatus: string | null;
  /** Hook-equivalent event order (the structural-event subset, per file note). */
  hookOrder: string[];
  /** Captured `thrown` from the transcript, if the SDK threw. */
  thrown: string | undefined;
}

/**
 * Project an OR transcript to a canonical projection.
 *
 * `extraIgnore` is the scenario's `comparator.ignore` extension — added on
 * top of the hard-coded mask set already applied by the harness.
 */
export function canonicalizeOr(
  transcript: OrTranscript,
  extraIgnore: ReadonlySet<string> = new Set(),
): Projection {
  const events: CanonicalEvent[] = [];
  const toolCalls: Array<{ name: string; args: unknown }> = [];
  const hookOrder: string[] = [];
  const textParts: string[] = [];
  let tokenUsage: { input: number; output: number } = { input: 0, output: 0 };
  let terminalStatus: string | null = null;

  for (const raw of transcript.events) {
    const ev = stripIds(raw, extraIgnore) as AgentCoreEvent;
    switch (ev.type) {
      case 'session_started':
        events.push({ type: 'session_start' });
        hookOrder.push('session_start');
        break;
      case 'turn_start':
        events.push({ type: 'turn_start', turnNumber: ev.turnNumber });
        hookOrder.push('turn_start');
        break;
      case 'text_delta':
        textParts.push(ev.content);
        events.push({ type: 'text', text: ev.content });
        break;
      case 'tool_call': {
        const args = stripIds(ev.input, extraIgnore);
        events.push({ type: 'tool_call', name: ev.name, args });
        toolCalls.push({ name: ev.name, args });
        hookOrder.push(`tool_call:${ev.name}`);
        break;
      }
      case 'tool_result':
        events.push({ type: 'tool_result', isError: ev.isError });
        hookOrder.push('tool_result');
        break;
      case 'turn_end':
        events.push({ type: 'turn_end' });
        if (ev.usage) {
          tokenUsage = orUsageToCanon(ev.usage);
        }
        hookOrder.push('turn_end');
        break;
      case 'stream_complete': {
        terminalStatus = ev.status;
        const usage = ev.usage ? orUsageToCanon(ev.usage) : tokenUsage;
        events.push({ type: 'terminal', status: ev.status, usage });
        hookOrder.push(`terminal:${ev.status}`);
        if (usage) tokenUsage = usage;
        break;
      }
      case 'error':
        events.push({ type: 'error', message: ev.message });
        hookOrder.push('error');
        break;
      default:
        // Forward-compat: unknown event types are projected to a stable
        // pseudo-error so divergence is loud, not silent.
        events.push({
          type: 'error',
          message: `unknown_or_event:${(ev as { type: string }).type}`,
        });
    }
  }

  return {
    events,
    finalText: textParts.join(''),
    toolCalls,
    tokenUsage,
    terminalStatus,
    hookOrder,
    thrown: transcript.thrown,
  };
}

/**
 * Project an Anthropic transcript to a canonical projection.
 *
 * The Anthropic SDK's `SDKMessage` union is wide — we walk it defensively
 * and pick out the structural events that have an OR counterpart. Unknown
 * messages are skipped (NOT projected to error) because the SDK emits many
 * status/lifecycle messages that don't map to OR's stream events — folding
 * them into the canonical stream would force divergence on noise.
 */
export function canonicalizeAnthropic(
  transcript: AnthropicTranscript,
  extraIgnore: ReadonlySet<string> = new Set(),
): Projection {
  const events: CanonicalEvent[] = [];
  const toolCalls: Array<{ name: string; args: unknown }> = [];
  const hookOrder: string[] = [];
  const textParts: string[] = [];
  let tokenUsage: { input: number; output: number } = { input: 0, output: 0 };
  let terminalStatus: string | null = null;
  let sessionStartedEmitted = false;
  // The Anthropic SDK splits a single agent turn across multiple top-level
  // messages: `assistant` (model output, may carry tool_use) → `user`
  // (tool_result) → next `assistant` (next turn or final text). The OR
  // runtime emits a single `turn_start`/`turn_end` bracket that spans the
  // full iteration including the tool_result. To get matching projections,
  // we DEFER the `turn_end` emission until the next turn_start (new
  // assistant message) or the terminal `result` — so tool_result events
  // from the user message land INSIDE the bracket, mirroring OR.
  let turnOpen = false;
  const closeTurn = (): void => {
    if (turnOpen) {
      events.push({ type: 'turn_end' });
      hookOrder.push('turn_end');
      turnOpen = false;
    }
  };

  for (const raw of transcript.messages) {
    const msg = stripIds(raw, extraIgnore) as Record<string, unknown>;
    const type = msg.type as string | undefined;

    if (type === 'system' && msg.subtype === 'init') {
      if (!sessionStartedEmitted) {
        events.push({ type: 'session_start' });
        hookOrder.push('session_start');
        sessionStartedEmitted = true;
      }
      continue;
    }

    if (type === 'assistant') {
      const message = msg.message as Record<string, unknown> | undefined;
      const content = message?.content as unknown[] | undefined;
      if (Array.isArray(content)) {
        // Close the previous turn (if any) before opening this one. Anthropic
        // doesn't emit a turn index; we count locally from already-emitted
        // turn_start events.
        closeTurn();
        const turnNumber = events.filter((e) => e.type === 'turn_start').length;
        events.push({ type: 'turn_start', turnNumber });
        hookOrder.push('turn_start');
        turnOpen = true;
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          const b = block as Record<string, unknown>;
          if (b.type === 'text' && typeof b.text === 'string') {
            textParts.push(b.text);
            events.push({ type: 'text', text: b.text });
          } else if (b.type === 'tool_use' && typeof b.name === 'string') {
            const args = stripIds(b.input, extraIgnore);
            events.push({ type: 'tool_call', name: b.name, args });
            toolCalls.push({ name: b.name, args });
            hookOrder.push(`tool_call:${b.name}`);
          }
        }
        // Bracket stays OPEN — the matching `turn_end` is emitted at the
        // next turn boundary (next assistant or terminal).
      }
      continue;
    }

    if (type === 'user') {
      const message = msg.message as Record<string, unknown> | undefined;
      const content = message?.content as unknown[] | undefined;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          const b = block as Record<string, unknown>;
          if (b.type === 'tool_result') {
            const isError = b.is_error === true;
            events.push({ type: 'tool_result', isError });
            hookOrder.push('tool_result');
          }
        }
      }
      continue;
    }

    if (type === 'result') {
      closeTurn();
      const subtype = (msg.subtype as string | undefined) ?? 'success';
      const usage = (msg.usage as Record<string, unknown> | undefined) ?? undefined;
      const canonUsage = usage ? anthropicUsageToCanon(usage) : null;
      if (canonUsage) tokenUsage = canonUsage;
      terminalStatus = subtype;
      events.push({ type: 'terminal', status: subtype, usage: canonUsage });
      hookOrder.push(`terminal:${subtype}`);
      continue;
    }

    // Other message types (`stream_event`, `partial_assistant`, hook
    // lifecycle, compact-boundary, status, rate-limit, …) deliberately
    // skipped — they don't have an OR counterpart in v1 and projecting
    // them would force divergence on lifecycle noise the comparator
    // can't actually assert against.
  }

  // Defensive: if the transcript ended without a `result` message (SDK
  // threw mid-stream, or some other partial-capture path), still close any
  // open turn so the projection's event count is well-formed for the
  // comparator.
  closeTurn();

  return {
    events,
    finalText: textParts.join(''),
    toolCalls,
    tokenUsage,
    terminalStatus,
    hookOrder,
    thrown: transcript.thrown,
  };
}

// ----- Helpers -----

/**
 * Deep-clone the input while stripping any string-valued key matching the
 * `toolu_*` / `call_*` / `id` patterns, and masking any key listed in
 * `extraIgnore`. Pure — never mutates input.
 *
 * Why strip IDs unconditionally: tool-use IDs are SDK-generated and never
 * align between Anthropic and OR. Comparing them would force every scenario
 * to mask them per-test. Strip once, here.
 */
function stripIds(value: unknown, extraIgnore: ReadonlySet<string>): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => stripIds(v, extraIgnore));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (extraIgnore.has(k)) {
        out[k] = '<masked>';
        continue;
      }
      if ((k === 'id' || k === 'tool_use_id' || k === 'callId') && typeof v === 'string') {
        out[k] = '<stripped-id>';
        continue;
      }
      out[k] = stripIds(v, extraIgnore);
    }
    return out;
  }
  if (typeof value === 'string') {
    // Strip inline tool-use IDs that show up embedded in other strings.
    return value
      .replace(/\btoolu_[A-Za-z0-9_-]+/g, '<toolu>')
      .replace(/\bcall_[A-Za-z0-9_-]+/g, '<call>');
  }
  return value;
}

function orUsageToCanon(usage: unknown): { input: number; output: number } {
  if (!usage || typeof usage !== 'object') return { input: 0, output: 0 };
  const u = usage as Record<string, unknown>;
  // OR's `Usage` exposes `inputTokens` / `outputTokens`. Some surfaces also
  // carry the underlying provider fields (`prompt_tokens`/`completion_tokens`
  // from OpenAI-style; `input_tokens`/`output_tokens` from Anthropic-style).
  // Accept any of the three to keep the projector tolerant of upstream
  // shape changes — the parity claim doesn't hinge on which field name won.
  const input = pickNumber(u, ['inputTokens', 'input_tokens', 'prompt_tokens']) ?? 0;
  const output = pickNumber(u, ['outputTokens', 'output_tokens', 'completion_tokens']) ?? 0;
  return { input, output };
}

function anthropicUsageToCanon(usage: Record<string, unknown>): {
  input: number;
  output: number;
} {
  const input = pickNumber(usage, ['input_tokens', 'inputTokens']) ?? 0;
  const output = pickNumber(usage, ['output_tokens', 'outputTokens']) ?? 0;
  return { input, output };
}

function pickNumber(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}
