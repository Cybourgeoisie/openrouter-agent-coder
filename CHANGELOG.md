# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
