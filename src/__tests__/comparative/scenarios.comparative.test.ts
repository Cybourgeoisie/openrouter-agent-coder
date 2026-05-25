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
    const { anthropicTranscript, orTranscript } = await runScenario(path, 'emulated');

    // Surface harness-level throws as a test failure with the captured
    // `thrown` text so the developer doesn't have to dig through the
    // failure dump to figure out what crashed.
    expect(
      anthropicTranscript.thrown,
      `Anthropic side threw:\n${anthropicTranscript.thrown}`,
    ).toBeUndefined();
    expect(orTranscript.thrown, `OR side threw:\n${orTranscript.thrown}`).toBeUndefined();

    const scenario = await loadScenario(path);
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
