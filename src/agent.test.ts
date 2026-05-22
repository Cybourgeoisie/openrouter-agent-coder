import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

const callModelMock = vi.fn();
const openRouterCtorMock = vi.fn();

vi.mock('@openrouter/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openrouter/agent')>();
  // Identity stop conditions — the real values are not exercised in tests.
  const stepCountIs = (n: number) => ({ kind: 'stepCountIs', n });
  const maxCost = (n: number) => ({ kind: 'maxCost', n });
  // Type guards keyed by the discriminant strings we use in test events.
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
import type { AgentCoreEvent } from './events.js';
import { allTools } from './tools/index.js';

interface FakeResponse {
  id?: string;
  model?: string;
  usage?: { cost?: number; inputTokens?: number; outputTokens?: number; totalTokens?: number };
  output?: unknown[];
}

interface FakeCallModelArgs {
  events: unknown[];
  response?: FakeResponse;
  /** Whether to invoke onTurnEnd internally with the response (true by default if response.usage.cost provided). */
  invokeOnTurnEnd?: boolean;
}

function fakeCallModel(args: FakeCallModelArgs) {
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
        if (args.invokeOnTurnEnd && request.onTurnEnd) {
          await request.onTurnEnd({}, response);
        }
      },
      async getResponse() {
        return response;
      },
    };
  };
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

beforeEach(() => {
  callModelMock.mockReset();
  openRouterCtorMock.mockReset();
});

const TEST_SESSION = 'test-agent-session';

afterEach(async () => {
  await rm(join(process.cwd(), 'logs', TEST_SESSION), { recursive: true, force: true });
});

describe('OpenRouterAgentRun event iteration', () => {
  it('yields session_started, turn_start, text_delta, turn_end, stream_complete in order for a simple turn', async () => {
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
          model: 'mock',
          usage: { cost: 0.001, inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          output: [],
        },
      }),
    );

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: TEST_SESSION,
      prompt: 'hi',
    });
    const events = await collect(run);

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      'session_started',
      'turn_start',
      'text_delta',
      'text_delta',
      'turn_end',
      'stream_complete',
    ]);
    expect(events[0]).toEqual({ type: 'session_started', sessionId: TEST_SESSION });
    expect(events[2]).toEqual({ type: 'text_delta', content: 'hello ' });
    expect(events[3]).toEqual({ type: 'text_delta', content: 'world' });
    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.status).toBe('success');
    expect(complete.usage?.totalTokens).toBe(15);
    expect(complete.costUsd).toBeGreaterThan(0);
    expect(complete.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('translates function_call output_item.done to tool_call with parsed JSON input', async () => {
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
              callId: 'call_123',
              name: 'read_file',
              arguments: '{"path":"foo.txt"}',
            },
          },
          {
            type: 'tool.call_output',
            timestamp: 1,
            output: {
              callId: 'call_123',
              type: 'function_call_output',
              output: 'file contents',
              status: 'completed',
            },
          },
          { type: 'turn.end', turnNumber: 0, timestamp: 2 },
        ],
      }),
    );

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: TEST_SESSION,
      prompt: 'read foo.txt',
    });
    const events = await collect(run);

    const toolCall = events.find((e) => e.type === 'tool_call');
    expect(toolCall).toEqual({
      type: 'tool_call',
      callId: 'call_123',
      name: 'read_file',
      input: { path: 'foo.txt' },
    });
    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult).toEqual({
      type: 'tool_result',
      callId: 'call_123',
      output: 'file contents',
      isError: false,
    });
  });

  it('marks tool_result.isError true when output status is incomplete', async () => {
    callModelMock.mockImplementation(
      fakeCallModel({
        events: [
          { type: 'turn.start', turnNumber: 0, timestamp: 1 },
          {
            type: 'tool.call_output',
            timestamp: 1,
            output: {
              callId: 'c1',
              type: 'function_call_output',
              output: 'boom',
              status: 'incomplete',
            },
          },
          { type: 'turn.end', turnNumber: 0, timestamp: 2 },
        ],
      }),
    );

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: TEST_SESSION,
      prompt: 'fail',
    });
    const events = await collect(run);

    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult).toMatchObject({ callId: 'c1', isError: true });
  });

  it('preserves raw arguments string when tool_call JSON parse fails', async () => {
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
              callId: 'c2',
              name: 'x',
              arguments: 'not-json{',
            },
          },
          { type: 'turn.end', turnNumber: 0, timestamp: 2 },
        ],
      }),
    );

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: TEST_SESSION,
      prompt: 'p',
    });
    const events = await collect(run);
    const toolCall = events.find((e) => e.type === 'tool_call');
    expect(toolCall).toMatchObject({ input: 'not-json{' });
  });
});

