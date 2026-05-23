# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
