# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- `compileGlobToRegex` in `src/utils/glob.ts` now treats `**/` as
  zero-or-more path segments (previously one-or-more), aligning with the
  standard gitignore / minimatch / bash-globstar semantic. Because the
  helper is shared, this silently broadens matching for two pre-existing
  callers:
  - `tool-filters` rule grammar (Phase 3.2) — e.g.
    `disallowedTools: ['Edit(src/**/foo.ts)']` now also matches
    `src/foo.ts` (in addition to `src/a/foo.ts`, `src/a/b/foo.ts`, …).
  - `grep_files` `file_glob` option (Phase 3.10) — same broadening:
    `file_glob: 'src/**/*.ts'` now also picks up files directly under
    `src/`. Patterns without `**/` are unaffected; `*`, `?`, and
    character-class behavior is unchanged.

### Added

- Phase 4.9: parallel subagent execution via the new built-in
  `spawn_subagents` (plural) tool. Bundled alongside the singular
  `spawn_subagent` whenever `OpenRouterAgentRun({ enableSubagents: true })`
  is set — no separate opt-in flag (the two tools share a `runSubagent`
  closure and lifecycle emitter, so wiring them independently would
  force two near-identical switches on the host). The new ctor option
  `maxParallelSubagents` (default `4`) caps the number of subagents
  in-flight at once for a single plural invocation; the array itself is
  Zod-capped at `MAX_PARALLEL_BATCH_SIZE` (= 16) entries. Each spec in
  the array accepts the same per-spec fields as `spawn_subagent`
  (`description` plus optional `tools` / `instructions` / `max_turns` /
  `max_budget_usd` / `model` / `permission_mode` / `allowed_tools` /
  `disallowed_tools` / `effort`), so all Phase 4.8 overrides propagate
  per-child. Concurrency is enforced by an inline promise pool (no
  `p-limit` dep). No fail-fast — per-child failures isolate into
  `{ status: 'success' | 'error' | 'aborted', subagentSessionId,
output, error? }` envelopes; aggregate `costUsd` + token totals sum
  the `'success'` envelopes only. Parent abort fans out into every
  in-flight child via `AbortSignal.any([parentSignal,
internalCtl.signal])`. Recursion-depth gate reuses the singular tool's
  check; depth-N parent at the cap rejects each spec with the same
  `'max subagent depth (N) exceeded'` envelope. `SubagentStart` /
  `SubagentEnd` hooks fire once per child (no new event types — pairs
  may interleave when children run in parallel, correlate on
  `subagentSessionId`). Each child inherits the parent's `maxBudgetUsd`
  independently by default; per-spec `max_budget_usd` overrides
  per-child (aggregate cost may therefore exceed any single child's
  cap, but no single child can exceed its own).
