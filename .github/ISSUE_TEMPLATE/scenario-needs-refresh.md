---
name: Scenario needs refresh (auto-filed)
about: A scenario has failed >10% of nightly runs over the past 7 days — flake threshold breached, the script needs review.
title: '[scenario-needs-refresh] <scenario-name> exceeded 10% flake rate over 7 days'
labels: scenario-needs-refresh
---

## What happened

The comparative-parity nightly workflow observed that one scenario has failed in more than 10% of nightly runs over the past 7 days. This is the plan-doc's flake threshold for "the scenario itself has become unreliable" — either the prompt is non-deterministic enough that even the tolerant comparator can't accommodate it, or the script encodes assumptions that the real provider now violates intermittently.

Distinct from `parity-drift` (one-off divergence): this is a recurring statistical signal.

## Action

1. Read the workflow runs over the past week and look at the failure pattern.
2. Decide whether to:
   - Tighten the scenario (more specific prompt, narrower comparator tolerances).
   - Loosen the scenario (broader tolerances) — only if the original assertion is no longer load-bearing.
   - Retire the scenario from the live-nightly set (still keep in emulated).

## Auto-filed context

<!-- AUTOFILL:START -->

- **Scenario:** _(autofilled)_
- **Workflow run:** _(autofilled)_
- **Flake rate:** _(autofilled)_
- **Recent failures:** _(autofilled)_
<!-- AUTOFILL:END -->
