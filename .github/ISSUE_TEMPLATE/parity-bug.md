---
name: Parity bug (auto-filed)
about: Emulated FAIL + live FAIL on the same scenario — the SDK plumbing or the scenario itself is broken.
title: '[parity-bug] <scenario-name> failing in both modes on <date>'
labels: parity-bug
---

## What happened

The comparative-parity nightly workflow observed an **emulated FAIL + live FAIL** double-failure on one scenario. Unlike `parity-drift` (which signals emulator staleness only), a both-modes failure means either the SDK behavior changed in a way the scenario doesn't tolerate, the harness has a bug, or the scenario itself encodes a contradiction.

Note: the PR gate already blocks on emulated failure, so this issue normally indicates a freshly merged regression OR a scenario authored against undocumented SDK behavior that subsequently changed.

## Action

1. Check `git log` for SDK or harness changes since the last green nightly run.
2. Run the scenario locally in both modes; capture transcripts.
3. Determine whether the scenario's expectations are still correct.
   - If the SDK regressed → fix the SDK or pin the version + open a follow-up.
   - If the scenario was wrong → update the scenario (or remove it from the canonical set if no longer meaningful).

## Auto-filed context

<!-- AUTOFILL:START -->

- **Scenario:** _(autofilled)_
- **Workflow run:** _(autofilled)_
- **Failure summary:** _(autofilled)_
<!-- AUTOFILL:END -->
