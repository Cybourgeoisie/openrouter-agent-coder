# Plan: Claude Agent SDK Parity Roadmap

> Forward-looking implementation plan for closing the remaining 36 non-Full parity gaps identified in [`claude-agent-sdk-parity.md`](./claude-agent-sdk-parity.md). Continues the phase sequence established by [`callboard-compatibility.md`](./callboard-compatibility.md): Phase 0 (tooling), Phase 1 (library refactor + coverage), Phase 2 (callboard adapter, deferred). **This plan defines Phase 3, Phase 4, and the Phase 5 spike list.**

Status: **Phase 0 + 1 complete; this roadmap carded 2026-05-22.** Phase 2 (callboard adapter) still deferred to the callboard repo. Phase 3 is the next active phase.

---

## Why this exists

After Phase 1, the library has the primitives (`canUseTool`, `onHook`, `signal`, `instructions`, `tools` arg, `accountInfo`/`supportedModels`) but lacks the named layers, discovery, and ergonomics that the Claude Agent SDK exposes on top of equivalent primitives. The parity matrix shows 10 Full / 11 Partial / 25 Missing across 46 rows. This roadmap turns that delta into actionable cards.

Most of the **Partial** rows are partial precisely because the primitive shipped in Phase 1 and only the layer-on-top is missing. Those are the quick wins. The hard items are clustered in three architectural questions that need spike-investigation before any commitment.

---

## Buckets

The 36 non-Full rows sort into four buckets:

- **Bucket A — Layer-on-top** (~50h, low risk). Primitive already shipped; we wrap it with config/discovery/named modes/ergonomics. → **Phase 3**
- **Bucket B — Net-new features** (~70h, moderate risk). Standalone implementations; each is a self-contained card or two. → **Phase 4**
- **Bucket C — Hard / contingent** (~50–120h, **high risk**). Requires upstream-SDK investigation first. → **Phase 5 (spike then build)**
- **Bucket D — Out of scope.** Skills, slash commands, plugins. These are Claude **Code** (CLI app) features, not Claude SDK API features. Host (callboard) owns equivalents. **Will not implement in this library.**

