// `describe.each` driver for the comparative-parity canonical scenario set
// (Phase 6.5a). One row per scenario JSON in `src/__tests__/comparative/scenarios/`.
// Each row:
//   1. Runs the harness in `emulated` mode against the scenario.
//   2. Asserts neither SDK threw at the harness level (transcripts captured
//      with a populated `thrown` field is a harness-level signal that
//      something broke in the plumbing, not a parity result).
//   3. Feeds both transcripts into the 6.4 comparator and asserts
//      `result.pass === true`. This is the parity assertion the canonical
//      set exists to make — anything weaker would silently rot.
//
// The smoke scenario shipped by 6.3 has been removed (ambiguity call #5):
// scenario #1 supersedes it as the canonical "single-turn no-tool" case,
// and the comparator-pass assertion makes the smoke's looser "transcripts
// captured" check redundant.

import { afterEach, beforeAll, describe, it, expect } from 'vitest';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareTranscriptsFromScenario } from './comparator.js';
import { runScenario } from './harness.js';
import { loadScenario } from './scenarios.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCENARIO_DIR = join(HERE, 'scenarios');

// Phase 6.8: opt-in per-scenario pass/fail JSONL emission for the nightly
// drift-detection workflow. Default off — local + PR runs don't pay the
// I/O. The nightly workflow sets `COMPARATIVE_EMULATED_RESULT_REPORT` to a
// directory; the driver writes one JSONL line per scenario test, last-
// write-wins on retries (vitest --retry=1 re-invokes the test body, the
// workflow's jq pass dedupes by scenario name). The file is wiped in
// beforeAll so each run starts clean.
const EMULATED_REPORT_DIR = process.env.COMPARATIVE_EMULATED_RESULT_REPORT;
const EMULATED_REPORT_PATH = EMULATED_REPORT_DIR
  ? join(EMULATED_REPORT_DIR, 'comparative-emulated-result-report.jsonl')
  : null;

const scenarios = readdirSync(SCENARIO_DIR)
  // Ignore authoring helpers (`_tools.ts`, `_helper.ts`, `README.md`).
  .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  .map((f) => ({ name: f.replace(/\.json$/, ''), path: join(SCENARIO_DIR, f) }))
  .sort((a, b) => a.name.localeCompare(b.name));

if (EMULATED_REPORT_PATH) {
  // Reset the report artifact so each run starts clean. The nightly
  // workflow reads this file after the test command exits.
  beforeAll(async () => {
    await mkdir(dirname(EMULATED_REPORT_PATH), { recursive: true });
    await writeFile(EMULATED_REPORT_PATH, '', 'utf8');
  });
}

describe.each(scenarios)('comparative scenario: $name', ({ name, path }) => {
  // Track this scenario's pass-state across afterEach so we can emit the
  // JSONL line whether the test threw or not. Vitest's --retry=1 re-runs
  // the test body, so afterEach fires again on retry — last-write-wins
  // semantics; the workflow's jq pass dedupes by scenario name.
  let scenarioPassed = false;
  afterEach(async () => {
    if (!EMULATED_REPORT_PATH) return;
    const line =
      JSON.stringify({
        scenario: name,
        mode: 'emulated',
        pass: scenarioPassed,
      }) + '\n';
    await appendFile(EMULATED_REPORT_PATH, line, 'utf8');
  });

  it('passes the comparator in emulated mode', async () => {
    scenarioPassed = false;
    const scenario = await loadScenario(path);
    const { anthropicTranscript, orTranscript } = await runScenario(path, 'emulated');

    // Surface harness-level throws as a test failure with the captured
    // `thrown` text so the developer doesn't have to dig through the
    // failure dump to figure out what crashed. Phase 6.5b cancellation
    // scenarios (#6) deliberately abort both SDKs mid-stream, populating
    // `thrown` with an AbortError; the comparator's `ignoreThrown` carries
    // the parity claim. For those scenarios we still inspect the throw
    // payload so a non-abort error (which would indicate genuine plumbing
    // breakage) still fails the test, but a benign abort path is allowed.
    // Phase 6.6 failure-injection scenarios (#13–#15) ALSO populate `thrown`
    // (transport/parse errors), but with SDK-specific phrasing that isn't
    // abort-shaped — they opt out of the regex check via the
    // `tolerateThrownInjection` flag while still requiring `ignoreThrown`
    // to suppress the no-throw assertion. The flag is intentionally narrow
    // (not a blanket "no defensive check") so non-injection scenarios that
    // misuse it still get caught by the schema's documentation.
    const cancelling = scenario.comparator?.ignoreThrown === true;
    const tolerateInjection = scenario.comparator?.tolerateThrownInjection === true;
    if (!cancelling) {
      expect(
        anthropicTranscript.thrown,
        `Anthropic side threw:\n${anthropicTranscript.thrown}`,
      ).toBeUndefined();
      expect(orTranscript.thrown, `OR side threw:\n${orTranscript.thrown}`).toBeUndefined();
    } else if (!tolerateInjection) {
      // Defensive: confirm the throw, if any, looks abort-flavored — guards
      // against a future regression where the SDK starts throwing for a
      // different reason and the comparator's ignoreThrown silently masks it.
      const ABORT_PATTERN = /abort|cancel/i;
      if (anthropicTranscript.thrown) {
        expect(
          anthropicTranscript.thrown,
          `Anthropic threw a non-abort error:\n${anthropicTranscript.thrown}`,
        ).toMatch(ABORT_PATTERN);
      }
      if (orTranscript.thrown) {
        expect(orTranscript.thrown, `OR threw a non-abort error:\n${orTranscript.thrown}`).toMatch(
          ABORT_PATTERN,
        );
      }
    }
    // tolerateThrownInjection: no shape-check on the throw text — failure-
    // injection scenarios surface SDK-specific transport/parse error
    // phrasing that we explicitly don't compare across SDKs.

    const result = await compareTranscriptsFromScenario(
      scenario,
      anthropicTranscript,
      orTranscript,
      { dumpOnFail: false },
    );

    // On failure, attach the human-readable Markdown report so the
    // diagnostic appears in the test output without requiring a separate
    // dump-file inspection step.
    expect(result.pass, `Comparator failed:\n${result.report}`).toBe(true);

    // Reached only if every expect above held — flag pass for the 6.8
    // nightly JSONL emitted in afterEach.
    scenarioPassed = true;
  });
});

