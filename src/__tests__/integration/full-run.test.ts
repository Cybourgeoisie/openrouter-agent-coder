import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createGate, loadFixture, type MockState } from './mock-openrouter.js';

const { state } = vi.hoisted(() => {
  // Inlined to satisfy vi.mock hoisting — the factory cannot reach back to
  // module-scope identifiers that initialize after hoist time.
  const sharedState: MockState = {
    fixture: null,
    ctorArgs: [],
    callModelArgs: [],
    pausedGate: null,
    constructorThrows: null,
  };
  return { state: sharedState };
});

vi.mock('@openrouter/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openrouter/agent')>();
  const { createOpenRouterMockModule } = await import('./mock-openrouter.js');
  return { ...actual, ...createOpenRouterMockModule(state) };
});

// Server-tool hooks would otherwise reach for an OpenRouter client at module
// load; stub them so the mocked OR module is the only path exercised here.
vi.mock('../../tools/server-tools.js', () => ({
  SERVER_TOOLS: [],
  createServerToolsHooks: () => ({}),
}));

import { OpenRouterAgentRun } from '../../index.js';
import type {
  AgentCoreEvent,
  CanUseTool,
  CanUseToolResult,
  HookEvent,
  HookPayload,
} from '../../index.js';

const TEST_SESSION = 'integration-full-run-session';

interface EchoTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (input: { value: string }) => Promise<string>;
  };
}

function echoTool(): EchoTool {
  return {
    type: 'function',
    function: {
      name: 'echo',
      description: 'returns the value field of its input',
      parameters: { type: 'object', properties: { value: { type: 'string' } } },
      execute: async (input) => `echoed:${input.value}`,
    },
  };
}

async function collect(run: OpenRouterAgentRun): Promise<AgentCoreEvent[]> {
  const out: AgentCoreEvent[] = [];
  for await (const e of run) out.push(e);
  return out;
}

beforeEach(() => {
  state.fixture = null;
  state.ctorArgs.length = 0;
  state.callModelArgs.length = 0;
  state.pausedGate = null;
  state.constructorThrows = null;
});

afterEach(async () => {
  await rm(join(process.cwd(), 'logs', TEST_SESSION), { recursive: true, force: true });
});

