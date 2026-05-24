import { describe, it, expect } from 'vitest';
import {
  spawnSubagentsTool,
  DEFAULT_MAX_PARALLEL_SUBAGENTS,
  MAX_PARALLEL_BATCH_SIZE,
  type SpawnSubagentsToolOptions,
  type SpawnSubagentsToolResult,
  type SpawnSubagentResultEnvelope,
  type SubagentRunConfig,
  type SubagentRunResult,
  type SubagentRunner,
  type SubagentLifecycleEmitter,
} from './spawn-subagent.js';
import type { HookEvent, HookPayload, TokenUsage } from '../events.js';

interface SpawnSpec {
  description: string;
  tools?: string[];
  instructions?: string;
  max_turns?: number;
  max_budget_usd?: number;
  model?: string;
  permission_mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
  allowed_tools?: string[];
  disallowed_tools?: string[];
  effort?: string;
}

interface PluralInput {
  subagents: SpawnSpec[];
}

type ExecuteFn = (input: PluralInput, ctx?: unknown) => Promise<SpawnSubagentsToolResult>;

function makeTool(
  opts: Partial<SpawnSubagentsToolOptions> & { runSubagent: SubagentRunner },
  ctx: Parameters<typeof spawnSubagentsTool>[1] = { cwd: '.' },
) {
  const full: SpawnSubagentsToolOptions = {
    parentSessionId: 'parent-session',
    ...opts,
  };
  const t = spawnSubagentsTool(full, ctx);
  return { tool: t, execute: t.function.execute as ExecuteFn };
}

function makeUsage(inputTokens: number, outputTokens: number): TokenUsage {
  return {
    inputTokens,
    inputTokensDetails: { cachedTokens: 0 },
    outputTokens,
    outputTokensDetails: { reasoningTokens: 0 },
    totalTokens: inputTokens + outputTokens,
  };
}

function captureLifecycle(): {
  emitter: SubagentLifecycleEmitter;
  events: Array<{ event: HookEvent; payload: HookPayload }>;
} {
  const events: Array<{ event: HookEvent; payload: HookPayload }> = [];
  const emitter: SubagentLifecycleEmitter = async (event, payload) => {
    events.push({ event, payload });
  };
  return { emitter, events };
}

describe('spawn_subagents tool — schema + identity', () => {
  it('exposes the correct name and a description that mentions parallel delegation', () => {
    const { tool } = makeTool({ runSubagent: async () => ({ status: 'success', text: '' }) });
    expect(tool.function.name).toBe('spawn_subagents');
    expect(tool.function.description).toMatch(/parallel|multiple|subagent/i);
  });

  it('DEFAULT_MAX_PARALLEL_SUBAGENTS is 4', () => {
    expect(DEFAULT_MAX_PARALLEL_SUBAGENTS).toBe(4);
  });

  it('MAX_PARALLEL_BATCH_SIZE is sane (≥4× default cap, ≤32)', () => {
    expect(MAX_PARALLEL_BATCH_SIZE).toBeGreaterThanOrEqual(DEFAULT_MAX_PARALLEL_SUBAGENTS * 4);
    expect(MAX_PARALLEL_BATCH_SIZE).toBeLessThanOrEqual(32);
  });
});