describe('OpenRouterAgentRun defaults', () => {
  it('defaults tools to allTools when none provided', async () => {
    callModelMock.mockImplementation(
      fakeCallModel({
        events: [
          { type: 'turn.start', turnNumber: 0 },
          { type: 'turn.end', turnNumber: 0 },
        ],
      }),
    );

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: TEST_SESSION,
      prompt: 'p',
    });
    await collect(run);

    expect(callModelMock).toHaveBeenCalledTimes(1);
    const passed = callModelMock.mock.calls[0][0];
    expect(passed.tools).toBe(allTools);
  });

  it('honours custom tools array', async () => {
    callModelMock.mockImplementation(
      fakeCallModel({
        events: [
          { type: 'turn.start', turnNumber: 0 },
          { type: 'turn.end', turnNumber: 0 },
        ],
      }),
    );

    const customTools: any[] = [{ type: 'function', function: { name: 'noop' } }];
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: TEST_SESSION,
      prompt: 'p',
      tools: customTools,
    });
    await collect(run);
    expect(callModelMock.mock.calls[0][0].tools).toBe(customTools);
  });

  it('passes apiKey, baseUrl, appTitle through to the OR client constructor', async () => {
    callModelMock.mockImplementation(
      fakeCallModel({
        events: [
          { type: 'turn.start', turnNumber: 0 },
          { type: 'turn.end', turnNumber: 0 },
        ],
      }),
    );

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-explicit',
      sessionId: TEST_SESSION,
      prompt: 'p',
      baseUrl: 'https://example.test',
      appTitle: 'my-app',
    });
    await collect(run);

    const ctorArgs = openRouterCtorMock.mock.calls[0][0];
    expect(ctorArgs.apiKey).toBe('sk-explicit');
    expect(ctorArgs.serverURL).toBe('https://example.test');
    expect(ctorArgs.appTitle).toBe('my-app');
  });

  it('defaults appTitle to openrouter-agent-coder', async () => {
    callModelMock.mockImplementation(
      fakeCallModel({
        events: [
          { type: 'turn.start', turnNumber: 0 },
          { type: 'turn.end', turnNumber: 0 },
        ],
      }),
    );
    const run = new OpenRouterAgentRun({
      apiKey: 'k',
      sessionId: TEST_SESSION,
      prompt: 'p',
    });
    await collect(run);
    expect(openRouterCtorMock.mock.calls[0][0].appTitle).toBe('openrouter-agent-coder');
  });
});

describe('OpenRouterAgentRun completion status', () => {
  it('reports max_budget when totalCost >= maxBudgetUsd', async () => {
    callModelMock.mockImplementation(
      fakeCallModel({
        events: [
          { type: 'turn.start', turnNumber: 0 },
          { type: 'turn.end', turnNumber: 0 },
        ],
        response: {
          id: 'r',
          model: 'm',
          usage: { cost: 0.5, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          output: [],
        },
      }),
    );

    const run = new OpenRouterAgentRun({
      apiKey: 'k',
      sessionId: TEST_SESSION,
      prompt: 'p',
      maxBudgetUsd: 0.1,
    });
    const events = await collect(run);
    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.status).toBe('max_budget');
  });

  it('reports max_turns when turn count reaches maxTurns', async () => {
    callModelMock.mockImplementation(
      fakeCallModel({
        events: [
          { type: 'turn.start', turnNumber: 0 },
          { type: 'turn.end', turnNumber: 0 },
          { type: 'turn.start', turnNumber: 1 },
          { type: 'turn.end', turnNumber: 1 },
        ],
      }),
    );

    const run = new OpenRouterAgentRun({
      apiKey: 'k',
      sessionId: TEST_SESSION,
      prompt: 'p',
      maxTurns: 2,
    });
    const events = await collect(run);
    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.status).toBe('max_turns');
  });

  it('yields error then stream_complete{status:error} when the stream throws', async () => {
    callModelMock.mockImplementation(() => ({
      async *getFullResponsesStream() {
        yield { type: 'turn.start', turnNumber: 0 };
        throw new Error('boom');
      },
      async getResponse() {
        throw new Error('unused');
      },
    }));

    const run = new OpenRouterAgentRun({
      apiKey: 'k',
      sessionId: TEST_SESSION,
      prompt: 'p',
    });
    const events = await collect(run);
    const types = events.map((e) => e.type);
    expect(types.at(-2)).toBe('error');
    expect(types.at(-1)).toBe('stream_complete');
    const err = events.find((e) => e.type === 'error') as Extract<
      AgentCoreEvent,
      { type: 'error' }
    >;
    expect(err.message).toBe('boom');
    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.status).toBe('error');
    expect(complete.reason).toBe('boom');
  });
});

