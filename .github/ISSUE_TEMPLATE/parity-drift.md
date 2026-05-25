---
name: Parity drift (auto-filed)
about: Emulated PASS + live FAIL on the same scenario — the emulator script has drifted from real provider semantics.
title: '[parity-drift] <scenario-name> diverged on <date>'
labels: parity-drift
---

## What happened

The comparative-parity nightly workflow observed an **emulated PASS + live FAIL** divergence on one scenario. The emulator's scripted response no longer matches what the real provider returns for the same prompt — the canary the harness exists to catch.

Mechanically: the emulated suite passed the comparator at PR-time (and just re-passed in nightly), but the live suite running the same scenario against the real provider produced a failure (a harness-level throw, or a cost breach, or both). Without the emulator script being refreshed, the PR-time gate is now testing behavior that doesn't exist in production.

## Action

1. Re-run the failing scenario in live mode locally (`npm run test:comparative:live` with both API keys set).
2. Capture the live-mode transcript via the harness's `dumpOnFail` path.
3. Diff the live transcript against the scenario's `script[]` block — the divergence point is where the emulator needs to be updated.
4. Update the scenario JSON (or open a Phase 6.9 scenario-update PR).
5. Verify the refresh by re-running both suites: `npm run test:comparative && npm run test:comparative:live`.

## Auto-filed context

The nightly workflow fills the section below before submitting. If this section is empty, the issue was opened manually — please add the scenario name, workflow-run URL, and failure summary by hand.

<!-- AUTOFILL:START -->

- **Scenario:** _(autofilled)_
- **Workflow run:** _(autofilled)_
- **Failure summary:** _(autofilled)_
<!-- AUTOFILL:END -->
