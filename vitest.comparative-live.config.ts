// Comparative-parity LIVE-mode smoke config (Phase 6.7).
//
// Run with `npm run test:comparative:live`. Drives a curated subset of the
// canonical-16 scenario set against REAL provider endpoints
// (`@anthropic-ai/claude-agent-sdk` → api.anthropic.com,
//  `@openrouter/agent` → openrouter.ai). Requires `ANTHROPIC_API_KEY` +
// `OPENROUTER_API_KEY` in the environment. Driver skips cleanly if either
// is absent — does NOT silently fall back to emulated mode.
//
// Why a separate config from the emulated suite:
//   - The emulated runner's `exclude` keeps `*.live.comparative.test.ts` out
//     of the no-keys-needed PR gate.
//   - The live runner has a much wider `testTimeout` because real provider
//     calls + the SDK retry loop need room to breathe across a 4-scenario
//     subset.
//   - Splitting the configs makes the workflow's `npm run test:comparative:live`
//     invocation unambiguous in CI — there's no env-flag flip-floppery for a
//     workflow reviewer to verify.
//
// Budget guardrails are layered:
//   - Per-scenario `maxCostUsd` (defaults $0.50, scenario JSON override)
//     enforced inside the harness — see `runScenario`'s BudgetMonitor.
//   - Per-PR aggregate cap ($0.25) enforced at the WORKFLOW level — the
//     `comparative-parity-live-smoke.yml` job tallies costs across scenarios
//     via the COMPARATIVE_LIVE_COST_REPORT artifact and short-circuits on
//     breach.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/comparative/**/*.live.comparative.test.ts'],
    // Live runs hit real providers; allow generous headroom. Anthropic
    // multi-turn flows + a few SDK retries can push 60–90s easily on a slow
    // network or under provider-side latency spikes. 180s is the runner-level
    // ceiling; the harness's per-scenario `harnessTimeoutMs` is the
    // narrower-grained signal.
    testTimeout: 180_000,
    fileParallelism: false,
  },
});
