// SSE event serialization for the Anthropic Messages API streaming format.
// Pulled out as its own module because Card 6.2 (OpenAI/OR adapter) will need
// a parallel `event: ... \n data: ...` writer that differs in event-name
// vocabulary but shares the chunk-control / failure-injection plumbing.

import type { AnthropicContentBlock, AnthropicResponse, StreamControl } from './script-engine.js';

export type SseEvent = {
  event: string;
  data: unknown;
};

/**
 * Build the Anthropic streaming event sequence for a successful response.
 * Order follows the documented spec:
 *   message_start
 *   → for each content block:
 *       content_block_start
 *       content_block_delta+   (text_delta for text; input_json_delta for tool_use)
 *       content_block_stop
 *   → message_delta
 *   → message_stop
 */
export function buildAnthropicEvents(
  response: AnthropicResponse,
  stream: StreamControl = {},
): SseEvent[] {
  const events: SseEvent[] = [];
  const messageId = response.id ?? `msg_${Math.random().toString(36).slice(2, 14)}`;
  // Use the scripted final output_tokens here even though the real Anthropic
  // API emits a placeholder `1` at message_start and only finalizes via
  // message_delta. The agent SDK in subprocess form appears to read the
  // assistant message's `usage.output_tokens` straight from message_start
  // and ignore the message_delta update — so emitting the real number up
  // front is the only way the per-turn usage agrees with the scripted
  // payload across both sides. (See `canonicalizeAnthropic` for the
  // canonical-projection rationale.)
  const initialUsage = {
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
  };

  events.push({
    event: 'message_start',
    data: {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: response.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: initialUsage,
      },
    },
  });

  response.content.forEach((block, index) => {
    events.push({
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index,
        content_block: emptyBlockShape(block),
      },
    });
    for (const delta of buildBlockDeltas(block, stream.chunkSize ?? 'natural')) {
      events.push({
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index, delta },
      });
    }
    events.push({
      event: 'content_block_stop',
      data: { type: 'content_block_stop', index },
    });
  });

  events.push({
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: {
        stop_reason: response.stopReason,
        stop_sequence: response.stopSequence ?? null,
      },
      usage: { output_tokens: response.usage.output_tokens },
    },
  });

  events.push({
    event: 'message_stop',
    data: { type: 'message_stop' },
  });

  return events;
}

function emptyBlockShape(block: AnthropicContentBlock): AnthropicContentBlock {
  if (block.type === 'text') {
    return { type: 'text', text: '' };
  }
  return { type: 'tool_use', id: block.id, name: block.name, input: {} };
}

function buildBlockDeltas(
  block: AnthropicContentBlock,
  chunkSize: 'natural' | number,
): Array<
  { type: 'text_delta'; text: string } | { type: 'input_json_delta'; partial_json: string }
> {
  if (block.type === 'text') {
    const chunks = chunkText(block.text, chunkSize);
    return chunks.map((text) => ({ type: 'text_delta', text }));
  }
  // tool_use: stream the JSON-serialized input as input_json_delta chunks.
  const json = JSON.stringify(block.input);
  const chunks = chunkText(json, chunkSize);
  return chunks.map((partial_json) => ({ type: 'input_json_delta', partial_json }));
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
 * Serialize a single SSE event in Anthropic-spec format:
 *
 *   event: <name>\n
 *   data: <json>\n
 *   \n
 */
export function serializeSseEvent(event: SseEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}
