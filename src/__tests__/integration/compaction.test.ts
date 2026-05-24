import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

const SESSION = 'integration-compaction';

/** Trivial parent fixture: one turn, one text delta, one turn end, success. */
function parentFixture(): Fixture {
  return {
    name: 'parent-trivial',
    steps: [
      { type: 'yield', event: { type: 'turn.start', turnNumber: 0, timestamp: 1 } },
      { type: 'yield', event: { type: 'response.output_text.delta', delta: 'done' } },
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

/**
 * Compaction fixture: yields a synthetic summary text via text_delta events.
 * Includes a non-text-delta event upfront so the event-filter branch in
 * `OpenRouterAgentRun.compact()` exercises both arms (matching + non-matching
 * `event.type`), and a deliberate empty-string delta to cover the
 * `typeof delta === 'string'` branch's "ignore falsy text" guard.
 */
function compactFixture(summary: string): Fixture {
  return {
    name: 'compact',
    steps: [
      { type: 'yield', event: { type: 'turn.start', turnNumber: 0, timestamp: 1 } },
      // A delta event whose `delta` is a number — exercises the
      // `typeof delta === 'string'` false branch of the summary collector.
      {
        type: 'yield',
        event: { type: 'response.output_text.delta', delta: 42 } as unknown as Record<
          string,
          unknown
        >,
      },
      { type: 'yield', event: { type: 'response.output_text.delta', delta: '' } },
      { type: 'yield', event: { type: 'response.output_text.delta', delta: summary } },
    ],
    response: {
      id: 'resp-compact',
      model: 'mock-model',
      usage: { cost: 0.0001, inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      output: [],
    },
  };
}

interface SeedStateOptions {
  logsRoot: string;
  sessionId: string;
  messages: unknown[];
  previousResponseId?: string;
}

async function seedState(opts: SeedStateOptions): Promise<string> {
  const dir = join(opts.logsRoot, opts.sessionId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'state.json');
  await writeFile(
    path,
    JSON.stringify({
      id: opts.sessionId,
      messages: opts.messages,
      ...(opts.previousResponseId !== undefined && { previousResponseId: opts.previousResponseId }),
      status: 'complete',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  return path;
}

let logsRoot: string;

beforeEach(async () => {
  state.fixture = null;
  state.fixtureQueue = [];
  state.ctorArgs.length = 0;
  state.callModelArgs.length = 0;
  state.pausedGate = null;
  state.constructorThrows = null;
  logsRoot = await mkdtemp(join(tmpdir(), 'compaction-test-'));
});

afterEach(async () => {
  await rm(logsRoot, { recursive: true, force: true });
});

describe('integration: context compaction', () => {
  it('fires auto-compaction when threshold crossed and rewrites state', async () => {
    // Seed a pre-existing transcript that exceeds the configured threshold —
    // the mocked SDK does NOT itself write state.json (its callModel skips
    // the StateAccessor entirely), so we install the message history we
    // want the auto-trigger to see.
    const longMessages = [
      { role: 'user', content: 'a'.repeat(100) },
      { role: 'assistant', content: 'b'.repeat(100) },
      { role: 'user', content: 'c'.repeat(100) },
      { role: 'assistant', content: 'd'.repeat(100) },
      { role: 'user', content: 'e'.repeat(100) },
      { role: 'assistant', content: 'f'.repeat(100) },
      { role: 'user', content: 'g'.repeat(100) },
      { role: 'assistant', content: 'h'.repeat(100) },
    ];
    const statePath = await seedState({
      logsRoot,
      sessionId: SESSION,
      messages: longMessages,
      previousResponseId: 'resp-stale-chain',
    });

    state.fixtureQueue = [parentFixture(), compactFixture('SUMMARY-OF-PRIOR-TURNS')];

    const hookEvents: Array<{ event: HookEvent; payload: HookPayload }> = [];
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'continue',
      logsRoot,
      compactionThreshold: 100, // well below the 8 * (100+overhead) of seed
      keepRecentTurns: 2,
      onHook: (event, payload) => {
        hookEvents.push({ event, payload });
      },
    });

    const events: AgentCoreEvent[] = [];
    for await (const ev of run) events.push(ev);

    // Stream stays well-formed — no compaction-related events injected.
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('session_started');
    expect(types.at(-1)).toBe('stream_complete');
    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.status).toBe('success');

    // PreCompact fires exactly once, between the run's PostToolUse events
    // and the SessionEnd / Stop bracket.
    const compactHooks = hookEvents.filter((h) => h.event === 'PreCompact');
    expect(compactHooks.length).toBe(1);
    const compactPayload = compactHooks[0].payload as Extract<HookPayload, { event: 'PreCompact' }>;
    expect(compactPayload.reason).toBe('auto');
    expect(compactPayload.keepRecentTurns).toBe(2);
    expect(Array.isArray(compactPayload.messages)).toBe(true);
    // 8 seeded - 2 keep = 6 in summarize
    expect((compactPayload.messages as unknown[]).length).toBe(6);

    const stopIdx = hookEvents.findIndex((h) => h.event === 'Stop');
    const preCompactIdx = hookEvents.findIndex((h) => h.event === 'PreCompact');
    const sessionEndIdx = hookEvents.findIndex((h) => h.event === 'SessionEnd');
    expect(preCompactIdx).toBeGreaterThan(-1);
    expect(preCompactIdx).toBeLessThan(sessionEndIdx);
    expect(sessionEndIdx).toBeLessThan(stopIdx);

    // The mock recorded TWO callModel invocations — the parent run, then the
    // isolated compaction sub-call with the `<session>:compact:<uuid>` id.
    expect(state.callModelArgs.length).toBe(2);
    const compactCallArgs = state.callModelArgs[1] as {
      sessionId: string;
      instructions: string;
      input: unknown;
    };
    expect(compactCallArgs.sessionId).toMatch(/^integration-compaction:compact:/);
    expect(compactCallArgs.instructions).toContain('context-compaction');
    expect(typeof compactCallArgs.input).toBe('string');

    // The persisted state.json was rewritten: leading summary message, then
    // the last 2 messages preserved verbatim, previousResponseId cleared.
    const persisted = JSON.parse(await readFile(statePath, 'utf-8'));
    expect(persisted.previousResponseId).toBeUndefined();
    expect(persisted.messages.length).toBe(3); // [summary, ...last 2]
    expect(persisted.messages[0]).toMatchObject({
      type: 'message',
      role: 'developer',
    });
    expect(persisted.messages[0].content).toContain('SUMMARY-OF-PRIOR-TURNS');
    // Last two messages of the seed survive verbatim.
    expect(persisted.messages[1]).toEqual(longMessages[6]);
    expect(persisted.messages[2]).toEqual(longMessages[7]);
  });

  it('does NOT auto-compact when threshold not crossed', async () => {
    // Seed a transcript well below the (default) threshold.
    await seedState({
      logsRoot,
      sessionId: SESSION,
      messages: [{ role: 'user', content: 'short' }],
    });

    state.fixture = parentFixture();

    const hookEvents: Array<{ event: HookEvent }> = [];
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'continue',
      logsRoot,
      compactionThreshold: 1_000_000,
      onHook: (event) => {
        hookEvents.push({ event });
      },
    });

    for await (const _ of run) void _;

    // Only the parent call — no compaction sub-call.
    expect(state.callModelArgs.length).toBe(1);
    expect(hookEvents.find((h) => h.event === 'PreCompact')).toBeUndefined();
  });

  it('honours `autoCompact: false` (no auto-trigger even above threshold)', async () => {
    await seedState({
      logsRoot,
      sessionId: SESSION,
      messages: [
        { role: 'user', content: 'x'.repeat(500) },
        { role: 'assistant', content: 'y'.repeat(500) },
        { role: 'user', content: 'z'.repeat(500) },
      ],
    });

    state.fixture = parentFixture();

    const hookEvents: Array<{ event: HookEvent }> = [];
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'continue',
      logsRoot,
      autoCompact: false,
      compactionThreshold: 50, // would otherwise trigger
      keepRecentTurns: 1,
      onHook: (event) => {
        hookEvents.push({ event });
      },
    });

    for await (const _ of run) void _;

    // No second callModel — the auto-trigger was suppressed.
    expect(state.callModelArgs.length).toBe(1);
    expect(hookEvents.find((h) => h.event === 'PreCompact')).toBeUndefined();
  });

  it('manual compact() works regardless of autoCompact and clears previousResponseId', async () => {
    const seedMessages = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'reply 2' },
      { role: 'user', content: 'third' },
    ];
    const statePath = await seedState({
      logsRoot,
      sessionId: SESSION,
      messages: seedMessages,
      previousResponseId: 'resp-to-clear',
    });

    // Only one callModel expected — the manual compact one. The agent's
    // iterate() is not driven in this test.
    state.fixtureQueue = [compactFixture('MANUAL-SUMMARY')];

    const hookEvents: Array<{ event: HookEvent; payload: HookPayload }> = [];
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'never iterated',
      logsRoot,
      autoCompact: false,
      keepRecentTurns: 1,
      onHook: (event, payload) => {
        hookEvents.push({ event, payload });
      },
    });

    await run.compact();

    expect(state.callModelArgs.length).toBe(1);
    const preCompact = hookEvents.find((h) => h.event === 'PreCompact');
    expect(preCompact).toBeDefined();
    const payload = preCompact!.payload as Extract<HookPayload, { event: 'PreCompact' }>;
    expect(payload.reason).toBe('manual');
    expect((payload.messages as unknown[]).length).toBe(4); // 5 - keepRecentTurns(1)

    const persisted = JSON.parse(await readFile(statePath, 'utf-8'));
    expect(persisted.previousResponseId).toBeUndefined();
    expect(persisted.messages.length).toBe(2);
    expect(persisted.messages[0].role).toBe('developer');
    expect(persisted.messages[0].content).toContain('MANUAL-SUMMARY');
    expect(persisted.messages[1]).toEqual(seedMessages[4]);
  });

  it('logs and swallows summarizer failures during auto-compaction without breaking the stream', async () => {
    await seedState({
      logsRoot,
      sessionId: SESSION,
      messages: [
        { role: 'user', content: 'x'.repeat(500) },
        { role: 'assistant', content: 'y'.repeat(500) },
        { role: 'user', content: 'z'.repeat(500) },
      ],
    });

    state.fixtureQueue = [
      parentFixture(),
      {
        name: 'compact-throws',
        steps: [{ type: 'throw', message: 'mock summarizer failure' }],
      },
    ];

    const logEntries: Array<{ level: string; message: string }> = [];
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'continue',
      logsRoot,
      compactionThreshold: 50,
      keepRecentTurns: 1,
      logger: (level, message) => {
        logEntries.push({ level, message });
      },
    });

    const events: AgentCoreEvent[] = [];
    for await (const ev of run) events.push(ev);

    // Stream still completes cleanly — auto-compact swallowed the throw.
    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.status).toBe('success');

    // The logger captured the failure record.
    const failureLog = logEntries.find((l) => l.message === 'Auto-compaction failed');
    expect(failureLog).toBeDefined();
    expect(failureLog?.level).toBe('error');
  });

  it('compact() short-circuits when messages array is empty', async () => {
    await seedState({ logsRoot, sessionId: SESSION, messages: [] });
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'noop',
      logsRoot,
    });
    await run.compact();
    expect(state.callModelArgs.length).toBe(0);
  });

  it('compact() short-circuits when persisted messages field is not an array', async () => {
    // Seed a state whose messages field is a string (the SDK accepts both
    // shapes per InputsUnion; the compaction heuristic skips strings).
    await mkdir(join(logsRoot, SESSION), { recursive: true });
    await writeFile(
      join(logsRoot, SESSION, 'state.json'),
      JSON.stringify({
        id: SESSION,
        messages: 'plain string input',
        status: 'complete',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'noop',
      logsRoot,
    });
    await run.compact();
    expect(state.callModelArgs.length).toBe(0);
  });

  it('compact() is a no-op when there is no saved state or messages are short', async () => {
    // Case 1: no state file at all.
    const run1 = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: 'never-existed',
      prompt: 'noop',
      logsRoot,
    });
    await run1.compact();
    expect(state.callModelArgs.length).toBe(0);

    // Case 2: state exists but messages shorter than keepRecentTurns.
    await seedState({
      logsRoot,
      sessionId: SESSION,
      messages: [{ role: 'user', content: 'one' }],
    });
    const run2 = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'noop',
      logsRoot,
      keepRecentTurns: 10,
    });
    await run2.compact();
    expect(state.callModelArgs.length).toBe(0);
  });
});
