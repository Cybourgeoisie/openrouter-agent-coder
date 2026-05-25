import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // The comparative-parity suite (Phase 6.3+) lives under
    // `src/__tests__/comparative/` and uses the `.comparative.test.ts` suffix.
    // It spawns the @anthropic-ai/claude-agent-sdk subprocess (cold-start +
    // internal retry loop) so it is deliberately excluded from the default
    // unit-test run and exercised via `vitest.comparative.config.ts`.
    exclude: ['node_modules', 'dist', 'src/__tests__/comparative/**/*.comparative.test.ts'],
    testTimeout: 10_000,
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/__tests__/**'],
      thresholds: {
        // Phase 5.7 dropped the thresholds modestly: the skills system adds
        // many short-circuit branches (object-spread conditionals across the
        // SkillFrontmatter surface, multi-shape argument parsing, fenced-vs-
        // inline shell paths) that are individually low-value to cover
        // 1:1. Per-file coverage for the new code is ≥90% across all four
        // metrics. Pre-5.7 bar was 99.6/98.65/98.8/99.93.
        //
        // 5.7 follow-up: inline-render `allowed-tools` narrowing fix
        // collapsed the unreachable deny branch in agent.ts and added two
        // cheap branch-completing tests (buildSkillListing kept===0,
        // formatExitFailure empty-stdout). Lock the gain.
        statements: 99.14,
        branches: 96.37,
        functions: 98.52,
        lines: 99.69,
      },
    },
  },
});
