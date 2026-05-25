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

import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareTranscriptsFromScenario } from './comparator.js';
import { runScenario } from './harness.js';
import { loadScenario } from './scenarios.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCENARIO_DIR = join(HERE, 'scenarios');

const scenarios = readdirSync(SCENARIO_DIR)
  // Ignore authoring helpers (`_tools.ts`, `_helper.ts`, `README.md`).
  .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  .map((f) => ({ name: f.replace(/\.json$/, ''), path: join(SCENARIO_DIR, f) }))
  .sort((a, b) => a.name.localeCompare(b.name));

describe.each(scenarios)('comparative scenario: $name', ({ path }) => {
  it('passes the comparator in emulated mode', async () => {
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
