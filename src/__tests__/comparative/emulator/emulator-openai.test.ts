import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { request as httpRequest } from 'node:http';

import {
  startEmulator,
  computePromptHash,
  canonicalizeRequest,
  ScriptRegistry,
  isOpenAIEntry,
  entryWire,
  type EmulatorHandle,
  type OpenAIResponse,
} from './index.js';
import { buildOpenAIChunks, serializeOpenAIChunk, SSE_DONE } from './openai.js';

// Wire-level round-trips here use raw fetch + manual SSE chunk parsing
// rather than the full `@openrouter/sdk` `chat.send()` client. Rationale:
// `@openrouter/agent` (already a runtime dep) re-exports an `OpenRouter`
// class that only adds `callModel`; the lower-level `chat.send()` surface
// lives on the full `@openrouter/sdk` package and would need to be pulled
// into devDependencies just for the test layer. Since the wire-level
// validation we need (chunk shape, [DONE] terminator, finish reasons,
// tool-call args concat) is fully covered by parsing raw bytes, that
// extra dep isn't justified for 6.2. The 6.3 harness still proves
// end-to-end SDK compatibility because `callModel` rides on
// `/responses` — a 6.3 follow-up that adds a `/responses` adapter is
// where the full agent-SDK round-trip belongs. See ambiguity-call #6
// in PR body.

const MODEL = 'openrouter/auto';

type ChatBody = {
  model: string;
  messages: Array<{ role: 'user' | 'system' | 'assistant'; content: string }>;
  stream: true;
  max_tokens?: number;
  tools?: Array<{
    type: 'function';
    function: { name: string; description?: string; parameters?: unknown };
  }>;
};

function singleTurnRequest(text: string, extra: Partial<ChatBody> = {}): ChatBody {
  return {
    model: MODEL,
    messages: [{ role: 'user', content: text }],
    stream: true,
    max_tokens: 256,
    ...extra,
  };
}

/**
 * Low-level POST helper that tolerates abrupt socket close mid-stream
 * (mirrors the rawHttpPost in emulator-anthropic.test.ts).
 */
function rawHttpPost(
  baseUrl: string,
  path: string,
  jsonBody: unknown,
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  const url = new URL(path, baseUrl);
  const payload = Buffer.from(JSON.stringify(jsonBody));
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: url.hostname,
        port: Number(url.port),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(payload.length),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        const finish = () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        };
        res.on('end', finish);
        res.on('close', finish);
        res.on('aborted', finish);
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