// ----- Scenario #4 hook firing order — load-bearing exact assertion ------
//
// The plan-doc's parity claim is "Hook firing order + event-shape assertions
// stay exact in both modes." Scenario #4 (permission denial) is the case
// where this matters most: a host-side canUseTool deny MUST short-circuit
// the tool dispatch on both SDKs in the SAME spot in the hook stream.
//
// We assert the exact canonical hook order here in addition to the
// comparator pass above, so a future regression that broke the deny path's
// ordering would surface with a precise failure rather than a vague
// "comparator pass=false" message that bundles every other parity check
// with this one. The expected order is hard-coded from the canonical
// canonicalization rules in `canonicalize.ts`.

describe('comparative scenario: 04-permission-denial — hook order', () => {
  it('emits the deny-path hook sequence in EXACT order on both SDKs', async () => {
    const scenarioPath = join(SCENARIO_DIR, '04-permission-denial.json');
    const { anthropicTranscript, orTranscript } = await runScenario(scenarioPath, 'emulated');
    const scenario = await loadScenario(scenarioPath);
    const result = await compareTranscriptsFromScenario(
      scenario,
      anthropicTranscript,
      orTranscript,
      { dumpOnFail: false },
    );

    expect(result.pass).toBe(true);

    // Both projections share `hookOrder`; if the comparator passed, they
    // are equal. Pin the exact sequence so a future change that ALSO
    // adjusts the comparator can't silently weaken this contract.
    const { canonicalizeAnthropic, canonicalizeOr } = await import('./canonicalize.js');
    const anthHook = canonicalizeAnthropic(anthropicTranscript).hookOrder;
    const orHook = canonicalizeOr(orTranscript).hookOrder;

    const expected = [
      'session_start',
      'turn_start',
      'tool_call:rm',
      'turn_end',
      'tool_result',
      'turn_start',
      'turn_end',
      'terminal:success',
    ];

    expect(anthHook).toEqual(expected);
    expect(orHook).toEqual(expected);
  });
});

// ----- Phase 6.5b: exact hook-order pins for canonical scenarios #5–#8 ----
//
// Per the plan doc + issue body, hook firing order is the load-bearing parity
// claim and MUST be asserted exactly on every scenario in the canonical set
// — the comparator's hook_order check already does this, but pinning the
// expected sequences here in addition prevents a future weakening of the
// comparator from silently rotting the contract.

