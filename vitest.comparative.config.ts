// Comparative-parity suite config (Phase 6.3+).
//
// Run with `npm run test:comparative`. This config is intentionally separate
// from the main `vitest.config.ts` so the comparative suite can be:
//   1. Run independently in CI (Phase 6.7's "emulated mode on every PR" gate).
//   2. Excluded from the default `npm test` run — the comparative suite spawns
//      the @anthropic-ai/claude-agent-sdk subprocess (cold-start cost + internal
//      retry loop on errors) which would slow the unit-test feedback loop.
//   3. Independently configured (longer timeouts; no coverage thresholds,
//      since the harness lives under `src/__tests__/` and is itself excluded
//      from coverage).
//
// No coverage block on purpose — the comparative suite is not a unit-test
// coverage target. The unit-test config in `vitest.config.ts` enforces
// thresholds; this config is a runner for scenario integration tests.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/comparative/**/*.comparative.test.ts'],
    // The agent-SDK subprocess cold-start + any retry-loop runtime needs
    // room. 60s is the spike's worst-observed wall time for a hot 15-retry
    // loop — we set 90s as a generous-but-bounded ceiling so a real hang
    // surfaces as a timeout rather than letting CI burn its global timeout
    // budget.
    testTimeout: 90_000,
    fileParallelism: false,
  },
});
