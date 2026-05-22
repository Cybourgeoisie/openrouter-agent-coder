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

  it('runs the tool when canUseTool resolves allow', async () => {
    state.fixture = loadFixture('single-tool-call');
    const decisions: Array<{ name: string; input: unknown }> = [];
    const canUseTool: CanUseTool = (name, input): CanUseToolResult => {
      decisions.push({ name, input });
      return { behavior: 'allow' };
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
    expect(toolResult.output).toBe('echoed:gated');
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
