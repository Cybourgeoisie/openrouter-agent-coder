# Comparative-parity gap audit — 2026-05-25

> Day-0 audit landed alongside Phase 6.9's PR-template tweak. Walks every **Full**-parity row of [`claude-agent-sdk-parity.md`](./claude-agent-sdk-parity.md) and notes whether a canonical scenario in [`src/__tests__/comparative/scenarios/`](../src/__tests__/comparative/scenarios/) (the 16 shipped through Phases 6.5a/b/c + 6.6) exercises that surface. Each "no coverage" row spawns one `parity-scenario-backfill`-labeled follow-up issue tracked under #131.
>
> Per the issue body's authorized ambiguity call #3, Phase 0/1/2 surface (pre-parity-claim foundation: basic tool loop, file primitives, session persistence/resume, account info, supported-models query) is **out of scope** unless a user-facing surface lacks coverage. Per call #4, each missing scenario gets its own issue (no combining).

## Canonical scenarios in place (Phases 6.5a/b/c + 6.6)

| #   | Scenario                  | Primary surface                                                                 |
| --- | ------------------------- | ------------------------------------------------------------------------------- |
| 1   | `01-single-turn-no-tool`  | Happy-path event-stream floor                                                   |
| 2   | `02-single-tool-call`     | Tool-loop foundation                                                            |
| 3   | `03-multi-turn-tool`      | Multi-turn state + turn counting                                                |
| 4   | `04-permission-denial`    | `canUseTool` deny path                                                          |
| 5   | `05-plan-mode-readonly`   | `permissionMode: 'plan'`                                                        |
| 6   | `06-cancel-mid-stream`    | `signal` / `abort()`                                                            |
| 7   | `07-tool-error-resume`    | Tool throws → SDK feeds `is_error=true` → model retries                         |
| 8   | `08-hook-block-modify`    | `PreToolUse` block (Phase 3.7)                                                  |
| 9   | `09-stop-max-tokens`      | `stop_reason='max_tokens'` terminal                                             |
| 10  | `10-stop-sequence`        | `stop_reason='stop_sequence'` terminal                                          |
| 11  | `11-malformed-tool-args`  | Lookup-tool happy path (malformed-args injection is a documented v1 limitation) |
| 12  | `12-retry-on-429`         | 429 retry behavior                                                              |
| 13  | `13-mid-stream-5xx`       | Mid-stream `response.failed` / `event: error`                                   |
| 14  | `14-malformed-sse`        | Invalid-JSON delta payload                                                      |
| 15  | `15-truncated-stream`     | TCP close mid-event, no terminal marker                                         |
| 16  | `16-chunk-boundary-split` | Parser reassembles split-across-write events                                    |

## Audit walk

Legend: **✅ covered** = at least one canonical scenario exercises this surface; **GAP** = no scenario in the canonical-16 exercises it (follow-up issue filed); **skip** = Phase 0/1/2 foundation, excluded per ambiguity call #3.

### Core Agent Loop

