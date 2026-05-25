// Smoke end-to-end wiring (Phase 6.4 AC#6 / AC#8).
//
// Runs the 6.3 smoke scenario through the harness + comparator, in BOTH
// emulated comparator modes. The scenario today exercises plumbing only —
// the Anthropic side throws a 500 (emulator_script_miss because the live
// SDK's promptHash differs from the placeholder we ship), and the OR side
// throws a 404 (no `/responses` adapter in 6.1/6.2). See PR #143 + the 6.3
// harness header for the rationale.
//
// Given the plumbing-only state, this test asserts the AMBIGUITY-CALL (b)
// contract from the build card brief: **the comparator runs without
// throwing and returns a structured pass/fail report.** When 6.5a wires
// real captured hashes and 6.3-followup adds the `/responses` adapter, the
// expectation here flips to `result.pass === true`.
//
// TODO(6.5a): replace placeholder promptHash with real captured value;
//   flip the assertion below to require `result.pass === true`.

import { describe, it, expect } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { rm } from 'node:fs/promises';

import { runScenario } from './harness.js';
import { compareTranscriptsFromScenario } from './comparator.js';
import { loadScenario } from './scenarios.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCENARIO_PATH = join(HERE, 'scenarios', 'smoke-single-turn.json');

describe('comparator smoke wiring', () => {
  it('runs the 6.3 smoke scenario end-to-end through the comparator without throwing', async () => {
    const dumpRoot = join(tmpdir(), `comparator-smoke-${process.pid}-${Date.now()}`);
    try {
      const { anthropicTranscript, orTranscript } = await runScenario(SCENARIO_PATH, 'emulated', {
        failureDumpRoot: dumpRoot,
      });
      const scenario = await loadScenario(SCENARIO_PATH);

      const result = await compareTranscriptsFromScenario(
        scenario,
        anthropicTranscript,
        orTranscript,
        { failureDumpRoot: dumpRoot, dumpOnFail: false },
      );

      // Comparator MUST produce a structured result regardless of plumbing
      // outcome. The verdict itself is currently allowed to be either —
      // see file header for the ambiguity-call rationale.
      expect(typeof result.pass).toBe('boolean');
      expect(typeof result.report).toBe('string');
      expect(result.report).toContain('# Comparator report: smoke-single-turn');
      expect(result.report).toContain('Mode:');
      expect(Array.isArray(result.failures)).toBe(true);

      // If either side captured a thrown, the comparator surfaces it as a
      // structured failure — silent swallowing is the rot the dual-mode
      // harness exists to prevent.
      if (anthropicTranscript.thrown || orTranscript.thrown) {
        expect(result.pass).toBe(false);
        expect(result.failures.some((f) => f.kind === 'thrown')).toBe(true);
      }
    } finally {
      await rm(dumpRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
