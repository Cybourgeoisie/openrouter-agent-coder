// OpenRouter `/responses` (OpenResponses) adapter for the comparative-parity
// emulator (Phase 6.5a — enables OR-side end-to-end for canonical scenarios).
//
// Handles `POST /responses` (no `/v1` prefix — the OR client constructs
// `${baseUrl}/responses` from the `serverURL` ctor option). On success, emits
// a Server-Sent Events stream that the OR agent SDK's `betaResponsesSend`
// consumer recognizes, producing text and function-call outputs that drive
// `OpenRouterAgentRun` through scripted turns. On a script miss, returns
// 500 with the same structured-diagnostic shape the other two wires use.
//
// === Why this exists ===
//
// 6.1 / 6.2 built the `/v1/messages` (Anthropic) and `/v1/chat/completions`
// (OpenAI) wires. The OR SDK in this repo (`@openrouter/agent` ≥0.3.x) routes
// through `/responses` instead — chat-completions is a sibling wire the agent
// doesn't actually call. Without a `/responses` adapter the OR side of every
// scenario 404s; 6.3's smoke deliberately tolerates that to land the harness
// plumbing, and 6.5a flips it green. The plan-doc tracked this as
// "6.3-followup"; folding it into 6.5a lets the canonical scenarios actually
// pass the comparator instead of getting another round of TODO tags.
//
// === Wire shape (v1, success-mode only) ===
//
// Event sequence the OR SDK consumes (per `stream-transformers.js`):
//   response.output_item.added  — opens a message OR function_call item
//   response.output_text.delta  — incremental text for message items
//   response.function_call_arguments.delta  — incremental args (JSON string)
//   response.function_call_arguments.done   — args finalized (parses → input)
//   response.output_item.done   — finalizes the item with full content
//   response.completed          — terminal; carries full OpenResponsesResult
//   data: [DONE]                — EventStream close marker
//
// The `OpenResponsesResult` body on `response.completed` is what feeds the
// SDK's per-turn `previousResponseId` state. We emit a deterministic
// `id` (`resp-${turn}`) so multi-turn scenarios produce stable prompt hashes
// across runs — the next turn's request includes the prior turn's
// `previous_response_id`, which is canonicalized into the hash.
//
// === What's NOT here (deferred) ===
//
//   - Failure injection EXCEPT rate_limit_429 (Phase 6.5c carve-out for
//     scenario #12 — see streamScriptEntry's 429 branch; that mode mirrors
//     anthropic.ts:111 and openai.ts:271 byte-for-byte at the HTTP layer
//     so the comparator's retry parity claim can be made across all three
//     wires). The remaining failure modes (mid-stream errors, malformed
//     JSON, truncation, etc.) are still deferred to 6.6 — the `/responses`
//     event vocabulary differs enough that a strict 1:1 port from chat-
//     completions would be wrong.
//   - Non-streaming `/responses` (`stream: false`). The agent SDK always
//     opens a streaming request; stub with 400 like the other adapters do.
//   - Reasoning / refusal / annotation events. None of #1-#4 need them; if a
//     future scenario does, this is the file that grows.
//
// Diagnostic-on-miss matches the Anthropic / OpenAI adapters byte-for-byte
// so the same harness failure-dump path catches divergence across all three
// wires.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

import type {
  ScriptRegistry,
  OpenResponsesScriptEntry,
  OpenResponsesResponse,
  StreamControl,
} from './script-engine.js';

/**
 * Format an HTTP-date string for Retry-After when the script supplied a
 * number (seconds). Both string and number forms are valid per RFC 7231, but
 * keeping the wire shape identical to Anthropic/OpenAI's `String(retryAfter)`
 * pattern preserves the SDK-side parse path under test.
 */
function formatRetryAfter(retryAfter: string | number): string {
  return String(retryAfter);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.length === 0) return {};
  return JSON.parse(raw);
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function writeSseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.flushHeaders();
}

/**
 * One SSE event in the OpenResponses event-vocabulary. The OR client's
 * `EventStream` parser keys on `data` lines and ignores `event:` (data-only
 * is the standard for /responses); we emit `event:` anyway so wireshark-style
 * log inspection stays readable.
 */
type ResponsesSseEvent = {
  event: string;
  data: unknown;
};

function serializeSseEvent(ev: ResponsesSseEvent): string {
  return `event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`;
}

// ----- Output-item shapes (subset of OpenResponsesResult.output) -----

type MessageOutputItem = {
  id: string;
  type: 'message';
  role: 'assistant';
  status: 'completed';
  content: Array<{
    type: 'output_text';
    text: string;
    annotations: never[];
  }>;
};

type FunctionCallOutputItem = {
  id: string;
  call_id: string;
  type: 'function_call';
  name: string;
  arguments: string;
  status: 'completed';
};

type OutputItem = MessageOutputItem | FunctionCallOutputItem;

// ----- Event builder -----

