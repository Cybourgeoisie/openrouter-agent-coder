// OpenAI / OpenRouter chat-completions API adapter for the comparative-parity
// emulator.
//
// Handles `POST /v1/chat/completions` (tolerating arbitrary query strings —
// pathname-only matching is enforced by the parent router). On success,
// emits the streaming format documented at
// https://platform.openai.com/docs/api-reference/chat/streaming and used by
// OpenRouter on `openrouter.ai/api/v1/chat/completions`. On a script miss
// or wire-mismatch, returns 500 with a structured diagnostic. Six
// failure-injection modes are wired up as config flags on the script entry,
// not as separate codepaths (five from 6.1's Anthropic adapter + the new
// `tool_call_args_malformed` mode that targets the SDK's args-JSON parser).
//
// Bytes-on-the-wire differ from the Anthropic shape:
//   - No `event: <name>\n` prefix line — just `data: <json>\n\n` chunks.
//   - Stream terminator is `data: [DONE]\n\n` rather than a `message_stop`
//     event.
//   - Each chunk has shape `{ id, object: "chat.completion.chunk",
//     created, model, choices: [{ index, delta, finish_reason }] }`.
//   - Tool-call args stream as incremental string concatenation in
//     `delta.tool_calls[i].function.arguments` (not whole-JSON-per-chunk).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

import type {
  ScriptRegistry,
  OpenAIScriptEntry,
  OpenAIResponse,
  OpenAIFailureMode,
  OpenAIToolCall,
  StreamControl,
} from './script-engine.js';

// ----- HTTP helpers (mirrors anthropic.ts; kept inline to avoid coupling the
// two adapters through a shared internal module — both call sites are small) -----

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

// ----- Chunk construction -----

type OpenAIDelta = {
  role?: 'assistant';
  content?: string;
  reasoning?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: 'function';
    function?: { name?: string; arguments?: string };
  }>;
};

type OpenAIChunk = {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: OpenAIDelta;
    finish_reason: OpenAIResponse['finishReason'] | null;
  }>;
  usage?: OpenAIResponse['usage'];
};

/**
 * Build the streaming chunk sequence for a successful OpenAI/OR response.
 * Order follows the documented shape:
 *   role-only opening chunk (with tool-call frame if applicable)
 *   → reasoning deltas (if scripted)
 *   → content deltas (if any)
 *   → tool-call argument deltas (per tool call, sequenced)
 *   → finish chunk (finish_reason set)
 *   → usage chunk (if scripted)
 *
 * `[DONE]` is appended by the writer, not this builder.
 */
export function buildOpenAIChunks(
  response: OpenAIResponse,
  stream: StreamControl = {},
): OpenAIChunk[] {
  const id = response.id ?? `chatcmpl_${Math.random().toString(36).slice(2, 14)}`;
  const created = Math.floor(Date.now() / 1000);
  const model = response.model;
  const chunkSize: 'natural' | number = stream.chunkSize ?? 'natural';
  const out: OpenAIChunk[] = [];

  // Opening chunk: role: 'assistant' (+ tool-call frames if the response
  // declares any). The OR SDK uses this to initialize the message assembly.
  const openingDelta: OpenAIDelta = { role: 'assistant' };
  if (response.toolCalls && response.toolCalls.length > 0) {
    openingDelta.tool_calls = response.toolCalls.map((tc, idx) => ({
      index: idx,
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: '' },
    }));
  }
  out.push(chunkOf(id, created, model, openingDelta));

  if (response.reasoning && response.reasoning.length > 0) {
    for (const part of chunkText(response.reasoning, chunkSize)) {
      out.push(chunkOf(id, created, model, { reasoning: part }));
    }
  }

  if (response.content && response.content.length > 0) {
    for (const part of chunkText(response.content, chunkSize)) {
      out.push(chunkOf(id, created, model, { content: part }));
    }
  }

  if (response.toolCalls) {
    response.toolCalls.forEach((tc, idx) => {
      for (const part of chunkText(tc.arguments, chunkSize)) {
        out.push(
          chunkOf(id, created, model, {
            tool_calls: [{ index: idx, function: { arguments: part } }],
          }),
        );
      }
    });
  }

  // Finish chunk with the scripted finish_reason. delta is empty per the spec.
  out.push({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: response.finishReason }],
  });

  // Usage chunk — OpenRouter emits one with empty choices after the finish
  // chunk when `stream_options.include_usage` is set. The emulator always
  // emits it so tests can assert the SDK accepts it; the SDK ignores it if
  // it didn't ask for it.
  out.push({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [],
    usage: response.usage,
  });

  return out;
}

