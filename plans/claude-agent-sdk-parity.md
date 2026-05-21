# Claude Agent SDK vs OpenRouter Agent Coder — Parity Analysis

> Comparison of the [Claude Code Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) (TypeScript) against the openrouter-agent-coder feature set.
> Generated 2026-05-21.

## Summary

| Status | Count |
|--------|-------|
| Full parity | 8 |
| Partial parity | 7 |
| Missing | 26 |
| **Total features** | **41** |

---

## Feature Parity Chart

### Core Agent Loop

| Feature | Claude Agent SDK | OpenRouter Agent Coder | Parity |
|---------|-----------------|----------------------|--------|
| Autonomous tool loop | SDK handles tool calls, results, repeats until done | Delegates to `@openrouter/agent` `callModel()` SDK | **Full** |
| Turn counting | Tracks turns, exposes in ResultMessage | Tracks turns via streaming events | **Full** |
| Max turns stop condition | `maxTurns` option | `stepCountIs(MAX_STEPS)` stop condition | **Full** |
| Max cost stop condition | `maxBudgetUsd` option | `maxCost(MAX_COST)` stop condition | **Full** |
| Effort / reasoning level | `effort` option (low/medium/high/xhigh/max) | Not implemented | **None** |
| Context compaction | Automatic summarization when context fills; PreCompact hook; manual `/compact` | Not implemented — relies on SDK's `previousResponseId` | **None** |
| Streaming output | Rich message stream (SystemMessage, AssistantMessage, UserMessage, StreamEvent, ResultMessage) | Text delta streaming + tool call/result events via `getFullResponsesStream()` | **Partial** |
| Streaming input | AsyncGenerator-based input; mid-session messages, interrupts, image attachments | Not implemented — REPL sends one prompt at a time | **None** |

### Built-in Tools

| Feature | Claude Agent SDK | OpenRouter Agent Coder | Parity |
|---------|-----------------|----------------------|--------|
| Read file | `Read` tool — any file, line offsets | `read_file` — with `start_line`/`end_line` support | **Full** |
| Write file | `Write` tool — create/overwrite | `write_file` — create/overwrite with auto-mkdir | **Full** |
| Edit file | `Edit` tool — precise string replacement | `edit_file` — exact unique string replacement | **Full** |
| Bash / run command | `Bash` — full shell with description, timeout | `run_command` — `sh -c`, 30s timeout, 1MB buffer | **Partial** |
| Glob (file search) | `Glob` — find files by pattern | `list_directory` — flat listing only, no glob patterns | **Partial** |
| Grep (content search) | `Grep` — regex search with context lines, file types | `grep_files` — regex with glob filter, recursion, match limits | **Partial** |
| WebSearch | Built-in WebSearch tool | Server-side `openrouter:web_search` | **Full** |
| WebFetch | Built-in WebFetch tool | Server-side `openrouter:web_fetch` | **Partial** |
| Monitor (background script) | Watch background process, react to output lines | Not implemented | **None** |
| NotebookEdit | Edit Jupyter notebook cells | Not implemented | **None** |
| AskUserQuestion | Multiple-choice clarifying questions with previews | Not implemented | **None** |
| ToolSearch | Dynamically load tools on demand from large tool sets | Not implemented | **None** |
| TaskCreate / TaskUpdate | Track subtasks within agent execution | Not implemented | **None** |

### Permissions & Safety

| Feature | Claude Agent SDK | OpenRouter Agent Coder | Parity |
|---------|-----------------|----------------------|--------|
| Permission modes | 6 modes: default, dontAsk, acceptEdits, bypassPermissions, plan, auto | No permission system — all tools run without approval | **None** |
| Allowed/disallowed tools | `allowedTools`, `disallowedTools` with scoped rules (e.g., `Bash(npm *)`) | Not implemented | **None** |
| canUseTool callback | Runtime approval/deny/modify for each tool call | Not implemented | **None** |
| Plan mode (read-only) | Restricts to read-only tools; explores before editing | Not implemented | **None** |

### Hooks System

| Feature | Claude Agent SDK | OpenRouter Agent Coder | Parity |
|---------|-----------------|----------------------|--------|
| PreToolUse / PostToolUse | Block, modify, log, audit tool calls with matcher patterns | Not implemented | **None** |
| Session lifecycle hooks | SessionStart, SessionEnd, Stop, Setup | Not implemented (SDK `onTurnEnd` callback only) | **None** |
| Subagent hooks | SubagentStart, SubagentStop | No subagent system | **None** |
| Notification hook | Forward agent status to Slack/PagerDuty/etc. | Not implemented | **None** |
| PreCompact hook | Archive transcript before compaction | No compaction system | **None** |

### Subagents & Orchestration

| Feature | Claude Agent SDK | OpenRouter Agent Coder | Parity |
|---------|-----------------|----------------------|--------|
| Subagent spawning | Agent tool: programmatic or filesystem-based definitions | Not implemented | **None** |
| Subagent tool restrictions | Per-subagent tool/model/effort overrides | Not implemented | **None** |
| Parallel subagents | Multiple subagents run concurrently | Not implemented | **None** |

