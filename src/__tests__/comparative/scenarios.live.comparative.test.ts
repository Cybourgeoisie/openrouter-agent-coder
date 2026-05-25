// Live-mode smoke driver for the comparative-parity harness (Phase 6.7).
//
// Filters the canonical scenario set to entries with `liveSmoke: true` and
// runs each against real provider endpoints. Skips the entire suite if either
// `OPENROUTER_API_KEY` or `ANTHROPIC_API_KEY` is absent — fork PRs and local
// dev environments without keys see "skipped", not red.
//
// Scope is deliberately narrow:
//   - Per-scenario `maxCostUsd` is honored by the harness's BudgetMonitor
//     (see `harness.ts:createBudgetMonitor`). On breach the harness aborts
//     and surfaces `costBreach: true` on the return; this driver records the
//     breach as a warning but does NOT fail the test (live runs are
//     best-effort; budget breach is a "refresh the scenario" signal, not a
//     merge blocker).
//   - The driver writes a per-scenario cost line to a JSONL artifact at
//     `tmp/comparative-live-cost-report.jsonl` so the workflow can:
//       (a) enforce the $0.25/PR aggregate cap,
//       (b) include the line items in the PR comment.
//   - This driver does NOT run the comparator's exact-mode event-stream
//     check — live runs have inherent nondeterminism that exact mode cannot
//     accommodate, and the tolerant-mode comparator is the v1 way to check
//     parity in live mode. v1 keeps it simple: verify the SDKs didn't throw
//     a harness-level failure (the comparator path) AND verify the cost
//     stayed under budget. A richer tolerant-mode comparator pass is the
//     next iteration (likely 6.8 when drift-detection lands).
//
// Why a separate file (vs. an env-flag inside `scenarios.comparative.test.ts`):
// the emulated and live drivers have structurally different assertion shapes
// (emulated: exact-mode comparator pass; live: no-throw + budget). Folding
// them into one file via a flag would mean every reader has to mentally
// re-derive which branches fire under which env. Two files keeps each
// driver's intent declarative.

import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runScenario } from './harness.js';
import { loadScenario } from './scenarios.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCENARIO_DIR = join(HERE, 'scenarios');

const COST_REPORT_PATH = join(
  process.env.COMPARATIVE_LIVE_COST_REPORT ?? join(process.cwd(), 'tmp'),
  'comparative-live-cost-report.jsonl',
);

const hasKeys =
  typeof process.env.ANTHROPIC_API_KEY === 'string' &&
  process.env.ANTHROPIC_API_KEY.length > 0 &&
  typeof process.env.OPENROUTER_API_KEY === 'string' &&
  process.env.OPENROUTER_API_KEY.length > 0;

// Discover liveSmoke scenarios at module load. We DON'T await loadScenario
// here (vitest collects describes synchronously); we use a simple sync read
// of the JSON file and a defensive check for the `liveSmoke` field. The
// per-scenario `loadScenario` inside each `it` block runs the real schema
// validation.
const smokeScenarios = readdirSync(SCENARIO_DIR)
  .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  .map((f) => ({ name: f.replace(/\.json$/, ''), path: join(SCENARIO_DIR, f) }))
  .filter(({ path }) => {
    try {
      const raw = readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw) as { liveSmoke?: boolean };
      return parsed.liveSmoke === true;
    } catch {
      return false;
    }
  })
  .sort((a, b) => a.name.localeCompare(b.name));

describe('comparative-live smoke', () => {
  beforeAll(async () => {
    // Reset the cost-report artifact so each run starts clean. The workflow
    // expects to read this file after the test command exits and aggregate
    // line items.
    await mkdir(dirname(COST_REPORT_PATH), { recursive: true });
    await writeFile(COST_REPORT_PATH, '', 'utf8');
  });

  afterAll(() => {
    // No teardown — the harness already cleans up its own emulator/SDK
    // resources per run, and the cost-report artifact is intentionally
    // preserved on disk for the workflow to ingest.
  });

  if (!hasKeys) {
    it.skip('skipped — set ANTHROPIC_API_KEY + OPENROUTER_API_KEY to run live smoke', () => {
      // Intentional no-op. Skip is the success path when keys are absent —
      // fork PRs and local dev without secrets see "skipped", not red.
    });
    return;
  }

  if (smokeScenarios.length === 0) {
    it.skip('skipped — no scenarios flagged with liveSmoke: true', () => {
      // Defensive: if someone removed `liveSmoke: true` from every scenario,
      // surface that as a skip rather than a silent zero-test pass.
    });
    return;
  }

  for (const { name, path } of smokeScenarios) {
    it(`${name} — runs live without harness-level throw, within budget`, async () => {
      const scenario = await loadScenario(path);
      const result = await runScenario(path, 'live');

      const anthropicCost = result.anthropicTranscript.costUsd ?? 0;
      const orCost = result.orTranscript.costUsd ?? 0;
      const totalCost = anthropicCost + orCost;

      // Append the per-scenario cost line to the workflow-facing artifact.
      // JSONL format — one record per line. The workflow's $0.25 aggregate
      // cap is computed from these lines after the test run completes.
      const line =
        JSON.stringify({
          scenario: name,
          anthropicCostUsd: anthropicCost,
          orCostUsd: orCost,
          totalCostUsd: totalCost,
          maxCostUsd: scenario.maxCostUsd ?? 0.5,
          costBreach: result.costBreach === true,
          anthropicThrew: result.anthropicTranscript.thrown !== undefined,
          orThrew: result.orTranscript.thrown !== undefined,
        }) + '\n';
      await appendFile(COST_REPORT_PATH, line, 'utf8');

      // Cost-breach surfaces as a console warning but NOT a test failure —
      // per the plan doc + issue body, live-mode budget breach is a
      // "flaky-scenario" signal, not a merge blocker. The workflow's
      // aggregate-cap check is the place where a breach triggers visible
      // CI behavior (yellow + PR comment).
      if (result.costBreach === true) {
        console.warn(
          `[live-smoke] ${name}: cost breach — total $${totalCost.toFixed(4)} exceeded cap $${(scenario.maxCostUsd ?? 0.5).toFixed(2)}`,
        );
      }

      // The cancellation scenario (#6) deliberately aborts both SDKs; the
      // throw IS the success signal. Match the emulated driver's
      // ignoreThrown/cancelling semantics by leaning on the scenario's
      // comparator config.
      const cancelling = scenario.comparator?.ignoreThrown === true;
      const tolerateInjection = scenario.comparator?.tolerateThrownInjection === true;
      if (!cancelling && !tolerateInjection) {
        expect(
          result.anthropicTranscript.thrown,
          `Anthropic side threw (live):\n${result.anthropicTranscript.thrown}`,
        ).toBeUndefined();
        expect(
          result.orTranscript.thrown,
          `OR side threw (live):\n${result.orTranscript.thrown}`,
        ).toBeUndefined();
      }
    });
  }
});
