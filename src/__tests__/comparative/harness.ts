// Dual-mode comparative-parity harness (Phase 6.3).
//
// Runs a scenario through BOTH `@anthropic-ai/claude-agent-sdk` and
// `@openrouter/agent`'s `OpenRouterAgentRun` against a single in-process
// emulator, captures append-only transcripts from each, and returns them for
// the 6.4 comparator to consume. Independent emulator instances per SDK so
// neither side's turn-cursor pollutes the other (proves no shared global
// state — `Promise.all`-driven concurrent execution surfaces any mistake here
// immediately).
//
// === Asymmetric base-URL plumbing (LOAD-BEARING — DO NOT UNIFY) ===
//
// OR side       → `baseUrl: emulator.url` ctor option on `OpenRouterAgentRun`
//                 → flows through to the OR client constructor's `serverURL`
//                 (`src/agent.ts:934`). In-process, ctor-arg.
// Anthropic side → per-`query()` `Options.env: { ANTHROPIC_BASE_URL: ... }`
//                 injection. Per 6.S1 spike, the agent SDK spawns a fresh
//                 `claude` subprocess per call and reads `ANTHROPIC_BASE_URL`
//                 *inside* that subprocess — NOT at parent import time. So
//                 env-isolation is structural; a parent `process.env` mutation
//                 would be both unnecessary and dangerous (would poison sibling
//                 tests). DO NOT replace this with `process.env.ANTHROPIC_BASE_URL = ...`.
//
// The shapes differ because the wire formats differ (`/v1/messages` vs.
// `/v1/chat/completions` vs. `/responses`). A shared "set the base URL" helper
// would have to fork on which SDK it's configuring — at which point you're
// back to two distinct call sites with extra plumbing on top. Two lines stays
// two lines.
//
// === TODO breadcrumbs ===
//
// TODO(6.4): the comparator. This file ONLY returns transcripts. The
//   `expect(orTranscript).toEqual(anthropicTranscript)` assertion lives in
//   6.4's `comparator.ts`. Resist adding it here.
// TODO(6.5): scenario expansion (#1–#12). v1 only consumes the minimal Zod
//   schema; failure-injection / tolerance bands are 6.5/6.6.
// TODO(6.3-followup): `/responses` adapter for full OR-side end-to-end. The
//   OR SDK's `callModel` routes through `/responses` (beta), which neither
//   6.1's `/v1/messages` adapter nor 6.2's `/v1/chat/completions` adapter
//   serves. Until that lands, the OR-side smoke transcript will surface an
//   error event for the 404 — the harness PLUMBING is exercised, but the
//   round-trip is not. See PR-body ambiguity call #7.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { OpenRouterAgentRun } from '../../agent.js';

import { startEmulator, type EmulatorHandle, type ScriptEntry } from './emulator/index.js';
import { entriesForWire, loadScenario, type Scenario } from './scenarios.js';
import {
  maskNondeterminism,
  type AnthropicTranscript,
  type OrTranscript,
  type ScenarioTranscripts,
} from './transcript.js';

export type HarnessMode = 'emulated' | 'live';

