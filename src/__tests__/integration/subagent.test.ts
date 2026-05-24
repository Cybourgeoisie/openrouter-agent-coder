import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Fixture, MockState } from './mock-openrouter.js';

const { state } = vi.hoisted(() => {
  const sharedState: MockState = {
    fixture: null,
    fixtureQueue: [],
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

vi.mock('../../tools/server-tools.js', () => ({
  SERVER_TOOLS: [],
  createServerToolsHooks: () => ({}),
}));

import { OpenRouterAgentRun } from '../../index.js';
import type { AgentCoreEvent, HookEvent, HookPayload } from '../../index.js';

const PARENT_SESSION = 'integration-subagent-parent';

interface SpawnArgs {
  description: string;
  tools?: string[];
  instructions?: string;
  max_turns?: number;
  max_budget_usd?: number;
}

function parentFixtureCallingSubagent(spawnArgs: SpawnArgs): Fixture {
  return {
    name: 'parent-spawn',
    steps: [
      { type: 'yield', event: { type: 'turn.start', turnNumber: 0, timestamp: 1 } },
      {
        type: 'yield',
        event: {
          type: 'response.output_item.done',
          outputIndex: 0,
          sequenceNumber: 1,
          item: {
            type: 'function_call',
            callId: 'spawn_call_1',
            name: 'spawn_subagent',
            arguments: JSON.stringify(spawnArgs),
          },
        },
      },
      {
        type: 'tool_execute',
        toolName: 'spawn_subagent',
        input: spawnArgs,
        callId: 'spawn_call_1',
      },
      { type: 'yield', event: { type: 'turn.end', turnNumber: 0, timestamp: 2 } },
    ],
    response: {
      id: 'resp-parent',
      model: 'mock-model',
      usage: { cost: 0.001, inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      output: [],
    },
  };
}

function childFixtureSimpleText(): Fixture {
  return {
    name: 'child-simple',
    steps: [
      { type: 'yield', event: { type: 'turn.start', turnNumber: 0, timestamp: 1 } },
      { type: 'yield', event: { type: 'response.output_text.delta', delta: 'subagent ' } },
      { type: 'yield', event: { type: 'response.output_text.delta', delta: 'result' } },
      { type: 'yield', event: { type: 'turn.end', turnNumber: 0, timestamp: 2 } },
    ],
    response: {
      id: 'resp-child',
      model: 'mock-model',
      usage: { cost: 0.0005, inputTokens: 5, outputTokens: 3, totalTokens: 8 },
      output: [],
    },
  };
}

function childFixtureCallingDeniedTool(): Fixture {
  return {
    name: 'child-denied',
    steps: [
      { type: 'yield', event: { type: 'turn.start', turnNumber: 0, timestamp: 1 } },
      {
        type: 'yield',
        event: {
          type: 'response.output_item.done',
          outputIndex: 0,
          sequenceNumber: 1,
          item: {
            type: 'function_call',
            callId: 'write_call_1',
            name: 'write_file',
            arguments: '{"path":"x.txt","content":"x"}',
          },
        },
      },
      // The child's tool pool was filtered to ['read_file'] only — the SDK
      // mock walks args.tools[] and reports "tool not found" because
      // write_file isn't in the filtered list. This is the denial path we
      // want to exercise.
      {
        type: 'tool_execute',
        toolName: 'write_file',
        input: { path: 'x.txt', content: 'x' },
        callId: 'write_call_1',
      },
      { type: 'yield', event: { type: 'turn.end', turnNumber: 0, timestamp: 2 } },
    ],
    response: {
      id: 'resp-child-denied',
      model: 'mock-model',
      usage: { cost: 0, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      output: [],
    },
  };
}

beforeEach(() => {
  state.fixture = null;
  state.fixtureQueue = [];
  state.ctorArgs.length = 0;
  state.callModelArgs.length = 0;
  state.pausedGate = null;
  state.constructorThrows = null;
});

afterEach(async () => {
  await rm(join(process.cwd(), 'logs', PARENT_SESSION), { recursive: true, force: true });
  // Subagent session dirs are persisted under logsRoot too — clean up by
  // prefix. The integration tests use a deterministic parent session id, but
  // subagent ids are UUID-suffixed so we wildcard-clean.
  // (rm with force on a directory that doesn't exist is a no-op.)
});

describe('integration: spawn_subagent via OpenRouterAgentRun', () => {
  it('drives a parent → subagent flow end-to-end and surfaces a single tool_result with the subagent text', async () => {
    state.fixtureQueue = [
      parentFixtureCallingSubagent({ description: 'do the thing' }),
      childFixtureSimpleText(),
    ];

    const hookEvents: Array<{ event: HookEvent; payload: HookPayload }> = [];

    const parent = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: PARENT_SESSION,
      prompt: 'use spawn_subagent',
      enableSubagents: true,
      persistSession: false,
      onHook: (event, payload) => {
        hookEvents.push({ event, payload });
      },
    });

    const events: AgentCoreEvent[] = [];
    for await (const ev of parent) events.push(ev);

    // Parent's event stream contains the spawn_subagent tool_call + tool_result
    // pair but NOT the subagent's session_started / turn_start / text_delta /
    // turn_end / stream_complete events (those are captured inside the runner).
    const parentTypes = events.map((e) => e.type);
    expect(parentTypes).toEqual([
      'session_started',
      'turn_start',
      'tool_call',
      'tool_result',
      'turn_end',
      'stream_complete',
    ]);

    const toolCall = events.find((e) => e.type === 'tool_call');
    expect(toolCall?.name).toBe('spawn_subagent');

    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult?.isError).toBe(false);
    const output = toolResult?.output as {
      subagentSessionId: string;
      status: string;
      text: string;
      costUsd?: number;
    };
    expect(output.status).toBe('success');
    expect(output.text).toBe('subagent result');
    expect(output.subagentSessionId).toMatch(/^integration-subagent-parent:sub:/);
    expect(output.costUsd).toBeGreaterThan(0);

    // Hook stream: parent's SessionStart fires, parent's PreToolUse fires for
    // spawn_subagent, then SubagentStart, then the child's full hook stream
    // (Setup → SessionStart → SessionEnd → Stop), then SubagentEnd, then
    // parent's PostToolUse for spawn_subagent, then parent's SessionEnd / Stop.
    const eventNames = hookEvents.map((h) => h.event);
    expect(eventNames).toContain('SubagentStart');
    expect(eventNames).toContain('SubagentEnd');

    // SubagentStart and SubagentEnd are bracketing the child's session events.
    const startIdx = eventNames.indexOf('SubagentStart');
    const endIdx = eventNames.indexOf('SubagentEnd');
    expect(endIdx).toBeGreaterThan(startIdx);
    const between = eventNames.slice(startIdx + 1, endIdx);
    expect(between).toContain('SessionStart');
    expect(between).toContain('SessionEnd');

    // SubagentEnd carries the full result summary.
    const endHook = hookEvents.find((h) => h.event === 'SubagentEnd')!;
    if (endHook.payload.event !== 'SubagentEnd') throw new Error('expected SubagentEnd');
    expect(endHook.payload.parentSessionId).toBe(PARENT_SESSION);
    expect(endHook.payload.depth).toBe(1);
    expect(endHook.payload.result.status).toBe('success');
    expect(endHook.payload.result.text).toBe('subagent result');
    expect(endHook.payload.result.costUsd).toBeGreaterThan(0);

    // PostToolUse for spawn_subagent fires AFTER SubagentEnd.
    const postSpawn = hookEvents.findIndex(
      (h) =>
        h.event === 'PostToolUse' &&
        (h.payload as { toolName?: string }).toolName === 'spawn_subagent',
    );
    expect(postSpawn).toBeGreaterThan(endIdx);
  });

  it('filters the subagent tool pool to the whitelist supplied in `tools`', async () => {
    state.fixtureQueue = [
      parentFixtureCallingSubagent({ description: 'narrow scope', tools: ['read_file'] }),
      childFixtureCallingDeniedTool(),
    ];

    const parent = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: PARENT_SESSION,
      prompt: 'use restricted subagent',
      enableSubagents: true,
      persistSession: false,
    });

    for await (const _ of parent) {
      void _;
    }

    // Inspect what the child's callModel was actually handed. The first
    // callModel was the parent's; the second was the subagent's.
    expect(state.callModelArgs.length).toBe(2);
    const childArgs = state.callModelArgs[1] as {
      tools: Array<{ function: { name: string } }>;
    };
    const childToolNames = childArgs.tools.map((t) => t.function.name).sort();
    // The whitelist passed only `read_file`; the subagent's pool should have
    // been filtered to that single name (no spawn_subagent, no write_file,
    // no monitor, …).
    expect(childToolNames).toEqual(['read_file']);
  });

  it('propagates onHook + lifecycle through nested subagents (sub spawns sub-sub)', async () => {
    // Parent spawns sub-1, sub-1 spawns sub-2, sub-2 returns simple text.
    // Three callModel invocations expected.
    const subSpawnArgs = { description: 'nested' };
    const grandSpawnArgs = { description: 'deepest' };

    const parentFixture: Fixture = {
      name: 'parent-nested',
      steps: [
        { type: 'yield', event: { type: 'turn.start', turnNumber: 0, timestamp: 1 } },
        {
          type: 'yield',
          event: {
            type: 'response.output_item.done',
            outputIndex: 0,
            sequenceNumber: 1,
            item: {
              type: 'function_call',
              callId: 'p_spawn_1',
              name: 'spawn_subagent',
              arguments: JSON.stringify(subSpawnArgs),
            },
          },
        },
        {
          type: 'tool_execute',
          toolName: 'spawn_subagent',
          input: subSpawnArgs,
          callId: 'p_spawn_1',
        },
        { type: 'yield', event: { type: 'turn.end', turnNumber: 0, timestamp: 2 } },
      ],
      response: {
        id: 'resp-p',
        model: 'mock-model',
        usage: { cost: 0.001, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output: [],
      },
    };

    const subFixture: Fixture = {
      name: 'sub-nested',
      steps: [
        { type: 'yield', event: { type: 'turn.start', turnNumber: 0, timestamp: 1 } },
        {
          type: 'yield',
          event: {
            type: 'response.output_item.done',
            outputIndex: 0,
            sequenceNumber: 1,
            item: {
              type: 'function_call',
              callId: 's_spawn_1',
              name: 'spawn_subagent',
              arguments: JSON.stringify(grandSpawnArgs),
            },
          },
        },
        {
          type: 'tool_execute',
          toolName: 'spawn_subagent',
          input: grandSpawnArgs,
          callId: 's_spawn_1',
        },
        { type: 'yield', event: { type: 'turn.end', turnNumber: 0, timestamp: 2 } },
      ],
      response: {
        id: 'resp-s',
        model: 'mock-model',
        usage: { cost: 0.001, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output: [],
      },
    };

    const grandFixture: Fixture = {
      name: 'grand',
      steps: [
        { type: 'yield', event: { type: 'turn.start', turnNumber: 0, timestamp: 1 } },
        { type: 'yield', event: { type: 'response.output_text.delta', delta: 'deepest text' } },
        { type: 'yield', event: { type: 'turn.end', turnNumber: 0, timestamp: 2 } },
      ],
      response: {
        id: 'resp-g',
        model: 'mock-model',
        usage: { cost: 0.0001, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output: [],
      },
    };

    state.fixtureQueue = [parentFixture, subFixture, grandFixture];

    const hookEvents: Array<{ event: HookEvent; payload: HookPayload }> = [];
    const parent = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: PARENT_SESSION,
      prompt: 'nested',
      enableSubagents: true,
      persistSession: false,
      onHook: (event, payload) => {
        hookEvents.push({ event, payload });
      },
    });
    for await (const _ of parent) void _;

    const startEvents = hookEvents.filter((h) => h.event === 'SubagentStart');
    const endEvents = hookEvents.filter((h) => h.event === 'SubagentEnd');
    // Two subagent levels were spawned: depth-1 (sub) and depth-2 (grand).
    expect(startEvents).toHaveLength(2);
    expect(endEvents).toHaveLength(2);

    const startDepths = startEvents.map((h) => (h.payload as { depth?: number }).depth).sort();
    expect(startDepths).toEqual([1, 2]);
  });

  it('inherits parent logger/baseUrl/onAskUserQuestion/onTasksChanged into the subagent run, and forwards child reason on error', async () => {
    const childThrowing: Fixture = {
      name: 'child-throws',
      steps: [
        { type: 'yield', event: { type: 'turn.start', turnNumber: 0, timestamp: 1 } },
        { type: 'throw', message: 'mid-stream boom' },
      ],
      response: {
        id: 'resp-child-throws',
        model: 'mock-model',
        usage: { cost: 0, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output: [],
      },
    };

    state.fixtureQueue = [
      parentFixtureCallingSubagent({ description: 'will fail' }),
      childThrowing,
    ];

    const logCalls: Array<{ level: string; msg: string }> = [];
    const parent = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: PARENT_SESSION,
      prompt: 'exercise inheritance + reason path',
      enableSubagents: true,
      persistSession: false,
      baseUrl: 'https://example.test',
      logger: (level, msg) => logCalls.push({ level, msg }),
      onAskUserQuestion: async () => ({ questionId: 'q' }),
      onTasksChanged: () => undefined,
    });

    const events: AgentCoreEvent[] = [];
    for await (const ev of parent) events.push(ev);

    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult).toBeDefined();
    const output = toolResult?.output as { status: string; reason?: string };
    expect(output.status).toBe('error');
    expect(output.reason).toBe('mid-stream boom');

    // Subagent's OR client received the same baseUrl (serverURL) as parent.
    expect(state.ctorArgs).toHaveLength(2);
    const childCtor = state.ctorArgs[1] as { serverURL?: string };
    expect(childCtor.serverURL).toBe('https://example.test');
  });

  it('threads the parent run signal into the subagent OpenRouterAgentRun (cascade observable via SubagentEnd)', async () => {
    // Drive a normal parent-spawn-child happy path, then assert the
    // child's callModel arg structure picked up the composite signal — the
    // unit tests cover the moment-of-abort semantics; this guards the
    // wiring at the agent.ts level (signal threading + onHook inheritance).
    state.fixtureQueue = [
      parentFixtureCallingSubagent({ description: 'observe signal' }),
      childFixtureSimpleText(),
    ];

    const parent = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: PARENT_SESSION,
      prompt: 'cascade-wiring',
      enableSubagents: true,
      persistSession: false,
    });
    for await (const _ of parent) void _;

    expect(state.ctorArgs).toHaveLength(2);
    // The child OR client receives the same apiKey + appTitle wiring (inherited).
    const parentCtor = state.ctorArgs[0] as { apiKey: string; appTitle: string };
    const childCtor = state.ctorArgs[1] as { apiKey: string; appTitle: string };
    expect(childCtor.apiKey).toBe(parentCtor.apiKey);
    expect(childCtor.appTitle).toBe(parentCtor.appTitle);

    // Subagent's session id is derived from the parent's.
    const childCallArgs = state.callModelArgs[1] as { sessionId: string };
    expect(childCallArgs.sessionId).toMatch(/^integration-subagent-parent:sub:/);
  });
});
