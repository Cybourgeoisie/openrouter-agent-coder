// Anthropic Messages API adapter for the comparative-parity emulator.
//
// Handles `POST /v1/messages` (tolerating `?beta=true` and similar query
// strings — pathname-only matching is enforced by the parent router). On
// success, emits the SSE stream documented at
// https://docs.anthropic.com/en/api/messages-streaming. On a script miss,
// returns 500 with a structured diagnostic. Five failure-injection modes are
// wired up as config flags on the script entry, not as separate codepaths.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

import type { ScriptRegistry, ScriptEntry, FailureMode } from './script-engine.js';
import { buildAnthropicEvents, serializeSseEvent, type SseEvent } from './sse.js';

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
  // Flush headers immediately so the client transitions to the response-
  // received state even if subsequent body bytes are delayed or the
  // connection is forcibly closed (truncated_stream failure mode).
  res.flushHeaders();
}

/**
 * Top-level adapter handler. Resolves once the response has been fully written
 * (or the connection forcibly closed for a failure-injection mode). Never
 * throws to the caller — all errors are surfaced through the HTTP response.
 */
export async function handleAnthropicMessages(
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

  // Per ambiguity call #5: non-streaming /v1/messages is stub-failed in v1.
  // The Claude Agent SDK uses streaming; if a scenario needs non-streaming,
  // revisit then.
  const isStreaming = (body as { stream?: unknown })?.stream === true;
  if (!isStreaming) {
    writeJson(res, 400, {
      error: {
        type: 'invalid_request_error',
        message: 'Emulator only supports streaming requests (stream: true) in Phase 6.1.',
      },
    });
    return;
  }

  const lookup = registry.lookup(body);
  if (!lookup.ok) {
    if (lookup.dedup) {
      writeJson(res, 500, {
        error: {
          type: 'emulator_script_miss',
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

async function streamScriptEntry(res: ServerResponse, entry: ScriptEntry): Promise<void> {
  if (entry.kind === 'failure' && entry.failure.type === 'rate_limit_429') {
    writeJson(
      res,
      429,
      {
        error: {
          type: 'rate_limit_error',
          message: 'Emulator-injected rate-limit (429).',
        },
      },
      { 'retry-after': String(entry.failure.retryAfter) },
    );
    return;
  }

  // For every other path we start a 200 SSE stream.
  const source = entry.kind === 'success' ? entry.response : entry.partial;
  if (!source) {
    // Failure entries that don't reference a partial response have nothing
    // to stream. Send a stub start/error/stop trio so the SDK sees a 200.
    writeSseHeaders(res);
    res.end();
    return;
  }
  const events = buildAnthropicEvents(source, entry.stream);
  const interChunkDelayMs = entry.stream?.interChunkDelayMs ?? 0;

  writeSseHeaders(res);

  if (entry.kind === 'success') {
    await writeAllEvents(res, events, interChunkDelayMs);
    res.end();
    return;
  }

  await applyFailureMode(res, events, entry.failure, interChunkDelayMs);
}

async function writeAllEvents(
  res: ServerResponse,
  events: SseEvent[],
  interChunkDelayMs: number,
): Promise<void> {
  for (let i = 0; i < events.length; i += 1) {
    res.write(serializeSseEvent(events[i]!));
    if (interChunkDelayMs > 0 && i < events.length - 1) {
      await delay(interChunkDelayMs);
    }
  }
}

async function applyFailureMode(
  res: ServerResponse,
  events: SseEvent[],
  failure: FailureMode,
  interChunkDelayMs: number,
): Promise<void> {
  switch (failure.type) {
    case 'rate_limit_429':
      // Handled in streamScriptEntry before SSE headers. Unreachable here.
      return;

    case 'mid_stream_error': {
      const take = Math.min(failure.eventsBeforeError, events.length);
      for (let i = 0; i < take; i += 1) {
        res.write(serializeSseEvent(events[i]!));
        if (interChunkDelayMs > 0) await delay(interChunkDelayMs);
      }
      const errorEvent: SseEvent = {
        event: 'error',
        data: {
          type: 'error',
          error: failure.error ?? {
            type: 'overloaded_error',
            message: 'Emulator-injected mid-stream error.',
          },
        },
      };
      res.write(serializeSseEvent(errorEvent));
      res.end();
      return;
    }

    case 'malformed_delta': {
      let deltaCount = 0;
      for (let i = 0; i < events.length; i += 1) {
        const ev = events[i]!;
        if (ev.event === 'content_block_delta') {
          if (deltaCount === failure.atDeltaIndex) {
            // Emit a content_block_delta event with malformed JSON in the
            // data line. The SDK's JSON parser must surface this as a typed
            // error rather than crashing.
            res.write(
              `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"\\xZZ-not-valid-json}\n\n`,
            );
            res.end();
            return;
          }
          deltaCount += 1;
        }
        res.write(serializeSseEvent(ev));
        if (interChunkDelayMs > 0) await delay(interChunkDelayMs);
      }
      res.end();
      return;
    }

    case 'truncated_stream': {
      const take = Math.min(failure.eventsBeforeTruncation, events.length);
      for (let i = 0; i < take; i += 1) {
        res.write(serializeSseEvent(events[i]!));
        if (interChunkDelayMs > 0) await delay(interChunkDelayMs);
      }
      // Write the head of one more event but don't terminate it.
      if (take < events.length) {
        const partial = serializeSseEvent(events[take]!);
        // Drop the trailing `\n\n` to make the truncation unambiguous.
        const truncated = partial.replace(/\n\n$/, '');
        res.write(truncated);
      }
      // Yield the event loop so the bytes we just queued actually leave
      // the kernel send buffer before the socket is destroyed. Without
      // this, the client may see the abort before it sees any headers
      // and surface a generic "socket hang up" rather than a partial body.
      await new Promise<void>((resolve) => setImmediate(resolve));
      res.socket?.destroy();
      return;
    }

    case 'split_json_field': {
      let deltaCount = 0;
      for (let i = 0; i < events.length; i += 1) {
        const ev = events[i]!;
        if (ev.event === 'content_block_delta' && deltaCount === failure.atDeltaIndex) {
          const serialized = serializeSseEvent(ev);
          const splitAt = Math.min(Math.max(0, failure.splitAt), serialized.length);
          // Force a TCP-level chunk boundary by writing the two halves
          // separately with an awaited flush in between.
          res.write(serialized.slice(0, splitAt));
          await new Promise<void>((resolve) => {
            // setImmediate yields the event loop so the bytes actually go on
            // the wire before we write the rest.
            setImmediate(() => resolve());
          });
          res.write(serialized.slice(splitAt));
          deltaCount += 1;
        } else {
          if (ev.event === 'content_block_delta') deltaCount += 1;
          res.write(serializeSseEvent(ev));
        }
        if (interChunkDelayMs > 0) await delay(interChunkDelayMs);
      }
      res.end();
      return;
    }
  }
}
