# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