Bucket D rationale: the library is consumed by a host application. The host already has its own skills/commands/plugin systems (callboard's plugin architecture). Duplicating those at the library level would either fork from the host's behavior or shadow it. Closing those rows in the parity matrix should be marked **"out of scope — host responsibility"** rather than implemented.

---

## Phase 3 — Layer-on-top (~50h, 12 cards)

All builds-on items reference primitives already shipped. Most are independent and can be picked in any order subject to the sequencing rules at the bottom of this doc.

| Card     | Title                                                                                                                                                   | Builds on                      | Est.   | Depends on   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------ | ------------ |
| ~~3.1~~  | ~~Named permission modes (default/acceptEdits/bypassPermissions)~~ ([#65](https://github.com/Cybourgeoisie/openrouter-agent-coder/pull/65))             | ~~`canUseTool` (Phase 1.4)~~   | ~~4h~~ | ~~—~~        |
| ~~3.2~~  | ~~`allowedTools` / `disallowedTools` config syntax (`Bash(npm *)`)~~ (PR pending)                                                                       | ~~`canUseTool` + 3.1~~         | ~~3h~~ | ~~3.1~~      |
| ~~3.3~~  | ~~Plan mode (read-only tool filter)~~ ([#68](https://github.com/Cybourgeoisie/openrouter-agent-coder/pull/68))                                          | ~~`canUseTool` + 3.1~~         | ~~1h~~ | ~~3.1~~      |
| ~~3.4~~  | ~~CLAUDE.md / `.claude/` auto-discovery → `instructions`~~ (PR pending)                                                                                 | ~~`instructions` (Phase 1.5)~~ | ~~4h~~ | ~~—~~        |
| ~~3.5~~  | ~~`tool()` helper + Zod-schema convenience + SDK-MCP-shaped helper~~ (PR pending)                                                                       | ~~`tools` arg (Phase 1.2)~~    | ~~5h~~ | ~~—~~        |
| ~~3.6~~  | ~~Remaining lifecycle hooks: `Stop`, `Setup`, `Notification`~~ (PR pending)                                                                             | ~~`onHook` (Phase 1.7)~~       | ~~5h~~ | ~~—~~        |
| ~~3.7~~  | ~~Block-and-modify hook capability (`PreToolUse` can short-circuit)~~ (PR pending)                                                                      | ~~`onHook` + `canUseTool`~~    | ~~6h~~ | ~~3.1, 3.2~~ |
| ~~3.8~~  | ~~Rich message stream (typed `AssistantMessage` etc.)~~ (PR pending)                                                                                    | ~~`AgentCoreEvent`~~           | ~~6h~~ | ~~—~~        |
| ~~3.9~~  | ~~Enhanced Bash: description field, configurable timeout~~ (PR pending)                                                                                 | ~~`run_command`~~              | ~~2h~~ | ~~—~~        |
| ~~3.10~~ | ~~Enhanced Grep: `-A`/`-B`/`-C`, filetype filters, output modes~~ (PR pending [#49](https://github.com/Cybourgeoisie/openrouter-agent-coder/issues/49)) | ~~`grep_files`~~               | ~~4h~~ | ~~—~~        |
| ~~3.11~~ | ~~Glob tool (new, separate from `list_directory`)~~ (PR pending [#50](https://github.com/Cybourgeoisie/openrouter-agent-coder/issues/50))               | ~~_new_~~                      | ~~3h~~ | ~~—~~        |
| ~~3.12~~ | ~~`persistSession: false` (in-memory only sessions)~~ (PR pending [#51](https://github.com/Cybourgeoisie/openrouter-agent-coder/issues/51))             | ~~`FileStateAccessor`~~        | ~~3h~~ | ~~—~~        |

**Phase 3 total:** ~50h.

**Initial Ready state on the project board** (no prereqs within Phase 3): 3.1, 3.4, 3.5, 3.6, 3.8, 3.9, 3.10, 3.11, 3.12 (9 cards). **Backlog until prereq lands:** ~~3.2~~ (now Done), ~~3.3~~ (now Done), ~~3.4~~ (now Done), ~~3.5~~ (now Done), ~~3.6~~ (now Done), ~~3.7~~ (now Done), ~~3.11~~ (now Done).

---

## Phase 4 — Net-new features (~70h, 9 cards)

Each is a self-contained implementation. Sequencing matters only within the subagent sub-tree (4.7 → 4.8/4.9). All other cards are independent.

| Card    | Title                                                                                                        | Est.    | Risk                 | Depends on |
| ------- | ------------------------------------------------------------------------------------------------------------ | ------- | -------------------- | ---------- |
| ~~4.1~~ | ~~AskUserQuestion tool~~ ([#52](https://github.com/Cybourgeoisie/openrouter-agent-coder/issues/52))          | ~~4h~~  | ~~host-UI contract~~ | ~~—~~      |
| ~~4.2~~ | ~~TaskCreate / TaskUpdate tools~~ ([#53](https://github.com/Cybourgeoisie/openrouter-agent-coder/issues/53)) | ~~8h~~  | ~~host-UI contract~~ | ~~—~~      |
| ~~4.3~~ | ~~NotebookEdit tool~~ ([#54](https://github.com/Cybourgeoisie/openrouter-agent-coder/issues/54))             | ~~10h~~ | ~~low~~              | ~~—~~      |
| 4.4     | Monitor tool (background-script watch)                                                                       | 10h     | low                  | —          |
| 4.5     | Session forking                                                                                              | 8h      | low                  | —          |
| 4.6     | File checkpointing                                                                                           | 12h     | moderate             | —          |
| 4.7     | Subagent system — basic, sequential                                                                          | 15h     | moderate             | —          |
| 4.8     | Subagent tool / model / effort overrides                                                                     | 5h      | moderate             | 4.7        |
| 4.9     | Parallel subagent execution                                                                                  | 7h      | moderate             | 4.7        |

**Phase 4 total:** ~70h (estimate; 4.7 is the largest single card and most likely to slip).

**Initial Ready state:** none — Phase 4 cards stay **Backlog** until Phase 3 substantially complete (mirroring the Phase 0 → Phase 1 gate from `callboard-compatibility.md`). Once Phase 3 is ≥80% Done, promote the independent Phase 4 cards (4.1–4.7) to Ready.

**Cards involving host-UI contracts (4.1, 4.2):** before implementation, agree on the event/payload shape the host expects. Both tools surface a request that callboard must render and respond to; the library can't unilaterally define that protocol. Document the contract in the issue body before opening the implementation PR.

**`ToolSearch` deferred.** Originally Bucket B item B5 — it depends on having an MCP server with many tools to search across, which is itself Bucket C (Phase 5). Carded as a Phase 5 follow-on, not Phase 4.

---

## Phase 5 — Hard / contingent (spike before commit)

Three architectural items need investigation before we can responsibly size them. Each spike is a small standalone card (1–2h of research + a short write-up), and answers a yes/no question that determines whether the full feature is doable, blocked, or expensive.

| Spike | Question                                                                                              | If yes (build est.)                                                               | If blocked                                                  |
| ----- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 5.S1  | Does `@openrouter/agent` expose the message history (vs only `previousResponseId`)?                   | ~~15–25h~~ **12–18h** compaction ([spike](./spikes/5.S1-message-history.md): Yes) | File upstream issue, defer.                                 |
| 5.S2  | Does `@openrouter/agent` `callModel` accept mid-call message injection for streaming-input semantics? | 10–20h streaming                                                                  | Document gap; consider host-driven multi-prompt workaround. |
| 5.S3  | Does OR's API accept an `effort` / reasoning-depth parameter?                                         | ~5h passthrough                                                                   | Mark Missing permanently.                                   |

**Full build-out items (gated on the spikes):**

| Card | Title                                 | Est.   | Notes                                                                                                                                                                                    |
| ---- | ------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5.1  | Context compaction (post-5.S1)        | 12–18h | History exposure confirmed via `ConversationState.messages` ([spike 5.S1](./spikes/5.S1-message-history.md)). Token counting via char-length heuristic for v1; includes PreCompact hook. |
| 5.2  | MCP server support (stdio + HTTP/SSE) | 30–50h | Full MCP-client implementation + `.mcp.json` config + tool-bridge. **Biggest single item in the entire roadmap.**                                                                        |
| 5.3  | Streaming input mode (post-5.S2)      | 10–20h | Mid-call message injection, image attachments, interrupts.                                                                                                                               |
| 5.4  | Effort / reasoning level (post-5.S3)  | ~5h    | Passthrough if upstream supports.                                                                                                                                                        |
| 5.5  | `ToolSearch` (post-5.2)               | 8h     | Dynamic tool loading from large MCP tool sets; needs 5.2 first.                                                                                                                          |

**Phase 5 total:** ~50–120h depending on spike outcomes.

---

## Out of scope (Bucket D)

| Row in matrix  | Recommendation                                                  |
| -------------- | --------------------------------------------------------------- |
| Skills system  | Host responsibility. Callboard has its own skill plugin system. |
| Slash commands | Host responsibility. Callboard has its own command system.      |
| Plugins        | Host responsibility. Callboard has its own plugin architecture. |

These three rows should be marked **"Out of scope — host responsibility"** in the parity matrix and excluded from the Missing total. Updating the matrix is a small follow-up card (call it 3.0 or do it as part of 3.4's CLAUDE.md PR since they touch related territory).

---

## Workflow & gates

Carrying forward the patterns established in `callboard-compatibility.md`:

### Fast-track merge

This project remains **fast-tracked**. Every Phase 3 / 4 / 5 PR may be reviewed-and-merged by the assigned coder agent / Claude session, provided all gates hold:

- Reviewer-agent verdict clean (or direct review-pass with `gh pr diff` + code-trace)
- CI green (`statusCheckRollup` SUCCESS) AND `mergeStateStatus: CLEAN` AND `mergeable: MERGEABLE`
- PR scope matches the issue (no surprise files outside the declared scope)
- Final independent diff scan by the merger
- **All hard invariants hold** (see below)

If any gate fails or uncertainty exists on any axis, leave for Ben.

### Hard invariants (verified at every merge)

Grep-clean in non-test `src/`:

- No `process.env` reads (constructor-default reads are OK; see Phase 1.5).
- No `console.*` calls.
- No `process.exit` / `process.stdin` / `readline` usage.
- `bin` field absent from `package.json`.
- `process.cwd` usage: 1 occurrence (`src/agent.ts:154`). Cards adding a new tool may need to negotiate this; in general, prefer `ctx.cwd` over `process.cwd()`.
- `git diff main -- src/ ':!**/*.test.ts' ':!src/__tests__/**'` shows exactly the production changes declared in the PR body.

### Coverage gate

**Coverage thresholds stay at `96 / 92 / 94 / 98` minimum.** Each card has a per-card expectation:

- **Tool-adds and pure-feature cards (most of Phase 3 + 4):** ratchet at least one axis by ≥0.5pp. New code must be tested at least to the gate floor (no carve-outs).
- **Refactor cards (e.g., 3.7 block-and-modify hooks):** must not regress any axis. New tests should match line-for-line the new code paths.
- **Infrastructure cards (e.g., 3.12 persistSession, 4.5 session forking):** preserve gate; ratchet if natural.

If a card would regress coverage, the PR body must explicitly identify which lines are uncovered and why (defensive paths, race-flaky, etc.) — same convention as Phase 1.14's coverage panel.

### Testing patterns

Established patterns to reuse:

- **FS error fallback coverage** — `chmod 000` with `finally` restore (see `src/state/file-state.test.ts:283` and `src/tools/grep-files.test.ts:246`). Skip on `process.getuid?.() === 0` and `win32`.
- **Integration tests** — fixture-driven via `src/__tests__/integration/mock-openrouter.ts`. Add a new fixture JSON for any new event-flow scenario; extend the mock's `FixtureStep` shape if needed (see Phase 1.15's `sdkOmitsCallId` extension).
- **API helper tests** — recorded fixtures under `src/__tests__/fixtures/openrouter-api/`. Wrong-type and 401/403 paths are first-class test scenarios.
- **Tool tests** — colocated `src/tools/<name>.test.ts`. Each new tool ships with its own test file.

### Reference implementations (use freely for inspiration)

When stuck on a design call or implementation detail, implementing agents are explicitly authorized to consult the following open-source reference implementations. Pattern-match what they do; don't blindly copy.

- **Claude Code source** — Anthropic open-sourced parts of Claude Code. The Agent SDK shape (`tool()`, hooks, permission modes, message-stream types) is the authoritative parity target. Check both their public SDK examples and any internal reference shipped in their open release.
- **opencode** ([sst/opencode](https://github.com/sst/opencode)) — community-built Claude-Code-alike with its own takes on subagents, MCP integration, and the tool ergonomics layer. Particularly useful for Cards 3.5 (`tool()` helper), 4.7 (subagent system), and 5.2 (MCP server support).
- **codex** ([openai/codex](https://github.com/openai/codex)) — OpenAI's open-source CLI. Shares the same problem space (agent loop, tool ergonomics, session persistence) under a different SDK. Useful for cross-checking design calls that aren't Anthropic-specific.

**When to consult them:**

- A Claude SDK feature's behavior is ambiguous from docs alone → check Claude Code source first.
- Stuck on `tool()` / MCP / subagent shape → cross-reference opencode's approach.
- Cross-vendor design pattern (file checkpointing, session forking, message streams) → check both opencode and codex for convergent patterns.

**What to avoid:**

- Copy-pasting code wholesale — license-mix risk. Read for ideas; write fresh implementations.
- Adopting a divergent design just because a reference uses it — the Claude SDK shape is the parity target; deviating needs a justified reason.
- Skipping the spike doc for Phase 5 items just because you saw how opencode/codex did it. The spike is a contract record that the build estimate has a basis.

### README + docs maintenance

Every user-facing card must include a documentation update in the same PR:

1. **README.md** — update constructor-options table, event-type table, tool table, or examples as needed.
2. **`plans/claude-agent-sdk-parity.md`** — update the matrix row for the feature being landed (`None`/`Partial` → `Full`, or refine description).
3. **This roadmap (`claude-sdk-parity-roadmap.md`)** — strike through the card row with PR number, matching the convention used in `callboard-compatibility.md` Phase 1.11–1.15 subsection.
4. **`CHANGELOG.md`** — _none exists yet. Recommend introducing one as part of Phase 3.5 (the `tool()` helper card) since that's the first net-new public-API surface._

---

## Sequencing rules

The plan's phases have hard dependencies. Don't pull a Ready card whose prerequisite isn't Done.

- **Phase 3 → Phase 4**: Phase 4 doesn't formally require Phase 3 complete, but to keep the surface stable while ergonomic layers land, Phase 4 cards stay Backlog until Phase 3 is ≥80% Done.
- **Within Phase 3**: see the per-card `Depends on` column above.
- **Within Phase 4**: 4.8 / 4.9 depend on 4.7.
- **Phase 5 spikes (5.S1, 5.S2, 5.S3)**: can run any time, in parallel with Phase 3 / 4 work, since they're investigation-only.
- **Phase 5 builds (5.1–5.5)**: gated on their corresponding spike + any cross-phase deps (5.5 ToolSearch depends on 5.2 MCP).

**One in-flight coder session per repo at a time.** Same rule as Phase 1. When a card moves to Done, scan Backlog for the next unblocked card and move it to Ready.

---

## Total roadmap estimate

| Phase              | Effort (est.) | Status                                                     |
| ------------------ | ------------- | ---------------------------------------------------------- |
| Phase 3            | ~50h          | Carded; ready to start.                                    |
| Phase 4            | ~70h          | Carded; blocked on Phase 3 ≥80%.                           |
| Phase 5            | ~50–120h      | Spikes carded; build-out cards gated on spike outcomes.    |
| Bucket D           | _0h_          | Out of scope.                                              |
| **Total in-scope** | **~170–240h** | ~4–6 weeks full-time (likely 2 months calendar with slip). |

With ~30% slip and integration cost, plan for a **two-month effort** to reach Full parity on the in-scope rows. Bucket D rows close as "Out of scope — host responsibility."

---

## Companion docs

- [`claude-agent-sdk-parity.md`](./claude-agent-sdk-parity.md) — the parity matrix this roadmap closes.
- [`callboard-compatibility.md`](./callboard-compatibility.md) — Phase 0/1/2 plan, fast-track gate conventions, hard invariants.
- The project board (https://github.com/users/cybilresistance/projects/1) — live status. Cards are sourced from this roadmap.
