// Script-execution engine for the comparative-parity emulator. Shared between
// the Anthropic adapter (this card) and the OpenAI/OR adapter (Card 6.2).
//
// Scripts are indexed by `{ promptHash, turn }`. `promptHash` is the SHA-256
// of the request body after stripping non-semantic fields. `turn` is a counter
// the emulator maintains per session — incremented on every successful match.
//
// A missing script entry is a HARD 500 with a structured diagnostic dump.
// Silent fallthrough is what makes mock-based tests rot.

import { createHash } from 'node:crypto';

export type AnthropicStopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'stop_sequence'
  | 'pause_turn';

export type AnthropicTextBlock = { type: 'text'; text: string };
export type AnthropicToolUseBlock = {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
};
export type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock;

export type AnthropicResponse = {
  id?: string;
  model: string;
  stopReason: AnthropicStopReason;
  stopSequence?: string | null;
  content: AnthropicContentBlock[];
  usage: { input_tokens: number; output_tokens: number };
};

export type StreamControl = {
  chunkSize?: 'natural' | number;
  interChunkDelayMs?: number;
};

export type FailureMode =
  | {
      type: 'mid_stream_error';
      // Deliver this many normal events before emitting an Anthropic
      // `error` event and closing the connection.
      eventsBeforeError: number;
      error?: { type: string; message: string };
    }
  | {
      type: 'rate_limit_429';
      retryAfter: string | number;
    }
  | {
      type: 'malformed_delta';
      // Inject malformed JSON in the Nth `content_block_delta` (0-indexed).
      atDeltaIndex: number;
    }
  | {
      type: 'truncated_stream';
      // Deliver this many normal events, then close the socket mid-event
      // (no terminating `\n\n`).
      eventsBeforeTruncation: number;
    }
  | {
      type: 'split_json_field';
      // Force a TCP chunk boundary in the middle of a `data:` line so the
      // SDK's incremental parser must reassemble across chunks.
      atDeltaIndex: number;
      splitAt: number;
    };

export type SuccessOutcome = {
  kind: 'success';
  response: AnthropicResponse;
  stream?: StreamControl;
};

export type FailureOutcome = {
  kind: 'failure';
  failure: FailureMode;
  // For failure modes that need a partial stream, the script may carry a
  // response whose initial events are replayed up to the failure point.
  partial?: AnthropicResponse;
  stream?: StreamControl;
};

export type ScriptOutcome = SuccessOutcome | FailureOutcome;

export type ScriptEntry = {
  promptHash: string;
  turn: number;
} & ScriptOutcome;

type DiagnosticEvent = {
  promptHash: string;
  turn: number;
  body: unknown;
  registered: Array<{ promptHash: string; turn: number; kind: ScriptOutcome['kind'] }>;
};

/**
 * Stable JSON serialization with sorted keys. Used to ensure that two
 * semantically-equal request bodies hash to the same value regardless of
 * the order the SDK happened to serialize fields in.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    if (obj[k] === undefined) continue;
    parts.push(JSON.stringify(k) + ':' + stableStringify(obj[k]));
  }
  return '{' + parts.join(',') + '}';
}

/**
 * Strip non-semantic fields from an Anthropic Messages API request body
 * before hashing. The fields we keep are the ones that meaningfully change
 * what the model would produce — model, messages, system, tools, tool_choice,
 * max_tokens, temperature, top_p, top_k, stop_sequences.
 *
 * Fields explicitly excluded: `metadata` (per-request identifiers),
 * `stream` (transport choice, not semantic), `anthropic_version` (header-level),
 * any `*_id` field, and unknown forward-compat fields.
 */
export function canonicalizeRequest(body: unknown): string {
  if (body === null || typeof body !== 'object') {
    return stableStringify({ raw: body });
  }
  const b = body as Record<string, unknown>;
  const canonical: Record<string, unknown> = {
    model: b.model ?? null,
    system: b.system ?? null,
    messages: b.messages ?? [],
    tools: b.tools ?? null,
    tool_choice: b.tool_choice ?? null,
    max_tokens: b.max_tokens ?? null,
    temperature: b.temperature ?? null,
    top_p: b.top_p ?? null,
    top_k: b.top_k ?? null,
    stop_sequences: b.stop_sequences ?? null,
  };
  return stableStringify(canonical);
}

export function computePromptHash(body: unknown): string {
  const canonical = canonicalizeRequest(body);
  return 'sha256:' + createHash('sha256').update(canonical).digest('hex');
}

export type ScriptMissError = {
  status: 500;
  body: {
    error: {
      type: 'emulator_script_miss';
      message: string;
      diagnostic: DiagnosticEvent;
    };
  };
  diagnosticKey: string;
};

/**
 * Per-emulator-instance script registry. One ScriptRegistry per test (or per
 * emulator instance). The `turn` counter advances on each successful match.
 *
 * Missing-script diagnostics are deduped by `{promptHash, turn}` so that the
 * SDK's 15-retry-on-500 loop doesn't spam the test output 15× with the same
 * miss — subsequent retries against the same miss get a thin "still-missing"
 * payload without the registered-scripts dump.
 */
export class ScriptRegistry {
  private readonly entries: ScriptEntry[] = [];
  private nextTurn = 0;
  private readonly emittedMisses = new Set<string>();

  register(entry: ScriptEntry): void {
    this.entries.push(entry);
  }

  registerMany(entries: ScriptEntry[]): void {
    for (const e of entries) this.entries.push(e);
  }

  /**
   * Look up the script for a freshly-received request body. On hit, advances
   * the turn counter. On miss, returns a structured diagnostic; the second
   * and subsequent misses for the same `{promptHash, turn}` get the
   * `dedup: true` flag so callers can emit a thinner response.
   */
  lookup(
    body: unknown,
  ):
    | { ok: true; entry: ScriptEntry; turn: number }
    | { ok: false; error: ScriptMissError; dedup: boolean } {
    const promptHash = computePromptHash(body);
    const turn = this.nextTurn;
    const hit = this.entries.find((e) => e.promptHash === promptHash && e.turn === turn);
    if (hit) {
      this.nextTurn += 1;
      return { ok: true, entry: hit, turn };
    }
    const diagnosticKey = `${promptHash}@${turn}`;
    const dedup = this.emittedMisses.has(diagnosticKey);
    this.emittedMisses.add(diagnosticKey);
    const diagnostic: DiagnosticEvent = {
      promptHash,
      turn,
      body,
      registered: this.entries.map((e) => ({
        promptHash: e.promptHash,
        turn: e.turn,
        kind: e.kind,
      })),
    };
    return {
      ok: false,
      error: {
        status: 500,
        body: {
          error: {
            type: 'emulator_script_miss',
            message: `No script registered for promptHash=${promptHash} turn=${turn}. Registered: ${this.entries.length} entries.`,
            diagnostic,
          },
        },
        diagnosticKey,
      },
      dedup,
    };
  }

  /** Total turns served so far. Useful for tests that assert how many round-trips happened. */
  get turnsServed(): number {
    return this.nextTurn;
  }

  /** Reset the turn counter (e.g. between scenarios within one emulator instance). */
  reset(): void {
    this.nextTurn = 0;
    this.emittedMisses.clear();
  }
}