describe('emulator: script-engine (openai wire)', () => {
  it('canonicalizes OpenAI-shape requests independent of key order', () => {
    const a = {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.2,
    };
    const b = {
      temperature: 0.2,
      messages: [{ role: 'user', content: 'hi' }],
      model: 'm',
    };
    expect(canonicalizeRequest(a, 'openai')).toBe(canonicalizeRequest(b, 'openai'));
  });

  it('strips non-semantic fields (stream, user, metadata) for openai canonicalization', () => {
    const base = singleTurnRequest('hello');
    const withCruft = { ...base, stream: false, user: 'u1', metadata: { trace: 'x' } };
    expect(computePromptHash(base, 'openai')).toBe(computePromptHash(withCruft, 'openai'));
  });

  it('differentiates anthropic vs openai canonical forms for the same body', () => {
    // Same JSON, different canonicalization shape — Anthropic keeps
    // `stop_sequences`/`top_k`, OpenAI keeps `stop`/`frequency_penalty`/etc.
    const body = singleTurnRequest('shared body');
    const anthropic = canonicalizeRequest(body, 'anthropic');
    const openai = canonicalizeRequest(body, 'openai');
    expect(anthropic).not.toBe(openai);
  });

  it('registry lookup honors expected wire and advances turn on match', () => {
    const r = new ScriptRegistry();
    const body = singleTurnRequest('hi');
    const hash = computePromptHash(body, 'openai');
    r.register({
      promptHash: hash,
      turn: 0,
      wire: 'openai',
      kind: 'success',
      response: {
        model: MODEL,
        finishReason: 'stop',
        content: 'hi back',
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    });
    const hit = r.lookup(body, 'openai');
    expect(hit.ok).toBe(true);
    if (!hit.ok) return;
    expect(isOpenAIEntry(hit.entry)).toBe(true);
    expect(r.turnsServed).toBe(1);
  });

  it('registry lookup reports wire mismatch without advancing turn', () => {
    const r = new ScriptRegistry();
    const body = singleTurnRequest('mismatch');
    // Register an Anthropic-flavored entry whose promptHash deliberately
    // collides with the OpenAI canonicalization of `body`. We do this by
    // computing the hash with `'openai'` so the registry index matches when
    // the OpenAI adapter looks it up.
    const hash = computePromptHash(body, 'openai');
    r.register({
      promptHash: hash,
      turn: 0,
      wire: 'anthropic',
      kind: 'success',
      response: {
        model: MODEL,
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'oops' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    const miss = r.lookup(body, 'openai');
    expect(miss.ok).toBe(false);
    if (miss.ok) return;
    expect('mismatch' in miss && miss.mismatch).toBe(true);
    expect(miss.error.body.error.type).toBe('emulator_wire_mismatch');
    expect(r.turnsServed).toBe(0);
    // Subsequent identical mismatch → dedup flag set.
    const second = r.lookup(body, 'openai');
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.dedup).toBe(true);
  });

  it('entryWire defaults to anthropic when the wire field is absent', () => {
    const e = {
      promptHash: 'sha256:abc',
      turn: 0,
      kind: 'success' as const,
      response: {
        model: MODEL,
        stopReason: 'end_turn' as const,
        content: [{ type: 'text' as const, text: 'x' }],
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    };
    expect(entryWire(e)).toBe('anthropic');
  });
});

describe('emulator: openai chunk builder', () => {
  const baseResponse: OpenAIResponse = {
    model: MODEL,
    finishReason: 'stop',
    content: 'hello',
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };

  it('emits role-only opening + content delta(s) + finish + usage', () => {
    const chunks = buildOpenAIChunks(baseResponse, { chunkSize: 'natural' });
    expect(chunks[0]!.choices[0]!.delta.role).toBe('assistant');
    expect(chunks[1]!.choices[0]!.delta.content).toBe('hello');
    expect(chunks[chunks.length - 2]!.choices[0]!.finish_reason).toBe('stop');
    expect(chunks[chunks.length - 1]!.usage).toEqual(baseResponse.usage);
    expect(chunks[chunks.length - 1]!.choices).toEqual([]);
  });

  it('chunkSize=N splits the content text into N-char deltas', () => {
    const chunks = buildOpenAIChunks({ ...baseResponse, content: 'abcdef' }, { chunkSize: 2 });
    const contentDeltas = chunks
      .map((c) => c.choices[0]?.delta.content)
      .filter((v): v is string => typeof v === 'string');
    expect(contentDeltas).toEqual(['ab', 'cd', 'ef']);
  });

  it('streams tool_calls with role-frame + incremental arguments concat', () => {
    const chunks = buildOpenAIChunks(
      {
        model: MODEL,
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'call_1', name: 'echo', arguments: '{"v":"hi"}' }],
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      },
      { chunkSize: 4 },
    );
    // Opening chunk carries the tool-call frame (id, name, type, empty args).
    const opening = chunks[0]!.choices[0]!.delta;
    expect(opening.tool_calls?.[0]).toMatchObject({
      index: 0,
      id: 'call_1',
      type: 'function',
      function: { name: 'echo', arguments: '' },
    });
    // Subsequent tool_call chunks carry only arg fragments — the SDK
    // string-concats them per `index`.
    const argFragments = chunks
      .slice(1)
      .map((c) => c.choices[0]?.delta.tool_calls?.[0]?.function?.arguments)
      .filter((v): v is string => typeof v === 'string');
    expect(argFragments.join('')).toBe('{"v":"hi"}');
    // finish_reason 'tool_calls' lands on the penultimate chunk (before usage).
    expect(chunks[chunks.length - 2]!.choices[0]!.finish_reason).toBe('tool_calls');
  });

  it('emits reasoning deltas before content when scripted', () => {
    const chunks = buildOpenAIChunks(
      {
        ...baseResponse,
        reasoning: 'think think',
      },
      { chunkSize: 'natural' },
    );
    const reasoningIdx = chunks.findIndex((c) => c.choices[0]?.delta.reasoning);
    const contentIdx = chunks.findIndex((c) => c.choices[0]?.delta.content);
    expect(reasoningIdx).toBeGreaterThan(0);
    expect(contentIdx).toBeGreaterThan(reasoningIdx);
  });

  it('serializes chunks to data:-only SSE lines', () => {
    const wire = serializeOpenAIChunk({
      id: 'x',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'm',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    });
    expect(wire).toMatch(/^data: \{.*\}\n\n$/);
    expect(wire).not.toContain('event: ');
    expect(SSE_DONE).toBe('data: [DONE]\n\n');
  });
});

describe('emulator: HTTP round-trip (OpenAI /v1/chat/completions)', () => {
  let emu: EmulatorHandle;

  beforeEach(async () => {
    emu = await startEmulator();
  });

  afterEach(async () => {
    await emu.stop();
  });

  it('round-trips a text-only response as a well-formed OpenAI/OR SSE stream', async () => {
    const body = singleTurnRequest('echo this');
    emu.registry.register({
      promptHash: computePromptHash(body, 'openai'),
      turn: 0,
      wire: 'openai',
      kind: 'success',
      response: {
        id: 'chatcmpl_test_1',
        model: MODEL,
        finishReason: 'stop',
        content: 'Hello from the emulator.',
        usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
      },
      stream: { chunkSize: 5 },
    });

    const res = await fetch(`${emu.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const text = await res.text();
    const blocks = text
      .split('\n\n')
      .map((b) => b.trim())
      .filter((b) => b.startsWith('data: '));

    let content = '';
    let finalFinish: string | null = null;
    let usageSeen = false;
    let openingRoleSeen = false;
    let idStable = true;
    let seenId: string | undefined;
    for (const line of blocks) {
      if (line === 'data: [DONE]') continue;
      const json = JSON.parse(line.slice('data: '.length)) as {
        id: string;
        object: string;
        choices: Array<{
          delta: { role?: string; content?: string };
          finish_reason: string | null;
        }>;
        usage?: { total_tokens?: number };
      };
      expect(json.object).toBe('chat.completion.chunk');
      if (seenId === undefined) seenId = json.id;
      else if (seenId !== json.id) idStable = false;
      const ch = json.choices[0];
      if (ch?.delta?.role === 'assistant') openingRoleSeen = true;
      if (ch?.delta?.content) content += ch.delta.content;
      if (ch?.finish_reason) finalFinish = ch.finish_reason;
      if (json.usage) usageSeen = true;
    }
    expect(openingRoleSeen).toBe(true);
    expect(content).toBe('Hello from the emulator.');
    expect(finalFinish).toBe('stop');
    expect(usageSeen).toBe(true);
    expect(idStable).toBe(true);
    expect(text.trim().endsWith('data: [DONE]')).toBe(true);
  });

  it('round-trips a tool_calls response with incremental args concat', async () => {
    const body = singleTurnRequest('use the tool', {
      tools: [
        {
          type: 'function',
          function: {
            name: 'echo',
            description: 'echo input',
            parameters: { type: 'object', properties: { value: { type: 'string' } } },
          },
        },
      ],
    });
    emu.registry.register({
      promptHash: computePromptHash(body, 'openai'),
      turn: 0,
      wire: 'openai',
      kind: 'success',
      response: {
        model: MODEL,
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'call_abc', name: 'echo', arguments: '{"value":"hello"}' }],
        usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
      },
      stream: { chunkSize: 3 },
    });

    // Use raw fetch — the OpenRouter SDK's stream wrapper drops tool_call
    // delta fragments below the top-level Choice schema, but the SSE wire
    // is what 6.3 cares about. Assert the args reassemble correctly when a
    // consumer string-concats by index.
    const res = await fetch(`${emu.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const dataLines = text
      .split('\n\n')
      .map((b) => b.trim())
      .filter((b) => b.startsWith('data: ') && !b.endsWith('[DONE]'));
    let argsConcat = '';
    let sawOpeningFrame = false;
    let finish: string | null = null;
    for (const line of dataLines) {
      const json = JSON.parse(line.slice('data: '.length)) as {
        choices: Array<{
          delta: {
            tool_calls?: Array<{
              index: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
          finish_reason: string | null;
        }>;
      };
      const tc = json.choices[0]?.delta?.tool_calls?.[0];
      if (tc?.id) sawOpeningFrame = true;
      if (tc?.function?.arguments && !tc.id) argsConcat += tc.function.arguments;
      if (json.choices[0]?.finish_reason) finish = json.choices[0].finish_reason;
    }
    expect(sawOpeningFrame).toBe(true);
    expect(argsConcat).toBe('{"value":"hello"}');
    expect(finish).toBe('tool_calls');
    expect(text.trim().endsWith('data: [DONE]')).toBe(true);
  });

  it('supports all four OpenAI finish reasons', async () => {
    const reasons = ['stop', 'tool_calls', 'length', 'content_filter'] as const;
    for (const fr of reasons) {
      const body = singleTurnRequest(`prompt for ${fr}`);
      emu.registry.reset();
      emu.registry.register({
        promptHash: computePromptHash(body, 'openai'),
        turn: 0,
        wire: 'openai',
        kind: 'success',
        response: {
          model: MODEL,
          finishReason: fr,
          content: fr === 'tool_calls' ? '' : fr,
          ...(fr === 'tool_calls'
            ? { toolCalls: [{ id: 'c', name: 'noop', arguments: '{}' }] }
            : {}),
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      });
      const res = await fetch(`${emu.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      expect(text).toContain(`"finish_reason":"${fr}"`);
      expect(text.trim().endsWith('data: [DONE]')).toBe(true);
    }
  });

  it('returns 500 with structured diagnostic on missing script', async () => {
    const body = singleTurnRequest('nothing registered');
    const res = await fetch(`${emu.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(500);
    const payload = (await res.json()) as {
      error: {
        type: string;
        message: string;
        diagnostic?: { promptHash: string; turn: number; registered: unknown[] };
      };
    };
    expect(payload.error.type).toBe('emulator_script_miss');
    expect(payload.error.diagnostic?.turn).toBe(0);
  });

  it('returns 500 with wire-mismatch diagnostic when script declares wire=anthropic', async () => {
    const body = singleTurnRequest('wire mismatch');
    emu.registry.register({
      // Index under the OpenAI hash so the lookup matches; declare the
      // wire as anthropic so the adapter rejects it.
      promptHash: computePromptHash(body, 'openai'),
      turn: 0,
      wire: 'anthropic',
      kind: 'success',
      response: {
        model: MODEL,
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'should not stream' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    const res = await fetch(`${emu.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(500);
    const payload = (await res.json()) as {
      error: {
        type: string;
        message: string;
        diagnostic?: { expectedWire?: string; entryWire?: string };
      };
    };
    expect(payload.error.type).toBe('emulator_wire_mismatch');
    expect(payload.error.diagnostic?.expectedWire).toBe('openai');
    expect(payload.error.diagnostic?.entryWire).toBe('anthropic');
  });

  it('rejects non-streaming requests with a 400 stub-fail', async () => {
    const res = await fetch(`${emu.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...singleTurnRequest('hi'), stream: false }),
    });
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: { message: string } };
    expect(payload.error.message).toMatch(/streaming/);
  });

  it('rejects non-JSON request bodies with a 400', async () => {
    // Send a non-JSON body to exercise the body-parse error branch.
    const url = new URL('/v1/chat/completions', emu.url);
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          host: url.hostname,
          port: Number(url.port),
          path: url.pathname,
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': '5' },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );
      req.on('error', reject);
      req.write('not-json');
      req.end();
    });
    expect(result.status).toBe(400);
  });

  it('404s on unknown paths beneath /v1/', async () => {
    const res = await fetch(`${emu.url}/v1/embeddings`, { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

describe('emulator: failure injection (OpenAI shape)', () => {
  let emu: EmulatorHandle;

  beforeEach(async () => {
    emu = await startEmulator();
  });

  afterEach(async () => {
    await emu.stop();
  });

  it('mid_stream_error: writes an error chunk after N normal chunks', async () => {
    const body = singleTurnRequest('mid stream boom');
    emu.registry.register({
      promptHash: computePromptHash(body, 'openai'),
      turn: 0,
      wire: 'openai',
      kind: 'failure',
      failure: { type: 'mid_stream_error', eventsBeforeError: 2 },
      partial: {
        model: MODEL,
        finishReason: 'stop',
        content: 'partial...',
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    });
    const res = await fetch(`${emu.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"role":"assistant"');
    expect(text).toContain('"error":');
    expect(text).not.toContain('data: [DONE]');
  });

  it('rate_limit_429: returns 429 with Retry-After header (no SSE)', async () => {
    const body = singleTurnRequest('rate-limited');
    emu.registry.register({
      promptHash: computePromptHash(body, 'openai'),
      turn: 0,
      wire: 'openai',
      kind: 'failure',
      failure: { type: 'rate_limit_429', retryAfter: 45 },
    });
    const res = await fetch(`${emu.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('45');
    const payload = (await res.json()) as { error: { type: string } };
    expect(payload.error.type).toBe('rate_limit_exceeded');
  });

  it('malformed_chunk: injects invalid JSON in the Nth chunk and closes', async () => {
    const body = singleTurnRequest('malformed chunk');
    emu.registry.register({
      promptHash: computePromptHash(body, 'openai'),
      turn: 0,
      wire: 'openai',
      kind: 'failure',
      failure: { type: 'malformed_chunk', atChunkIndex: 0 },
      partial: {
        model: MODEL,
        finishReason: 'stop',
        content: 'unreachable',
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    });
    const res = await fetch(`${emu.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('not-valid-json');
    expect(text).not.toContain('data: [DONE]');
  });

  it('truncated_stream: closes the socket mid-chunk (no terminator, no [DONE])', async () => {
    const body = singleTurnRequest('truncate me');
    emu.registry.register({
      promptHash: computePromptHash(body, 'openai'),
      turn: 0,
      wire: 'openai',
      kind: 'failure',
      failure: { type: 'truncated_stream', eventsBeforeTruncation: 1 },
      partial: {
        model: MODEL,
        finishReason: 'stop',
        content: 'should-not-complete',
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    });
    const { status, body: text } = await rawHttpPost(emu.url, '/v1/chat/completions', body);
    expect(status).toBe(200);
    expect(text).toContain('"role":"assistant"');
    expect(text).not.toContain('data: [DONE]');
  });

  it('split_json_field: forces a TCP boundary mid-JSON; content still reassembles', async () => {
    const body = singleTurnRequest('split me');
    emu.registry.register({
      promptHash: computePromptHash(body, 'openai'),
      turn: 0,
      wire: 'openai',
      kind: 'failure',
      failure: { type: 'split_json_field', atChunkIndex: 0, splitAt: 30 },
      partial: {
        model: MODEL,
        finishReason: 'stop',
        content: 'hello-world',
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    });
    const res = await fetch(`${emu.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    // The full content still appears in the reassembled response — the
    // split is byte-level, not logical.
    expect(text).toContain('hello-world');
    expect(text.trim().endsWith('data: [DONE]')).toBe(true);
  });

  it('tool_call_args_malformed: streams a tool-call whose arguments are invalid JSON', async () => {
    const body = singleTurnRequest('break the args');
    emu.registry.register({
      promptHash: computePromptHash(body, 'openai'),
      turn: 0,
      wire: 'openai',
      kind: 'failure',
      failure: { type: 'tool_call_args_malformed', toolCallIndex: 0 },
      partial: {
        model: MODEL,
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'call_x', name: 'echo', arguments: '{"this":"is overridden"}' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    });
    const res = await fetch(`${emu.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    // The SSE envelope is well-formed (we still terminate with [DONE]).
    expect(text.trim().endsWith('data: [DONE]')).toBe(true);
    // Reassemble the args fragments — they should compose to the malformed
    // sentinel `{"unterminated` rather than the original.
    const argFragments: string[] = [];
    for (const block of text.split('\n\n')) {
      const trimmed = block.trim();
      if (!trimmed.startsWith('data: ') || trimmed.endsWith('[DONE]')) continue;
      const json = JSON.parse(trimmed.slice('data: '.length)) as {
        choices: Array<{
          delta: {
            tool_calls?: Array<{
              id?: string;
              function?: { arguments?: string };
            }>;
          };
        }>;
      };
      const tc = json.choices[0]?.delta.tool_calls?.[0];
      if (tc?.function?.arguments && !tc.id) argFragments.push(tc.function.arguments);
    }
    const reassembled = argFragments.join('');
    expect(reassembled).toBe('{"unterminated');
    expect(() => JSON.parse(reassembled)).toThrow();
  });
});
