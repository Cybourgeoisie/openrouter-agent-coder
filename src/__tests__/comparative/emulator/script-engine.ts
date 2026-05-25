// Script-execution engine for the comparative-parity emulator. Shared between
// the Anthropic adapter (Card 6.1) and the OpenAI/OR adapter (Card 6.2).
//
// Scripts are indexed by `{ promptHash, turn }`. `promptHash` is the SHA-256
// of the request body after stripping non-semantic fields. `turn` is a counter
// the emulator maintains per session — incremented on every successful match.
//
// A missing script entry is a HARD 500 with a structured diagnostic dump.
// Silent fallthrough is what makes mock-based tests rot.
//
// 6.2 adds a `wire: 'anthropic' | 'openai'` discriminator on every entry. The
// adapter infers the wire from the request URL path; the script's `wire` field
// MUST match or lookup returns a wire-mismatch error (same diagnostic shape as
// a miss). Entries without `wire` default to 'anthropic' so 6.1 scripts and
// tests continue to type-check and behave identically.

import { createHash } from 'node:crypto';

export type WireFormat = 'anthropic' | 'openai';

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

// ----- OpenAI / OpenRouter chat-completions response shape -----

export type OpenAIFinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter';

export type OpenAIToolCall = {
  id: string;
  name: string;
  // Arguments serialized to a JSON string. Streamed as incremental
  // string-concat in `delta.tool_calls[i].function.arguments`.
  arguments: string;
};

