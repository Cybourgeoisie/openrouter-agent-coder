// describe.each driver for the comparative-parity scenario suite (Phase 6.3).
//
// One row per scenario JSON file in `src/__tests__/comparative/scenarios/`.
// For each row we run the harness in `'emulated'` mode and assert the
// transcripts were captured cleanly (no harness-level throw; both transcript
// arrays populated). The exact-mode comparator assertions
// (`expect(orTranscript).toEqual(anthropicTranscript)` after canonicalization)
// live in 6.4's `comparator.ts` — NOT here. This driver's contract is
// "transcripts captured, ready for 6.4".
//
// 6.5a will replace the smoke scenario with the canonical set (#1–#4) and
// add a tolerant-mode mirror for live runs. Until then, the smoke is enough
// to prove the harness end-to-end.

import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runScenario } from './harness.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCENARIO_DIR = join(HERE, 'scenarios');

const scenarios = readdirSync(SCENARIO_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({ name: f.replace(/\.json$/, ''), path: join(SCENARIO_DIR, f) }));

describe.each(scenarios)('comparative scenario: $name', ({ path }) => {
  it('captures both transcripts in emulated mode without harness-level throw', async () => {
    const { anthropicTranscript, orTranscript } = await runScenario(path, 'emulated');

    // Wire discriminator is what the comparator (6.4) keys off.
    expect(anthropicTranscript.wire).toBe('anthropic');
    expect(orTranscript.wire).toBe('openrouter');

    // The harness MUST capture something from both sides — either real
    // messages/events or, when an SDK error short-circuited the run, a
    // populated `thrown` field. Empty arrays + no thrown = the harness
    // silently swallowed the run, which is exactly the rot the dual-mode
    // design exists to prevent.
    const anthropicHasSignal =
      anthropicTranscript.messages.length > 0 || anthropicTranscript.thrown !== undefined;
    const orHasSignal = orTranscript.events.length > 0 || orTranscript.thrown !== undefined;
    expect(anthropicHasSignal).toBe(true);
    expect(orHasSignal).toBe(true);

    // The harness's masking ran — at least one captured object should carry
    // a masked string in a known-volatile field IF the side ran far enough
    // to produce one. This is a smoke-grade check on the masking pipeline;
    // 6.4 will tighten it once the canonicalization sweep is specified.
    // For the OR side, an emitted `session_started` carries a sessionId
    // that must end up as the literal masked-marker string.
    for (const ev of orTranscript.events) {
      if (
        typeof ev === 'object' &&
        ev !== null &&
        (ev as { type?: unknown }).type === 'session_started'
      ) {
        expect((ev as { sessionId?: unknown }).sessionId).toBe('<masked:sessionId>');
      }
    }
  });
});