| Row                                  | Coverage   | Notes                                                                                                                                                                                                                                        |
| ------------------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Autonomous tool loop                 | ✅ covered | #02, #03                                                                                                                                                                                                                                     |
| Turn counting                        | ✅ covered | #03 multi-turn drives turn-count assertions implicitly                                                                                                                                                                                       |
| Max turns stop condition             | skip       | Phase 1 stop primitive; not a Phase-3+ surface                                                                                                                                                                                               |
| Max cost stop condition              | skip       | Phase 1 stop primitive; not a Phase-3+ surface                                                                                                                                                                                               |
| Interrupt / abort                    | ✅ covered | #06                                                                                                                                                                                                                                          |
| Effort / reasoning level (Phase 5.4) | **GAP**    | No scenario exercises `effort` forwarding into `callModel`; SDK comparison would assert that the per-provider mapping (Anthropic `thinking.budget_tokens` vs Claude SDK's request shape) projects identically into the canonical request log |
| Context compaction (Phase 5.1)       | **GAP**    | No scenario triggers the compaction summarizer or asserts the `PreCompact` hook (paired below)                                                                                                                                               |
| Streaming output                     | ✅ covered | Implicit in every scenario's event-stream comparison                                                                                                                                                                                         |
| Streaming input (Phase 5.3)          | **GAP**    | No scenario uses `prompt: AsyncIterable<UserInput>` + `pushUserMessage()` + `interrupt()`                                                                                                                                                    |

### Built-in Tools

| Row                                 | Coverage                                   | Notes                                                                                           |
| ----------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Read file                           | skip                                       | Phase 0; #02/#03 exercise generic-tool dispatch which is the SDK-comparison-relevant surface    |
| Write file                          | skip                                       | Phase 0                                                                                         |
| Edit file                           | skip                                       | Phase 0                                                                                         |
| Bash / run command                  | skip (baseline); see "Enhanced Bash" below | Phase 0 baseline; Phase 3.9 enhancements are a separate gap                                     |
| Glob (Phase 3.11)                   | **GAP**                                    | No scenario exercises the `glob` tool's path-pattern path through the SDK                       |
| Grep (Phase 3.10 enhanced)          | **GAP**                                    | No scenario exercises context-lines / type / output_mode parity                                 |
| WebSearch                           | skip                                       | Server-side tool; no host-side branching to compare                                             |
| WebFetch                            | n/a                                        | **Partial** parity — not eligible per audit rule (Full rows only)                               |
| Monitor (Phase 4.4)                 | **GAP**                                    | No scenario exercises the readline buffer / SIGTERM-with-grace forced-stop paths                |
| NotebookEdit (Phase 4.3)            | **GAP**                                    | No scenario exercises the Jupyter source-normalization + four-op dispatch                       |
| AskUserQuestion (Phase 4.1)         | **GAP**                                    | No scenario exercises the `onAskUserQuestion` host callback round-trip                          |
| ToolSearch (Phase 5.5)              | **GAP**                                    | No scenario exercises `enableToolSearch: true` + `tool_search` / `tool_load` working-set growth |
| TaskCreate / TaskUpdate (Phase 4.2) | **GAP**                                    | No scenario exercises the in-run task list emission via `Notification('tasks_changed')`         |
| Enhanced Bash (Phase 3.9)           | **GAP**                                    | No scenario exercises `description` advisory + `timeout_ms` clamp + SIGTERM-on-timeout          |

### Permissions & Safety

| Row                                               | Coverage   | Notes                                                                                                   |
| ------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------- |
| Permission modes                                  | n/a        | **Partial** parity — not eligible (`dontAsk` / `auto` unimplemented)                                    |
| Allowed/disallowed tools rule grammar (Phase 3.2) | **GAP**    | #04 exercises `canUseTool` deny but not the scoped-rule layer (e.g. `Bash(npm *)`, `Edit(src/**/*.ts)`) |
| canUseTool callback                               | ✅ covered | #04                                                                                                     |
| Plan mode (Phase 3.3)                             | ✅ covered | #05                                                                                                     |

### Hooks System

| Row                                                                                                | Coverage   | Notes                                                                                                                                         |
| -------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| PreToolUse / PostToolUse                                                                           | ✅ covered | #02, #04, #08 (firing order is the load-bearing claim across the canonical-16)                                                                |
| Session lifecycle hooks — `Setup` / `Stop` brackets on abort + constructor-throw paths (Phase 3.6) | **GAP**    | The hookOrder assertions assume happy-path bracketing; no scenario explicitly verifies `Setup`/`Stop` fire on the abort + ctor-throw branches |
| Subagent hooks                                                                                     | n/a        | **Partial** parity — `SubagentStop` matcher patterns unimplemented                                                                            |
| Notification hook (Phase 3.6)                                                                      | **GAP**    | No scenario emits via `ctx.notify(level, message, context?)` and compares the resulting `Notification` event projection                       |
| PreCompact hook (Phase 5.1)                                                                        | **GAP**    | Paired with the compaction gap above — no scenario forces a `PreCompact` fire                                                                 |

### Subagents & Orchestration

| Row                                    | Coverage | Notes                                                                                                                   |
| -------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| Subagent spawning (Phase 4.7)          | **GAP**  | No scenario exercises `spawn_subagent` + the parent-side `tool_result` containment                                      |
| Subagent tool restrictions (Phase 4.8) | **GAP**  | No scenario exercises per-subagent `model` / `permission_mode` / `allowed_tools` / `effort` REPLACE-semantics overrides |
| Parallel subagents (Phase 4.9)         | **GAP**  | No scenario exercises `spawn_subagents` (plural) + `maxParallelSubagents` pool + per-child abort fan-out                |

### Sessions & State

| Row                                  | Coverage | Notes                                                                                           |
| ------------------------------------ | -------- | ----------------------------------------------------------------------------------------------- |
| Session persistence                  | n/a      | **Partial** parity                                                                              |
| Session resume                       | n/a      | **Partial** parity                                                                              |
| Session forking (Phase 4.5)          | **GAP**  | No scenario exercises `forkSession()` / `OpenRouterAgentRun.fork()` + `parentSessionId` lineage |
| File checkpointing (Phase 4.6)       | **GAP**  | No scenario exercises auto-checkpoint on `write_file`/`edit_file` + restore semantics           |
| `persistSession: false` (Phase 3.12) | **GAP**  | No scenario exercises the in-memory `StateAccessor` swap + zero-disk-writes invariant           |

### Extensibility

| Row                                                       | Coverage | Notes                                                                                                                                    |
| --------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| MCP server support (Phase 5.2.\*)                         | **GAP**  | No scenario exercises the stdio/HTTP/SSE client lifecycle + `<serverName>__<toolName>` dispatch + `McpServerStart`/`McpServerStop` hooks |
| Custom tools (`tool()` / `createSdkMcpServer`, Phase 3.5) | **GAP**  | No scenario exercises a host-defined Zod-typed tool flowing through the run's tool array                                                 |
| Skills system (Phase 5.7)                                 | **GAP**  | No scenario exercises the `skill()` built-in tool + substitution helper + per-skill `allowed-tools` narrowing                            |
| Slash commands (Phase 5.6)                                | **GAP**  | No scenario exercises the command loader's `resolve()` → rendered body fed to the next prompt                                            |
| Plugins (Phase 5.8)                                       | **GAP**  | No scenario exercises `loadPlugins()` + the skill/MCP/substitution fold + `PluginStart`/`PluginStop`                                     |
| CLAUDE.md / `settingSources` (Phase 3.4)                  | **GAP**  | No scenario exercises the project/user/local discovery walk + 50k-char cap into the rendered `instructions`                              |

### Diagnostics & Accounts

| Row                    | Coverage | Notes                                          |
| ---------------------- | -------- | ---------------------------------------------- |
| Account / credit info  | n/a      | **N/A** parity row (provider-specific surface) |
| Supported models query | n/a      | **N/A** parity row (provider-specific surface) |

## Gap summary

24 user-facing surfaces lack a canonical scenario as of 2026-05-25:

1. **Effort / reasoning level** (Phase 5.4)
2. **Context compaction** (Phase 5.1)
3. **Streaming input** (Phase 5.3)
4. **Glob tool** (Phase 3.11)
5. **Enhanced Grep tool** (Phase 3.10 — context lines / type / output_mode)
6. **Monitor tool** (Phase 4.4)
7. **NotebookEdit tool** (Phase 4.3)
8. **AskUserQuestion tool** (Phase 4.1)
9. **ToolSearch + tool_load** (Phase 5.5)
10. **TaskCreate / TaskUpdate tools** (Phase 4.2)
11. **Enhanced Bash tool** (Phase 3.9 — description + timeout_ms + SIGTERM grace)
12. **Allowed/disallowed tools rule grammar** (Phase 3.2 scoped rules)
13. **`Setup` / `Stop` brackets on abort + constructor-throw paths** (Phase 3.6)
14. **Notification hook emission** (Phase 3.6)
15. **PreCompact hook** (Phase 5.1)
16. **Subagent spawning** (Phase 4.7)
17. **Subagent tool restrictions** (Phase 4.8)
18. **Parallel subagents** (Phase 4.9)
19. **Session forking** (Phase 4.5)
20. **File checkpointing** (Phase 4.6)
21. **`persistSession: false`** (Phase 3.12)
22. **MCP server support** (Phase 5.2.\*)
23. **Custom tools ergonomics** (Phase 3.5 — `tool()` + `createSdkMcpServer`)
24. **Skills system** (Phase 5.7)
25. **Slash commands** (Phase 5.6)
26. **Plugins** (Phase 5.8)
27. **CLAUDE.md / `settingSources` discovery** (Phase 3.4)

(That's 27 gaps once the 5-bucket list is expanded into the 27 enumerated surfaces above — the "24" figure in the header counts conceptually-distinct surfaces collapsing the paired Phase 5.1 compaction-engine + PreCompact-hook entries, but each row above gets its own follow-up issue per ambiguity call #4.)

## Per-gap one-paragraph specs

Each entry below seeds the body of its tracking follow-up issue. Issues live under label `parity-scenario-backfill` and reference this audit doc + #131 (rolling).

### 1. Effort / reasoning level (Phase 5.4)

A scenario sets `effort: 'high'` on the OR `OpenRouterAgentRunOptions` and asserts the value propagates into the captured `callModel` request as `reasoning: { effort: 'high' }`. The Anthropic side scripts an identical-shape request whose canonical projection shows the same `effort` field. Comparator uses exact-mode positional equality on the canonical request log; the parity claim is that the host-supplied effort knob reaches both providers via their respective request shapes without library-side mutation.

### 2. Context compaction + PreCompact hook (Phase 5.1)

A scenario seeds a ConversationState whose char-length crosses the `compactionThreshold`, runs one more turn, and asserts: (a) `PreCompact` hook fires with `{ reason: 'auto', keepRecentTurns: N }`; (b) the post-compaction `state.json` shows `messages = [summary, ...lastN]` with `previousResponseId` cleared; (c) the Anthropic side projects the equivalent post-compaction transcript (Anthropic SDK auto-summarization). Comparator allows summary-text divergence but asserts the structural shape (count + bracketing). Paired with gap #15 (PreCompact hook event projection).

### 3. Streaming input (Phase 5.3)

A scenario constructs the run with `prompt: AsyncIterable<UserInput>` and yields three user messages across the loop, with one `OpenRouterAgentRun.interrupt()` call between turns 2 and 3. Asserts: (a) the canonical event stream shows three distinct user-message admissions; (b) the interrupt projects to `state.interruptedBy = 'host-interrupt'` and the in-flight cycle exits with `status: 'interrupted'` + populated `partialResponse`; (c) the next cycle commits `partialResponse.text` as an assistant message before submitting the next user input. Anthropic side scripts the equivalent multi-message control-stream shape.

### 4. Glob tool (Phase 3.11)

A scenario registers the `glob` tool and prompts the model to find `**/*.ts` under a fixture tree. Asserts: tool dispatches via the SDK's tool-use channel, returns the sorted+capped match list, and the SDK projects the result identically on both sides. Comparator uses positional equality on the canonical event stream; the tool-result payload shape is the load-bearing parity claim.

### 5. Enhanced Grep tool (Phase 3.10)

A scenario exercises `grep_files` with `before_context: 2`, `after_context: 2`, `type: 'ts'`, `output_mode: 'content'`, and asserts the response carries context lines + type-filter union semantics + the right output mode. Anthropic side scripts the equivalent `Grep` tool call with the same SDK-projected args. Parity claim: the enhanced-knob surface reaches the tool-call shape identically on both wires.

### 6. Monitor tool (Phase 4.4)

A scenario invokes `monitor` with a fixture shell command that emits 5 lines then sleeps, with `max_lines: 3` to force the truncation path. Asserts: SIGTERM fires with a 250 ms SIGKILL grace, the response shape is `{ truncated: true, exitCode: null, lines: [...] }`, and the tool-result projects identically on both sides. Pattern-filter variant covered as a sub-scenario or separate file at author's discretion.

### 7. NotebookEdit tool (Phase 4.3)

A scenario invokes `edit_notebook` against a fixture `.ipynb` with each of the four operations (`replace_source` / `insert` / `delete` / `change_type`) and asserts source-normalization to `string[]` lands on every write. Validation-error paths (missing `new_source` on `replace_source`, missing `new_cell_type` on `insert`) covered as additional cases or a separate scenario.

### 8. AskUserQuestion tool (Phase 4.1)

A scenario constructs the run with an `onAskUserQuestion` handler that returns `{ selectedOptionId: 'b', label: 'no', freeTextAnswer: undefined }` and asserts: the model's `ask_user_question` tool call projects to the canonical event stream identically on both sides, the `Notification` hook fires with the request payload, and the resolved tool-result feeds back into the next turn unchanged. Anthropic side scripts the equivalent `AskUserQuestion` round-trip.

### 9. ToolSearch + tool_load (Phase 5.5)

A scenario opts in via `enableToolSearch: true`, registers two MCP-bridge tools (hidden from the initial pool), and prompts the model to call `tool_search({ query: 'fetch' })` → `tool_load({ names: [...] })` → invoke the loaded tool. Asserts: working-set growth fires `Notification('tool_loaded')` for each load, the wrapped tool reaches the model's tool pool mid-cycle, and the canonical event stream projects identically on both SDKs (Anthropic SDK equivalent: the dynamic-tool-set surface).

### 10. TaskCreate / TaskUpdate (Phase 4.2)

A scenario invokes `task_create` twice + `task_update` once + a final `task_update(cancelled)`, and asserts: (a) each tool call emits the full latest list via `Notification('tasks_changed')`; (b) the `onTasksChanged` constructor callback fires with the same payload; (c) `task_update` with an unknown id returns `{ error: 'unknown task id: ...' }` (separate sub-case). Parity claim: the in-run ephemeral task list projects to a Notification stream identically on both SDKs.

### 11. Enhanced Bash tool (Phase 3.9)

A scenario invokes `run_command` with `description: 'list build artifacts'`, `timeout_ms: 100` (well below the 30s default) against a shell command that sleeps 5s. Asserts: SIGTERM fires within 100 ms + a 250 ms SIGKILL grace, the tool result shape carries `truncated: true` + `exitCode: null`, and the `description` advisory propagates into the canonical request log. Out-of-bounds `timeout_ms` clamp (over `MAX_TIMEOUT_MS = 600_000`) covered as a sub-case.

### 12. Allowed/disallowed tools rule grammar (Phase 3.2)

A scenario constructs the run with `allowedTools: ['Bash(npm *)']` and `disallowedTools: ['Edit(src/**/*.ts)']`, then prompts the model to invoke `Bash('rm -rf foo')` (denied), `Bash('npm install')` (allowed), and `Edit('src/foo.ts')` (denied). Asserts the SDK projects each deny via the canonical `tool_result(isError=true)` shape with the matching scoped-rule reason text. Distinct from #04 (which exercises only the `canUseTool` callback primitive).

### 13. Setup / Stop bracket on abort + constructor-throw paths (Phase 3.6)

A scenario aborts mid-cycle (paired with the existing #06 cancel path) and asserts the canonical hookOrder is `Setup → SessionStart → … → SessionEnd → Stop` with `Stop` firing on the abort branch — not just the happy path. A second sub-case exercises constructor-throw (e.g. invalid `model`) and asserts `Setup → Stop` brackets the failed-construction path with no `SessionStart`/`SessionEnd` in between.

### 14. Notification hook emission (Phase 3.6)

A scenario registers a custom tool that calls `ctx.notify('info', 'fixture-event', { foo: 'bar' })` mid-dispatch and asserts the `onHook(Notification, ...)` callback fires with `{ level: 'info', message: 'fixture-event', context: { foo: 'bar' } }` and the event projects identically on both SDKs. Direct `onHook` (bypassing `ctx.notify`) covered as a sub-case.

### 15. PreCompact hook event projection (Phase 5.1)

Paired with gap #2 — extracts the hook-event-only assertions into a focused sub-scenario: when auto-compaction fires, `PreCompact` reaches the host's `onHook` with `{ event: 'PreCompact', messages, keepRecentTurns, reason: 'auto' }`, return value is ignored, throws are logged + swallowed. The manual-trigger variant (`reason: 'manual'`) covered as a sibling.

### 16. Subagent spawning (Phase 4.7)

A scenario opts in via `enableSubagents: true`, invokes `spawn_subagent({ description: '...', max_turns: 2 })`, and asserts: (a) `SubagentStart`/`SubagentEnd` fire on the parent's `onHook` with `parentSessionId`/`subagentSessionId`/`depth`; (b) the child's events do NOT bleed into the parent's `for await`; (c) the parent receives a single `tool_result` carrying the `SubagentResultSummary`. Anthropic side scripts the equivalent `Agent` tool round-trip.

### 17. Subagent tool restrictions (Phase 4.8)

A scenario invokes `spawn_subagent` with `permission_mode: 'plan'` + `effort: 'low'` + `model: '<other>'` overrides and asserts REPLACE-semantics: the child's `callModel` request reflects the override-only values (parent's `bypassPermissions` does NOT bleed in). Includes a sub-case for `allowed_tools` / `disallowed_tools` override layering on top of `permission_mode`.

### 18. Parallel subagents (Phase 4.9)

A scenario invokes `spawn_subagents({ subagents: [s1, s2, s3, s4, s5] })` with `maxParallelSubagents: 2` and asserts: pool throttles to 2 concurrent, results envelope each child as `{ status, subagentSessionId, output, error? }`, `aggregatedUsage` sums success envelopes only, parent abort fans out to all in-flight children (verified via abort sub-case). Depth-cap rejection covered as a sibling.

### 19. Session forking (Phase 4.5)

A scenario runs a parent through one turn (persisting `state.json`), invokes `forkSession({ sessionId, newSessionId: 'child', logsRoot })`, and asserts the new directory carries a copy of `state.json` + a fresh `session.json` stamped with `parentSessionId`. The forked session resumes via a new `OpenRouterAgentRun` and the `session_started` event payload surfaces lineage. In-memory rejection sub-case covered separately.

### 20. File checkpointing (Phase 4.6)

A scenario opts in via `checkpoint: true`, runs a turn that invokes `write_file` + `edit_file`, asserts auto-checkpoint snapshots land at `<logsRoot>/<sessionId>/checkpoints/<id>/` with the right `manifest.json` + per-file snapshot encoding, then invokes `restoreCheckpoint(...)` and asserts the two-phase rename through `.restore-tmp/` succeeds atomically. Tombstone (file-absent) restore covered as a sibling.

### 21. `persistSession: false` (Phase 3.12)

A scenario constructs the run with `persistSession: false`, runs one turn invoking `write_file`, and asserts zero writes under `logsRoot` (no `session.json` / `request.json` / `response.json` / `state.json`). The in-memory `StateAccessor` round-trips `previousResponseId` correctly across turns within the run.

### 22. MCP server support (Phase 5.2.\*)

A scenario configures a fixture MCP server (in-process SDK server is simplest for the harness; stdio + HTTP variants as siblings if appetite holds), registers two tools, and asserts: `McpServerStart` fires with capability counts; the tools surface in the model's tool pool as `<serverName>__<toolName>`; a tool call dispatches through the bridge and projects to the canonical event stream identically; `McpServerStop` fires with `reason ∈ {'closed', 'error', 'aborted'}` + `durationMs`. Init-failure path covered as a sibling.

### 23. Custom tools ergonomics (Phase 3.5)

A scenario constructs the run with a `tool({ name: 'fixture_tool', description, inputSchema, execute })` defined inline and asserts the Zod-typed input flows through the SDK's tool-use channel to the model, then back to `execute()` with the validated payload. Anthropic side scripts the equivalent custom-tool registration via `createSdkMcpServer`.

### 24. Skills system (Phase 5.7)

A scenario seeds a fixture `<cwd>/.claude/skills/fixture/SKILL.md` and constructs the run with `skills` enabled. Asserts: the rendered system instructions carry a `## Available Skills` listing; the model invokes `skill({ name: 'fixture' })`; the substitution helper resolves `$ARGUMENTS` + `${VAR}`; `Notification('skill_loaded')` fires. Per-skill `allowed-tools` narrowing covered as a sibling.

### 25. Slash commands (Phase 5.6)

A scenario seeds a fixture `<cwd>/.claude/commands/run-tests.md`, host-invokes `loader.resolve('/run-tests fast')`, and asserts the rendered body feeds as the next prompt. Converged-menu fold (skill-as-command) covered as a sibling. The unknown-command `undefined` return path is a host-side unit test (not a comparative scenario).

### 26. Plugins (Phase 5.8)

A scenario constructs the run with `plugins: ['<fixture-plugin-root>']`, asserts `PluginStart` fires with the right component counts, the plugin's skills + commands + MCP servers fold into the run, namespaced `<pluginName>:<serverName>__<toolName>` tools dispatch correctly, and `PluginStop` fires on teardown. Manifest-less auto-discovery covered as a sub-case.

### 27. CLAUDE.md / `settingSources` discovery (Phase 3.4)

A scenario seeds fixture `<cwd>/.claude/CLAUDE.md` + `<home>/.claude/CLAUDE.md` + `<cwd>/.claude/CLAUDE.local.md` files (~5k chars each), constructs the run with `settingSources: ['project', 'user', 'local']`, and asserts the rendered `instructions` carry the user → project → local concatenation under the ~50k-char cap. Cap-overflow truncation covered as a sub-case.

## Out of scope (for completeness)

- **Phase 0/1/2 foundation** (per ambiguity call #3): file primitives, basic agent loop, session persistence/resume, account info, supported-models query. The canonical-16 covers Phase 0/1/2 surface implicitly through #02/#03/etc.
- **Partial-parity rows**: Permission modes (`dontAsk`/`auto` unimplemented), Subagent hooks (matcher patterns unimplemented), Session persistence + Session resume + WebFetch (these stay **Partial** on the matrix). Per audit rule, only **Full** rows generate gap follow-ups.
- **Missing-parity rows**: Session listing ergonomics (`listSessions` / `getSessionMessages` / `renameSession` / `tagSession`) — quality-of-life follow-on, not a parity gap.
- **N/A rows**: Account / credit info, Supported models query — provider-specific surface not eligible.

## Rolling follow-up

This doc is dated 2026-05-25 and reflects coverage as of merge of #153 (Phase 6.8). Per the issue body, the doc gets refreshed every few months; intervening scenario PRs close their respective `parity-scenario-backfill` issues incrementally. When this doc is refreshed, the rolling card (#131) stays open.