### Sessions & State

| Feature | Claude Agent SDK | OpenRouter Agent Coder | Parity |
|---------|-----------------|----------------------|--------|
| Session persistence | JSONL on disk under `~/.claude/projects/` | `ConversationState` (`previousResponseId`) + `state.json` | **Partial** |
| Session resume | `resume` by ID, `continue` most recent, `fork` to branch | `--continue` flag (last session), `OR_SESSION_ID` env var | **Partial** |
| Session forking | Fork creates new session with copied history | Not implemented | **None** |
| Session listing / management | `listSessions()`, `getSessionMessages()`, `renameSession()`, `tagSession()` | `sessions.json` registry (append, getLastSession only) | **Partial** |
| File checkpointing | Track & rewind file changes to any checkpoint | Not implemented | **None** |
| persistSession: false | In-memory only sessions (no disk writes) | Not implemented | **None** |

### Extensibility

| Feature | Claude Agent SDK | OpenRouter Agent Coder | Parity |
|---------|-----------------|----------------------|--------|
| MCP server support | stdio, HTTP/SSE, in-process SDK servers; `.mcp.json` config | Not implemented | **None** |
| Custom tools (SDK MCP) | `tool()` helper + `createSdkMcpServer()` — in-process custom tools with Zod schemas | Not implemented (tools are hardcoded) | **None** |
| Skills system | Markdown-based skills in `.claude/skills/` | Not implemented | **None** |
| Slash commands | Custom commands in `.claude/commands/` | Not implemented | **None** |
| Plugins | Extend with custom commands, agents, MCP servers | Not implemented | **None** |
| CLAUDE.md / project context | Loaded from `.claude/` and `~/`, configurable via `settingSources` | Not implemented (system prompt is hardcoded) | **None** |

---

## Required Features for Parity — Prioritized

> **P0** = core agent capability gaps
> **P1** = important for production use  
> **P2** = nice to have / advanced

### P0 — Critical

1. **Permission system** — Implement permission modes (at least default + acceptEdits + bypassPermissions) with `allowedTools`/`disallowedTools` filtering and `canUseTool` callback for runtime approval.

2. **Context compaction** — Detect when context window is filling and automatically summarize older messages to free space while preserving key decisions.

3. **Hooks system (PreToolUse/PostToolUse)** — Callback-based interception for tool calls: block, modify input, audit, or add context. Pattern matchers to filter by tool name.

4. **Glob tool** — File pattern matching (e.g., `**/*.ts`) separate from directory listing. Current `list_directory` is too basic.

5. **AskUserQuestion tool** — Let the agent ask the user clarifying questions with structured multiple-choice options during execution.

6. **CLAUDE.md / project context** — Load project instructions from `.claude/` or `CLAUDE.md` files, injected into every request as persistent context.

### P1 — Important

7. **Subagent system** — Agent tool for spawning focused subtasks with isolated context, restricted tools, and optional model overrides.

8. **Session forking** — Create a new session branching from an existing one's history to explore alternative approaches.

9. **Streaming input mode** — AsyncGenerator-based input for mid-session messages, interruptions, and image attachments.

10. **Rich message stream** — Typed message objects (SystemMessage, AssistantMessage, UserMessage, ResultMessage) instead of raw stream events.

11. **MCP server support** — Connect external tools via Model Context Protocol: stdio, HTTP/SSE transports, `.mcp.json` config.

12. **Custom tools API** — `tool()` helper + `createSdkMcpServer()` pattern for defining custom tools with Zod schemas and handlers.

13. **Effort / reasoning level** — Control reasoning depth per query (low/medium/high/xhigh/max) to trade cost vs thoroughness.

14. **File checkpointing** — Track file changes and allow rewinding to any previous checkpoint state.

15. **Session lifecycle hooks** — SessionStart, SessionEnd, Stop, Notification, and other lifecycle callbacks.

16. **Enhanced Bash tool** — Add description field, configurable timeout, better output handling to match Claude SDK's Bash.

17. **Enhanced Grep tool** — Add context lines (-A/-B/-C), file type filters, output modes (content/files/count) to match SDK's Grep.

### P2 — Nice to Have

18. **Monitor tool** — Watch background processes and react to output lines as events.

19. **NotebookEdit tool** — Edit Jupyter notebook cells.

20. **ToolSearch** — Dynamic tool loading from large MCP tool sets to save context window space.

21. **TaskCreate / TaskUpdate** — Built-in task tracking tools for organizing multi-step work.

22. **Skills system** — Markdown-based reusable capabilities in `.claude/skills/`.

23. **Slash commands** — Custom commands in `.claude/commands/`.

24. **Plugins** — Extension system for custom commands, agents, MCP servers.

25. **Plan mode** — Read-only mode for analysis without modifications.

26. **In-memory sessions** — `persistSession: false` for stateless/ephemeral usage.

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