describe('OpenRouterAgentRun side-effect invariants', () => {
  it('does not read process.env for OPENROUTER_API_KEY or OR_* config', async () => {
    callModelMock.mockImplementation(
      fakeCallModel({
        events: [
          { type: 'turn.start', turnNumber: 0 },
          { type: 'turn.end', turnNumber: 0 },
        ],
      }),
    );

    const sentinel = Symbol('untouched');
    const watched: Record<string, unknown> = {
      OPENROUTER_API_KEY: sentinel,
      OR_MODEL: sentinel,
      OR_MAX_STEPS: sentinel,
      OR_MAX_COST: sentinel,
      OPENROUTER_BASE_URL: sentinel,
      DEBUG: sentinel,
    };
    const reads: string[] = [];
    const realEnv = process.env;
    const proxiedEnv = new Proxy(realEnv, {
      get(target, prop, recv) {
        if (typeof prop === 'string' && prop in watched) {
          reads.push(prop);
          return undefined;
        }
        return Reflect.get(target, prop, recv);
      },
    }) as NodeJS.ProcessEnv;
    Object.defineProperty(process, 'env', { value: proxiedEnv, configurable: true });

    try {
      const run = new OpenRouterAgentRun({
        apiKey: 'k',
        sessionId: TEST_SESSION,
        prompt: 'p',
      });
      await collect(run);
    } finally {
      Object.defineProperty(process, 'env', { value: realEnv, configurable: true });
    }

    expect(reads).toEqual([]);
  });

  it('does not call any console method during a normal run', async () => {
    callModelMock.mockImplementation(
      fakeCallModel({
        events: [
          { type: 'turn.start', turnNumber: 0 },
          { type: 'turn.end', turnNumber: 0 },
        ],
      }),
    );

    const spies = {
      log: vi.spyOn(console, 'log').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      info: vi.spyOn(console, 'info').mockImplementation(() => {}),
      debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
    };
    try {
      const run = new OpenRouterAgentRun({
        apiKey: 'k',
        sessionId: TEST_SESSION,
        prompt: 'p',
      });
      await collect(run);
      for (const s of Object.values(spies)) expect(s).not.toHaveBeenCalled();
    } finally {
      for (const s of Object.values(spies)) s.mockRestore();
    }
  });

  it('invokes the logger callback when set, and only then', async () => {
    callModelMock.mockImplementation(
      fakeCallModel({
        events: [
          { type: 'turn.start', turnNumber: 0 },
          { type: 'turn.end', turnNumber: 0 },
        ],
      }),
    );

    const calls: Array<[string, string, Record<string, unknown> | undefined]> = [];
    const run = new OpenRouterAgentRun({
      apiKey: 'k',
      sessionId: TEST_SESSION,
      prompt: 'p',
      logger: (level, msg, fields) => calls.push([level, msg, fields]),
    });
    await collect(run);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0][0]).toBe('debug');
  });
});

describe('OpenRouterAgentRun lifecycle', () => {
  it('exposes an abort() stub that can be called without throwing', () => {
    const run = new OpenRouterAgentRun({
      apiKey: 'k',
      sessionId: TEST_SESSION,
      prompt: 'p',
    });
    expect(() => run.abort()).not.toThrow();
  });

  it('throws if iterated more than once', async () => {
    callModelMock.mockImplementation(
      fakeCallModel({
        events: [
          { type: 'turn.start', turnNumber: 0 },
          { type: 'turn.end', turnNumber: 0 },
        ],
      }),
    );

    const run = new OpenRouterAgentRun({
      apiKey: 'k',
      sessionId: TEST_SESSION,
      prompt: 'p',
    });
    await collect(run);
    expect(() => run[Symbol.asyncIterator]()).toThrow(/single-shot/);
  });
});