/**
 * Build the streaming event sequence for a successful response. Order:
 *
 *   response.created
 *   response.in_progress
 *   per output item: output_item.added → (deltas) → output_item.done
 *   response.completed
 *
 * The `OpenResponsesResult` carried on `created` / `completed` is fully
 * populated against the SDK's `OpenResponsesResult$inboundSchema` so the
 * discriminated-union parse succeeds and `case 'response.completed':` in
 * the SDK's consumer actually terminates the stream. (If the parse falls
 * back to the `isUnknown` sentinel, the consumer never sees the terminator.)
 */
export function buildOpenResponsesEvents(
  response: OpenResponsesResponse,
  stream: StreamControl = {},
): ResponsesSseEvent[] {
  const id = response.id ?? `resp_${Math.random().toString(36).slice(2, 12)}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const chunkSize: 'natural' | number = stream.chunkSize ?? 'natural';
  const events: ResponsesSseEvent[] = [];

  // Build the output items first so we can both stream their deltas AND
  // include the finalized array on `response.completed`'s body.
  const outputItems: OutputItem[] = [];
  let itemCounter = 0;
  for (const block of response.content) {
    if (block.type === 'text') {
      outputItems.push({
        id: `msg_${itemCounter++}`,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: block.text, annotations: [] }],
      });
    } else {
      outputItems.push({
        id: `fc_${itemCounter++}`,
        call_id: block.callId,
        type: 'function_call',
        name: block.name,
        arguments: block.arguments,
        status: 'completed',
      });
    }
  }

  let sequenceNumber = 0;
  const next = (): number => sequenceNumber++;

  const resultBase = buildOpenResponsesResult(id, createdAt, response, outputItems, 'in_progress');
  events.push({
    event: 'response.created',
    data: { type: 'response.created', response: resultBase, sequence_number: next() },
  });
  events.push({
    event: 'response.in_progress',
    data: { type: 'response.in_progress', response: resultBase, sequence_number: next() },
  });

  // Per-item streaming.
  outputItems.forEach((item, outputIndex) => {
    // `output_item.added` carries the item in its `in_progress` form — the
    // SDK opens accumulation state on this event and reads `name` / `id`
    // off the item to key its toolCallsInProgress map.
    const addedItem: OutputItem =
      item.type === 'message'
        ? {
            ...item,
            status: 'completed',
            content: [{ type: 'output_text', text: '', annotations: [] }],
          }
        : { ...item, status: 'completed', arguments: '' };
    events.push({
      event: 'response.output_item.added',
      data: {
        type: 'response.output_item.added',
        item: addedItem,
        output_index: outputIndex,
        sequence_number: next(),
      },
    });

    if (item.type === 'message') {
      const text = item.content[0]!.text;
      const parts = chunkText(text, chunkSize);
      for (const part of parts) {
        events.push({
          event: 'response.output_text.delta',
          data: {
            type: 'response.output_text.delta',
            content_index: 0,
            delta: part,
            item_id: item.id,
            logprobs: [],
            output_index: outputIndex,
            sequence_number: next(),
          },
        });
      }
    } else {
      const parts = chunkText(item.arguments, chunkSize);
      for (const part of parts) {
        events.push({
          event: 'response.function_call_arguments.delta',
          data: {
            type: 'response.function_call_arguments.delta',
            delta: part,
            item_id: item.id,
            output_index: outputIndex,
            sequence_number: next(),
          },
        });
      }
      events.push({
        event: 'response.function_call_arguments.done',
        data: {
          type: 'response.function_call_arguments.done',
          arguments: item.arguments,
          item_id: item.id,
          name: item.name,
          output_index: outputIndex,
          sequence_number: next(),
        },
      });
    }

    events.push({
      event: 'response.output_item.done',
      data: {
        type: 'response.output_item.done',
        item,
        output_index: outputIndex,
        sequence_number: next(),
      },
    });
  });

  const resultFinal = buildOpenResponsesResult(
    id,
    createdAt,
    response,
    outputItems,
    response.status,
  );
  events.push({
    event: 'response.completed',
    data: { type: 'response.completed', response: resultFinal, sequence_number: next() },
  });

  return events;
}

/**
 * Construct an `OpenResponsesResult` body that satisfies the SDK's strict
 * `OpenResponsesResult$inboundSchema`. Missing any required field would push
 * the parse into the `isUnknown` fallback path of the SDK's
 * `discriminatedUnion`, which would mean `response.completed` never reaches
 * the consumer's terminator switch. Every nullable field is explicitly
 * `null` rather than omitted — `z.nullable()` is `value | null`, not optional.
 */
function buildOpenResponsesResult(
  id: string,
  createdAt: number,
  response: OpenResponsesResponse,
  output: OutputItem[],
  status: 'in_progress' | OpenResponsesResponse['status'],
): Record<string, unknown> {
  const isTerminal = status !== 'in_progress';
  return {
    background: null,
    completed_at: isTerminal ? createdAt : null,
    created_at: createdAt,
    error: null,
    frequency_penalty: null,
    id,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    max_tool_calls: null,
    metadata: null,
    model: response.model,
    object: 'response',
    output,
    output_text: response.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join(''),
    parallel_tool_calls: false,
    presence_penalty: null,
    previous_response_id: null,
    prompt_cache_key: null,
    reasoning: null,
    safety_identifier: null,
    service_tier: null,
    status,
    store: false,
    temperature: null,
    text: { format: { type: 'text' } },
    tool_choice: 'auto',
    tools: [],
    top_logprobs: null,
    top_p: null,
    truncation: null,
    usage: isTerminal
      ? {
          input_tokens: response.usage.input_tokens,
          // `input_tokens_details` / `output_tokens_details` are REQUIRED on
          // the SDK's `Usage$inboundSchema` (not optional). Omitting them
          // would fail the strict parse and push `response.completed` into
          // the discriminated-union UNKNOWN fallback — at which point the
          // SDK's consumer never sees the terminator and the stream sits
          // open until the test timeout fires. Scripted runs don't model
          // cache hits or reasoning, so both detail blocks report zero.
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: response.usage.output_tokens,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens:
            response.usage.total_tokens ??
            response.usage.input_tokens + response.usage.output_tokens,
        }
      : null,
    user: null,
  };
}

function chunkText(text: string, chunkSize: 'natural' | number): string[] {
  if (text.length === 0) return [''];
  if (chunkSize === 'natural') return [text];
  const size = Math.max(1, chunkSize);
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    out.push(text.slice(i, i + size));
  }
  return out;
}

export const SSE_RESPONSES_DONE = 'data: [DONE]\n\n';

// ----- Adapter entrypoint -----

/**
 * Top-level adapter handler. Resolves once the response has been fully
 * written. Never throws to the caller — all errors are surfaced through
 * the HTTP response. Matches the other adapters' shape so the parent
 * router can compose all three behind one `try/catch`.
 */
export async function handleOpenResponses(
  req: IncomingMessage,
  res: ServerResponse,
  registry: ScriptRegistry,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    writeJson(res, 400, {
      error: {
        type: 'invalid_request_error',
        message: `Failed to parse JSON body: ${(err as Error).message}`,
      },
    });
    return;
  }

  const isStreaming = (body as { stream?: unknown })?.stream === true;
  if (!isStreaming) {
    writeJson(res, 400, {
      error: {
        type: 'invalid_request_error',
        message:
          'Emulator only supports streaming requests (stream: true) on the /responses wire in Phase 6.5a.',
      },
    });
    return;
  }

  const lookup = registry.lookup(body, 'openresponses');
  if (!lookup.ok) {
    // 422 (not 500) on miss: the OR client's default `retryCodes` is `["5XX"]`
    // with a 1-hour `maxElapsedTime` budget — a 500 here would hot-loop a
    // retry chain until the abort signal fires, blowing every scenario's
    // wall-clock budget. 422 is semantically "request shape can't be served"
    // and is not in any default retry set, so the SDK surfaces it as an
    // error event on the first attempt — which is exactly what we want a
    // script-miss to look like to the comparator (a single error, not 30s of
    // retries). The diagnostic body shape is otherwise identical to the
    // other two adapters'.
    if (lookup.dedup) {
      writeJson(res, 422, {
        error: {
          type: lookup.error.body.error.type,
          message: lookup.error.body.error.message,
          dedup: true,
        },
      });
      return;
    }
    writeJson(res, 422, lookup.error.body);
    return;
  }

  await streamScriptEntry(res, lookup.entry);
}

async function streamScriptEntry(
  res: ServerResponse,
  entry: OpenResponsesScriptEntry,
): Promise<void> {
  // Phase 6.5c: failure-mode dispatch BEFORE SSE headers are written. 429
  // returns a synthetous OR error body shape with a `retry-after` header so
  // the OR SDK's built-in backoff can pick it up and retry. The SDK keys on
  // HTTP status alone — the body is informational. Mirrors the wire shape of
  // Anthropic's rate_limit_429 path (anthropic.ts:111) and OpenAI's
  // (openai.ts:271) so the comparator can assert end-to-end retry parity
  // against all three adapters once a scenario exercises it.
  if (entry.kind === 'failure' && entry.failure.type === 'rate_limit_429') {
    writeJson(
      res,
      429,
      {
        error: {
          type: 'rate_limit_exceeded',
          message: 'Emulator-injected rate-limit (429).',
        },
      },
      { 'retry-after': formatRetryAfter(entry.failure.retryAfter) },
    );
    return;
  }

  // Success path. Failure path above returns directly; nothing else to handle.
  if (entry.kind !== 'success') {
    // Defensive — unreachable given the union, but a typed exhaustiveness
    // check would force a re-think on every new failure mode added below.
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({ error: { type: 'emulator_internal', message: 'Unknown entry kind' } }),
    );
    return;
  }

  const events = buildOpenResponsesEvents(entry.response, entry.stream);
  const interChunkDelayMs = entry.stream?.interChunkDelayMs ?? 0;

  writeSseHeaders(res);
  for (let i = 0; i < events.length; i += 1) {
    res.write(serializeSseEvent(events[i]!));
    if (interChunkDelayMs > 0 && i < events.length - 1) {
      await delay(interChunkDelayMs);
    }
  }
  res.write(SSE_RESPONSES_DONE);
  res.end();
}