function chunkOf(id: string, created: number, model: string, delta: OpenAIDelta): OpenAIChunk {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: null }],
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

/**
 * Serialize a single OpenAI/OR chunk to the SSE wire format. No `event:`
 * line — the OpenAI shape is `data:`-only.
 */
export function serializeOpenAIChunk(chunk: OpenAIChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

export const SSE_DONE = 'data: [DONE]\n\n';

// ----- Adapter entrypoint -----

/**
 * Top-level adapter handler. Resolves once the response has been fully
 * written (or the connection forcibly closed for a failure-injection mode).
 * Never throws to the caller — all errors are surfaced through the HTTP
 * response.
 */
export async function handleOpenAIChatCompletions(
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

  // Per ambiguity call #4: non-streaming /v1/chat/completions is stub-failed
  // in v1. @openrouter/agent always opens a streaming request; if a future
  // scenario needs non-streaming, revisit then.
  const isStreaming = (body as { stream?: unknown })?.stream === true;
  if (!isStreaming) {
    writeJson(res, 400, {
      error: {
        type: 'invalid_request_error',
        message: 'Emulator only supports streaming requests (stream: true) in Phase 6.2.',
      },
    });
    return;
  }

  const lookup = registry.lookup(body, 'openai');
  if (!lookup.ok) {
    if (lookup.dedup) {
      writeJson(res, 500, {
        error: {
          type: lookup.error.body.error.type,
          message: lookup.error.body.error.message,
          dedup: true,
        },
      });
      return;
    }
    writeJson(res, 500, lookup.error.body);
    return;
  }

  await streamScriptEntry(res, lookup.entry);
}

async function streamScriptEntry(res: ServerResponse, entry: OpenAIScriptEntry): Promise<void> {
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
      { 'retry-after': String(entry.failure.retryAfter) },
    );
    return;
  }

  const source = entry.kind === 'success' ? entry.response : entry.partial;
  if (!source) {
    writeSseHeaders(res);
    res.end();
    return;
  }
  const effectiveSource =
    entry.kind === 'failure' && entry.failure.type === 'tool_call_args_malformed'
      ? injectMalformedToolArgs(source, entry.failure.toolCallIndex)
      : source;

  const chunks = buildOpenAIChunks(effectiveSource, entry.stream);
  const interChunkDelayMs = entry.stream?.interChunkDelayMs ?? 0;

  writeSseHeaders(res);

  if (entry.kind === 'success') {
    await writeAllChunks(res, chunks, interChunkDelayMs);
    res.write(SSE_DONE);
    res.end();
    return;
  }

  await applyFailureMode(res, chunks, entry.failure, interChunkDelayMs);
}

function injectMalformedToolArgs(source: OpenAIResponse, toolCallIndex: number): OpenAIResponse {
  // Replace the args of the targeted tool call with a syntactically-invalid
  // JSON fragment. The streamer otherwise builds chunks as if these args
  // were valid — the SDK's incremental concat sees `{"unterminated` and
  // must report a typed parse error rather than crashing.
  if (!source.toolCalls || source.toolCalls.length === 0) return source;
  const next: OpenAIToolCall[] = source.toolCalls.map((tc, idx) =>
    idx === toolCallIndex ? { ...tc, arguments: '{"unterminated' } : tc,
  );
  return { ...source, toolCalls: next };
}

async function writeAllChunks(
  res: ServerResponse,
  chunks: OpenAIChunk[],
  interChunkDelayMs: number,
): Promise<void> {
  for (let i = 0; i < chunks.length; i += 1) {
    res.write(serializeOpenAIChunk(chunks[i]!));
    if (interChunkDelayMs > 0 && i < chunks.length - 1) {
      await delay(interChunkDelayMs);
    }
  }
}