export type OpenAIResponse = {
  id?: string;
  model: string;
  finishReason: OpenAIFinishReason;
  // Plain assistant text content. Omit or set to '' when emitting tool_calls
  // only. Streamed via `delta.content`.
  content?: string;
  // Each entry streams as one or more `delta.tool_calls` chunks. Args text
  // is chunked according to `StreamControl.chunkSize`.
  toolCalls?: OpenAIToolCall[];
  // Optional `delta.reasoning` text streamed before content. Stub-only
  // wiring per ambiguity call #3 — only emitted if a script supplies it.
  reasoning?: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

export type StreamControl = {
  chunkSize?: 'natural' | number;
  interChunkDelayMs?: number;
};

export type AnthropicFailureMode =
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

// Re-exported under the legacy name so 6.1 tests keep compiling.
export type FailureMode = AnthropicFailureMode;

export type OpenAIFailureMode =
  | {
      type: 'mid_stream_error';
      // Deliver this many normal chat.completion.chunk events, then write an
      // OpenAI-shape error chunk and close the connection. Distinct from the
      // upstream-5xx path (use HTTP status injection for that — not yet wired
      // because no scenario needs it; mid-stream after 200 is what the SDK
      // actually has to survive).
      eventsBeforeError: number;
      error?: { type: string; message: string; code?: string };
    }
  | {
      type: 'rate_limit_429';
      retryAfter: string | number;
    }
  | {
      type: 'malformed_chunk';
      // Inject malformed JSON in the Nth `data:` chunk (0-indexed, counting
      // only content/tool-call delta chunks — not the implicit role-only
      // first chunk).
      atChunkIndex: number;
    }
  | {
      type: 'truncated_stream';
      // Deliver N chunks, then close the socket mid-chunk (no `\n\n`
      // terminator and no `data: [DONE]`).
      eventsBeforeTruncation: number;
    }
  | {
      type: 'split_json_field';
      // Force a TCP chunk boundary inside the Nth chunk's data line so the
      // SDK's incremental parser must reassemble across reads.
      atChunkIndex: number;
      splitAt: number;
    }
  | {
      type: 'tool_call_args_malformed';
      // Replace the tool-call args streamed JSON with an invalid token (e.g.
      // `{"bad":` with no close). Exercises the SDK's args-parsing fallback.
      // The script must declare a `toolCalls` entry; the args of the Nth
      // tool call (0-indexed) get the malformed override.
      toolCallIndex: number;
    };

export type SuccessOutcome = {
  kind: 'success';
  response: AnthropicResponse;
  stream?: StreamControl;
};

export type FailureOutcome = {
  kind: 'failure';
  failure: AnthropicFailureMode;
  // For failure modes that need a partial stream, the script may carry a
  // response whose initial events are replayed up to the failure point.
  partial?: AnthropicResponse;
  stream?: StreamControl;
};

export type ScriptOutcome = SuccessOutcome | FailureOutcome;

type AnthropicScriptEntryBase = {
  promptHash: string;
  turn: number;
  // `wire` defaults to 'anthropic' when absent — preserves the 6.1 entry
  // shape verbatim. The adapter sees this default during wire-match.
  wire?: 'anthropic';
};

type OpenAISuccessOutcome = {
  kind: 'success';
  response: OpenAIResponse;
  stream?: StreamControl;
};

type OpenAIFailureOutcome = {
  kind: 'failure';
  failure: OpenAIFailureMode;
  partial?: OpenAIResponse;
  stream?: StreamControl;
};

type OpenAIScriptEntryBase = {
  promptHash: string;
  turn: number;
  wire: 'openai';
};

export type AnthropicScriptEntry = AnthropicScriptEntryBase & ScriptOutcome;
export type OpenAIScriptEntry = OpenAIScriptEntryBase &
  (OpenAISuccessOutcome | OpenAIFailureOutcome);

export type ScriptEntry = AnthropicScriptEntry | OpenAIScriptEntry;

export function entryWire(entry: ScriptEntry): WireFormat {
  return entry.wire ?? 'anthropic';
}

export function isAnthropicEntry(entry: ScriptEntry): entry is AnthropicScriptEntry {
  return entryWire(entry) === 'anthropic';
}

export function isOpenAIEntry(entry: ScriptEntry): entry is OpenAIScriptEntry {
  return entryWire(entry) === 'openai';
}

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
 *
 * The `wire` argument selects between the Anthropic and OpenAI/OR shapes.
 * Defaults to 'anthropic' for back-compat with 6.1 callers.
 */
export function canonicalizeRequest(body: unknown, wire: WireFormat = 'anthropic'): string {
  if (body === null || typeof body !== 'object') {
    return stableStringify({ raw: body });
  }
  const b = body as Record<string, unknown>;
  if (wire === 'openai') {
    // OpenAI/OR-compatible chat-completions shape. Fields kept are the
    // ones that meaningfully shape the model's output. Excluded: `stream`
    // (transport), `metadata` / `user` (per-request identifiers), `n` (the
    // emulator only scripts single completions), and unknown forward-compat
    // fields. The hash deliberately does NOT include the `wire` token so the
    // wire-mismatch path is reachable: a body can hash-collide across both
    // adapters and the registry catches the wire mismatch explicitly.
    const canonical: Record<string, unknown> = {
      model: b.model ?? null,
      messages: b.messages ?? [],
      tools: b.tools ?? null,
      tool_choice: b.tool_choice ?? null,
      max_tokens: b.max_tokens ?? null,
      temperature: b.temperature ?? null,
      top_p: b.top_p ?? null,
      frequency_penalty: b.frequency_penalty ?? null,
      presence_penalty: b.presence_penalty ?? null,
      stop: b.stop ?? null,
      seed: b.seed ?? null,
      response_format: b.response_format ?? null,
    };
    return stableStringify(canonical);
  }
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

export function computePromptHash(body: unknown, wire: WireFormat = 'anthropic'): string {
  const canonical = canonicalizeRequest(body, wire);
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

export type ScriptWireMismatchError = {
  status: 500;
  body: {
    error: {
      type: 'emulator_wire_mismatch';
      message: string;
      diagnostic: DiagnosticEvent & { expectedWire: WireFormat; entryWire: WireFormat };
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
   *
   * The `expectedWire` argument defaults to 'anthropic' so 6.1 callers
   * continue to work verbatim. When the matched entry's `wire` field
   * disagrees, the lookup fails with a `emulator_wire_mismatch` diagnostic
   * — same dedup semantics as a script miss — and does NOT advance the turn
   * counter (so a follow-up request with the right wire can still match).
   */
  lookup(
    body: unknown,
    expectedWire?: 'anthropic',
  ):
    | { ok: true; entry: AnthropicScriptEntry; turn: number }
    | { ok: false; error: ScriptMissError; dedup: boolean }
    | { ok: false; error: ScriptWireMismatchError; dedup: boolean; mismatch: true };
  lookup(
    body: unknown,
    expectedWire: 'openai',
  ):
    | { ok: true; entry: OpenAIScriptEntry; turn: number }
    | { ok: false; error: ScriptMissError; dedup: boolean }
    | { ok: false; error: ScriptWireMismatchError; dedup: boolean; mismatch: true };
  lookup(
    body: unknown,
    expectedWire: WireFormat = 'anthropic',
  ):
    | { ok: true; entry: ScriptEntry; turn: number }
    | { ok: false; error: ScriptMissError; dedup: boolean }
    | { ok: false; error: ScriptWireMismatchError; dedup: boolean; mismatch: true } {
    const promptHash = computePromptHash(body, expectedWire);
    const turn = this.nextTurn;
    const hit = this.entries.find((e) => e.promptHash === promptHash && e.turn === turn);
    if (hit) {
      const hitWire = entryWire(hit);
      if (hitWire !== expectedWire) {
        const diagnosticKey = `${promptHash}@${turn}#wire`;
        const dedup = this.emittedMisses.has(diagnosticKey);
        this.emittedMisses.add(diagnosticKey);
        const diagnostic = {
          promptHash,
          turn,
          body,
          registered: this.entries.map((e) => ({
            promptHash: e.promptHash,
            turn: e.turn,
            kind: e.kind,
            wire: entryWire(e),
          })),
          expectedWire,
          entryWire: hitWire,
        };
        return {
          ok: false,
          mismatch: true,
          error: {
            status: 500,
            body: {
              error: {
                type: 'emulator_wire_mismatch',
                message: `Script entry for promptHash=${promptHash} turn=${turn} declares wire=${hitWire} but request arrived on the ${expectedWire} adapter.`,
                diagnostic,
              },
            },
            diagnosticKey,
          },
          dedup,
        };
      }
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
