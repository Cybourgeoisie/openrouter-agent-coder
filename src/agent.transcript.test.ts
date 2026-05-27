import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const callModelMock = vi.fn();
const openRouterCtorMock = vi.fn();

vi.mock('@openrouter/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openrouter/agent')>();
  const stepCountIs = (n: number) => ({ kind: 'stepCountIs', n });
  const maxCost = (n: number) => ({ kind: 'maxCost', n });
  const isTurnStartEvent = (e: unknown): e is { type: 'turn.start'; turnNumber: number } =>
    !!e && typeof e === 'object' && (e as { type?: string }).type === 'turn.start';
  const isTurnEndEvent = (e: unknown): e is { type: 'turn.end'; turnNumber: number } =>
    !!e && typeof e === 'object' && (e as { type?: string }).type === 'turn.end';
  const isToolCallOutputEvent = (
    e: unknown,
  ): e is {
    type: 'tool.call_output';
    output: { callId: string; output: unknown; status?: string };
  } => !!e && typeof e === 'object' && (e as { type?: string }).type === 'tool.call_output';
  class OpenRouter {
    callModel: typeof callModelMock;
    constructor(...args: unknown[]) {
      openRouterCtorMock(...args);
      this.callModel = callModelMock;
    }
  }
  return {
    ...actual,
    OpenRouter,
    stepCountIs,
    maxCost,
    isTurnStartEvent,
    isTurnEndEvent,
    isToolCallOutputEvent,
  };
});

vi.mock('./tools/server-tools.js', () => ({
  SERVER_TOOLS: [],
  createServerToolsHooks: () => ({}),
}));

import { OpenRouterAgentRun } from './agent.js';
import { readTranscript, type TranscriptRecord } from './logging/transcript.js';

interface FakeResponse {
  id?: string;
  model?: string;
  usage?: {
    cost?: number;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    inputTokensDetails?: { cachedTokens?: number };
    outputTokensDetails?: { reasoningTokens?: number };
  };
  output?: unknown[];
}

