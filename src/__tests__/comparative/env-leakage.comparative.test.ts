// Env-leakage assertion (Phase 6.3).
//
// Load-bearing: the entire reason 6.S1 picked per-`query()` `Options.env`
// injection over parent-process env mutation is to keep `ANTHROPIC_BASE_URL`
// scoped to the spawned `claude` subprocess so it CANNOT leak into other
// vitest workers / sibling test files. This file asserts that contract holds.
//
// If a future contributor "simplifies" the harness to use
// `process.env.ANTHROPIC_BASE_URL = ...` at the parent level, this test
// should fail. Do not relax it without revisiting 6.S1.

import { describe, it, expect } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runScenario } from './harness.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SMOKE = join(HERE, 'scenarios', 'smoke-single-turn.json');

describe('harness env-leakage invariants', () => {
  it('does NOT mutate parent process.env.ANTHROPIC_BASE_URL across a run', async () => {
    const before = process.env.ANTHROPIC_BASE_URL;
    await runScenario(SMOKE, 'emulated');
    const after = process.env.ANTHROPIC_BASE_URL;
    // The before/after values must match exactly — neither set if previously
    // unset, nor changed if previously set to a fixed value (e.g. by a
    // sibling test or a shell export). This is the structural invariant from
    // 6.S1; per-`query()` `Options.env` injection is the only path that
    // upholds it.
    expect(after).toBe(before);
  });

  it('does NOT mutate parent process.env.ANTHROPIC_API_KEY across a run', async () => {
    const before = process.env.ANTHROPIC_API_KEY;
    await runScenario(SMOKE, 'emulated');
    const after = process.env.ANTHROPIC_API_KEY;
    expect(after).toBe(before);
  });
});