export type RunScenarioOptions = {
  /**
   * Per-run timeout for each SDK. Defaults to 30s — generous enough to absorb
   * the agent SDK's subprocess cold-start (~1-2s on Linux per 6.S1) plus
   * a few SSE turns; tight enough to surface real hangs as test failures
   * rather than CI timeouts.
   */
  timeoutMs?: number;
  /**
   * Override the failure-dump root. Defaults to `<cwd>/tmp/comparative-failures`.
   * Tests can point this at a temp dir to avoid cluttering the project's
   * `tmp/` during the env-leakage and self-test runs.
   */
  failureDumpRoot?: string;
};

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Run a scenario through both SDKs concurrently and capture their transcripts.
 *
 * `mode: 'emulated'` — spins up one emulator per SDK on its own ephemeral
 * port, points each SDK at its emulator via the appropriate base-URL override
 * (see file header), seeds the scenario's script entries into each
 * emulator's registry filtered by `wire`. The two emulator instances exist
 * for isolation: a multi-turn scenario that races concurrent requests cannot
 * cross-pollute turn cursors.
 *
 * `mode: 'live'` — not implemented in 6.3. The function throws so the test
 * surfaces the gap clearly. 6.7 wires live mode with API keys from
 * `.env.local`.
 *
 * Failure handling: if either SDK throws (vs. emitting an `error` event), the
 * transcripts captured so far are dumped to disk under
 * `<failureDumpRoot>/<scenarioName>-<isoTimestamp>/` and the throw is
 * recorded on the transcript's `thrown` field. The function then resolves
 * normally so the caller (a vitest `it` block) can decide whether to fail
 * the test based on transcript content. We choose fail-fast at the SDK level
 * (we don't try to "best-effort capture more after a throw") because the
 * harness exists to prevent silent rot — a throw mid-capture means we've
 * already lost ordering information, and pretending otherwise hides bugs.
 */
export async function runScenario(
  scenarioPath: string,
  mode: HarnessMode,
  options: RunScenarioOptions = {},
): Promise<ScenarioTranscripts> {
  if (mode === 'live') {
    // TODO(6.7): live mode requires `.env.local` API-key loading + budget
    // guards. Out of scope for 6.3.
    throw new Error('Live mode is not implemented in Phase 6.3. See TODO(6.7).');
  }

  const scenario = await loadScenario(scenarioPath);
  const failureDumpRoot =
    options.failureDumpRoot ?? join(process.cwd(), 'tmp', 'comparative-failures');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // One emulator per SDK so script cursors don't cross-pollinate. Each
  // emulator binds to its own ephemeral port (`server.listen(0)`).
  const anthropicEmulator = await startEmulator();
  const orEmulator = await startEmulator();

  // Seed each registry with only the entries that target its wire format.
  // Entries that don't match are silently skipped (the wire-mismatch path is
  // owned by the script-engine when a request actually arrives).
  registerEntries(anthropicEmulator, entriesForWire(scenario, 'anthropic'));
  registerEntries(orEmulator, entriesForWire(scenario, 'openai'));

  let transcripts: [AnthropicTranscript, OrTranscript];
  try {
    // Promise.all so both SDKs run truly concurrently. Each side captures
    // its own transcript; a throw on one side does NOT abort the other (we
    // wrap each in its own catch so we can dump partial transcripts from
    // BOTH on a single side's failure).
    const anthropicPromise = captureAnthropic(scenario, anthropicEmulator.url, timeoutMs).catch(
      (err) => failedAnthropicTranscript(err),
    );
    const orPromise = captureOpenRouter(scenario, orEmulator.url, timeoutMs).catch((err) =>
      failedOrTranscript(err),
    );

    transcripts = await Promise.all([anthropicPromise, orPromise]);
  } finally {
    await anthropicEmulator.stop();
    await orEmulator.stop();
  }
  const [anthropicTranscript, orTranscript] = transcripts;

  if (anthropicTranscript.thrown || orTranscript.thrown) {
    await dumpFailure(failureDumpRoot, scenario, { anthropicTranscript, orTranscript });
  }

  return { anthropicTranscript, orTranscript };
}

function registerEntries(emulator: EmulatorHandle, entries: ScriptEntry[]): void {
  for (const entry of entries) emulator.registry.register(entry);
}

// ----- Anthropic side capture -----

/**
 * Drives the Claude Agent SDK via `query()` with `Options.env` carrying our
 * emulator URL + a stub API key. We deliberately pass `{ ...process.env, ... }`
 * so PATH / HOME / TMPDIR still reach the spawned `claude` subprocess (per
 * 6.S1's hosting-pattern note); the override fields go LAST so they win any
 * collision with the parent env. The parent process's `ANTHROPIC_BASE_URL`
 * (if any) is preserved into the spread but immediately overridden — so this
 * call site CANNOT leak the emulator URL into the parent.
 */
async function captureAnthropic(
  scenario: Scenario,
  emulatorUrl: string,
  timeoutMs: number,
): Promise<AnthropicTranscript> {
  const messages: Array<Record<string, unknown>> = [];
  const abortController = new AbortController();
  let timeoutHit = false;
  const timer = setTimeout(() => {
    timeoutHit = true;
    abortController.abort();
  }, timeoutMs);
  timer.unref();

  try {
    const q = query({
      prompt: scenario.prompt,
      options: {
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: emulatorUrl,
          ANTHROPIC_API_KEY: 'sk-ant-emulator-stub',
        },
        abortController,
        ...(scenario.model && { model: scenario.model }),
        ...(scenario.systemPrompt && { systemPrompt: scenario.systemPrompt }),
      },
    });
    for await (const msg of q) {
      messages.push(maskNondeterminism(msg as unknown as Record<string, unknown>));
    }
  } catch (err) {
    if (timeoutHit) {
      return {
        wire: 'anthropic',
        messages,
        thrown: `Anthropic-side capture timed out after ${timeoutMs}ms`,
      };
    }
    return {
      wire: 'anthropic',
      messages,
      thrown: formatThrown(err),
    };
  } finally {
    clearTimeout(timer);
  }
  return { wire: 'anthropic', messages };
}