- Phase 4.8: per-subagent tool / model / effort overrides on
  `spawn_subagent`. The Zod input schema gains five optional fields —
  `model?: string`, `permission_mode?: 'default' | 'acceptEdits' |
'bypassPermissions' | 'plan'`, `allowed_tools?: string[]` and
  `disallowed_tools?: string[]` (both reuse the Phase 3.2 rule grammar:
  plain names like `'read_file'` / `'Read'` or scoped rules like
  `'Bash(npm *)'` / `'Edit(src/**/*.ts)'`), and `effort?: string` — that
  the runner maps to the child `OpenRouterAgentRun`'s constructor args
  (snake_case in the tool schema → camelCase on the ctor). Each override
  REPLACES the parent's resolved value rather than composing — so
  `permission_mode: 'plan'` from a `bypassPermissions` parent isolates
  the read-only restriction to the child; the parent's own subsequent
  tool calls remain unrestricted. The 4.7 `tools?: string[]`
  pool-narrowing whitelist still composes on top of the 3.2 filters:
  `tools` controls which tool factories are available to the child;
  `allowed_tools` / `disallowed_tools` then gate calls within that pool.
  `effort` is **accepted-but-no-op** — the value is stored on both the
  spawn config and the child run's `OpenRouterAgentRunOptions.effort`
  field, but the OR `callModel` call does not yet forward it. Full
  wiring lands in Phase 5.4 (gated on spike 5.S3 — whether OR's API
  accepts an effort parameter at all). The new `effort?: string` field
  on `OpenRouterAgentRunOptions` is documented as a stub with the same
  no-op caveat so the surface stays stable. Documented in the README
  Subagents subsection and parity matrix (`Subagent tool restrictions`
  graduates Partial → Full). ([#59](https://github.com/Cybourgeoisie/openrouter-agent-coder/issues/59))

- Phase 4.7: subagent system — basic, sequential. New `spawnSubagentTool(opts, ctx?)` factory (exported from the library root) plus `OpenRouterAgentRun({ enableSubagents: true, maxSubagentDepth?: 3, currentSubagentDepth?: 0 })` constructor options that wire the built-in `spawn_subagent` tool into the default bundle. The tool's Zod input schema accepts `description: string`, optional `tools?: string[]` (whitelist of tool names that narrows the inherited parent pool — unknown names silently dropped), optional `instructions?: string`, `max_turns?: number`, and `max_budget_usd?: number` (each defaults to the parent's value when omitted). When invoked, the parent's `spawn_subagent.execute` derives a child session id (`<parentSessionId>:sub:<uuid>`), composes the parent's abort signal with a subagent-internal `AbortController` via `AbortSignal.any`, and builds a child `OpenRouterAgentRun` inheriting the parent's `apiKey` / `baseUrl` / `appTitle` / `logsRoot` / `logger` / `onHook` / `model` / `cwd` / `persistSession`. The runner drains the child's `AgentCoreEvent` stream and returns the captured `SubagentResultSummary` (status, usage, costUsd, durationMs, reason, plus concatenated assistant text) as a single `tool_result` — subagent events do NOT bleed into the parent's `for await`. Recursion cap: the spawn check `parent.currentSubagentDepth + 1` against `maxSubagentDepth` rejects when the next depth would meet or exceed the cap (default 3 → chain of at most three levels: parent → sub → sub-sub → reject 4th), surfacing `{ error: 'max subagent depth (3) exceeded', subagentSessionId }`. The `HookEvent` union is extended with `'SubagentStart'` and `'SubagentEnd'`; both payloads carry `parentSessionId`, `subagentSessionId`, `depth`, and (on End) the full `SubagentResultSummary`. Both fire even on the depth-cap rejection path so audit consumers see a matched Start/End pair. Opt-in via `OpenRouterAgentRun({ enableSubagents: true })` or by passing `AllToolsOptions.spawnSubagent` to `allTools()`; the tool is **NOT** in the default bundle when `enableSubagents` is unset (mirrors the host-hook opt-in pattern from Phase 4.1/4.2). ([#58](https://github.com/Cybourgeoisie/openrouter-agent-coder/issues/58))

- Phase 4.6: file checkpointing. New `createCheckpoint(sessionId,
logsRoot, files[], { logger? })`, `listCheckpoints(sessionId, logsRoot)`,
  and `restoreCheckpoint(checkpointId, sessionId, logsRoot)` helpers
  (exported from the library root) plus an auto-checkpoint hook on the
  built-in `write_file` and `edit_file` tools. Snapshots land at
  `<logsRoot>/<sessionId>/checkpoints/<checkpointId>/` and consist of
  `manifest.json` plus one `<encoded-path>.snapshot` companion per file —
  path encoding replaces every `/` (including the leading `/` of absolute
  paths) with the sentinel token `__SLASH__`, so each snapshot fits in a
  single basename and round-trips losslessly through the exported
  `encodePath` / `decodePath` helpers. Files absent at checkpoint time
  are recorded as tombstones (`existed: false`, no `.snapshot` file);
  restoring a tombstone unlinks the live path if it currently exists.
  `restoreCheckpoint` is atomic across the whole manifest — every file
  is first staged into `<checkpointDir>/.restore-tmp/`, then `fs.rename`d
  into place once every staged file is ready; tombstones are unlinked
  last (after all renames succeed). Per-session cap
  `MAX_CHECKPOINTS_PER_SESSION = 100` evicts the oldest checkpoint(s)
  (by `timestamp`, ascending) on overflow and logs each eviction at
  `'warn'`. Create-time fast-path: when the target file's `mtimeMs` +
  `size` match its most-recent prior snapshot in the same session, the
  new snapshot is created via `fs.link` (hard-link) instead of copying
  bytes — falls through to `copyFile` on `EXDEV` / unsupported FS.
  ([#57](https://github.com/Cybourgeoisie/openrouter-agent-coder/issues/57))
- Phase 4.6: `checkpoint?: boolean` constructor option on
  `OpenRouterAgentRun` (default `false`). When `true`, the built-in
  `write_file` and `edit_file` tools snapshot their target path under
  `<logsRoot>/<sessionId>/checkpoints/` before mutating it. Per-call
  override field `checkpoint` on those tools' input schemas wins over
  the constructor default. When the run is constructed with
  `persistSession: false`, requested checkpoints become a NO-OP — the
  library logs `'warn'` with the message `'checkpoint requested but
persistSession is false'` and the underlying write proceeds normally.
  Ignored when the caller supplies a custom `tools` array (the option
  threads through the built-in tool bundle only). Both tools also gained
  a per-call `checkpoint?: boolean` field on their Zod input schemas.
  ([#57](https://github.com/Cybourgeoisie/openrouter-agent-coder/issues/57))
- Phase 4.6: new public exports from the library root: `createCheckpoint`,
  `listCheckpoints`, `restoreCheckpoint`, `encodePath`, `decodePath`,
  `MAX_CHECKPOINTS_PER_SESSION`, plus types `Checkpoint`,
  `CheckpointFile`, `RestoreCheckpointResult`, `CheckpointLogger`.
  `ToolContext` gained five optional fields (`sessionId`, `logsRoot`,
  `checkpoint`, `persistSession`, `logger`) threaded in by `agent.ts` so
  the checkpointing tools can find the session directory and emit warn
  logs; tools that don't need them ignore the new fields.
  ([#57](https://github.com/Cybourgeoisie/openrouter-agent-coder/issues/57))
- Phase 4.5: session forking. New `forkSession({ sessionId, newSessionId?,
logsRoot })` standalone helper plus an `OpenRouterAgentRun.fork({
newSessionId? })` instance wrapper that reuses the run's resolved
  `logsRoot`. Forking copies the source session's `state.json` via atomic
  write (`*.tmp` → `rename`) into a new session directory under the same
  `logsRoot` and stamps a fresh `session.json` whose new `parentSessionId`
  field points back at the source. Per-request `req_*` / `gen_*`
  subdirectories are **not** copied — the fork inherits the OR
  `previousResponseId` chain via `state.json` alone. `newSessionId` is
  auto-minted as a UUID v4 when omitted. Forking a `persistSession: false`
  run (or any source missing `state.json`) rejects with `cannot fork
in-memory session: <id> has no on-disk state at <path>`; the instance
  wrapper's check is local — no filesystem round-trip. Standalone
  `forkSession` requires an explicit `logsRoot` (no `<cwd>/logs` default)
  to preserve the library's "exactly one `process.cwd()` call site" rule.
- Phase 4.5: `parentSessionId?: string` constructor option on
  `OpenRouterAgentRun`. When set, the value is written to the run's
  `session.json` (new optional `parentSessionId` field on `SessionLog`) and
  surfaced on the `session_started` event payload. Root sessions omit the
  field from both — back-compat with legacy `session.json` files is
  preserved by absence.
- New `monitor` client tool — spawn a shell command via `/bin/sh -c` and
  stream its stdout/stderr line-by-line into a capture buffer that resolves
  on one of four stop conditions: natural process exit, line-count cap hit,
  duration cap hit, or `ctx.signal` abort. Inputs: `command` (string,
  required), optional `cwd` (resolved against the run's `cwd`), optional
  `pattern` (JS regex string — compiled once at execute-time; invalid
  patterns resolve with `{ error: 'invalid pattern: <message>' }` rather
  than throwing), optional `max_lines` (default `1000`, silently clamped
  to `10_000` with a `warn` notification), optional `max_duration_ms`
  (default `60_000`, silently clamped to `600_000` with a `warn`
  notification). Pattern filtering happens per-line; non-matching lines
  are dropped on the floor (no buffer entry). All three forced-stop paths
  (line cap, duration cap, abort) SIGTERM the child with a 250ms SIGKILL
  grace mirroring `run_command`, and mark the returned result
  `truncated: true` with `exitCode: null`. Natural exit returns
  `truncated: false` with the real exit code. Result shape:
  `{ exitCode: number | null, lines: { stream: 'stdout' | 'stderr', text: string }[], truncated: boolean, durationMs: number }`.
  Wired into `allTools()` as the twelfth client tool; the agent's default
  tool set now ships with 12 client tools. (Phase 4.4)
- New `edit_notebook` client tool — Jupyter notebook (`.ipynb`) cell
  manipulation. Inputs: `path` (relative to the agent `cwd`), `operation`
  (Zod enum: `'replace_source'` / `'insert'` / `'delete'` /
  `'change_type'`), `cell_index` (non-negative integer; for `insert`,
  `0` prepends and `cells.length` appends), optional `new_source`
  (required for `replace_source` + `insert`), optional `new_cell_type`
  (Zod enum: `'code'` / `'markdown'`; required for `insert` +
  `change_type`). Round-trip preservation: untouched cells keep every
  field (`metadata`, `outputs`, `execution_count`, `id`, etc.), notebook-
  level `metadata` / `nbformat` / `nbformat_minor` / `kernelspec` and any
  other top-level keys are preserved verbatim. `source` is normalized to
  the canonical Jupyter `string[]` shape on write (splitting on `\n` and
  preserving the trailing `\n` on each non-final line). `change_type`
  `code → markdown` strips `outputs` + `execution_count`;
  `markdown → code` adds `outputs: []` + `execution_count: null`. Returns
  `{ ok: true, cells: <post-mutation-count> }` on success; surfaces
  validation / index-range / parse / read / write failures as
  `{ error: '<diagnostic>' }` (tool-error path — the model sees the
  error and can recover, no throws). Wired into `allTools()` as the
  eleventh client tool; the agent's default tool set now ships with 11
  client tools. (Phase 4.3)
- New `task_create` / `task_update` client tools — in-run task tracking
  surfaced through the `Notification` hook so a host UI can render
  progress. `task_create` inputs: `content` (string, required) + optional
  `activeForm` (present-continuous form). `task_update` inputs: `taskId`
  (required) + `state` (Zod enum: `'pending'` / `'in_progress'` /
  `'completed'` / `'cancelled'`, required) + optional `content` (rewrites
  the description only when provided). Library assigns each new task a
  UUID; `task_create` returns `{ id }`, `task_update` returns `{}` on
  success or `{ error: 'unknown task id: <id>' }` (tool-error path) for
  unknown ids. Every successful mutation emits one `Notification` hook
  with `level: 'info'`, `message: 'tasks_changed'`, and `context: { tasks:
Task[] }` (the FULL latest list, not a diff). The task list is held in an
  in-run `taskListRef` on `OpenRouterAgentRun` — ephemeral per run, never
  persisted to `state.json`, lost when the process exits. Both factories
  share the same ref via `allTools(ctx, { taskListRef, onTasksChanged })`
  so they read/write one list across turns. (Phase 4.2)
- `onTasksChanged` constructor option on `OpenRouterAgentRun` — host
  callback `(tasks: Task[]) => void` fired after every `task_create` /
  `task_update` mutation with a defensive shallow-copy of the full latest
  list. Equivalent to filtering the `Notification` hook on
  `message === 'tasks_changed'`; supply this when you don't want to
  subscribe to every Notification just to render the task list. Plumbed
  through `allTools(ctx, { onTasksChanged })`. Ignored when the caller
  supplies a custom `tools` array. (Phase 4.2)
- New public exports from the library root: `taskCreateTool`,
  `taskUpdateTool`, `TaskState`, `Task`, `OnTasksChanged`, `TaskListRef`,
  `TaskToolOptions`, `CreateTaskRequest`, `UpdateTaskRequest`,
  `TaskListChangedNotification`, `TaskCreateToolResult`,
  `TaskUpdateToolResult`. (Phase 4.2)
- New `ask_user_question` client tool — multiple-choice clarifying
  questions surfaced to a host UI during a run. Inputs: `question`
  (string), `options` (2–26 entries; each `{ label, preview? }`), optional
  `allow_free_text`, optional `timeout_ms` (default 300 000, clamped to
  600 000). The library generates a UUID `questionId` and auto-assigns
  per-option ids `'a'`–`'z'` lexicographically. The tool returns
  `{ selectedOptionId, label, freeTextAnswer? }` on success — `label`
  resolved from the request's options so the model never has to remember
  the lettering. Aborting via `signal` / `run.abort()` resolves promptly
  with `{ error: 'aborted' }`; a missing host handler returns
  `{ error: 'no host handler registered for ask_user_question' }`; a
  timeout returns `{ error: 'timed out after <ms>ms' }`. (Phase 4.1)
- `onAskUserQuestion` constructor option on `OpenRouterAgentRun` — host
  callback `(req: UserQuestionRequest) => Promise<UserQuestionResponse>`
  that powers `ask_user_question`. Plumbed through `allTools(ctx, {
onAskUserQuestion })`. Ignored when the caller supplies a custom `tools`
  array. (Phase 4.1)
- New public exports from the library root: `askUserQuestionTool`,
  `AllToolsOptions`, `AskUserQuestionToolOptions`,
  `AskUserQuestionToolResult`, `OnAskUserQuestion`, `UserQuestionRequest`,
  `UserQuestionResponse`. (Phase 4.1)
- The `Notification` lifecycle hook now fires once per
  `ask_user_question` call with `level: 'info'`,
  `message: 'ask_user_question'`, and the full request payload as
  `context`. Subscribers without a UI still observe every question.
  (Phase 4.1)
- `persistSession` constructor option on `OpenRouterAgentRun` (default
  `true`, backward-compatible). When `false`, the run swaps the
  `FileStateAccessor` for an in-memory accessor and skips every write under
  `logsRoot` — no `session.json`, no per-request `request.json`, no
  per-generation `response.json`, no `state.json`. The session is still
  tracked server-side by `sessionId`, hooks still fire, and the
  `AgentCoreEvent` stream is byte-identical to a persisted run. Trade-off:
  no resume across processes (the next process sees ENOENT for that
  sessionId under `logsRoot`), and external readers like `readSessionLog`
  (Phase 1.6) see nothing for that sessionId. (Phase 3.12)
- New `glob` client tool — recursive file finder by glob pattern, separate
  from the flat `list_directory` listing. Inputs: `pattern` (required, e.g.
  `**/*.ts`, `src/**/*.test.ts`, `*.md`), `path` (defaults to the agent
  `cwd`; relative paths resolve against `ctx.cwd`, absolute paths pass
  through), and `case_sensitive` (default `true`, Linux convention).
  Patterns support `**` (recursive across path separators, with
  zero-or-more-segments semantics when followed by `/` — `**/*.ts` matches
  both `top.ts` and `a/b/deep.ts`), `*` (per-segment wildcard, does not
  cross `/`), `?` (single non-`/` character), and `[...]` character
  classes (e.g. `[a-z]`, `[!abc]` for negation). Walk strategy: BFS by
  directory level (more even path-length distribution under truncation
  than DFS). Skips `node_modules`, `dist`, `coverage`, and any name
  starting with `.` at every depth. Honors `ctx.signal` — aborts promptly
  on cancellation between BFS levels and between directories within a
  level. Result shape: `{ pattern, path, matches: string[], matchCount,
truncated }`, with `matches` sorted lexicographically and capped at
  `MAX_MATCHES = 1000`. The `compileGlobToRegex` helper in
  `src/utils/glob.ts` was extended in place to support `?`, `[...]`
  character classes, and zero-or-more-segments matching when `**` is
  followed by `/`; patterns that don't use those features compile to the
  same regex as before.
  ([#50](https://github.com/Cybourgeoisie/openrouter-agent-coder/issues/50))
- Four optional input fields on the `grep_files` tool schema: `before_context`
  / `after_context` / `context` (context-line capture, like `grep -B`/`-A`/`-C`,
  each silently clamped to `[0, 20]`) and `type` (built-in filetype alias —
  `'ts'`, `'js'`, `'py'`, `'rust'`, `'go'`, `'java'`, `'rb'`, `'php'`, `'c'`,
  `'cpp'`, `'cs'`, `'sh'`, `'md'`, `'json'`, `'yaml'`; unknown values silently
  ignored). `type` combines with the existing `file_glob` via UNION — a file
  matches if either includes it. Plus a new `output_mode` enum (`'content'`
  default, `'files_with_matches'`, `'count'`) that projects the same scan into
  three result shapes — `content` (existing per-line matches, now with optional
  `before`/`after` arrays per match), `files_with_matches`
  (`{ files: string[]; matchCount: number; truncated: boolean }`), and `count`
  (`{ totalMatches: number; perFile: Array<{ file: string; count: number }>; truncated: boolean }`).
  The existing `MAX_MATCHES = 200` cap is honored across all three modes with
  `truncated: true` set on overflow. Mode dispatch happens at the
  result-assembly step (the scan always produces the full per-line match list
  internally); existing callers that pass none of the new fields see the
  identical pre-3.10 shape.
  ([#49](https://github.com/Cybourgeoisie/openrouter-agent-coder/issues/49))
- Two optional input fields on the `run_command` tool schema:
  `description` (free-text advisory note from the model, forwarded through
  `tool_call.input` — never gates execution, never appears in stdout/stderr)
  and `timeout_ms` (overrides the default 30s timeout). `timeout_ms` is
  clamped at `MAX_TIMEOUT_MS = 600_000` (10 minutes); when an over-cap value
  is supplied the tool emits a single `ctx.notify('warn', …, { requestedMs,
effectiveMs })` and proceeds with the clamped value (never throws). The
  existing SIGTERM + 250ms grace → SIGKILL escalation now applies to the
  timeout path as well, matching the long-standing abort-path behaviour;
  the abort path itself is unchanged. `MAX_TIMEOUT_MS` is exported from
  `src/tools/run-command.ts`. Existing callers that pass neither field see
  no behavioural change. ([#48](https://github.com/Cybourgeoisie/openrouter-agent-coder/issues/48))
- `run.messages()` method on `OpenRouterAgentRun` returning an
  `AsyncIterable<AgentMessage>` — a typed message-level view of the run
  aggregated from the underlying `AgentCoreEvent` stream. Yields a fixed
  sequence per run: `SystemMessage{subtype:'session_start'}` →
  per-turn `AssistantMessage` / `UserMessage` blocks → `ResultMessage` →
  `SystemMessage{subtype:'session_end'}`. Aggregation rules: `text_delta`s
  within a turn concatenate into a single `TextContent`; `tool_call`s within
  the same turn append `ToolUseContent` blocks to the same `AssistantMessage`
  (text and tool blocks interleave in event order — Claude SDK parity);
  `tool_result` flushes any open `AssistantMessage` and emits a `UserMessage`
  carrying one stringified `ToolResultContent`; `turn_end` flushes any open
  `AssistantMessage` (empty turns yield nothing). Abort flushes any open
  `AssistantMessage` before the terminal `ResultMessage`, so no buffered
  content is lost. New exports from the library entry point: `AgentMessage`,
  `SystemMessage`, `AssistantMessage`, `UserMessage`, `ResultMessage`,
  `TextContent`, `ToolUseContent`, `ToolResultContent`. **One consumer per
  run** — `for await (... of run)` (raw events) and `run.messages()` (typed
  messages) are mutually exclusive on the same instance; the second call
  throws (single-shot guard). Existing event-stream consumers are entirely
  unaffected. ([#47](https://github.com/Cybourgeoisie/openrouter-agent-coder/issues/47))
- `PreToolUseAction` discriminated union (`{ action: 'continue' }` /
  `{ action: 'block'; reason: string }` / `{ action: 'modify'; input: unknown }`)
  exported from the library. `onHook` handlers may now return one of these
  values from the `PreToolUse` event to short-circuit (`block`) or rewrite
  (`modify`) the tool call before `canUseTool` runs. Returning `void` /
  `undefined` (the pre-3.7 contract) is equivalent to `{ action: 'continue' }`
  — this is NOT a breaking change. Block synthesises the same
  `{ error, denied: true }` JSON shape `canUseTool`-deny already produces, so
  audit consumers see a uniform denial payload across both sources. `modify`
  flows the substituted input through `canUseTool` and the underlying tool
  while leaving the `tool_call` event payload (and `PreToolUse.input` /
  `PostToolUse.input`) untouched — modifications are invisible at the
  event-stream layer except via the eventual `tool_result`. Precedence:
  hook-`block` beats `canUseTool`-allow; `canUseTool`-`deny` beats
  hook-`continue` / `modify`. A throw from a `PreToolUse` handler is still
  logged-and-swallowed (treated as `continue`, never as `block`) — same
  safety contract as Phase 1.7. ([#46](https://github.com/Cybourgeoisie/openrouter-agent-coder/issues/46))
- Three new lifecycle hook events on `onHook`: `Setup` (fires once per
  `OpenRouterAgentRun` instance, BEFORE `SessionStart` — useful for first-run
  resource provisioning), `Stop` (fires LAST in the run, after `SessionEnd`,
  on every exit path including abort and constructor-throw — carries the final
  `status` and an optional `reason`), and `Notification` (caller-emitted; not
  auto-fired by the runtime). Documented fire order:
  `Setup` → `SessionStart` → `PreToolUse` / `PostToolUse` pairs → `SessionEnd` → `Stop`.
  Existing four hook events (`SessionStart`, `SessionEnd`, `PreToolUse`,
  `PostToolUse`) are unchanged.
  ([#45](https://github.com/Cybourgeoisie/openrouter-agent-coder/issues/45))
- `ctx.notify(level, message, context?)` on the tool execution context — a
  thin facade over `onHook({ event: 'Notification', ... })` so library code or
  custom tools can push status updates without taking a direct dependency on
  the hook callback. Available to both built-in and custom tools via the SDK
  `ToolExecuteContext` injected by the hook wrapper; undefined (no-op) when
  `onHook` is omitted, so callers can use the `ctx.notify?.(...)` form
  unconditionally. ([#45](https://github.com/Cybourgeoisie/openrouter-agent-coder/issues/45))
- `tool()` helper for building a `Tool` from a Zod schema with a typed `execute`
  callback — mirrors the Claude Agent SDK's `tool()` shape so callers porting
  from `@anthropic-ai/claude-agent-sdk` can keep the same object literal. Drops
  into `OpenRouterAgentRunOptions['tools']` unchanged and integrates with
  `canUseTool`, `onHook`, and the existing run loop. Schema-validation failures
  are surfaced as `tool_result.isError = true` instead of crashing the run.
  ([#44](https://github.com/Cybourgeoisie/openrouter-agent-coder/issues/44))
- `createSdkMcpServer({ name, version, tools })` factory returning an
  in-process `{ name, version, tools }` value bag — matches the Claude Agent
  SDK shape so host code can build against the eventual MCP surface. Real MCP
  transports (stdio / HTTP+SSE / `.mcp.json` discovery) come in Phase 5.2.
  ([#44](https://github.com/Cybourgeoisie/openrouter-agent-coder/issues/44))