describe('spawn_subagents tool — happy path (3 parallel)', () => {
  it('runs 3 subagents to success, returns results in submission order, sums usage', async () => {
    const runner: SubagentRunner = async (config) => ({
      status: 'success',
      text: `done:${config.prompt}`,
      costUsd: 0.01,
      durationMs: 5,
      usage: makeUsage(100, 50),
    });
    const { execute } = makeTool({ runSubagent: runner });

    const out = await execute({
      subagents: [{ description: 'task A' }, { description: 'task B' }, { description: 'task C' }],
    });

    expect(out.results).toHaveLength(3);
    expect(out.results.map((r) => (r.status === 'success' ? r.output.text : null))).toEqual([
      'done:task A',
      'done:task B',
      'done:task C',
    ]);
    for (const r of out.results) {
      expect(r.status).toBe('success');
      expect(r.subagentSessionId).toMatch(/^parent-session:sub:[0-9a-f-]{36}$/);
    }
    expect(out.aggregatedUsage.usd).toBeCloseTo(0.03, 10);
    expect(out.aggregatedUsage.tokensIn).toBe(300);
    expect(out.aggregatedUsage.tokensOut).toBe(150);
    expect(out.aggregatedUsage.totalTokens).toBe(450);
    expect(out.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('fires SubagentStart + SubagentEnd once per child (3 specs → 6 events)', async () => {
    const runner: SubagentRunner = async () => ({ status: 'success', text: 'x', costUsd: 0 });
    const { emitter, events } = captureLifecycle();
    const { execute } = makeTool({ runSubagent: runner, onSubagentLifecycle: emitter });

    await execute({
      subagents: [{ description: 'a' }, { description: 'b' }, { description: 'c' }],
    });

    const starts = events.filter((e) => e.event === 'SubagentStart');
    const ends = events.filter((e) => e.event === 'SubagentEnd');
    expect(starts).toHaveLength(3);
    expect(ends).toHaveLength(3);
    // Every Start should have a matching End by subagentSessionId.
    const startIds = starts.map((e) =>
      e.payload.event === 'SubagentStart' ? e.payload.subagentSessionId : '',
    );
    const endIds = ends.map((e) =>
      e.payload.event === 'SubagentEnd' ? e.payload.subagentSessionId : '',
    );
    expect(new Set(startIds)).toEqual(new Set(endIds));
  });
});

describe('spawn_subagents tool — mixed success / failure isolation', () => {
  it('isolates a middle-spec throw; siblings still succeed; aggregate excludes failed cost', async () => {
    const runner: SubagentRunner = async (config) => {
      if (config.prompt === 'boom') {
        throw new Error('runner exploded');
      }
      return {
        status: 'success',
        text: `ok:${config.prompt}`,
        costUsd: 0.05,
        usage: makeUsage(200, 100),
      };
    };
    const { execute } = makeTool({ runSubagent: runner });

    const out = await execute({
      subagents: [{ description: 'first' }, { description: 'boom' }, { description: 'third' }],
    });

    expect(out.results).toHaveLength(3);
    expect(out.results[0].status).toBe('success');
    expect(out.results[1].status).toBe('error');
    expect(out.results[2].status).toBe('success');

    const mid = out.results[1];
    if (mid.status !== 'error') throw new Error('expected error');
    expect(mid.error).toBe('runner exploded');
    expect(mid.output).toBeNull();

    // Aggregate sums only the two successes — not the thrown middle one.
    expect(out.aggregatedUsage.usd).toBeCloseTo(0.1, 10);
    expect(out.aggregatedUsage.tokensIn).toBe(400);
    expect(out.aggregatedUsage.tokensOut).toBe(200);
    expect(out.aggregatedUsage.totalTokens).toBe(600);
  });

  it('maps a child that returned status=error (non-abort) to envelope.error with the reason', async () => {
    const runner: SubagentRunner = async () => ({
      status: 'max_budget',
      text: 'capped',
      costUsd: 1,
      reason: 'budget exceeded',
    });
    const { execute } = makeTool({ runSubagent: runner });
    const out = await execute({ subagents: [{ description: 'x' }] });
    // max_budget is not 'error' — it's a non-success terminal status that
    // still represents a normal completion. The envelope classification
    // keys on terminal status === 'error', so max_budget maps to success
    // (the subagent finished cleanly, it just hit its cap).
    expect(out.results[0].status).toBe('success');
  });

  it('maps a child that returned status=error from a non-abort cause to envelope.error', async () => {
    const runner: SubagentRunner = async () => ({
      status: 'error',
      text: '',
      reason: 'constructor threw',
    });
    const { execute } = makeTool({ runSubagent: runner });
    const out = await execute({ subagents: [{ description: 'x' }] });
    const r = out.results[0];
    expect(r.status).toBe('error');
    if (r.status !== 'error') throw new Error('expected error');
    expect(r.error).toBe('constructor threw');
    expect(r.output?.status).toBe('error');
  });

  it('falls back to "subagent errored" when summary.status=error but reason is undefined', async () => {
    const runner: SubagentRunner = async () => ({ status: 'error', text: '' });
    const { execute } = makeTool({ runSubagent: runner });
    const out = await execute({ subagents: [{ description: 'x' }] });
    const r = out.results[0];
    if (r.status !== 'error') throw new Error('expected error');
    expect(r.error).toBe('subagent errored');
  });
});

describe('spawn_subagents tool — aggregate excludes children without cost/usage', () => {
  it('omits cost / usage gracefully when a successful child reports neither', async () => {
    const runner: SubagentRunner = async () => ({ status: 'success', text: 'x' });
    const { execute } = makeTool({ runSubagent: runner });
    const out = await execute({
      subagents: [{ description: 'a' }, { description: 'b' }],
    });
    expect(out.aggregatedUsage.usd).toBe(0);
    expect(out.aggregatedUsage.tokensIn).toBe(0);
    expect(out.aggregatedUsage.tokensOut).toBe(0);
    expect(out.aggregatedUsage.totalTokens).toBe(0);
  });
});

describe('spawn_subagents tool — concurrency cap', () => {
  it('caps in-flight subagents at the default 4 even when submitted with 8', async () => {
    let inFlight = 0;
    let peak = 0;
    const runner: SubagentRunner = async () => {
      inFlight++;
      if (inFlight > peak) peak = inFlight;
      // Yield repeatedly so other workers can attempt to enter while we hold this slot.
      for (let i = 0; i < 5; i++) await Promise.resolve();
      inFlight--;
      return { status: 'success', text: 'x', costUsd: 0 };
    };
    const { execute } = makeTool({ runSubagent: runner });

    const out = await execute({
      subagents: Array.from({ length: 8 }, (_, i) => ({ description: `t${i}` })),
    });

    expect(out.results).toHaveLength(8);
    expect(peak).toBeLessThanOrEqual(DEFAULT_MAX_PARALLEL_SUBAGENTS);
    expect(peak).toBeGreaterThanOrEqual(2); // proves we did actually run in parallel
    expect(out.results.every((r) => r.status === 'success')).toBe(true);
  });

  it('honors a custom maxParallel override (cap=2 caps peak at 2 even with 6 specs)', async () => {
    let inFlight = 0;
    let peak = 0;
    const runner: SubagentRunner = async () => {
      inFlight++;
      if (inFlight > peak) peak = inFlight;
      for (let i = 0; i < 5; i++) await Promise.resolve();
      inFlight--;
      return { status: 'success', text: 'x', costUsd: 0 };
    };
    const { execute } = makeTool({ runSubagent: runner, maxParallel: 2 });

    await execute({
      subagents: Array.from({ length: 6 }, (_, i) => ({ description: `t${i}` })),
    });
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThanOrEqual(2);
  });

  it('runs each spec exactly once even when more than maxParallel are submitted', async () => {
    const seen: string[] = [];
    const runner: SubagentRunner = async (config) => {
      seen.push(config.prompt);
      return { status: 'success', text: 'x', costUsd: 0 };
    };
    const { execute } = makeTool({ runSubagent: runner });
    await execute({
      subagents: Array.from({ length: 8 }, (_, i) => ({ description: `t${i}` })),
    });
    expect(seen.sort()).toEqual(['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7']);
  });
});

describe('spawn_subagents tool — parent abort fans out', () => {
  it('parent abort propagates into every in-flight subagent (all 4 see signal.aborted)', async () => {
    const parentCtl = new AbortController();
    const observedSignals: AbortSignal[] = [];
    const runner: SubagentRunner = async (config) => {
      observedSignals.push(config.signal);
      // Wait until the signal aborts, then resolve with the abort summary
      // the real subagent runner produces on cancellation.
      await new Promise<void>((resolve) => {
        if (config.signal.aborted) return resolve();
        config.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { status: 'error', text: '', reason: 'aborted' };
    };
    const { execute } = makeTool({ runSubagent: runner });

    const pending = execute(
      {
        subagents: [
          { description: 'a' },
          { description: 'b' },
          { description: 'c' },
          { description: 'd' },
        ],
      },
      { signal: parentCtl.signal },
    );

    // Give the pool a tick so all 4 workers have entered runSubagent.
    await new Promise((r) => setTimeout(r, 10));
    expect(observedSignals).toHaveLength(4);
    expect(observedSignals.every((s) => !s.aborted)).toBe(true);

    parentCtl.abort();
    const out = await pending;

    expect(observedSignals.every((s) => s.aborted)).toBe(true);
    expect(out.results).toHaveLength(4);
    expect(out.results.every((r) => r.status === 'aborted')).toBe(true);
    for (const r of out.results) {
      if (r.status !== 'aborted') throw new Error('expected aborted');
      expect(r.error).toBe('aborted');
      expect(r.output?.reason).toBe('aborted');
    }
    // Aborted children do not contribute to aggregate cost.
    expect(out.aggregatedUsage.usd).toBe(0);
    expect(out.aggregatedUsage.totalTokens).toBe(0);
  });
});

describe('spawn_subagents tool — recursion depth cap', () => {
  it('rejects EACH spec when parent+1 >= maxDepth (matched Start/End pair per rejected spec)', async () => {
    const runnerCalls: SubagentRunConfig[] = [];
    const runner: SubagentRunner = async (config) => {
      runnerCalls.push(config);
      return { status: 'success', text: 'x', costUsd: 0 };
    };
    const { emitter, events } = captureLifecycle();
    const { execute } = makeTool({
      runSubagent: runner,
      currentDepth: 0,
      maxDepth: 1,
      onSubagentLifecycle: emitter,
    });

    const out = await execute({
      subagents: [{ description: 'one' }, { description: 'two' }],
    });

    expect(runnerCalls).toHaveLength(0); // runner never invoked
    expect(out.results).toHaveLength(2);
    for (const r of out.results) {
      expect(r.status).toBe('error');
      if (r.status !== 'error') throw new Error('expected error');
      expect(r.error).toMatch(/max subagent depth \(1\) exceeded/);
      expect(r.output).toBeNull();
    }
    // Matched Start/End pair PER rejected spec.
    expect(events.filter((e) => e.event === 'SubagentStart')).toHaveLength(2);
    expect(events.filter((e) => e.event === 'SubagentEnd')).toHaveLength(2);
  });

  it('SubagentStart on the depth-cap rejection path carries `tools` when supplied', async () => {
    const { emitter, events } = captureLifecycle();
    const { execute } = makeTool({
      runSubagent: async () => ({ status: 'success', text: '' }),
      currentDepth: 0,
      maxDepth: 1,
      onSubagentLifecycle: emitter,
    });
    await execute({
      subagents: [{ description: 'x', tools: ['read_file', 'grep_files'] }],
    });
    const start = events.find((e) => e.event === 'SubagentStart')!;
    if (start.payload.event !== 'SubagentStart') throw new Error('expected SubagentStart');
    expect(start.payload.toolNames).toEqual(['read_file', 'grep_files']);
  });
});

describe('spawn_subagents tool — non-Error throws stringify cleanly', () => {
  it('runner throwing a string surfaces as envelope.error = the string', async () => {
    const runner: SubagentRunner = async () => {
      throw 'plain-string-throw';
    };
    const { execute } = makeTool({ runSubagent: runner });
    const out = await execute({ subagents: [{ description: 'x' }] });
    const r = out.results[0];
    expect(r.status).toBe('error');
    if (r.status !== 'error') throw new Error('expected error');
    expect(r.error).toBe('plain-string-throw');
    expect(r.output).toBeNull();
  });
});

describe('spawn_subagents tool — per-spec override propagation', () => {
  it('each spec carries independent model / permission_mode / allowed_tools to the runner', async () => {
    const observed: SubagentRunConfig[] = [];
    const runner: SubagentRunner = async (config) => {
      observed.push(config);
      return { status: 'success', text: 'x', costUsd: 0 };
    };
    const { execute } = makeTool({ runSubagent: runner });

    await execute({
      subagents: [
        {
          description: 'A',
          model: 'openai/gpt-5-codex',
          permission_mode: 'plan',
          allowed_tools: ['read_file'],
        },
        {
          description: 'B',
          model: '~anthropic/claude-opus-latest',
          permission_mode: 'bypassPermissions',
          allowed_tools: ['Bash(echo *)'],
          disallowed_tools: ['Bash(rm *)'],
          effort: 'high',
        },
        {
          description: 'C',
          tools: ['grep_files'],
          max_turns: 2,
          max_budget_usd: 0.25,
          instructions: 'be terse',
        },
      ],
    });

    // We can't guarantee call ORDER inside the pool, so look up by prompt.
    const byPrompt = new Map(observed.map((c) => [c.prompt, c]));
    const a = byPrompt.get('A')!;
    expect(a.model).toBe('openai/gpt-5-codex');
    expect(a.permissionMode).toBe('plan');
    expect(a.allowedTools).toEqual(['read_file']);
    expect(a.effort).toBeUndefined();

    const b = byPrompt.get('B')!;
    expect(b.model).toBe('~anthropic/claude-opus-latest');
    expect(b.permissionMode).toBe('bypassPermissions');
    expect(b.allowedTools).toEqual(['Bash(echo *)']);
    expect(b.disallowedTools).toEqual(['Bash(rm *)']);
    expect(b.effort).toBe('high');

    const c = byPrompt.get('C')!;
    expect(c.toolNames).toEqual(['grep_files']);
    expect(c.maxTurns).toBe(2);
    expect(c.maxBudgetUsd).toBe(0.25);
    expect(c.instructions).toBe('be terse');
    expect(c.model).toBeUndefined();
    expect(c.permissionMode).toBeUndefined();
  });

  it('omits override fields from runner config when a spec omits them', async () => {
    const observed: SubagentRunConfig[] = [];
    const runner: SubagentRunner = async (config) => {
      observed.push(config);
      return { status: 'success', text: 'x', costUsd: 0 };
    };
    const { execute } = makeTool({ runSubagent: runner });
    await execute({ subagents: [{ description: 'minimal' }] });
    const c = observed[0];
    expect(c.model).toBeUndefined();
    expect(c.permissionMode).toBeUndefined();
    expect(c.allowedTools).toBeUndefined();
    expect(c.disallowedTools).toBeUndefined();
    expect(c.effort).toBeUndefined();
    expect(c.toolNames).toBeUndefined();
    expect(c.maxTurns).toBeUndefined();
    expect(c.maxBudgetUsd).toBeUndefined();
    expect(c.instructions).toBeUndefined();
  });

  it('starts each child at currentDepth + 1', async () => {
    const observed: SubagentRunConfig[] = [];
    const runner: SubagentRunner = async (config) => {
      observed.push(config);
      return { status: 'success', text: '', costUsd: 0 };
    };
    const { execute } = makeTool({ runSubagent: runner, currentDepth: 1 });
    await execute({ subagents: [{ description: 'a' }, { description: 'b' }] });
    expect(observed.every((c) => c.depth === 2)).toBe(true);
  });
});

describe('spawn_subagents tool — schema validation', () => {
  it('rejects an empty subagents array at parse time', () => {
    const t = spawnSubagentsTool(
      {
        parentSessionId: 'p',
        runSubagent: async () => ({ status: 'success', text: '' }),
      },
      { cwd: '.' },
    );
    const schema = (t.function as unknown as { inputSchema: { parse: (i: unknown) => unknown } })
      .inputSchema;
    expect(() => schema.parse({ subagents: [] })).toThrow();
  });

  it('rejects an array longer than MAX_PARALLEL_BATCH_SIZE at parse time', () => {
    const t = spawnSubagentsTool(
      {
        parentSessionId: 'p',
        runSubagent: async () => ({ status: 'success', text: '' }),
      },
      { cwd: '.' },
    );
    const schema = (t.function as unknown as { inputSchema: { parse: (i: unknown) => unknown } })
      .inputSchema;
    const tooMany = Array.from({ length: MAX_PARALLEL_BATCH_SIZE + 1 }, () => ({
      description: 'x',
    }));
    expect(() => schema.parse({ subagents: tooMany })).toThrow();
  });

  it('rejects an invalid per-spec permission_mode at parse time', () => {
    const t = spawnSubagentsTool(
      {
        parentSessionId: 'p',
        runSubagent: async () => ({ status: 'success', text: '' }),
      },
      { cwd: '.' },
    );
    const schema = (t.function as unknown as { inputSchema: { parse: (i: unknown) => unknown } })
      .inputSchema;
    expect(() =>
      schema.parse({
        subagents: [{ description: 'x', permission_mode: 'not-a-mode' }],
      }),
    ).toThrow();
  });

  it('accepts a description-only spec (every other field optional)', () => {
    const t = spawnSubagentsTool(
      {
        parentSessionId: 'p',
        runSubagent: async () => ({ status: 'success', text: '' }),
      },
      { cwd: '.' },
    );
    const schema = (t.function as unknown as { inputSchema: { parse: (i: unknown) => unknown } })
      .inputSchema;
    expect(() => schema.parse({ subagents: [{ description: 'x' }] })).not.toThrow();
  });
});

describe('spawn_subagents tool — submission-order preservation under unordered completion', () => {
  it('returns results in submission order even when later specs complete first', async () => {
    // Build a runner where spec i completes after (N - i) ticks, so the
    // pool's completion order is reversed relative to submission. The
    // assertion verifies out.results[i] still matches subagents[i].
    const N = 4;
    const runner: SubagentRunner = async (config) => {
      const idx = parseInt(config.prompt, 10);
      const ticks = N - idx;
      for (let i = 0; i < ticks; i++) await Promise.resolve();
      return {
        status: 'success',
        text: `done-${idx}`,
        costUsd: 0,
      };
    };
    const { execute } = makeTool({ runSubagent: runner });
    const out = await execute({
      subagents: Array.from({ length: N }, (_, i) => ({ description: String(i) })),
    });
    out.results.forEach((r, i) => {
      if (r.status !== 'success') throw new Error('expected success');
      expect(r.output.text).toBe(`done-${i}`);
    });
  });
});

describe('spawn_subagents tool — falls back to factory ctx.signal when execCtx has none', () => {
  it('composes the factory-time ctx.signal into every child config', async () => {
    const factoryCtl = new AbortController();
    const observedSignals: AbortSignal[] = [];
    const runner: SubagentRunner = async (config) => {
      observedSignals.push(config.signal);
      await new Promise<void>((resolve) => {
        if (config.signal.aborted) return resolve();
        config.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { status: 'error', text: '', reason: 'aborted' };
    };
    const t = spawnSubagentsTool(
      { parentSessionId: 'p', runSubagent: runner },
      { cwd: '.', signal: factoryCtl.signal },
    );
    const execute = t.function.execute as ExecuteFn;
    const pending = execute({ subagents: [{ description: 'a' }, { description: 'b' }] });
    await new Promise((r) => setTimeout(r, 5));
    factoryCtl.abort();
    const out = await pending;
    expect(observedSignals.every((s) => s.aborted)).toBe(true);
    expect(out.results.every((r: SpawnSubagentResultEnvelope) => r.status === 'aborted')).toBe(
      true,
    );
  });
});

describe('spawn_subagents tool — lifecycle Start payload includes toolNames when present', () => {
  it('SubagentStart for a spec with `tools` carries the whitelist; omits otherwise', async () => {
    const runner: SubagentRunner = async (): Promise<SubagentRunResult> => ({
      status: 'success',
      text: 'x',
      costUsd: 0,
    });
    const { emitter, events } = captureLifecycle();
    const { execute } = makeTool({ runSubagent: runner, onSubagentLifecycle: emitter });
    await execute({
      subagents: [{ description: 'a', tools: ['read_file', 'grep_files'] }, { description: 'b' }],
    });
    const starts = events
      .filter((e) => e.event === 'SubagentStart')
      .map((e) => e.payload)
      .filter(
        (p): p is Extract<HookPayload, { event: 'SubagentStart' }> => p.event === 'SubagentStart',
      );
    const byPrompt = new Map(starts.map((p) => [p.prompt, p]));
    expect(byPrompt.get('a')!.toolNames).toEqual(['read_file', 'grep_files']);
    expect('toolNames' in byPrompt.get('b')!).toBe(false);
  });
});