describe('comparative scenario: 05-plan-mode-readonly — hook order', () => {
  it('emits the plan-mode (read passes / write denied) hook sequence in EXACT order on both SDKs', async () => {
    const scenarioPath = join(SCENARIO_DIR, '05-plan-mode-readonly.json');
    const { anthropicTranscript, orTranscript } = await runScenario(scenarioPath, 'emulated');
    const { canonicalizeAnthropic, canonicalizeOr } = await import('./canonicalize.js');
    const expected = [
      'session_start',
      'turn_start',
      'tool_call:read', // read passes the filter, dispatches
      'turn_end',
      'tool_result',
      'turn_start',
      'tool_call:write', // write filtered, short-circuited
      'turn_end',
      'tool_result',
      'turn_start',
      'turn_end',
      'terminal:success',
    ];
    expect(canonicalizeAnthropic(anthropicTranscript).hookOrder).toEqual(expected);
    expect(canonicalizeOr(orTranscript).hookOrder).toEqual(expected);
  });
});

describe('comparative scenario: 06-cancel-mid-stream — hook order', () => {
  it('emits the cancellation hook sequence in EXACT order on both SDKs', async () => {
    const scenarioPath = join(SCENARIO_DIR, '06-cancel-mid-stream.json');
    const { anthropicTranscript, orTranscript } = await runScenario(scenarioPath, 'emulated');
    const { canonicalizeAnthropic, canonicalizeOr } = await import('./canonicalize.js');
    // Both sides: session → opened-turn (synthesized) → closed-turn (synthesized)
    // → synthetic terminal:aborted. Anthropic's terminal:aborted is emitted by
    // canonicalizeAnthropic when transcript.thrown is set and no `result`
    // arrived; OR's comes from canonicalizeOr's stream_complete{status:error,
    // reason:aborted} → 'aborted' remap.
    const expected = ['session_start', 'turn_start', 'turn_end', 'terminal:aborted'];
    expect(canonicalizeAnthropic(anthropicTranscript).hookOrder).toEqual(expected);
    expect(canonicalizeOr(orTranscript).hookOrder).toEqual(expected);
  });
});

describe('comparative scenario: 07-tool-error-resume — hook order', () => {
  it('emits the throw-and-retry hook sequence in EXACT order on both SDKs', async () => {
    const scenarioPath = join(SCENARIO_DIR, '07-tool-error-resume.json');
    const { anthropicTranscript, orTranscript } = await runScenario(scenarioPath, 'emulated');
    const { canonicalizeAnthropic, canonicalizeOr } = await import('./canonicalize.js');
    // Turn 0: tool_call(flakyFetch) → tool_result(isError=true on Anthropic,
    // false on OR per known agent.ts gap documented on the comparator's
    // `tolerateToolResultIsError` flag).
    // Turn 1: retry tool_call → tool_result(isError=false on both).
    // Turn 2: text summary → terminal:success.
    const expected = [
      'session_start',
      'turn_start',
      'tool_call:flakyFetch',
      'turn_end',
      'tool_result',
      'turn_start',
      'tool_call:flakyFetch',
      'turn_end',
      'tool_result',
      'turn_start',
      'turn_end',
      'terminal:success',
    ];
    expect(canonicalizeAnthropic(anthropicTranscript).hookOrder).toEqual(expected);
    expect(canonicalizeOr(orTranscript).hookOrder).toEqual(expected);
  });
});

// Phase 6.5c: scenario #12 retry assertion. The comparator above asserts that
// the canonical event streams match (i.e., the 429+retry is invisible at the
// projection layer); this supplemental check inspects the raw Anthropic
// transcript for `system:api_retry` messages, proving the SDK ACTUALLY
// retried. Without this, the scenario could spuriously "pass" if the SDK had
// some other (unintended) recovery path that bypassed retry but still reached
// terminal:success — the bytes-on-the-wire claim of "the SDK retries 429" is
// the load-bearing finding, and the test must check that bytes-on-the-wire
// directly. The OR side is NOT checked here because its SDK doesn't retry
// 429 by default (see scenario JSON description for the divergence finding).

describe('comparative scenario: 12-retry-on-429 — retry observed', () => {
  it('Anthropic transcript carries at least one api_retry message (proves 429 retry path fired)', async () => {
    const scenarioPath = join(SCENARIO_DIR, '12-retry-on-429.json');
    const { anthropicTranscript } = await runScenario(scenarioPath, 'emulated');
    const apiRetryCount = anthropicTranscript.messages.filter(
      (m) =>
        (m as { type?: string }).type === 'system' &&
        (m as { subtype?: string }).subtype === 'api_retry',
    ).length;
    expect(
      apiRetryCount,
      `Expected at least 1 api_retry message on the Anthropic transcript (proves the SDK retried the scripted 429); got ${apiRetryCount}.`,
    ).toBeGreaterThanOrEqual(1);
  });
});

