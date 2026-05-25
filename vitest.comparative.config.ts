// Comparative-parity emulated-mode suite config (Phase 6.3+; budget knobs 6.7).
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
// Live-mode smoke runs use a separate config (`vitest.comparative-live.config.ts`)
// that targets `*.live.comparative.test.ts` files. Splitting the configs (vs.
// a single config with an env-flag toggle inside the test file) keeps each
// runner's include glob declarative — CI can grep workflows to find which
// scenario files actually exercised which mode.
//
// No coverage block on purpose — the comparative suite is not a unit-test
// coverage target. The unit-test config in `vitest.config.ts` enforces
// thresholds; this config is a runner for scenario integration tests.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/comparative/**/*.comparative.test.ts'],
    // Exclude live-mode smoke from the emulated runner so a misconfigured
    // local invocation (no API keys) doesn't surface confusing skipped tests
    // in the emulated suite's output.
    exclude: ['src/__tests__/comparative/**/*.live.comparative.test.ts'],
    // The agent-SDK subprocess cold-start + any retry-loop runtime needs
    // room. Phase 6.7 widens this to 120s so scenarios #13/#15 (mid-stream
    // 5xx + truncated stream) — which use a per-scenario `harnessTimeoutMs`
    // of 60s to give the Anthropic SDK's `invalid_request_error` retry loop
    // breathing room — still have headroom inside the test runner's own
    // wrapper. A real hang still surfaces here as a timeout rather than
    // letting CI burn its global timeout budget.
    testTimeout: 120_000,
    fileParallelism: false,
  },
});