describe('integration: full run via OpenRouterAgentRun', () => {
  it('iterates a multi-turn run with a tool call end-to-end', async () => {
    state.fixture = loadFixture('multi-turn-with-tool');
    const hookEvents: Array<{ event: HookEvent; payload: HookPayload }> = [];

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-test',
      sessionId: TEST_SESSION,
      prompt: 'do work',
      tools: [echoTool()] as unknown as ConstructorParameters<
        typeof OpenRouterAgentRun
      >[0]['tools'],
      onHook: (event, payload) => {
        hookEvents.push({ event, payload });
      },
    });
    const events = await collect(run);
    const types = events.map((e) => e.type);

    expect(types[0]).toBe('session_started');
    expect(types).toContain('turn_start');
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');
    expect(types).toContain('text_delta');
    const turnEnds = events.filter((e) => e.type === 'turn_end');
    expect(turnEnds.length).toBe(2);

    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.type).toBe('stream_complete');
    expect(complete.status).toBe('success');
    expect(complete.reason).toBeUndefined();
    expect(complete.usage?.totalTokens).toBe(28);

    const toolResult = events.find((e) => e.type === 'tool_result') as Extract<
      AgentCoreEvent,
      { type: 'tool_result' }
    >;
    expect(toolResult.output).toBe('echoed:hello');
    expect(toolResult.isError).toBe(false);

    // Lifecycle hooks fired in the expected order around the tool call.
    const hookNames = hookEvents.map((h) => h.event);
    expect(hookNames[0]).toBe('SessionStart');
    expect(hookNames).toContain('PreToolUse');
    expect(hookNames).toContain('PostToolUse');
    expect(hookNames.at(-1)).toBe('SessionEnd');
  });

  it('runs the tool with substituted input when canUseTool returns updatedInput', async () => {
    state.fixture = loadFixture('single-tool-call');
    const decisions: Array<{ name: string; input: unknown }> = [];
    const canUseTool: CanUseTool = (name, input): CanUseToolResult => {
      decisions.push({ name, input });
      // Substitute the input — exercises the `updatedInput !== undefined` arm
      // of the permission wrapper so the wrapped execute receives the
      // override rather than the original input.
      return { behavior: 'allow', updatedInput: { value: 'rewritten' } };
    };

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-test',
      sessionId: TEST_SESSION,
      prompt: 'gated allow',
      tools: [echoTool()] as unknown as ConstructorParameters<
        typeof OpenRouterAgentRun
      >[0]['tools'],
      canUseTool,
    });
    const events = await collect(run);

    expect(decisions).toEqual([{ name: 'echo', input: { value: 'gated' } }]);
    const toolResult = events.find((e) => e.type === 'tool_result') as Extract<
      AgentCoreEvent,
      { type: 'tool_result' }
    >;
    expect(toolResult.isError).toBe(false);
    expect(toolResult.output).toBe('echoed:rewritten');
    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.status).toBe('success');
  });

  it('surfaces a denial when canUseTool resolves deny', async () => {
    state.fixture = loadFixture('single-tool-call');
    const canUseTool: CanUseTool = (): CanUseToolResult => ({
      behavior: 'deny',
      reason: 'not allowed in test',
    });

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-test',
      sessionId: TEST_SESSION,
      prompt: 'gated deny',
      tools: [echoTool()] as unknown as ConstructorParameters<
        typeof OpenRouterAgentRun
      >[0]['tools'],
      canUseTool,
    });
    const events = await collect(run);

    const toolResult = events.find((e) => e.type === 'tool_result') as Extract<
      AgentCoreEvent,
      { type: 'tool_result' }
    >;
    expect(toolResult.isError).toBe(true);
    const parsed = JSON.parse(String(toolResult.output));
    expect(parsed).toMatchObject({ denied: true, error: 'not allowed in test' });
    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.status).toBe('success');
  });

  it('yields stream_complete{status:error, reason:aborted} when abort() fires mid-stream', async () => {
    state.fixture = loadFixture('abort-mid-stream');
    const gate = createGate();
    state.pausedGate = gate;

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-test',
      sessionId: TEST_SESSION,
      prompt: 'will be aborted',
      tools: [echoTool()] as unknown as ConstructorParameters<
        typeof OpenRouterAgentRun
      >[0]['tools'],
    });

    const events: AgentCoreEvent[] = [];
    const iter = run[Symbol.asyncIterator]();
    // Drain until we've seen at least one text_delta, then abort and release.
    for (;;) {
      const next = await iter.next();
      if (next.done) break;
      events.push(next.value);
      if (next.value.type === 'text_delta') {
        run.abort();
        gate.resolve();
      }
      // Stop accumulating on stream_complete — the iterator should end after it.
      if (next.value.type === 'stream_complete') break;
    }

    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.type).toBe('stream_complete');
    expect(complete.status).toBe('error');
    expect(complete.reason).toBe('aborted');
    // Post-abort events must be filtered out.
    const deltas = events.filter((e) => e.type === 'text_delta');
    expect(deltas.length).toBe(1);
    expect(deltas[0]).toMatchObject({ content: 'starting...' });
  });

  it('emits error + stream_complete when the OpenRouter constructor throws', async () => {
    // No fixture needed — the constructor throws before callModel is invoked.
    state.constructorThrows = 'invalid API key';
    const hookEvents: Array<{ event: HookEvent; payload: HookPayload }> = [];

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-bad',
      sessionId: TEST_SESSION,
      prompt: 'never gets there',
      tools: [echoTool()] as unknown as ConstructorParameters<
        typeof OpenRouterAgentRun
      >[0]['tools'],
      onHook: (event, payload) => {
        hookEvents.push({ event, payload });
      },
    });
    const events = await collect(run);
    const types = events.map((e) => e.type);

    // No session_started — construction failure short-circuits before that yield.
    expect(types).not.toContain('session_started');
    expect(types).toEqual(['error', 'stream_complete']);

    const error = events[0] as Extract<AgentCoreEvent, { type: 'error' }>;
    expect(error.message).toBe('invalid API key');
    expect(error.cause).toBeInstanceOf(Error);

    const complete = events[1] as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.status).toBe('error');
    expect(complete.reason).toBe('invalid API key');

    // SessionStart hook never fires because session_started was never yielded.
    // SessionEnd still fires (it bookends stream_complete) with zeroed tallies.
    const hookNames = hookEvents.map((h) => h.event);
    expect(hookNames).not.toContain('SessionStart');
    expect(hookNames).toEqual(['SessionEnd']);
    const sessionEnd = hookEvents[0].payload as Extract<HookPayload, { event: 'SessionEnd' }>;
    expect(sessionEnd.status).toBe('error');
    expect(sessionEnd.usage).toBeNull();
    expect(sessionEnd.costUsd).toBe(0);
  });

  it('catches an inner reject after abort and yields stream_complete{reason:aborted} via the catch arm', async () => {
    // Fixture invokes onTurnEnd (cost=0.05) and yields turn.end, then awaits
    // the paused gate. The test aborts + releases the gate, after which the
    // mock throws unconditionally — agent.ts's outer catch observes
    // signal.aborted=true and takes Block B (the aborted-inside-catch path).
    state.fixture = loadFixture('abort-then-throw');
    const gate = createGate();
    state.pausedGate = gate;
    const hookEvents: Array<{ event: HookEvent; payload: HookPayload }> = [];

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-test',
      sessionId: TEST_SESSION,
      prompt: 'will be aborted then thrown',
      tools: [echoTool()] as unknown as ConstructorParameters<
        typeof OpenRouterAgentRun
      >[0]['tools'],
      onHook: (event, payload) => {
        hookEvents.push({ event, payload });
      },
    });

    const events: AgentCoreEvent[] = [];
    let aborted = false;
    for await (const event of run) {
      events.push(event);
      // Wait until the turn has fully closed (so onTurnEnd's cost tally lands
      // in totalCostUsd) before aborting + releasing the gate.
      if (!aborted && event.type === 'turn_end') {
        aborted = true;
        run.abort();
        gate.resolve();
      }
    }

    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.type).toBe('stream_complete');
    expect(complete.status).toBe('error');
    expect(complete.reason).toBe('aborted');
    // Pre-abort tallies survive the catch — onTurnEnd ran before the throw.
    expect(complete.costUsd).toBeCloseTo(0.05);

    // SessionEnd hook carries matching status + pre-abort tallies.
    const sessionEnd = hookEvents.find((h) => h.event === 'SessionEnd')?.payload as
      | Extract<HookPayload, { event: 'SessionEnd' }>
      | undefined;
    expect(sessionEnd).toBeDefined();
    expect(sessionEnd!.status).toBe('error');
    expect(sessionEnd!.costUsd).toBeCloseTo(0.05);
    // The catch arm runs before getResponse(), so finalUsage is still null.
    expect(sessionEnd!.usage).toBeNull();
  });

  it('completes with null usage and zero cost when the response carries no usage block', async () => {
    state.fixture = loadFixture('single-turn-no-usage');
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-test',
      sessionId: TEST_SESSION,
      prompt: 'no-usage path',
      tools: [echoTool()] as unknown as ConstructorParameters<
        typeof OpenRouterAgentRun
      >[0]['tools'],
    });
    const events = await collect(run);
    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.status).toBe('success');
    expect(complete.usage).toBeNull();
    expect(complete.costUsd).toBe(0);
  });

  it('synthesizes a hook callId when the SDK ctx omits toolCall.callId', async () => {
    state.fixture = loadFixture('tool-call-sdk-omits-ctx-callid');
    const hookEvents: Array<{ event: HookEvent; payload: HookPayload }> = [];

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-test',
      sessionId: TEST_SESSION,
      prompt: 'no-ctx-callid',
      tools: [echoTool()] as unknown as ConstructorParameters<
        typeof OpenRouterAgentRun
      >[0]['tools'],
      onHook: (event, payload) => {
        hookEvents.push({ event, payload });
      },
    });
    await collect(run);

    const pre = hookEvents.find((h) => h.event === 'PreToolUse');
    const post = hookEvents.find((h) => h.event === 'PostToolUse');
    expect(pre).toBeDefined();
    expect(post).toBeDefined();
    const preId = (pre!.payload as { callId: string }).callId;
    const postId = (post!.payload as { callId: string }).callId;
    expect(preId).toBe(postId);
    expect(preId).not.toBe('call_x');
    expect(preId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('synth-denies run_command with reason "requires approval" under permissionMode:"default"', async () => {
    state.fixture = loadFixture('single-run-command');
    // Stub run_command tool — its execute should never be invoked because the
    // mode-derived canUseTool denies before the wrapper reaches the handler.
    const execSpy = vi.fn(async () => 'should not run');
    const runCommandStub = {
      type: 'function' as const,
      function: {
        name: 'run_command',
        description: 'stub run_command',
        parameters: { type: 'object', properties: { command: { type: 'string' } } },
        execute: execSpy,
      },
    };

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-test',
      sessionId: TEST_SESSION,
      prompt: 'try to run a command',
      tools: [runCommandStub] as unknown as ConstructorParameters<
        typeof OpenRouterAgentRun
      >[0]['tools'],
      permissionMode: 'default',
    });
    const events = await collect(run);

    expect(execSpy).not.toHaveBeenCalled();
    const toolResult = events.find((e) => e.type === 'tool_result') as Extract<
      AgentCoreEvent,
      { type: 'tool_result' }
    >;
    expect(toolResult.isError).toBe(true);
    const parsed = JSON.parse(String(toolResult.output));
    expect(parsed).toEqual({ error: 'requires approval', denied: true });
    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.status).toBe('success');
  });

  it('reports stream_complete{status:max_turns} when the turn count reaches maxTurns', async () => {
    state.fixture = loadFixture('max-turns');
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-test',
      sessionId: TEST_SESSION,
      prompt: 'cap-the-turns',
      tools: [echoTool()] as unknown as ConstructorParameters<
        typeof OpenRouterAgentRun
      >[0]['tools'],
      maxTurns: 2,
    });
    const events = await collect(run);
    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.status).toBe('max_turns');
  });
});