describe('comparative scenario: 08-hook-block-modify — hook order', () => {
  it('emits the hook-block (shell denied before dispatch) sequence in EXACT order on both SDKs', async () => {
    const scenarioPath = join(SCENARIO_DIR, '08-hook-block-modify.json');
    const { anthropicTranscript, orTranscript } = await runScenario(scenarioPath, 'emulated');
    const { canonicalizeAnthropic, canonicalizeOr } = await import('./canonicalize.js');
    // PreToolUse fires (tool_call observed in the stream), dispatch never
    // happens (no execute() entry — the denial short-circuits at canUseTool),
    // tool_result returns isError=true with the canon denial message, model
    // adapts in the next turn.
    const expected = [
      'session_start',
      'turn_start',
      'tool_call:shell',
      'turn_end',
      'tool_result',
      'turn_start',
      'turn_end',
      'terminal:success',
    ];
    expect(canonicalizeAnthropic(anthropicTranscript).hookOrder).toEqual(expected);
    expect(canonicalizeOr(orTranscript).hookOrder).toEqual(expected);
  });
});

// ----- Phase 6.9 backfill #174: persistSession: false — zero-disk-writes -----
//
// The shared `runScenario` harness already constructs the OR side with
// `persistSession: false` (harness.ts:530), so the standard comparator-pass
// run on scenario #18 implicitly exercises the in-memory `StateAccessor`'s
// `previousResponseId` roundtrip: the turn-1 OR request includes
// `previous_response_id: resp-18-0`, which is canonicalized into the
// promptHash; an in-memory accessor that failed to carry the id forward
// would produce a different turn-1 hash and miss the script.
//
// This supplemental test pins the OTHER half of the Phase 3.12 contract: that
// `persistSession: false` produces ZERO filesystem writes under `logsRoot`.
// It builds an OR-only run inline (the Anthropic agent SDK has no equivalent
// `persistSession` knob — its subprocess writes to `~/.claude/projects/`
// under its own bookkeeping, out of scope for this parity claim — see PR
// body ambiguity call #1), drives the same two-turn `write`-tool flow against
// an in-process emulator seeded with scenario #18's OR-wire script entries,
// and asserts the explicit `logsRoot` tmpdir remains EMPTY after the run.
//
// The full-harness `runScenario` would suffice for the previousResponseId
// roundtrip but does NOT thread `logsRoot` through to the OR ctor (it
// defaults to `<cwd>/logs/`, which the harness assumes is unused because
// `persistSession: false` is set). Pinning an explicit `logsRoot` here lets
// the assertion target a known-empty tmpdir without touching the harness
// surface.

describe('comparative scenario: 18-persist-session-false — zero disk writes (OR-only)', () => {
  it('writes nothing under logsRoot when persistSession is false', async () => {
    const { mkdtemp, rm, readdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { startEmulator } = await import('./emulator/index.js');
    const { OpenRouterAgentRun } = await import('../../agent.js');
    const { buildHarnessTools } = await import('./scenarios/_tools.js');

    const scenarioPath = join(SCENARIO_DIR, '18-persist-session-false.json');
    const scenario = await loadScenario(scenarioPath);

    const logsRoot = await mkdtemp(join(tmpdir(), 'persist-session-false-'));
    const emu = await startEmulator();
    for (const entry of scenario.script) {
      if ((entry.wire ?? 'anthropic') !== 'openresponses') continue;
      emu.registry.register(entry as Parameters<typeof emu.registry.register>[0]);
    }
    const tools = buildHarnessTools(scenario.tools ?? []);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30_000).unref();

    try {
      const run = new OpenRouterAgentRun({
        apiKey: 'sk-or-emulator-stub',
        sessionId: `persist-session-false-${Date.now()}`,
        prompt: scenario.prompt,
        baseUrl: emu.url,
        persistSession: false,
        logsRoot,
        signal: ac.signal,
        tools: tools.orTools,
        model: scenario.model,
        instructions: scenario.systemPrompt,
      });
      for await (const _ev of run) {
        // discard — the parity claim above already asserts event-stream
        // correctness; this test's job is the filesystem assertion below.
      }
    } finally {
      await emu.stop();
    }

    // Phase 3.12's contract: nothing under logsRoot. We assert the directory
    // tree is empty (`{ withFileTypes: true, recursive: true }` surfaces
    // both files and any nested dirs the implementation might have created
    // — a passing run leaves the dir we mkdtemp'd above pristine).
    const entries = await readdir(logsRoot, { recursive: true, withFileTypes: true });
    const written = entries.map((e) => (e.parentPath ? `${e.parentPath}/${e.name}` : e.name));
    expect(
      written,
      `persistSession: false must not write under logsRoot; found: ${written.join(', ')}`,
    ).toEqual([]);

    await rm(logsRoot, { recursive: true, force: true });
  });
});