function failedAnthropicTranscript(err: unknown): AnthropicTranscript {
  return { wire: 'anthropic', messages: [], thrown: formatThrown(err) };
}

// ----- OpenRouter side capture -----

/**
 * Drives `OpenRouterAgentRun` with `baseUrl` set to the emulator. We use
 * `persistSession: false` so the run does NOT write to `logs/` during the
 * test (no on-disk pollution, no test-runner working-dir surprises). The
 * `apiKey` is a stub — the emulator ignores it. Tools are explicitly empty:
 * the scaffolding doesn't need tool plumbing to exercise base-URL routing.
 *
 * Subscribes to the run's `AgentCoreEvent` async-iterable and captures every
 * event in fire order. Hooks (`Setup` / `SessionStart` / `SessionEnd` /
 * `Stop`) are deliberately NOT captured here — their fire-order parity is
 * captured by the AgentCoreEvent stream's structural events
 * (`session_started` / `stream_complete`); the hook surface is a separate
 * audit concern that 6.4 may decide to fold in.
 */
async function captureOpenRouter(
  scenario: Scenario,
  emulatorUrl: string,
  timeoutMs: number,
): Promise<OrTranscript> {
  const events: AgentEventCapture[] = [];
  const abortController = new AbortController();
  let timeoutHit = false;
  const timer = setTimeout(() => {
    timeoutHit = true;
    abortController.abort();
  }, timeoutMs);
  timer.unref();

  let run: OpenRouterAgentRun | undefined;
  try {
    run = new OpenRouterAgentRun({
      apiKey: 'sk-or-emulator-stub',
      sessionId: `comparative-${scenario.name}`,
      prompt: scenario.prompt,
      baseUrl: emulatorUrl,
      persistSession: false,
      signal: abortController.signal,
      ...(scenario.model && { model: scenario.model }),
      ...(scenario.systemPrompt && { instructions: scenario.systemPrompt }),
    });
    for await (const event of run) {
      events.push(maskNondeterminism(event));
    }
  } catch (err) {
    if (timeoutHit) {
      return {
        wire: 'openrouter',
        events,
        thrown: `OpenRouter-side capture timed out after ${timeoutMs}ms`,
      };
    }
    return {
      wire: 'openrouter',
      events,
      thrown: formatThrown(err),
    };
  } finally {
    clearTimeout(timer);
  }
  return { wire: 'openrouter', events };
}

function failedOrTranscript(err: unknown): OrTranscript {
  return { wire: 'openrouter', events: [], thrown: formatThrown(err) };
}

type AgentEventCapture = Parameters<
  typeof maskNondeterminism<import('../../events.js').AgentCoreEvent>
>[0];

// ----- Failure dump -----

async function dumpFailure(
  root: string,
  scenario: Scenario,
  transcripts: ScenarioTranscripts,
): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(root, `${scenario.name}-${timestamp}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'scenario.json'), JSON.stringify(scenario, null, 2), 'utf8');
  await writeFile(
    join(dir, 'anthropic.transcript.json'),
    JSON.stringify(transcripts.anthropicTranscript, null, 2),
    'utf8',
  );
  await writeFile(
    join(dir, 'or.transcript.json'),
    JSON.stringify(transcripts.orTranscript, null, 2),
    'utf8',
  );
}

function formatThrown(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  return String(err);
}
