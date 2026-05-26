## Summary

<!-- 1-3 bullets. What changed and why. Link the issue you're closing. -->

Closes #

## Test plan

- [ ] `npm run lint && npm run format:check && npm run build && npm test` — all green locally
- [ ] Coverage thresholds still hold (`npm run test:coverage` — see `vitest.config.ts` for the locked values)
- [ ] Comparative-parity suite still passes (`npm run test:comparative`) — if you touched anything under `src/` that the harness exercises
- [ ] Scenario added in `src/__tests__/comparative/scenarios/` (for user-facing changes; N/A for internal refactors / docs / tests)
- [ ] CHANGELOG.md updated (if user-facing)
- [ ] 5-grep invariants verified on non-test `src/`: no `process.env.*` reads, no `console.*`, no `process.exit`, no `process.stdin`; `process.cwd()` exactly once at `src/agent.ts:633`; no `bin` field in `package.json`

## Ambiguity calls taken

<!-- If the issue body authorized calls or you had to make new ones, list them with rationale. Otherwise delete this section. -->

## Notes

<!-- Anything reviewers should know that isn't in the diff: deferred follow-ups, runtime measurements, screenshots, ambiguity calls flagged for follow-up. Otherwise delete this section. -->