function fakeCallModel(args: { events: unknown[]; response?: FakeResponse }) {
  return (request: { onTurnEnd?: (ctx: unknown, resp: FakeResponse) => Promise<void> | void }) => {
    const response: FakeResponse = args.response ?? {
      id: 'resp-1',
      model: 'mock-model',
      usage: { cost: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      output: [],
    };
    return {
      async *getFullResponsesStream() {
        for (const ev of args.events) yield ev;
        if (request.onTurnEnd) {
          await request.onTurnEnd({ numberOfTurns: 1 }, response);
        }
      },
      async getResponse() {
        return response;
      },
    };
  };
}

async function drain(iter: AsyncIterable<unknown>): Promise<void> {
  for await (const _e of iter) {
    void _e;
  }
}

async function collectTranscript(logsRoot: string, sessionId: string): Promise<TranscriptRecord[]> {
  const out: TranscriptRecord[] = [];
  for await (const r of readTranscript(logsRoot, sessionId)) out.push(r);
  return out;
}

beforeEach(() => {
  callModelMock.mockReset();
  openRouterCtorMock.mockReset();
});

let logsRoot: string;
const SESSION = 'sess_transcript_integration';

beforeEach(async () => {
  logsRoot = await mkdtemp(join(tmpdir(), 'or-agent-transcript-'));
});

afterEach(async () => {
  await rm(logsRoot, { recursive: true, force: true });
});

describe('OpenRouterAgentRun transcript log', () => {
  it('writes session_start → user → assistant (with model/usage/cost) → session_end on a simple turn', async () => {
    callModelMock.mockImplementation(
      fakeCallModel({
        events: [
          { type: 'turn.start', turnNumber: 0, timestamp: 1 },
          { type: 'response.output_text.delta', delta: 'hello ' },
          { type: 'response.output_text.delta', delta: 'world' },
          { type: 'turn.end', turnNumber: 0, timestamp: 2 },
        ],
        response: {
          id: 'r1',
          model: 'openrouter/auto/resolved-to-claude',
          usage: {
            cost: 0.0034,
            inputTokens: 42,
            outputTokens: 13,
            totalTokens: 55,
            inputTokensDetails: { cachedTokens: 8 },
            outputTokensDetails: { reasoningTokens: 5 },
          },
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'hello world' }],
            },
          ],
        },
      }),
    );

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'say hi',
      logsRoot,
    });
    await drain(run);

    const records = await collectTranscript(logsRoot, SESSION);
    const kinds = records.map((r) => r.kind);
    expect(kinds).toEqual(['session_start', 'user', 'assistant', 'session_end']);

    const assistant = records[2] as Extract<TranscriptRecord, { kind: 'assistant' }>;
    expect(assistant.turnNumber).toBe(1);
    expect(assistant.model).toBe('openrouter/auto/resolved-to-claude');
    expect(assistant.text).toBe('hello world');
    expect(assistant.usage).toEqual({
      prompt: 42,
      completion: 13,
      reasoning: 5,
      cached: 8,
    });
    expect(assistant.costUsd).toBeCloseTo(0.0034);
    expect(assistant.requestId).toMatch(/^req_/);

    const sessionEnd = records[3] as Extract<TranscriptRecord, { kind: 'session_end' }>;
    expect(sessionEnd.status).toBe('success');
    expect(sessionEnd.totalCostUsd).toBeCloseTo(0.0034);
  });

  it('captures reasoning content from response.output reasoning items', async () => {
    callModelMock.mockImplementation(
      fakeCallModel({
        events: [
          { type: 'turn.start', turnNumber: 0, timestamp: 1 },
          { type: 'turn.end', turnNumber: 0, timestamp: 2 },
        ],
        response: {
          id: 'r2',
          model: 'm',
          usage: { cost: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          output: [
            {
              type: 'reasoning',
              content: [{ type: 'reasoning_text', text: 'Let me think… ' }],
            },
            {
              type: 'reasoning',
              content: [{ type: 'reasoning_text', text: 'OK done.' }],
            },
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'answer' }],
            },
          ],
        },
      }),
    );

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'think hard',
      logsRoot,
    });
    await drain(run);

    const records = await collectTranscript(logsRoot, SESSION);
    const assistant = records.find((r) => r.kind === 'assistant') as Extract<
      TranscriptRecord,
      { kind: 'assistant' }
    >;
    expect(assistant.reasoning).toBe('Let me think… OK done.');
    expect(assistant.text).toBe('answer');
  });

  it('writes tool_result with the resolved tool name (looked up from tool_call)', async () => {
    callModelMock.mockImplementation(
      fakeCallModel({
        events: [
          { type: 'turn.start', turnNumber: 0, timestamp: 1 },
          {
            type: 'response.output_item.done',
            outputIndex: 0,
            sequenceNumber: 1,
            item: {
              type: 'function_call',
              callId: 'call_abc',
              name: 'read_file',
              arguments: '{"path":"foo.txt"}',
            },
          },
          {
            type: 'tool.call_output',
            timestamp: 1,
            output: {
              callId: 'call_abc',
              type: 'function_call_output',
              output: 'file body',
              status: 'completed',
            },
          },
          { type: 'turn.end', turnNumber: 0, timestamp: 2 },
        ],
      }),
    );

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'read foo',
      logsRoot,
    });
    await drain(run);

    const records = await collectTranscript(logsRoot, SESSION);
    const toolResult = records.find((r) => r.kind === 'tool_result') as Extract<
      TranscriptRecord,
      { kind: 'tool_result' }
    >;
    expect(toolResult).toBeDefined();
    expect(toolResult.callId).toBe('call_abc');
    expect(toolResult.name).toBe('read_file');
    expect(toolResult.isError).toBe(false);
    expect(toolResult.output).toBe('file body');
  });

  it('writes nothing under logsRoot when persistSession is false', async () => {
    callModelMock.mockImplementation(
      fakeCallModel({
        events: [
          { type: 'turn.start', turnNumber: 0, timestamp: 1 },
          { type: 'response.output_text.delta', delta: 'noop' },
          { type: 'turn.end', turnNumber: 0, timestamp: 2 },
        ],
      }),
    );

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'no persist',
      logsRoot,
      persistSession: false,
    });
    await drain(run);

    expect(existsSync(join(logsRoot, SESSION, 'transcript.jsonl'))).toBe(false);
    expect(existsSync(join(logsRoot, SESSION, 'session.json'))).toBe(false);

    const records = await collectTranscript(logsRoot, SESSION);
    expect(records).toEqual([]);
  });
});
