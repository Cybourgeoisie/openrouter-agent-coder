# Claude Agent SDK vs OpenRouter Agent Coder — Parity Analysis

> Comparison of the [Claude Code Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) (TypeScript) against the openrouter-agent-coder feature set.
> Originally generated 2026-05-21. **Last reviewed against this codebase: 2026-05-23** (after Phase 3.1 + 3.2 + 3.3 + 3.4 landed — see [`claude-sdk-parity-roadmap.md`](./claude-sdk-parity-roadmap.md)).

## Summary

| Status             | Count  |
| ------------------ | ------ |
| Full parity        | 15     |
| Partial parity     | 10     |
| Missing            | 21     |
| **Total features** | **46** |

Net change vs the original 2026-05-21 snapshot: **+7 Full** (`canUseTool`, new `Interrupt/abort` row, `Allowed/disallowed tools` after Phase 3.2, `Plan mode` after Phase 3.3, `CLAUDE.md / project context` after Phase 3.4, `Session lifecycle hooks` and `Notification hook` after Phase 3.6), **+2 Partial** (`PreToolUse`/`PostToolUse` are audit-only — hooks can log but can't block/modify like the Claude SDK; constructor-injected tools). Most "Missing" rows softened to "Partial" because their building blocks landed in Phase 1; the remaining gap is the ergonomic / discovery / block-modify layer on top.

---

## Feature Parity Chart

### Core Agent Loop

| Feature                  | Claude Agent SDK                                                                               | OpenRouter Agent Coder                                                                                      | Parity      |
| ------------------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------- |
| Autonomous tool loop     | SDK handles tool calls, results, repeats until done                                            | Delegates to `@openrouter/agent` `callModel()` SDK                                                          | **Full**    |
| Turn counting            | Tracks turns, exposes in ResultMessage                                                         | Tracks turns via streaming events; surfaced on `turn_end` and `stream_complete`                             | **Full**    |
| Max turns stop condition | `maxTurns` option                                                                              | `maxTurns` constructor option → `stepCountIs()`                                                             | **Full**    |
| Max cost stop condition  | `maxBudgetUsd` option                                                                          | `maxBudgetUsd` constructor option → `maxCost()`                                                             | **Full**    |
| Interrupt / abort        | `query.interrupt()` and streaming-input control messages                                       | `signal` constructor option + `run.abort()` method (combined internally via `AbortSignal.any`)              | **Full**    |
| Effort / reasoning level | `effort` option (low/medium/high/xhigh/max)                                                    | Not implemented                                                                                             | **None**    |
| Context compaction       | Automatic summarization when context fills; PreCompact hook; manual `/compact`                 | Not implemented — relies on SDK's `previousResponseId`                                                      | **None**    |
| Streaming output         | Rich message stream (SystemMessage, AssistantMessage, UserMessage, StreamEvent, ResultMessage) | `AgentCoreEvent` discriminated union (text_delta, tool_call/result, turn_start/end, stream_complete, error) | **Partial** |
| Streaming input          | AsyncGenerator-based input; mid-session messages, interrupts, image attachments                | Not implemented — one prompt per `OpenRouterAgentRun` instance                                              | **None**    |

### Built-in Tools

| Feature                     | Claude Agent SDK                                      | OpenRouter Agent Coder                                         | Parity      |
| --------------------------- | ----------------------------------------------------- | -------------------------------------------------------------- | ----------- |
| Read file                   | `Read` tool — any file, line offsets                  | `read_file` — with `start_line`/`end_line` support             | **Full**    |
| Write file                  | `Write` tool — create/overwrite                       | `write_file` — create/overwrite with auto-mkdir                | **Full**    |
| Edit file                   | `Edit` tool — precise string replacement              | `edit_file` — exact unique string replacement                  | **Full**    |
| Bash / run command          | `Bash` — full shell with description, timeout         | `run_command` — `sh -c`, 30s timeout, 1MB buffer               | **Partial** |
| Glob (file search)          | `Glob` — find files by pattern                        | `list_directory` — flat listing only, no glob patterns         | **Partial** |
| Grep (content search)       | `Grep` — regex search with context lines, file types  | `grep_files` — regex with glob filter, recursion, match limits | **Partial** |
| WebSearch                   | Built-in WebSearch tool                               | Server-side `openrouter:web_search`                            | **Full**    |
| WebFetch                    | Built-in WebFetch tool                                | Server-side `openrouter:web_fetch`                             | **Partial** |
| Monitor (background script) | Watch background process, react to output lines       | Not implemented                                                | **None**    |
| NotebookEdit                | Edit Jupyter notebook cells                           | Not implemented                                                | **None**    |
| AskUserQuestion             | Multiple-choice clarifying questions with previews    | Not implemented                                                | **None**    |
| ToolSearch                  | Dynamically load tools on demand from large tool sets | Not implemented                                                | **None**    |
| TaskCreate / TaskUpdate     | Track subtasks within agent execution                 | Not implemented                                                | **None**    |

### Permissions & Safety

| Feature                  | Claude Agent SDK                                                          | OpenRouter Agent Coder                                                                                                                                                                                                                                                                 | Parity      |
| ------------------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Permission modes         | 6 modes: default, dontAsk, acceptEdits, bypassPermissions, plan, auto     | `permissionMode` constructor option — 4 of 6 modes implemented (`default` / `acceptEdits` / `bypassPermissions` / `plan`). `dontAsk` and `auto` not implemented. Composes with the `allowedTools`/`disallowedTools` layer (Phase 3.2).                                                 | **Partial** |
| Allowed/disallowed tools | `allowedTools`, `disallowedTools` with scoped rules (e.g., `Bash(npm *)`) | `allowedTools` / `disallowedTools` constructor options accept plain names and scoped `<Tool>(<pattern>)` rules. Bash patterns use `*` as a wildcard; Edit/Read/Write/List/Grep patterns are path globs. Layers on top of `permissionMode`; explicit `canUseTool` overrides both lists. | **Full**    |
| canUseTool callback      | Runtime approval/deny/modify for each tool call                           | `canUseTool` constructor option — returns `{ behavior: 'allow' \| 'deny', reason?, updatedInput? }`. Server-side tools bypass.                                                                                                                                                         | **Full**    |
| Plan mode (read-only)    | Restricts to read-only tools; explores before editing                     | `permissionMode: 'plan'` (Phase 3.3) denies `write_file` / `edit_file` / `run_command` with reason `'plan mode: read-only — propose edits in your reply'`; allows `read_file` / `list_directory` / `grep_files`. `allowedTools` composes on top to whitelist individual custom tools.  | **Full**    |

### Hooks System

| Feature                  | Claude Agent SDK                                           | OpenRouter Agent Coder                                                                                                                                                                                                            | Parity      |
| ------------------------ | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| PreToolUse / PostToolUse | Block, modify, log, audit tool calls with matcher patterns | `onHook` fires `PreToolUse` before the `canUseTool` decision (audit even on deny) and `PostToolUse` after each tool result (`isError` matches subsequent `tool_result.isError`). Audit-only — hooks cannot block or modify input. | **Partial** |
| Session lifecycle hooks  | SessionStart, SessionEnd, Stop, Setup, Notification        | `onHook` fires `Setup` → `SessionStart` → … → `SessionEnd` → `Stop` on every run; `Setup` / `Stop` still bracket abort and constructor-throw paths. `Notification` is caller-emitted via `ctx.notify` or direct `onHook`.         | **Full**    |
| Subagent hooks           | SubagentStart, SubagentStop                                | No subagent system                                                                                                                                                                                                                | **None**    |
| Notification hook        | Forward agent status to Slack/PagerDuty/etc.               | `Notification` event in the `HookEvent` union; emit via `ctx.notify(level, message, context?)` from inside a tool, or call `onHook` directly. No-op when `onHook` is omitted.                                                     | **Full**    |
| PreCompact hook          | Archive transcript before compaction                       | No compaction system                                                                                                                                                                                                              | **None**    |

### Subagents & Orchestration

| Feature                    | Claude Agent SDK                                         | OpenRouter Agent Coder | Parity   |
| -------------------------- | -------------------------------------------------------- | ---------------------- | -------- |
| Subagent spawning          | Agent tool: programmatic or filesystem-based definitions | Not implemented        | **None** |
| Subagent tool restrictions | Per-subagent tool/model/effort overrides                 | Not implemented        | **None** |
| Parallel subagents         | Multiple subagents run concurrently                      | Not implemented        | **None** |

### Sessions & State

| Feature                      | Claude Agent SDK                                                            | OpenRouter Agent Coder                                                                                                                                                                                       | Parity      |
| ---------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| Session persistence          | JSONL on disk under `~/.claude/projects/`                                   | `ConversationState` (`previousResponseId`) persisted to `<logsRoot>/<sessionId>/state.json` via `FileStateAccessor`                                                                                          | **Partial** |
| Session resume               | `resume` by ID, `continue` most recent, `fork` to branch                    | `sessionId` constructor arg — host passes the same id to resume; library round-trips `previousResponseId` per turn                                                                                           | **Partial** |
| Session forking              | Fork creates new session with copied history                                | Not implemented                                                                                                                                                                                              | **None**    |
| Session listing / management | `listSessions()`, `getSessionMessages()`, `renameSession()`, `tagSession()` | Not implemented in-library. The callboard `OpenRouterSessionProvider` concept (Phase 2 in companion plan) scans `<logsRoot>/<id>/session.json` externally — Phase 1.6 captures `cwd` there for that purpose. | **None**    |
| File checkpointing           | Track & rewind file changes to any checkpoint                               | Not implemented                                                                                                                                                                                              | **None**    |
| persistSession: false        | In-memory only sessions (no disk writes)                                    | Not implemented (library always writes `<logsRoot>/<id>/`)                                                                                                                                                   | **None**    |

### Extensibility

| Feature                     | Claude Agent SDK                                                                    | OpenRouter Agent Coder                                                                                                                                                                                                                                                                                                                                                                      | Parity      |
| --------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| MCP server support          | stdio, HTTP/SSE, in-process SDK servers; `.mcp.json` config                         | Not implemented                                                                                                                                                                                                                                                                                                                                                                             | **None**    |
| Custom tools                | `tool()` helper + `createSdkMcpServer()` — in-process custom tools with Zod schemas | `tools` constructor option accepts any `readonly Tool[]`; bundled `allTools(ctx)` is the default. `tool({ name, description, inputSchema, execute })` (Zod-typed input) and `createSdkMcpServer({ name, version, tools })` (in-process value bag) shipped in Phase 3.5. Real MCP transports (stdio / HTTP+SSE / `.mcp.json` discovery) remain Phase 5.2 — verdict stays Partial until then. | **Partial** |
| Skills system               | Markdown-based skills in `.claude/skills/`                                          | Not implemented                                                                                                                                                                                                                                                                                                                                                                             | **None**    |
| Slash commands              | Custom commands in `.claude/commands/`                                              | Not implemented                                                                                                                                                                                                                                                                                                                                                                             | **None**    |
| Plugins                     | Extend with custom commands, agents, MCP servers                                    | Not implemented                                                                                                                                                                                                                                                                                                                                                                             | **None**    |
| CLAUDE.md / project context | Loaded from `.claude/` and `~/`, configurable via `settingSources`                  | `settingSources` constructor option (Phase 3.4): walks `project` (cwd + .claude/CLAUDE.md up to first .git or 10 levels), `user` (`~/.claude/CLAUDE.md`), and `local` (`<cwd>/.claude/CLAUDE.local.md`); composed into `instructions` in user→project→local order with a ~50k-char cap. Default `[]` preserves verbatim `instructions`.                                                     | **Full**    |

### Diagnostics & Accounts

| Feature                | Claude Agent SDK                                 | OpenRouter Agent Coder                                                                                                       | Parity  |
| ---------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------- |
| Account / credit info  | Anthropic billing surfaced via console / API key | `accountInfo({ apiKey })` → `{ provider: 'openrouter', label, usageUsd, limitUsd }` (Phase 1.8). Returns `null` for 401/403. | **N/A** |
| Supported models query | Models surfaced via Anthropic console            | `supportedModels({ apiKey })` → `{ value, displayName, description }[]` against `/api/v1/models` (Phase 1.8)                 | **N/A** |

These rows mark provider-specific surface area without a directly-comparable Claude SDK feature; they're listed for completeness, not counted toward parity totals.

---

## Required Features for Parity — Prioritized

> **P0** = core agent capability gaps
> **P1** = important for production use
> **P2** = nice to have / advanced

Items shipped in Phase 1 are crossed through with a back-pointer; the **layer-on-top** gap (e.g., the named-modes layer above `canUseTool`) is what remains in scope.

### P0 — Critical

1. **Permission modes layer.** Named modes (`default` / `acceptEdits` / `bypassPermissions` / `plan`) and an `allowedTools`/`disallowedTools` filtering syntax (e.g., `Bash(npm *)`) on top of the existing primitive. _`canUseTool` runtime callback shipped in Phase 1.4 — the named-modes layer would compose on top._

2. **Context compaction.** Detect context-window pressure and automatically summarize older messages.

3. ~~**Hooks (PreToolUse / PostToolUse).**~~ _Shipped in Phase 1.7 via `onHook` (audit-only)._ Block-and-modify capability moves to P1.

4. **Glob tool.** File pattern matching (e.g., `**/*.ts`) separate from `list_directory`.

5. **AskUserQuestion tool.** Structured multiple-choice clarifying questions during execution.

6. ~~**CLAUDE.md / project-context auto-discovery.**~~ _Shipped in Phase 3.4 via the `settingSources` constructor option ([#TBD](https://github.com/Cybourgeoisie/openrouter-agent-coder/pull/TBD))._

### P1 — Important

7. **Subagent system.** Agent tool for spawning focused subtasks with isolated context, restricted tools, optional model overrides.

8. **Session forking.** Branch a session from existing history to explore alternatives.

9. **Streaming input mode.** AsyncGenerator-based input for mid-session messages, interruptions, image attachments. (Interrupt-only is already covered via `signal` / `abort()`.)

10. **Rich message stream.** Typed message objects (SystemMessage, AssistantMessage, UserMessage, ResultMessage) instead of raw stream events. (Partial overlap with the "Streaming output" matrix row.)

11. **MCP server support.** Connect external tools via Model Context Protocol — stdio, HTTP/SSE, `.mcp.json` config.

12. ~~**Custom-tools ergonomics.** `tool()` helper / `createSdkMcpServer` / Zod-schema convenience.~~ _Shipped in Phase 3.5 — `tool({ name, description, inputSchema, execute })` (Zod-typed input) and `createSdkMcpServer({ name, version, tools })` (in-process value bag) are exported from the library. Real MCP transports remain Phase 5.2._

13. **Effort / reasoning level.** `effort` option to trade cost vs depth.

14. **File checkpointing.** Track file changes and rewind to checkpoints.

15. **Remaining session lifecycle hooks.** `Stop` (before exit), `Setup` (on first call), `Notification` (forward status externally). _`SessionStart` / `SessionEnd` shipped in Phase 1.7 via `onHook`._

16. **Block-and-modify hook capability.** Today `onHook` is audit-only — to match the Claude SDK, `PreToolUse` should be able to short-circuit the call or rewrite input. (Currently that's done via `canUseTool`; merging the two surfaces is a design decision.)

17. **Enhanced Bash tool.** Add description field, configurable timeout, improved output handling.

18. **Enhanced Grep tool.** Add context lines (`-A`/`-B`/`-C`), file-type filters, output modes (content/files/count).

### P2 — Nice to Have

19. **Monitor tool.** Watch background processes and react to output lines as events.

20. **NotebookEdit tool.** Edit Jupyter notebook cells.

21. **ToolSearch.** Dynamic tool loading from large MCP tool sets to save context.

22. **TaskCreate / TaskUpdate.** Built-in task tracking for multi-step work.

23. **Skills system.** Markdown-based reusable capabilities in `.claude/skills/`.

24. **Slash commands.** Custom commands in `.claude/commands/`.

25. **Plugins.** Extension system for custom commands, agents, MCP servers.

26. ~~**Plan mode.**~~ _Shipped in Phase 3.3 via `permissionMode: 'plan'`._

27. **In-memory sessions.** `persistSession: false` for stateless/ephemeral usage.

---

## Sources

- [Claude Code Agent SDK Overview](https://code.claude.com/docs/en/agent-sdk/overview)
- [Agent SDK Hooks](https://code.claude.com/docs/en/agent-sdk/hooks)
- [Agent SDK Permissions](https://code.claude.com/docs/en/agent-sdk/permissions)
- [Agent SDK Sessions](https://code.claude.com/docs/en/agent-sdk/sessions)
- [Agent SDK Subagents](https://code.claude.com/docs/en/agent-sdk/subagents)
- [Agent SDK User Input](https://code.claude.com/docs/en/agent-sdk/user-input)
- [Agent SDK MCP](https://code.claude.com/docs/en/agent-sdk/mcp)
- [Agent SDK Custom Tools](https://code.claude.com/docs/en/agent-sdk/custom-tools)
- [Agent SDK Agent Loop](https://code.claude.com/docs/en/agent-sdk/agent-loop)
- [Agent SDK File Checkpointing](https://code.claude.com/docs/en/agent-sdk/file-checkpointing)
- [Agent SDK Streaming Input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
- [@anthropic-ai/claude-agent-sdk on npm](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
