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

import { OpenRouterAgentRun, DEFAULT_INSTRUCTIONS } from './agent.js';
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
  it('defaults tools to the built-in set when none provided', async () => {
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
    const names = passed.tools.map((t: { function: { name: string } }) => t.function.name);
    expect(names).toEqual(allTools().map((t) => t.function.name));
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
  it('exposes an abort() method that can be called without throwing', () => {
    const run = new OpenRouterAgentRun({
      apiKey: 'k',
      sessionId: TEST_SESSION,
      prompt: 'p',
    });
    expect(() => run.abort()).not.toThrow();
    // Idempotent — second call is also fine.
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

describe('OpenRouterAgentRun abort behavior', () => {
  // Stream factory that yields one event, awaits a controllable promise, then
  // yields more events. The "pause" simulates a mid-stream point at which the
  // consumer can call abort().
  function pausableStreamCallModel(args: {
    before: unknown[];
    after: unknown[];
    paused: Promise<void>;
    afterCompleteCancel?: () => void;
  }) {
    let cancelled = false;
    return () => ({
      cancel: async () => {
        cancelled = true;
        args.afterCompleteCancel?.();
      },
      async *getFullResponsesStream() {
        for (const ev of args.before) yield ev;
        await args.paused;
        if (cancelled) return;
        for (const ev of args.after) yield ev;
      },
      async getResponse() {
        return {
          id: 'r',
          model: 'm',
          usage: { cost: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          output: [],
        };
      },
    });
  }

  it('skips all events and yields stream_complete{aborted} when signal is pre-aborted at construction', async () => {
    callModelMock.mockImplementation(
      fakeCallModel({
        events: [
          { type: 'turn.start', turnNumber: 0 },
          { type: 'response.output_text.delta', delta: 'never seen' },
          { type: 'turn.end', turnNumber: 0 },
        ],
      }),
    );

    const ctrl = new AbortController();
    ctrl.abort();
    const run = new OpenRouterAgentRun({
      apiKey: 'k',
      sessionId: TEST_SESSION,
      prompt: 'p',
      signal: ctrl.signal,
    });
    const events = await collect(run);

    // No session_started, no model invocation, just stream_complete.
    expect(events).toHaveLength(1);
    const complete = events[0] as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.type).toBe('stream_complete');
    expect(complete.status).toBe('error');
    expect(complete.reason).toBe('aborted');
    // OR client should not have been invoked at all.
    expect(callModelMock).not.toHaveBeenCalled();
  });

  it('stops yielding text_delta events after external signal aborts mid-stream', async () => {
    let release: () => void = () => {};
    const paused = new Promise<void>((r) => {
      release = r;
    });
    callModelMock.mockImplementation(
      pausableStreamCallModel({
        before: [
          { type: 'turn.start', turnNumber: 0 },
          { type: 'response.output_text.delta', delta: 'first' },
        ],
        after: [
          { type: 'response.output_text.delta', delta: 'should-not-be-seen' },
          { type: 'response.output_text.delta', delta: 'also-not-seen' },
          { type: 'turn.end', turnNumber: 0 },
        ],
        paused,
      }),
    );

    const ctrl = new AbortController();
    const run = new OpenRouterAgentRun({
      apiKey: 'k',
      sessionId: TEST_SESSION,
      prompt: 'p',
      signal: ctrl.signal,
    });

    const events: AgentCoreEvent[] = [];
    const iterPromise = (async () => {
      for await (const e of run) events.push(e);
    })();

    // Wait for the iterator to settle on the first delta, then fire abort.
    await new Promise<void>((r) => setTimeout(r, 20));
    ctrl.abort();
    release();
    await iterPromise;

    const deltas = events.filter((e) => e.type === 'text_delta');
    expect(deltas).toHaveLength(1);
    expect((deltas[0] as Extract<AgentCoreEvent, { type: 'text_delta' }>).content).toBe('first');

    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.type).toBe('stream_complete');
    expect(complete.status).toBe('error');
    expect(complete.reason).toBe('aborted');
  });

  it('internal abort() method produces the same outcome as an external signal', async () => {
    let release: () => void = () => {};
    const paused = new Promise<void>((r) => {
      release = r;
    });
    callModelMock.mockImplementation(
      pausableStreamCallModel({
        before: [
          { type: 'turn.start', turnNumber: 0 },
          { type: 'response.output_text.delta', delta: 'one' },
        ],
        after: [
          { type: 'response.output_text.delta', delta: 'two' },
          { type: 'turn.end', turnNumber: 0 },
        ],
        paused,
      }),
    );

    const run = new OpenRouterAgentRun({
      apiKey: 'k',
      sessionId: TEST_SESSION,
      prompt: 'p',
    });

    const events: AgentCoreEvent[] = [];
    const iterPromise = (async () => {
      for await (const e of run) events.push(e);
    })();

    await new Promise<void>((r) => setTimeout(r, 20));
    run.abort();
    release();
    await iterPromise;

    const deltas = events.filter((e) => e.type === 'text_delta');
    expect(deltas).toHaveLength(1);
    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.type).toBe('stream_complete');
    expect(complete.status).toBe('error');
    expect(complete.reason).toBe('aborted');
  });

  it('surfaces tool execution cancellation as tool_result.isError when abort fires during a tool call', async () => {
    // Simulate the OR SDK actually invoking a tool whose execute honours the
    // signal. The fake stream awaits the tool's promise and emits a
    // tool_call_output with status:'incomplete' if the tool throws.
    let toolStarted: () => void = () => {};
    const toolStartedP = new Promise<void>((r) => {
      toolStarted = r;
    });

    callModelMock.mockImplementation(
      (request: {
        tools: Array<{
          function: { name: string; execute: (...a: unknown[]) => Promise<unknown> };
        }>;
      }) => {
        const tool = request.tools.find((t) => t.function.name === 'slow_tool');
        return {
          cancel: async () => {},
          async *getFullResponsesStream() {
            yield { type: 'turn.start', turnNumber: 0 };
            yield {
              type: 'response.output_item.done',
              outputIndex: 0,
              sequenceNumber: 1,
              item: {
                type: 'function_call',
                callId: 'call_slow',
                name: 'slow_tool',
                arguments: '{}',
              },
            };
            toolStarted();
            let output: unknown;
            let status: 'completed' | 'incomplete' = 'completed';
            try {
              output = await tool!.function.execute({}, {});
            } catch (e) {
              output = (e as Error).message;
              status = 'incomplete';
            }
            yield {
              type: 'tool.call_output',
              timestamp: 1,
              output: {
                callId: 'call_slow',
                type: 'function_call_output',
                output,
                status,
              },
            };
            yield { type: 'turn.end', turnNumber: 0 };
          },
          async getResponse() {
            return {
              id: 'r',
              model: 'm',
              usage: { cost: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
              output: [],
            };
          },
        };
      },
    );

    // A custom tool that respects the agent's composite signal. Since custom
    // tools aren't wrapped automatically, the test exercises the wiring path
    // via run.abort() → run.compositeSignal → tool execute via closure.
    // To bridge: we read the signal from the run after construction.
    const ctrl = new AbortController();
    const signalRef: AbortSignal = ctrl.signal;

    const slowTool = {
      type: 'function' as const,
      function: {
        name: 'slow_tool',
        description: 'slow',
        execute: async () => {
          return await new Promise<unknown>((resolve, reject) => {
            if (signalRef.aborted) {
              reject(new Error('slow_tool cancelled'));
              return;
            }
            const onAbort = () => {
              clearTimeout(timer);
              reject(new Error('slow_tool cancelled'));
            };
            const timer = setTimeout(() => {
              signalRef.removeEventListener('abort', onAbort);
              resolve('ok');
            }, 5_000);
            signalRef.addEventListener('abort', onAbort, { once: true });
          });
        },
      },
    };

    const run = new OpenRouterAgentRun({
      apiKey: 'k',
      sessionId: TEST_SESSION,
      prompt: 'do slow thing',
      tools: [slowTool] as unknown as never,
      signal: ctrl.signal,
    });

    const events: AgentCoreEvent[] = [];
    const iterPromise = (async () => {
      for await (const e of run) events.push(e);
    })();

    await toolStartedP;
    ctrl.abort();
    await iterPromise;

    const toolResult = events.find((e) => e.type === 'tool_result') as Extract<
      AgentCoreEvent,
      { type: 'tool_result' }
    >;
    expect(toolResult).toBeDefined();
    expect(toolResult.isError).toBe(true);
    expect(String(toolResult.output)).toMatch(/cancel/i);

    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.status).toBe('error');
    expect(complete.reason).toBe('aborted');
  });

  it('does not affect the default no-signal run (back-compat)', async () => {
    callModelMock.mockImplementation(
      fakeCallModel({
        events: [
          { type: 'turn.start', turnNumber: 0 },
          { type: 'response.output_text.delta', delta: 'hi' },
          { type: 'turn.end', turnNumber: 0 },
        ],
      }),
    );

    const run = new OpenRouterAgentRun({
      apiKey: 'k',
      sessionId: TEST_SESSION,
      prompt: 'p',
    });
    const events = await collect(run);
    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.status).toBe('success');
    expect(complete.reason).toBeUndefined();
  });
});

describe('OpenRouterAgentRun canUseTool', () => {
  // Drives a single tool invocation through the mock OR SDK by reaching into
  // the wrapped tool's execute. Mirrors how the real SDK ferries tool calls.
  function singleToolCallModel(args: {
    toolName: string;
    callId: string;
    input: unknown;
    captureExecuteResult?: (r: { output: unknown; status: 'completed' | 'incomplete' }) => void;
  }) {
    return (request: {
      tools: Array<{ function: { name: string; execute?: (i: unknown, c?: unknown) => unknown } }>;
    }) => {
      const tool = request.tools.find((t) => t.function.name === args.toolName);
      return {
        async *getFullResponsesStream() {
          yield { type: 'turn.start', turnNumber: 0 };
          yield {
            type: 'response.output_item.done',
            outputIndex: 0,
            sequenceNumber: 1,
            item: {
              type: 'function_call',
              callId: args.callId,
              name: args.toolName,
              arguments: JSON.stringify(args.input),
            },
          };
          let output: unknown;
          let status: 'completed' | 'incomplete' = 'completed';
          try {
            output = await tool!.function.execute!(args.input, {});
          } catch (e) {
            output = (e as Error).message;
            status = 'incomplete';
          }
          args.captureExecuteResult?.({ output, status });
          yield {
            type: 'tool.call_output',
            timestamp: 1,
            output: {
              callId: args.callId,
              type: 'function_call_output',
              output,
              status,
            },
          };
          yield { type: 'turn.end', turnNumber: 0 };
        },
        async getResponse() {
          return {
            id: 'r',
            model: 'm',
            usage: { cost: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            output: [],
          };
        },
      };
    };
  }

  function makeEchoTool(execSpy?: (input: unknown) => void) {
    return {
      type: 'function' as const,
      function: {
        name: 'echo_tool',
        description: 'echo back the input',
        execute: async (input: unknown) => {
          execSpy?.(input);
          return { echoed: input };
        },
      },
    };
  }

  it('runs the handler normally when canUseTool returns allow', async () => {
    const execSpy = vi.fn();
    callModelMock.mockImplementation(
      singleToolCallModel({
        toolName: 'echo_tool',
        callId: 'c-allow',
        input: { msg: 'hi' },
      }),
    );

    const canUseTool = vi.fn().mockResolvedValue({ behavior: 'allow' });
    const run = new OpenRouterAgentRun({
      apiKey: 'k',
      sessionId: TEST_SESSION,
      prompt: 'p',
      tools: [makeEchoTool(execSpy)] as unknown as never,
      canUseTool,
    });
    const events = await collect(run);

    expect(canUseTool).toHaveBeenCalledWith('echo_tool', { msg: 'hi' });
    expect(execSpy).toHaveBeenCalledWith({ msg: 'hi' });
    const result = events.find((e) => e.type === 'tool_result') as Extract<
      AgentCoreEvent,
      { type: 'tool_result' }
    >;
    expect(result.isError).toBe(false);
    expect(result.output).toEqual({ echoed: { msg: 'hi' } });
  });

  it('passes updatedInput to the handler instead of the original input', async () => {
    const execSpy = vi.fn();
    callModelMock.mockImplementation(
      singleToolCallModel({
        toolName: 'echo_tool',
        callId: 'c-upd',
        input: { msg: 'original' },
      }),
    );

    const canUseTool = vi
      .fn()
      .mockResolvedValue({ behavior: 'allow', updatedInput: { msg: 'rewritten' } });
    const run = new OpenRouterAgentRun({
      apiKey: 'k',
      sessionId: TEST_SESSION,
      prompt: 'p',
      tools: [makeEchoTool(execSpy)] as unknown as never,
      canUseTool,
    });
    const events = await collect(run);

    expect(execSpy).toHaveBeenCalledTimes(1);
    expect(execSpy).toHaveBeenCalledWith({ msg: 'rewritten' });
    expect(execSpy).not.toHaveBeenCalledWith({ msg: 'original' });
    const result = events.find((e) => e.type === 'tool_result') as Extract<
      AgentCoreEvent,
      { type: 'tool_result' }
    >;
    expect(result.output).toEqual({ echoed: { msg: 'rewritten' } });
  });

  it('skips the handler and surfaces tool_result.isError with the deny reason on deny', async () => {
    const execSpy = vi.fn();
    callModelMock.mockImplementation(
      singleToolCallModel({
        toolName: 'echo_tool',
        callId: 'c-deny',
        input: { msg: 'no' },
      }),
    );

    const canUseTool = vi
      .fn()
      .mockResolvedValue({ behavior: 'deny', reason: 'not allowed in tests' });
    const run = new OpenRouterAgentRun({
      apiKey: 'k',
      sessionId: TEST_SESSION,
      prompt: 'p',
      tools: [makeEchoTool(execSpy)] as unknown as never,
      canUseTool,
    });
    const events = await collect(run);

    expect(execSpy).not.toHaveBeenCalled();
    const result = events.find((e) => e.type === 'tool_result') as Extract<
      AgentCoreEvent,
      { type: 'tool_result' }
    >;
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(String(result.output));
    expect(parsed).toEqual({ error: 'not allowed in tests', denied: true });
  });

  it('executes tools normally when canUseTool is omitted (backward compat)', async () => {
    const execSpy = vi.fn();
    callModelMock.mockImplementation(
      singleToolCallModel({
        toolName: 'echo_tool',
        callId: 'c-none',
        input: { msg: 'free' },
      }),
    );

    const run = new OpenRouterAgentRun({
      apiKey: 'k',
      sessionId: TEST_SESSION,
      prompt: 'p',
      tools: [makeEchoTool(execSpy)] as unknown as never,
    });
    const events = await collect(run);

    expect(execSpy).toHaveBeenCalledWith({ msg: 'free' });
    const result = events.find((e) => e.type === 'tool_result') as Extract<
      AgentCoreEvent,
      { type: 'tool_result' }
    >;
    expect(result.isError).toBe(false);
  });

  it('treats a thrown canUseTool as a deny with the thrown message', async () => {
    const execSpy = vi.fn();
    callModelMock.mockImplementation(
      singleToolCallModel({
        toolName: 'echo_tool',
        callId: 'c-throw',
        input: {},
      }),
    );

    const canUseTool = vi.fn().mockRejectedValue(new Error('policy backend down'));
    const run = new OpenRouterAgentRun({
      apiKey: 'k',
      sessionId: TEST_SESSION,
      prompt: 'p',
      tools: [makeEchoTool(execSpy)] as unknown as never,
      canUseTool,
    });
    const events = await collect(run);

    expect(execSpy).not.toHaveBeenCalled();
    const result = events.find((e) => e.type === 'tool_result') as Extract<
      AgentCoreEvent,
      { type: 'tool_result' }
    >;
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(String(result.output));
    expect(parsed).toEqual({ error: 'policy backend down', denied: true });
    // Run must finish (not crash) — stream_complete should still arrive.
    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.type).toBe('stream_complete');
  });

  it('does not invoke canUseTool for server-side tools (web_search/web_fetch/datetime)', async () => {
    // Server tools execute on OR's servers and never appear in the local
    // request.tools array — they're injected via hooks. Our model mock here
    // emits a tool.call_output for `web_search` without ever calling a local
    // execute, mirroring how the real SDK surfaces server-side tool results.
    const canUseTool = vi.fn().mockResolvedValue({ behavior: 'allow' });
    callModelMock.mockImplementation(() => ({
      async *getFullResponsesStream() {
        yield { type: 'turn.start', turnNumber: 0 };
        yield {
          type: 'tool.call_output',
          timestamp: 1,
          output: {
            callId: 'c-srv',
            type: 'function_call_output',
            output: 'server-side result',
            status: 'completed',
          },
        };
        yield { type: 'turn.end', turnNumber: 0 };
      },
      async getResponse() {
        return {
          id: 'r',
          model: 'm',
          usage: { cost: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          output: [],
        };
      },
    }));

    const run = new OpenRouterAgentRun({
      apiKey: 'k',
      sessionId: TEST_SESSION,
      prompt: 'search the web',
      canUseTool,
    });
    const events = await collect(run);

    expect(canUseTool).not.toHaveBeenCalled();
    // The web_search tool_result is still surfaced normally.
    const result = events.find((e) => e.type === 'tool_result') as Extract<
      AgentCoreEvent,
      { type: 'tool_result' }
    >;
    expect(result).toBeDefined();
    expect(result.isError).toBe(false);
  });
});

describe('OpenRouterAgentRun constructor options', () => {
  it('throws if apiKey is missing', () => {
    expect(
      () =>
        new OpenRouterAgentRun({
          apiKey: '',
          sessionId: TEST_SESSION,
          prompt: 'p',
        }),
    ).toThrow(/apiKey is required/);
    expect(
      () =>
        new OpenRouterAgentRun({
          // @ts-expect-error - exercising missing-required-field handling
          apiKey: undefined,
          sessionId: TEST_SESSION,
          prompt: 'p',
        }),
    ).toThrow(/apiKey is required/);
  });

  it('defaults numeric options to maxTurns: 25 and maxBudgetUsd: 1.0', async () => {
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
    const args = callModelMock.mock.calls[0][0];
    const stopWhen = args.stopWhen as Array<{ kind: string; n: number }>;
    const step = stopWhen.find((s) => s.kind === 'stepCountIs');
    const cost = stopWhen.find((s) => s.kind === 'maxCost');
    expect(step?.n).toBe(25);
    expect(cost?.n).toBe(1.0);
  });

  it('defaults model to ~anthropic/claude-sonnet-latest and instructions to DEFAULT_INSTRUCTIONS', async () => {
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
    const args = callModelMock.mock.calls[0][0];
    expect(args.model).toBe('~anthropic/claude-sonnet-latest');
    expect(args.instructions).toBe(DEFAULT_INSTRUCTIONS);
    expect(DEFAULT_INSTRUCTIONS).toMatch(/code editing agent/i);
  });

  it('omits serverURL on the OR client when baseUrl is unset', async () => {
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
    const ctorArgs = openRouterCtorMock.mock.calls[0][0];
    expect('serverURL' in ctorArgs).toBe(false);
  });
});

describe('OpenRouterAgentRun cwd threading', () => {
  it('captures process.cwd() as the default cwd', async () => {
    // Drive a tool call through the wrapped read_file tool and observe that
    // a relative path resolves against process.cwd() (the constructor default).
    const tmpDir = join(process.cwd(), '.test-tmp', 'agent-default-cwd');
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(tmpDir, { recursive: true });
    const file = join(tmpDir, 'hello.txt');
    await writeFile(file, 'cwd-default', 'utf-8');

    try {
      callModelMock.mockImplementation(
        (request: {
          tools: Array<{
            function: { name: string; execute?: (i: unknown, c?: unknown) => unknown };
          }>;
        }) => {
          const tool = request.tools.find((t) => t.function.name === 'read_file');
          return {
            async *getFullResponsesStream() {
              yield { type: 'turn.start', turnNumber: 0 };
              const out = await tool!.function.execute!(
                { path: '.test-tmp/agent-default-cwd/hello.txt' },
                {},
              );
              yield {
                type: 'tool.call_output',
                timestamp: 1,
                output: {
                  callId: 'c1',
                  type: 'function_call_output',
                  output: out,
                  status: 'completed',
                },
              };
              yield { type: 'turn.end', turnNumber: 0 };
            },
            async getResponse() {
              return {
                id: 'r',
                model: 'm',
                usage: { cost: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                output: [],
              };
            },
          };
        },
      );

      const run = new OpenRouterAgentRun({
        apiKey: 'k',
        sessionId: TEST_SESSION,
        prompt: 'read',
      });
      const events = await collect(run);
      const result = events.find((e) => e.type === 'tool_result') as Extract<
        AgentCoreEvent,
        { type: 'tool_result' }
      >;
      expect((result.output as { content: string }).content).toBe('cwd-default');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('honours explicit cwd, flowing it into FS tools (read_file resolves relative paths under it)', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const tmpRoot = await mkdtemp(join(tmpdir(), 'agent-cwd-explicit-'));
    await writeFile(join(tmpRoot, 'sample.txt'), 'sample-contents', 'utf-8');

    try {
      callModelMock.mockImplementation(
        (request: {
          tools: Array<{
            function: { name: string; execute?: (i: unknown, c?: unknown) => unknown };
          }>;
        }) => {
          const tool = request.tools.find((t) => t.function.name === 'read_file');
          return {
            async *getFullResponsesStream() {
              yield { type: 'turn.start', turnNumber: 0 };
              const out = await tool!.function.execute!({ path: 'sample.txt' }, {});
              yield {
                type: 'tool.call_output',
                timestamp: 1,
                output: {
                  callId: 'c1',
                  type: 'function_call_output',
                  output: out,
                  status: 'completed',
                },
              };
              yield { type: 'turn.end', turnNumber: 0 };
            },
            async getResponse() {
              return {
                id: 'r',
                model: 'm',
                usage: { cost: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                output: [],
              };
            },
          };
        },
      );

      const run = new OpenRouterAgentRun({
        apiKey: 'k',
        sessionId: TEST_SESSION,
        prompt: 'read',
        cwd: tmpRoot,
        logsRoot: join(tmpRoot, 'logs'),
      });
      const events = await collect(run);
      const result = events.find((e) => e.type === 'tool_result') as Extract<
        AgentCoreEvent,
        { type: 'tool_result' }
      >;
      expect((result.output as { content: string }).content).toBe('sample-contents');
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('threads cwd through run_command (child process spawns in ctx.cwd)', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const tmpRoot = await mkdtemp(join(tmpdir(), 'agent-cwd-run-'));
    await writeFile(join(tmpRoot, 'marker.txt'), 'marker', 'utf-8');

    try {
      callModelMock.mockImplementation(
        (request: {
          tools: Array<{
            function: { name: string; execute?: (i: unknown, c?: unknown) => unknown };
          }>;
        }) => {
          const tool = request.tools.find((t) => t.function.name === 'run_command');
          return {
            async *getFullResponsesStream() {
              yield { type: 'turn.start', turnNumber: 0 };
              const out = await tool!.function.execute!({ command: 'ls' }, {});
              yield {
                type: 'tool.call_output',
                timestamp: 1,
                output: {
                  callId: 'c1',
                  type: 'function_call_output',
                  output: out,
                  status: 'completed',
                },
              };
              yield { type: 'turn.end', turnNumber: 0 };
            },
            async getResponse() {
              return {
                id: 'r',
                model: 'm',
                usage: { cost: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                output: [],
              };
            },
          };
        },
      );

      const run = new OpenRouterAgentRun({
        apiKey: 'k',
        sessionId: TEST_SESSION,
        prompt: 'list',
        cwd: tmpRoot,
        logsRoot: join(tmpRoot, 'logs'),
      });
      const events = await collect(run);
      const result = events.find((e) => e.type === 'tool_result') as Extract<
        AgentCoreEvent,
        { type: 'tool_result' }
      >;
      const out = result.output as { exitCode: number; stdout: string };
      expect(out.exitCode).toBe(0);
      expect(out.stdout).toContain('marker.txt');
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('writes logs under the explicit logsRoot when provided', async () => {
    const { mkdtemp, stat } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const logsRoot = await mkdtemp(join(tmpdir(), 'agent-logsroot-'));

    try {
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
        sessionId: 'logs-root-session',
        prompt: 'p',
        logsRoot,
      });
      await collect(run);
      const s = await stat(join(logsRoot, 'logs-root-session'));
      expect(s.isDirectory()).toBe(true);
    } finally {
      await rm(logsRoot, { recursive: true, force: true });
    }
  });
});

describe('OpenRouterAgentRun session.json (Phase 1.6)', () => {
  it('writes session.json with the cwd passed to the constructor', async () => {
    const { mkdtemp, readFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const logsRoot = await mkdtemp(join(tmpdir(), 'agent-session-cwd-'));
    const cwdFixture = await mkdtemp(join(tmpdir(), 'agent-session-cwd-target-'));

    try {
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
        sessionId: 'session-cwd-explicit',
        prompt: 'p',
        cwd: cwdFixture,
        logsRoot,
      });
      await collect(run);
      const raw = await readFile(join(logsRoot, 'session-cwd-explicit', 'session.json'), 'utf-8');
      const data = JSON.parse(raw);
      expect(data.sessionId).toBe('session-cwd-explicit');
      expect(data.cwd).toBe(cwdFixture);
      expect(data.startedAt).toBeDefined();
    } finally {
      await rm(logsRoot, { recursive: true, force: true });
      await rm(cwdFixture, { recursive: true, force: true });
    }
  });

  it('defaults the captured cwd to process.cwd() when none is passed', async () => {
    const { mkdtemp, readFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const logsRoot = await mkdtemp(join(tmpdir(), 'agent-session-cwd-default-'));

    try {
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
        sessionId: 'session-cwd-default',
        prompt: 'p',
        logsRoot,
      });
      await collect(run);
      const raw = await readFile(join(logsRoot, 'session-cwd-default', 'session.json'), 'utf-8');
      const data = JSON.parse(raw);
      expect(data.cwd).toBe(process.cwd());
    } finally {
      await rm(logsRoot, { recursive: true, force: true });
    }
  });
});