async function applyFailureMode(
  res: ServerResponse,
  chunks: OpenAIChunk[],
  failure: OpenAIFailureMode,
  interChunkDelayMs: number,
): Promise<void> {
  switch (failure.type) {
    case 'rate_limit_429':
      // Handled in streamScriptEntry before SSE headers. Unreachable here.
      return;

    case 'mid_stream_error': {
      const take = Math.min(failure.eventsBeforeError, chunks.length);
      for (let i = 0; i < take; i += 1) {
        res.write(serializeOpenAIChunk(chunks[i]!));
        if (interChunkDelayMs > 0) await delay(interChunkDelayMs);
      }
      // OpenRouter surfaces mid-stream errors as an SSE chunk with an
      // `error` field instead of the usual `choices` block, then closes.
      const errorChunk = {
        error: failure.error ?? {
          type: 'server_error',
          message: 'Emulator-injected mid-stream error.',
        },
      };
      res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
      res.end();
      return;
    }

    case 'malformed_chunk': {
      // Walk chunks; when we hit the targeted delta chunk index, emit a
      // `data:` line with invalid JSON instead. Anything past the malformed
      // chunk is dropped — the SDK's incremental parser should bail.
      let deltaIdx = 0;
      for (let i = 0; i < chunks.length; i += 1) {
        const ch = chunks[i]!;
        const isDelta = ch.choices.length > 0 && ch.choices[0]!.finish_reason === null && !ch.usage;
        if (isDelta && deltaIdx === failure.atChunkIndex) {
          res.write(
            `data: {"id":"chatcmpl-bad","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"\\xZZ-not-valid-json}\n\n`,
          );
          res.end();
          return;
        }
        if (isDelta) deltaIdx += 1;
        res.write(serializeOpenAIChunk(ch));
        if (interChunkDelayMs > 0) await delay(interChunkDelayMs);
      }
      res.end();
      return;
    }

    case 'truncated_stream': {
      const take = Math.min(failure.eventsBeforeTruncation, chunks.length);
      for (let i = 0; i < take; i += 1) {
        res.write(serializeOpenAIChunk(chunks[i]!));
        if (interChunkDelayMs > 0) await delay(interChunkDelayMs);
      }
      // Write the head of one more chunk but no terminator and no [DONE].
      if (take < chunks.length) {
        const partial = serializeOpenAIChunk(chunks[take]!);
        const truncated = partial.replace(/\n\n$/, '');
        res.write(truncated);
      }
      // Yield the event loop so the bytes leave the kernel send buffer
      // before we destroy the socket — same fix as the Anthropic adapter.
      await new Promise<void>((resolve) => setImmediate(resolve));
      res.socket?.destroy();
      return;
    }

    case 'split_json_field': {
      let deltaIdx = 0;
      for (let i = 0; i < chunks.length; i += 1) {
        const ch = chunks[i]!;
        const isDelta = ch.choices.length > 0 && ch.choices[0]!.finish_reason === null && !ch.usage;
        if (isDelta && deltaIdx === failure.atChunkIndex) {
          const serialized = serializeOpenAIChunk(ch);
          const splitAt = Math.min(Math.max(0, failure.splitAt), serialized.length);
          res.write(serialized.slice(0, splitAt));
          await new Promise<void>((resolve) => setImmediate(resolve));
          res.write(serialized.slice(splitAt));
          deltaIdx += 1;
        } else {
          if (isDelta) deltaIdx += 1;
          res.write(serializeOpenAIChunk(ch));
        }
        if (interChunkDelayMs > 0) await delay(interChunkDelayMs);
      }
      res.write(SSE_DONE);
      res.end();
      return;
    }

    case 'tool_call_args_malformed': {
      // The malformed override was already baked into `source.toolCalls`
      // before chunks were built. Just stream them out normally — the SDK
      // receives a perfectly well-formed SSE envelope whose `arguments`
      // payload happens to be invalid JSON, exercising the args-parsing
      // path rather than the SSE-parsing path.
      await writeAllChunks(res, chunks, interChunkDelayMs);
      res.write(SSE_DONE);
      res.end();
      return;
    }
  }
}
