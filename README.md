# openrouter-agent-coder

A library for building agent applications on the [OpenRouter Agent SDK](https://openrouter.ai/docs/agent-sdk/overview) — exposes an async-iterable agent core with tool gating, lifecycle hooks, and abort support.

## Why this exists

`openrouter-agent-coder` is designed to be a drop-in replacement for `@anthropic-ai/claude-agent-sdk` inside [callboard](https://github.com/Cybourgeoisie/callboard) or any host that needs a programmatic agent runtime. The library exposes the same shape host code already speaks (`for await` over a discriminated event stream, `canUseTool` permission gate, `onHook` lifecycle callbacks, `AbortSignal`-based cancellation), with OpenRouter routing model calls instead of Anthropic.

See [`plans/callboard-compatibility.md`](./plans/callboard-compatibility.md) for the full compatibility plan.

## Install

```bash
npm install openrouter-agent-coder
```

## Quick start

```ts
import { OpenRouterAgentRun } from 'openrouter-agent-coder';
import { randomUUID } from 'node:crypto';

const run = new OpenRouterAgentRun({
  apiKey: process.env.OPENROUTER_API_KEY!,
  sessionId: randomUUID(),
  prompt: 'List the files in the current directory and summarize the project.',
});

for await (const event of run) {
  if (event.type === 'text_delta') process.stdout.write(event.content);
  else if (event.type === 'tool_call') console.log(`\n[tool] ${event.name}`, event.input);
  else if (event.type === 'stream_complete') console.log(`\n[done] ${event.status}`);
}
```

## API reference

### `OpenRouterAgentRun`

Single-shot async iterable that drives one agent run. Construct, `for await` the events, done.

#### Constructor options

| Option                 | Type                | Required | Default                                  | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------- | ------------------- | -------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiKey`               | `string`            | yes      | —                                        | OpenRouter API key. No env fallback.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `sessionId`            | `string`            | yes      | —                                        | Stable session id used for OR server-side session tracking and on-disk state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `prompt`               | `string`            | yes      | —                                        | User prompt for this run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `instructions`         | `string`            | no       | `DEFAULT_INSTRUCTIONS`                   | System instructions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `model`                | `string`            | no       | `~anthropic/claude-sonnet-latest`        | Model alias or id.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `cwd`                  | `string`            | no       | `process.cwd()`                          | Working directory tools resolve relative paths against.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `maxTurns`             | `number`            | no       | `25`                                     | Max inner-loop turns.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `maxBudgetUsd`         | `number`            | no       | `1.0`                                    | Max cumulative cost in USD.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `tools`                | `readonly Tool[]`   | no       | `allTools({ cwd, signal })`              | Tools passed to the model. Custom tools are NOT context-bound — caller handles cwd/abort.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `canUseTool`           | `CanUseTool`        | no       | _(allow all)_                            | Permission gate invoked before each client tool's execute. Server-side tools bypass this hook.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `permissionMode`       | `PermissionMode`    | no       | _(allow all)_                            | Named preset — `'default'` / `'acceptEdits'` / `'bypassPermissions'` / `'plan'`. Translated to an internal `canUseTool`. Explicit `canUseTool` wins when both are set (and a `warn` log is emitted).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `allowedTools`         | `readonly string[]` | no       | _(none)_                                 | Pre-approve list. Plain name (`'read_file'` / `'Read'`) matches any invocation; scoped rules (`'Bash(npm *)'`, `'Edit(src/handlers.ts)'`) match a tool-specific argument. Layers on top of `permissionMode`; explicit `canUseTool` overrides both lists. Malformed rules throw at construction.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `disallowedTools`      | `readonly string[]` | no       | _(none)_                                 | Deny list with the same grammar as `allowedTools`. Denials win over both `allowedTools` and `permissionMode`. Explicit `canUseTool` overrides this list. Malformed rules throw at construction.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `onHook`               | `OnHook`            | no       | _(none)_                                 | Lifecycle callback. Auto-fired in order `Setup` → `SessionStart` → `PreToolUse`/`PostToolUse` pairs → `SessionEnd` → `Stop`. `Notification` is caller-emitted (via `ctx.notify` or direct `onHook` calls). When `enableSubagents: true`, the parent's `onHook` also receives `SubagentStart` / `SubagentEnd` around each `spawn_subagent` invocation AND the subagent's own inherited per-event hooks (its `Setup` → `SessionStart` → … → `Stop`). When `mcpServers` / `autoDiscoverMcp` resolve any servers, the parent's `onHook` also receives `McpServerStart` (per-server, after handshake) and `McpServerStop` (per-server, at teardown) — failed-init servers fire `Notification`/`mcp_server_failed` instead. `PreCompact` fires before each context-compaction call. Audit-only — thrown errors are logged and swallowed. |
| `onAskUserQuestion`    | `OnAskUserQuestion` | no       | _(none)_                                 | Host callback wired into the built-in `ask_user_question` tool. Receives a `UserQuestionRequest` (UUID `questionId`, auto-assigned `a`/`b`/`c`… option ids) and must resolve with a `UserQuestionResponse`. Omitted → the tool resolves with `{ error: 'no host handler registered for ask_user_question' }`. Ignored when a custom `tools` array is supplied.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `onTasksChanged`       | `OnTasksChanged`    | no       | _(none)_                                 | Convenience callback fired after every `task_create` / `task_update` mutation with the full latest task list (defensive shallow-copy). Equivalent to filtering `Notification` hook events on `message === 'tasks_changed'`. Ignored when a custom `tools` array is supplied.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `signal`               | `AbortSignal`       | no       | _(none)_                                 | External abort signal. Combined internally with the run's `abort()` method via `AbortSignal.any`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `logsRoot`             | `string`            | no       | `<cwd>/logs`                             | Directory for session logs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `baseUrl`              | `string`            | no       | OpenRouter production                    | Override the OpenRouter API base URL.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `appTitle`             | `string`            | no       | `openrouter-agent-coder`                 | App title sent in OR client metadata.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `logger`               | `AgentLogger`       | no       | _(silent)_                               | Diagnostic logger — `(level, message, fields?) => void`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `settingSources`       | `SettingSource[]`   | no       | `[]`                                     | Opt-in context-discovery list — `'project'` (walks up from `cwd` reading `CLAUDE.md` / `.claude/CLAUDE.md`, stops at the first `.git` or 10 levels), `'user'` (`<os.homedir()>/.claude/CLAUDE.md`), `'local'` (`<cwd>/.claude/CLAUDE.local.md`). Discovered content is prepended to `instructions` in user → project → local order. Default `[]` performs no FS reads.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `persistSession`       | `boolean`           | no       | `true`                                   | When `false`, the run uses an in-memory `StateAccessor` and skips every write under `logsRoot` (`session.json`, per-request `request.json`, per-generation `response.json`, `state.json`). The event stream is byte-identical to a persisted run, but resume across processes is impossible and external readers like `readSessionLog` see ENOENT for that sessionId.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `parentSessionId`      | `string`            | no       | _(none)_                                 | Set when this run continues a session forked from another. Threaded into `session.json` and surfaced on the `session_started` event payload. Defaults undefined — the field is omitted from both on-disk and event payloads for root sessions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `checkpoint`           | `boolean`           | no       | `false`                                  | When `true`, the built-in `write_file` and `edit_file` tools snapshot their target path under `<logsRoot>/<sessionId>/checkpoints/` _before_ mutating it. Per-call `checkpoint` field on those tools overrides this default. No-op (warn log + write proceeds) when paired with `persistSession: false`. Ignored when a custom `tools` array is supplied.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `enableSubagents`      | `boolean`           | no       | `false`                                  | Phase 4.7: when `true`, the built-in `spawn_subagent` tool is added to the default tool bundle and the agent wires an internal `SubagentRunner` that constructs child runs inheriting the parent's `apiKey` / `baseUrl` / `appTitle` / `logsRoot` / `logger` / `onHook` / `model` / `cwd` / `persistSession`. See the [Subagents](#subagents) subsection. Ignored when a custom `tools` array is supplied.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `maxSubagentDepth`     | `number`            | no       | `3`                                      | Phase 4.7: maximum chain depth for subagent recursion (root = `0`). `spawn_subagent` rejects when `parent.currentSubagentDepth + 1 >= maxSubagentDepth` — default `3` yields a chain of at most three levels (parent → sub → sub-sub → reject 4th). Threaded into every spawned subagent so the cap is uniform across the chain.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `currentSubagentDepth` | `number`            | no       | `0`                                      | Phase 4.7: this run's own position in the subagent chain (root = `0`, first subagent = `1`, …). Set internally by `spawn_subagent` when constructing a child run — **external callers should leave this undefined**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `maxParallelSubagents` | `number`            | no       | `4`                                      | Phase 4.9: maximum number of subagents allowed in-flight at once for a single `spawn_subagents` (plural) invocation. The plural tool's array may be longer than the cap; excess specs queue and submit in order as workers free up. Threaded onto every spawned child so the cap propagates uniformly down the chain. Ignored when a custom `tools` array is supplied.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `effort`               | `EffortLevel`       | no       | _(none)_                                 | Phase 5.4: per-run reasoning-depth override. One of `'xhigh' \| 'high' \| 'medium' \| 'low' \| 'minimal' \| 'none'`. Forwarded into the OR `callModel` call as `reasoning: { effort }` only when set; omitted runs send no `reasoning` field. OR normalizes the level and maps it to each provider's native param (OpenAI `reasoning_effort`, Anthropic `thinking.budget_tokens`, Gemini `thinkingLevel`, Qwen `thinking_budget`, xAI `reasoning_effort`), substituting the nearest supported level when a model lacks the requested one. Ignored by non-reasoning models.                                                                                                                                                                                                                                                         |
| `compactionThreshold`  | `number`            | no       | `getModelContextWindow(model) * 4 * 0.8` | Phase 5.1: character-count threshold that triggers auto-compaction once `ConversationState.messages` crosses it. Interpreted as **raw characters**, not tokens — opt out of the chars-per-token derivation by passing a literal value. Honoured only when `autoCompact !== false`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `keepRecentTurns`      | `number`            | no       | `5`                                      | Phase 5.1: number of trailing messages preserved verbatim during compaction. Older messages are condensed into a single `developer`-role summary. Treated at message granularity, not strict conversational-turn granularity (the SDK's `InputsUnion` mixes user / assistant / tool-call / tool-result items; a robust turn-boundary detector is deferred).                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `autoCompact`          | `boolean`           | no       | `true`                                   | Phase 5.1: when `false`, suppresses the post-`stream_complete` threshold check. The manual `run.compact()` method still works regardless of this setting — `autoCompact: false` gates **only** the implicit trigger.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

### `AgentCoreEvent`

Discriminated union yielded by `for await (... of run)`. Narrow on `event.type`.

| Variant           | Payload                                              | Notes                                                                           |
| ----------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| `session_started` | `{ sessionId, parentSessionId? }`                    | Fires once at the start of a run. `parentSessionId` is set only on forked runs. |
| `turn_start`      | `{ turnNumber }`                                     | Inner loop turn beginning (0-indexed).                                          |
| `text_delta`      | `{ content }`                                        | Streaming text chunk from the model.                                            |
| `tool_call`       | `{ callId, name, input }`                            | Model has emitted a function call. `input` is parsed JSON when valid.           |
| `tool_result`     | `{ callId, output, isError }`                        | Forwarded even after abort to surface cancellation observability.               |
| `turn_end`        | `{ turnNumber, usage, costUsd }`                     | Per-turn close-out with cumulative cost.                                        |
| `stream_complete` | `{ status, usage?, costUsd?, durationMs?, reason? }` | Terminal event. `status` is `success`/`max_turns`/`max_budget`/`error`.         |
| `error`           | `{ message, cause? }`                                | Non-fatal error; always followed by a `stream_complete` with `status: 'error'`. |

`HookEvent` and `HookPayload` are separately exported for `onHook` consumers; they are not part of `AgentCoreEvent`.

### Message-level stream

`run.messages()` returns an `AsyncIterable<AgentMessage>` — a typed, aggregated view over the same run as the event stream above. Text deltas within a turn collapse into a single `AssistantMessage.content.TextContent`; tool calls within the same turn append to that message's `content` array; tool results emit a `UserMessage`; the run begins with a `SystemMessage{subtype:'session_start'}` and terminates with a `ResultMessage` followed by `SystemMessage{subtype:'session_end'}`.

```ts
import { OpenRouterAgentRun, type AgentMessage } from 'openrouter-agent-coder';

const run = new OpenRouterAgentRun({ apiKey, sessionId, prompt });
for await (const msg of run.messages()) {
  switch (msg.type) {
    case 'system':
      // msg.subtype === 'session_start' | 'session_end'
      break;
    case 'assistant':
      // msg.content is an Array<TextContent | ToolUseContent>
      break;
    case 'user':
      // msg.content[0] is a ToolResultContent
      break;
    case 'result':
      // msg.status / usage / costUsd / durationMs / reason
      break;
  }
}
```

| Message            | Aggregation rule                                                                                                                                                           |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SystemMessage`    | One at the start (`session_start`) and one at the end (`session_end`), both carrying `sessionId`.                                                                          |
| `AssistantMessage` | One per turn that produced text and/or tool calls. `text_delta`s concatenate into a `TextContent`; each `tool_call` becomes a `ToolUseContent`. Empty turns yield nothing. |
| `UserMessage`      | One per `tool_result`. `output` is always stringified. Flushes any open `AssistantMessage` first so model output precedes its tool answer.                                 |
| `ResultMessage`    | Mirrors `stream_complete` (status / usage / costUsd / durationMs / reason). Always followed by `SystemMessage{session_end}`.                                               |

**One consumer per run.** `OpenRouterAgentRun` is single-shot — pick either `for await (... of run)` (raw events) **or** `run.messages()` (typed messages). The second call throws. Text and tool blocks within a single turn can interleave inside one `AssistantMessage` (Claude SDK parity: a tool call followed by more text opens a fresh `TextContent` after the `ToolUseContent`).

#### `canUseTool` example

```ts
const run = new OpenRouterAgentRun({
  apiKey,
  sessionId,
  prompt,
  canUseTool: async (name, input) => {
    if (name === 'run_command') return { behavior: 'deny', reason: 'shell disabled' };
    if (name === 'write_file') {
      const patched = { ...(input as object), path: `sandbox/${(input as any).path}` };
      return { behavior: 'allow', updatedInput: patched };
    }
    return { behavior: 'allow' };
  },
});
```

#### `permissionMode` example

```ts
const run = new OpenRouterAgentRun({
  apiKey,
  sessionId,
  prompt,
  // 'default' allows read_file / list_directory / grep_files; denies the rest
  // with reason 'requires approval'. Other modes: 'acceptEdits' (also allows
  // write_file / edit_file), 'bypassPermissions' (allow all), 'plan' (strictly
  // read-only — denies edits too).
  permissionMode: 'default',
});
```

When both `permissionMode` and `canUseTool` are supplied, the explicit `canUseTool` wins and a `'warn'`-level log is emitted via `logger`.

##### Plan mode

`permissionMode: 'plan'` denies every write/exec tool — `write_file`, `edit_file`, and `run_command` — while letting `read_file`, `list_directory`, and `grep_files` through. Use it when you want the model to explore the codebase and propose changes textually rather than applying them. The deny reason surfaced to the model on the blocked `tool_result` is `'plan mode: read-only — propose edits in your reply'` (a hint that it should describe edits in its next message instead of retrying the call); other modes still use the generic `'requires approval'`.

To poke a hole for a single tool (a custom tool you trust, or an explicit Bash command), layer `allowedTools` on top — its rules win over the plan-mode gate. `canUseTool` (the explicit callback) overrides plan mode entirely:

```ts
const run = new OpenRouterAgentRun({
  apiKey,
  sessionId,
  prompt,
  permissionMode: 'plan',
  // Still allow the model to invoke a read-only custom analyzer tool.
  allowedTools: ['my_analyzer'],
});
```

#### `allowedTools` / `disallowedTools` example

```ts
const run = new OpenRouterAgentRun({
  apiKey,
  sessionId,
  prompt,
  // Pre-approve any `npm` invocation, but deny `npm publish` outright.
  // `disallowedTools` wins over `allowedTools` for overlapping matches:
  // an `npm publish` call hits both rules, the deny rule takes precedence,
  // and the tool result surfaces a `denied: true` payload.
  allowedTools: ['Bash(npm *)'],
  disallowedTools: ['Bash(npm publish*)'],
});
```

Entries accept either a plain tool name (canonical `'read_file'` or the Claude-SDK-style alias `'Read'`) or a scoped rule `'ToolName(pattern)'`. Argument keys per tool: `Bash`/`run_command` → `command`, `Edit`/`Write`/`Read`/`List` → `path`, `Grep` → `pattern`. Bash patterns use `*` as the only wildcard (everything else is a regex literal); path patterns are globs with `*` (single segment) and `**` (multi-segment).

Resolution order per call: `disallowedTools` (deny wins) → `allowedTools` (allow) → `permissionMode` gate → allow. Explicit `canUseTool` overrides every higher-level option and emits one `warn` log mentioning all three names when more than one source is set.

#### `onHook` example

Seven hook events are exposed. Six are auto-fired by the runtime in this fixed order on every run:

1. `Setup` — fires once per `OpenRouterAgentRun` instance, BEFORE any other hook. Use for first-run resource provisioning (cache warmup, scratch directories, etc.). Still fires when the run is pre-aborted or the OR client constructor throws.
2. `SessionStart` — fires after the `session_started` event yields, carrying `sessionId` / `cwd` / `model`.
3. `PreToolUse` / `PostToolUse` — bracket each client tool call. `PreToolUse` always fires (audit, even when `canUseTool` denies); `PostToolUse.isError` mirrors the subsequent `tool_result.isError`. `PreToolUse` MAY return a `PreToolUseAction` to `block` or `modify` the call (see ["Hook + canUseTool precedence"](#hook--canusetool-precedence) below); a `void`/`undefined` return is treated as `continue` (audit-only — the historical contract).
4. `SessionEnd` — fires after `stream_complete`, with the final status / usage / cost.
5. `Stop` — fires LAST, regardless of how the run exited. Carries `status` and an optional `reason` (populated on abort or thrown-error paths).

The seventh event, **`Notification`**, is NOT auto-fired. Callers emit it themselves to surface progress or errors to subscribers — either by calling `onHook` directly or by using `ctx.notify(level, message, context?)` from inside a tool. When `onHook` is omitted, `ctx.notify` is undefined on the SDK tool context, so a `ctx.notify?.(...)` call no-ops cleanly.

```ts
import { tool } from 'openrouter-agent-coder';
import { z } from 'zod';

const indexFiles = tool({
  name: 'index_files',
  description: 'index files under a path',
  inputSchema: z.object({ path: z.string() }),
  execute: async ({ path }, ctx) => {
    // ctx.notify is wired through onHook when one is supplied — call it
    // unconditionally with `?.()` so the tool stays portable.
    await (ctx as { notify?: (l: string, m: string, c?: unknown) => Promise<void> }).notify?.(
      'info',
      'starting index',
      { path },
    );
    // ... real work ...
    return { indexed: 42 };
  },
});

const run = new OpenRouterAgentRun({
  apiKey,
  sessionId,
  prompt,
  tools: [indexFiles],
  onHook: async (event, payload) => {
    switch (event) {
      case 'Setup':
        // payload.sessionId, payload.cwd
        break;
      case 'SessionStart':
        // payload.sessionId, payload.cwd, payload.model
        break;
      case 'PreToolUse':
        // payload.toolName, payload.input, payload.callId
        //
        // Optional return value of type `PreToolUseAction`:
        //   { action: 'continue' }                  — proceed (same as void)
        //   { action: 'block', reason: 'why' }     — synth-deny the call
        //   { action: 'modify', input: { ... } }   — substitute the input
        if (payload.toolName === 'run_command') {
          const cmd = (payload.input as { command?: string }).command ?? '';
          if (cmd.startsWith('rm ')) {
            return { action: 'block', reason: 'rm not allowed by audit hook' };
          }
          if (cmd.startsWith('npm test')) {
            return { action: 'modify', input: { command: `${cmd} --reporter=dot` } };
          }
        }
        return; // void / undefined === { action: 'continue' }
      case 'PostToolUse':
        // payload.toolName, payload.input, payload.output, payload.isError, payload.callId
        // For hook-blocked calls, isError=true and output is the same
        // `{ error, denied: true }` JSON the canUseTool-deny path produces.
        break;
      case 'Notification':
        // payload.level, payload.message, payload.context
        break;
      case 'SessionEnd':
        // payload.status, payload.usage, payload.costUsd
        break;
      case 'Stop':
        // payload.status, payload.reason?
        break;
    }
  },
});
```

##### Hook + canUseTool precedence

When `PreToolUse` returns a `PreToolUseAction` and `canUseTool` is also set, evaluation order per call is:

1. `PreToolUse` fires.
   - `block` → tool is NOT executed; a synth-denial `tool_result` (shape `{ error: reason, denied: true }`) is surfaced and `PostToolUse` still fires with `isError: true` carrying the synth output. `canUseTool` is **never** consulted.
   - `modify` → the substituted `input` becomes the effective input for the rest of the call.
   - `continue` (or `void`) → no change.
2. `canUseTool` runs against the (possibly modified) input. It may still `deny` — that deny wins.
3. The tool executes with whatever input survived steps 1–2.

Precedence rules to remember:

- **Hook-`block` beats `canUseTool`-allow.** The hook fires first; blocking short-circuits the composition before `canUseTool` is even called.
- **`canUseTool`-`deny` beats hook-`continue`/`modify`.** The hook lets the call through; `canUseTool` is the second gate and can still refuse. The `tool_result` carries `canUseTool`'s reason (not the hook's), so denial sources are distinguishable.

Other invariants:

- `tool_call` event payloads always reflect the **original** input — `modify` is invisible at the event-stream layer except via the eventual `tool_result`. `PreToolUse.input` and `PostToolUse.input` likewise stay original (matching how `canUseTool`'s `updatedInput` is invisible on `PostToolUse`).
- A throw from a `PreToolUse` handler is logged via `logger` and treated as `continue` — never silently translated into a `block`. A malformed return shape is treated the same way, with a `warn` log naming the offending action.
- Backward compatible: handlers that return `void` from `PreToolUse` (the pre-3.7 contract) work unchanged.

#### Project context discovery example

Opt in to reading `CLAUDE.md` files from the working tree, the user home, and the local override:

```ts
const run = new OpenRouterAgentRun({
  apiKey,
  sessionId,
  prompt,
  // Composed into instructions in user → project → local order. Missing /
  // unreadable files are silently skipped. The composed total is capped at
  // ~50k characters; on overflow the oldest source is dropped first and a
  // `warn` log fires via `logger`.
  settingSources: ['user', 'project', 'local'],
});
```

Per-source lookup:

- `'project'` — walks up from `cwd`, picking up `<dir>/CLAUDE.md` and `<dir>/.claude/CLAUDE.md` at each level. Stops at the first directory containing `.git`, or after 10 levels.
- `'user'` — `<os.homedir()>/.claude/CLAUDE.md` (uses `os.homedir()`, not `process.env.HOME`).
- `'local'` — `<cwd>/.claude/CLAUDE.local.md`.

Default `[]` preserves prior behaviour — no FS reads, `instructions` (or `DEFAULT_INSTRUCTIONS`) is sent verbatim.

#### `AbortSignal` example

```ts
const ac = new AbortController();
setTimeout(() => ac.abort(), 5_000);

const run = new OpenRouterAgentRun({ apiKey, sessionId, prompt, signal: ac.signal });
for await (const event of run) {
  if (event.type === 'stream_complete' && event.reason === 'aborted') break;
}
```

You can also call `run.abort()` directly — it's combined with the external `signal` via `AbortSignal.any`.

#### Host integration — asking the user questions

The built-in `ask_user_question` tool lets the model surface multiple-choice clarifications that the host UI renders and the user answers. Wire it by passing `onAskUserQuestion` on the constructor:

```ts
import {
  OpenRouterAgentRun,
  type UserQuestionRequest,
  type UserQuestionResponse,
} from 'openrouter-agent-coder';

const run = new OpenRouterAgentRun({
  apiKey,
  sessionId,
  prompt,
  onAskUserQuestion: async (req: UserQuestionRequest): Promise<UserQuestionResponse> => {
    // Render req.question + req.options in your UI; resolve once the user
    // picks an option. `req.questionId` echoes back so you can correlate.
    const chosen = await showHostUiPicker(req); // your code
    return { questionId: req.questionId, selectedOptionId: chosen.id };
  },
});
```

Library-side types:

```ts
type UserQuestionRequest = {
  questionId: string; // UUID assigned by the library
  question: string;
  options: Array<{ id: string; label: string; preview?: string }>; // ids are 'a','b','c',… lexicographically
  allowFreeText?: boolean;
};
type UserQuestionResponse = {
  questionId: string;
  selectedOptionId?: string;
  freeTextAnswer?: string;
};
```

Behaviour:

- Option ids are auto-assigned `'a'`–`'z'` (max 26 options; the Zod schema rejects more). Hosts must echo back one of those ids in `selectedOptionId`.
- The tool result returned to the model has shape `{ selectedOptionId, label, freeTextAnswer? }` — `label` is looked up from the request's options array so the model never has to remember the lettering. When the host's `selectedOptionId` doesn't match any option, `label` is omitted.
- Default wait is 5 minutes (`300_000` ms); pass `timeout_ms` per call to override, clamped at 10 minutes (`600_000`). Over-cap timeouts emit a `'warn'`-level `Notification` hook before clamping.
- Aborting the run (`signal` or `run.abort()`) resolves the pending question promptly with `{ error: 'aborted' }`.
- A missing `onAskUserQuestion` resolves with `{ error: 'no host handler registered for ask_user_question' }` — the model gets a real tool-result and can recover instead of throwing.
- Each call also fires the `Notification` lifecycle hook with `level: 'info'`, `message: 'ask_user_question'`, and `context = UserQuestionRequest`. Subscribers that only listen on `onHook` (logs, dashboards, non-UI sinks) still observe every question.

#### Host integration — task tracking

The built-in `task_create` / `task_update` tools maintain a per-run task list that survives across turns but is **never persisted to `state.json`** (ephemeral; lost when the process exits). On every mutation the library pushes the full latest list to two channels: the `Notification` hook (so log/audit subscribers see it) and the optional `onTasksChanged` constructor callback (so a host UI doesn't have to filter every Notification).

```ts
import { OpenRouterAgentRun, type Task, type OnTasksChanged } from 'openrouter-agent-coder';

const onTasksChanged: OnTasksChanged = (tasks: Task[]) => {
  // Re-render the task panel. `tasks` is a defensive shallow-copy — safe to retain.
  renderTaskList(tasks);
};

const run = new OpenRouterAgentRun({
  apiKey,
  sessionId,
  prompt,
  onTasksChanged,
});
```

Library-side types:

```ts
type TaskState = 'pending' | 'in_progress' | 'completed' | 'cancelled';
type Task = { id: string; content: string; state: TaskState; activeForm?: string };
type TaskListChangedNotification = { tasks: Task[] };
type OnTasksChanged = (tasks: Task[]) => void;
```

Behaviour:

- `task_create` returns `{ id }` where `id` is a UUID. New tasks start in state `pending`.
- `task_update` requires `taskId` + `state`; `content` is optional (rewrites the description only when provided). Unknown ids resolve with `{ error: 'unknown task id: <id>' }` (tool-error path — the model sees the error and can recover). The state enum is validated by Zod; invalid values are rejected at schema-validation time.
- Both tools emit a single `Notification` hook per call with `level: 'info'`, `message: 'tasks_changed'`, and `context: TaskListChangedNotification` (the full latest list, not a diff). The same payload flows through `onTasksChanged` when wired.
- The task list is in-memory only. Resuming a session by `sessionId` does NOT restore the previous run's task list — host code that needs persistence should mirror the `onTasksChanged` callback to its own store.

#### Session forking

Phase 4.5 ships a `forkSession()` helper and an `OpenRouterAgentRun.fork()` instance method. A fork copies the source session's on-disk `state.json` into a new session directory under the same `logsRoot` and writes a fresh `session.json` whose `parentSessionId` points back at the source. Per-request subdirectories (`req_*` / `gen_*`) are **not** copied — the fork inherits the OR `previousResponseId` chain via `state.json` alone, which is everything `callModel` needs to resume the conversation.

```ts
import { OpenRouterAgentRun, forkSession } from 'openrouter-agent-coder';

// 1) Run a session that persists state to disk.
const root = new OpenRouterAgentRun({
  apiKey,
  sessionId: 'root-abc',
  prompt: 'pick a starting move',
});
for await (const _ of root) {
  /* drain events */
}

// 2a) Fork via the instance helper (reuses the run's logsRoot + sessionId).
const { sessionId: childId } = await root.fork();

// 2b) Or fork via the standalone helper (caller supplies logsRoot).
const { sessionId: child2Id } = await forkSession({
  sessionId: 'root-abc',
  logsRoot: './logs',
  newSessionId: 'my-chosen-id', // optional; UUID v4 minted when omitted
});

// 3) Continue the conversation in a new run, tagged with the parent for lineage.
const branch = new OpenRouterAgentRun({
  apiKey,
  sessionId: childId,
  prompt: 'try a different opening',
  parentSessionId: 'root-abc',
});
```

Library-side signatures:

```ts
interface ForkSessionOptions {
  sessionId: string; // source — must have an on-disk state.json
  newSessionId?: string; // auto-minted (UUID v4) when omitted
  logsRoot: string; // required — no <cwd>/logs default
}
interface ForkSessionResult {
  sessionId: string;
}
function forkSession(opts: ForkSessionOptions): Promise<ForkSessionResult>;
```

Behaviour:

- The standalone `forkSession()` requires `logsRoot`; there is no `<cwd>/logs` fallback (the library reserves exactly one `process.cwd()` call site at the `OpenRouterAgentRun` constructor default). `OpenRouterAgentRun.fork()` reuses the run's already-resolved `logsRoot` so callers driving the instance method never need to supply one.
- `state.json` is copied via atomic write (`*.tmp` → `rename`). The forked file is genuinely independent — mutating one does not affect the other.
- `session.json` carries forward the source's `cwd` when present (best-effort: a missing source `session.json` is non-fatal — the fork still succeeds and just omits `cwd`).
- Forking a `persistSession: false` run via `run.fork()` rejects synchronously with `cannot fork in-memory session: <sessionId> has no on-disk state at <logsRoot>/<sessionId>/state.json` — the check is local (no FS round-trip) and fires before any I/O. Calling the standalone `forkSession()` with the same source id yields the same error.
- Lineage is opt-in on the consuming side: pass `parentSessionId` to the next `OpenRouterAgentRun` to record the link on `session.json` and surface it on `session_started`. The library does not look up or validate the parent; consumers wire the chain themselves.

#### File checkpointing

Phase 4.6 adds pre-write file checkpointing to the built-in `write_file` and `edit_file` tools. When the run is constructed with `checkpoint: true` — or when an individual tool call passes `{ checkpoint: true }` in its arguments — the library snapshots the target path under `<logsRoot>/<sessionId>/checkpoints/<checkpointId>/` before the mutation lands, so the change can be reverted later with `restoreCheckpoint()`.

```ts
import { OpenRouterAgentRun, listCheckpoints, restoreCheckpoint } from 'openrouter-agent-coder';

const run = new OpenRouterAgentRun({
  apiKey,
  sessionId: 'demo',
  prompt: 'make some edits',
  checkpoint: true, // every write_file / edit_file snapshots first
});
for await (const _ of run) {
  /* drain events */
}

// Inspect snapshots, then rewind to one of them.
const checkpoints = await listCheckpoints('demo', './logs');
const { filesRestored } = await restoreCheckpoint(checkpoints[0]!.checkpointId, 'demo', './logs');
```

On-disk layout under the session directory:

```
<logsRoot>/<sessionId>/checkpoints/
  <checkpointId>/                # uuid v4
    manifest.json                # { checkpointId, timestamp, files: [...] }
    <encoded-original-path>.snapshot   # raw bytes; absent for tombstones
    ...
```

Path encoding replaces every `/` (including the leading `/` of absolute paths) with the sentinel token `__SLASH__`, so each snapshot fits in a single filesystem basename. The encoder / decoder pair (`encodePath`, `decodePath`) round-trips losslessly. Files that did not exist at checkpoint time are recorded as **tombstones** in `manifest.json` (`existed: false`, no `.snapshot` file); restoring a tombstone removes the live path if it currently exists.

Library-side signatures:

```ts
function createCheckpoint(
  sessionId: string,
  logsRoot: string,
  files: string[],
  options?: { logger?: CheckpointLogger },
): Promise<Checkpoint>;

function listCheckpoints(sessionId: string, logsRoot: string): Promise<Checkpoint[]>;

function restoreCheckpoint(
  checkpointId: string,
  sessionId: string,
  logsRoot: string,
): Promise<{ filesRestored: string[] }>;
```

Behaviour:

- Auto-checkpointing is **off by default**. The constructor option (`checkpoint: true`) turns it on for the whole run; the per-call `{ checkpoint: true | false }` argument on `write_file` / `edit_file` always wins over the constructor default.
- `persistSession: false` interaction: when the run is in-memory, requested checkpoints are a NO-OP. The library emits a `'warn'`-level log (`'checkpoint requested but persistSession is false'`) and the underlying write proceeds normally — no snapshot directory is created.
- `restoreCheckpoint` is atomic across the manifest. Every restored file is first staged into `<checkpointDir>/.restore-tmp/`, then `fs.rename()`d into place once every staged file is ready. Tombstoned paths are unlinked last (after all renames succeed). The `.restore-tmp/` directory is cleaned up on every exit path (success and error).
- Each session is capped at `MAX_CHECKPOINTS_PER_SESSION = 100` checkpoints. New checkpoints beyond the cap evict the oldest (by `timestamp`, ascending) and emit a `'warn'`-level log via the optional logger. The cap is a module-level constant — not per-session configurable in v1.
- Fast-path: when creating a checkpoint, if the target file has the **same `mtimeMs` and `size`** as in its most-recent prior snapshot in this session, the new snapshot is created by hard-linking to the prior one (`fs.link`) instead of re-copying the bytes. Falls through to a regular `copyFile` on cross-filesystem (`EXDEV`) or unsupported FS errors.

#### Context compaction

Phase 5.1: long-running sessions whose persisted message history grows past the active model's context window are condensed in-place by an auto-compaction pass. When the char-length of `ConversationState.messages` crosses `compactionThreshold` between runs, the library spawns a single isolated `callModel` (session id `<sessionId>:compact:<uuid>`, no tools) that summarizes the prefix into a `developer`-role message, then rewrites the persisted state to `[summary, ...lastN]` where `N = keepRecentTurns`. `previousResponseId` is cleared on the rewrite so the server cannot splice a stale response chain onto the new input array (see [spike 5.S1 §2d](./plans/spikes/5.S1-message-history.md)).

| Option                | Type      | Default                                                        | Description                                                                                                                           |
| --------------------- | --------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `compactionThreshold` | `number`  | `getModelContextWindow(model) * 4 * 0.8` _(chars, not tokens)_ | Threshold in **characters** (v1 ships no tokenizer dep — the default applies a conservative ~4 chars/token estimate at 80% headroom). |
| `keepRecentTurns`     | `number`  | `5`                                                            | Number of trailing messages preserved verbatim. Treated at message granularity, not strict conversational turns.                      |
| `autoCompact`         | `boolean` | `true`                                                         | Suppress the in-`finally` threshold check when `false`. `compact()` still works.                                                      |

```ts
import { OpenRouterAgentRun, getModelContextWindow } from 'openrouter-agent-coder';

// Auto-trigger when ~64% of GPT-4o's 128k window worth of chars accumulates.
const tokens = getModelContextWindow('openai/gpt-4o');
const run = new OpenRouterAgentRun({
  apiKey,
  sessionId: 'demo',
  prompt: 'continue',
  model: 'openai/gpt-4o',
  compactionThreshold: tokens * 4 * 0.64,
  keepRecentTurns: 8,
});
for await (const _ of run) {
  /* drain events */
}

// Force a compaction at any time between runs that share the sessionId.
await run.compact();
```

The new `PreCompact` lifecycle event fires right before each compaction call. It is **audit-only** — return values are ignored and thrown errors are logged + swallowed. Typical use is archiving the about-to-be-discarded prefix to external storage so audit consumers retain it after the on-disk state is rewritten.

```ts
import { OpenRouterAgentRun } from 'openrouter-agent-coder';

const run = new OpenRouterAgentRun({
  apiKey,
  sessionId: 'demo',
  prompt: 'work',
  onHook: async (event, payload) => {
    if (event !== 'PreCompact') return;
    // payload is { event, messages, keepRecentTurns, reason: 'auto' | 'manual' }
    await archivePrefix(payload.messages);
  },
});
```

The `getModelContextWindow(model)` helper is exported so consumers can compute their own threshold without re-deriving the table — it falls back to `DEFAULT_CONTEXT_WINDOW_TOKENS` (128k) for unknown models. The complete static table is also exported as `MODEL_CONTEXT_WINDOWS`.

**Mid-run safety.** `compact()` is designed to be called between runs that share a `sessionId`, not mid-`for await`. The run iterator is single-shot and the SDK manages the in-memory `ConversationState` while a stream is active; calling `compact()` while `iterate()` is still yielding will race with the SDK's own `state.save()` calls and may corrupt the persisted JSON. Guarded at runtime — a `compact()` call from outside the iter while iteration is in flight throws synchronously. Auto-compaction fires inside the iterator's `finally` block, so the trigger runs whether the consumer drains the stream to completion OR `break`s on `stream_complete` (the generator's `return()` still runs finally).

#### Subagents

Phase 4.7: opt-in `spawn_subagent` built-in tool. Lets the parent model delegate a focused subtask to a child `OpenRouterAgentRun` with its own session id and (optionally) a narrowed tool whitelist. The parent waits for the subagent to complete and receives the subagent's final assistant text plus status/cost as a single `tool_result` — the subagent's own event stream stays internal to the runner.

```ts
import { OpenRouterAgentRun } from 'openrouter-agent-coder';
import { randomUUID } from 'node:crypto';

const run = new OpenRouterAgentRun({
  apiKey,
  sessionId: randomUUID(),
  prompt:
    'Use spawn_subagent to research how Foo handles edge cases, ' +
    'then summarize the findings and write the fix.',
  enableSubagents: true, // bundles spawn_subagent into the default tool set
  maxSubagentDepth: 3, // optional; default 3 (chain of at most parent → sub → sub-sub)
  onHook: async (event, payload) => {
    if (event === 'SubagentStart') {
      console.log(`[subagent] start depth=${payload.depth} id=${payload.subagentSessionId}`);
    } else if (event === 'SubagentEnd') {
      console.log(
        `[subagent] end status=${payload.result.status} cost=$${payload.result.costUsd ?? 0}`,
      );
    }
  },
});

for await (const event of run) {
  if (event.type === 'tool_call' && event.name === 'spawn_subagent') {
    console.log(`spawning subagent: ${(event.input as { description?: string }).description}`);
  } else if (event.type === 'tool_result' && event.callId) {
    // The subagent's captured summary surfaces here as the tool_result output.
  }
}
```

Tool input schema (zod):

| Field              | Type             | Required | Default                    | Description                                                                                                                                                                                                                              |
| ------------------ | ---------------- | -------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `description`      | `string`         | yes      | —                          | Prompt handed to the subagent.                                                                                                                                                                                                           |
| `tools`            | `string[]`       | no       | _(inherit parent pool)_    | Whitelist of tool names. Unknown names are silently dropped. Whitelist NARROWS — it does not extend.                                                                                                                                     |
| `instructions`     | `string`         | no       | parent's `instructions`    | System instructions override.                                                                                                                                                                                                            |
| `max_turns`        | `number`         | no       | parent's `maxTurns`        | Per-subagent turn cap.                                                                                                                                                                                                                   |
| `max_budget_usd`   | `number`         | no       | parent's `maxBudgetUsd`    | Per-subagent cost cap in USD.                                                                                                                                                                                                            |
| `model`            | `string`         | no       | parent's resolved `model`  | Phase 4.8: per-subagent model override.                                                                                                                                                                                                  |
| `permission_mode`  | `PermissionMode` | no       | parent's `permissionMode`  | Phase 4.8: per-subagent permission preset (`'default'` / `'acceptEdits'` / `'bypassPermissions'` / `'plan'`).                                                                                                                            |
| `allowed_tools`    | `string[]`       | no       | parent's `allowedTools`    | Phase 4.8: per-subagent allow list using the same rule grammar as `OpenRouterAgentRun.allowedTools`. **REPLACES** the parent's list.                                                                                                     |
| `disallowed_tools` | `string[]`       | no       | parent's `disallowedTools` | Phase 4.8: per-subagent deny list using the same rule grammar as `OpenRouterAgentRun.disallowedTools`. **REPLACES** the parent's list.                                                                                                   |
| `effort`           | `EffortLevel`    | no       | parent's `effort`          | Phase 5.4: per-subagent reasoning-depth override (`'xhigh' \| 'high' \| 'medium' \| 'low' \| 'minimal' \| 'none'`). Forwarded into the child's `callModel` call as `reasoning: { effort }`. **REPLACES** the parent's `effort` when set. |

Composition layers (innermost → outermost) when a spawn call uses both `tools` and a permission filter:

1. `tools` (Phase 4.7) narrows the inherited tool **pool** by name.
2. `permission_mode` (Phase 3.1) gates each call by canonical tool name.
3. `allowed_tools` / `disallowed_tools` (Phase 3.2) layer scoped rules on top of the mode gate.
4. An optional caller-supplied `canUseTool` is the final word.

Per-subagent overrides REPLACE the parent's resolved value on the child run's constructor (parent's filters do NOT bleed into the child). Override semantics are designed so a `permission_mode: 'plan'` spawn from a `bypassPermissions` parent isolates the restriction to the child; the parent's own subsequent tool calls remain unrestricted. Phase 5.4 wired `effort` through to the child's `callModel` call (`reasoning: { effort }`) using the same inheritance rails — the parent's `effort` falls through to the child when the spawn call omits its own override.

Tool result (success):

```ts
{
  subagentSessionId: '<parentSessionId>:sub:<uuid>',
  status: 'success' | 'max_turns' | 'max_budget' | 'error',
  text: '<concatenated assistant text>',
  costUsd?: number,
  durationMs?: number,
  usage?: TokenUsage | null,
  reason?: string,
}
```

Tool result (depth-cap rejection or runner throw):

```ts
{ error: 'max subagent depth (3) exceeded', subagentSessionId: '...' }
```

Lifecycle hooks fire on the parent's `onHook` for every subagent invocation — order on the happy path: `PreToolUse(spawn_subagent)` → `SubagentStart` → _(subagent's full hook stream: `Setup` → `SessionStart` → … → `SessionEnd` → `Stop`)_ → `SubagentEnd` → `PostToolUse(spawn_subagent)`. Both `SubagentStart` and `SubagentEnd` fire even on the depth-cap rejection path so audit consumers see a matched Start/End pair.

Key invariants:

- **Subagent events do not bleed.** Anything the subagent yields (`session_started`, `text_delta`, `tool_call`, `tool_result`, `turn_end`, `stream_complete`) is consumed inside the `runSubagent` closure. The parent's `for await` only sees the single `tool_result` carrying the captured summary.
- **Inheritance.** Subagent inherits parent's `apiKey` / `baseUrl` / `appTitle` / `logsRoot` / `logger` / `onHook` / `model` / `cwd` / `persistSession`. New: `sessionId` (`<parentSessionId>:sub:<uuid>`), `prompt` (the spawn `description`), and a composite `signal` (`AbortSignal.any([parentSignal, subagentInternalCtl.signal])`).
- **Abort cascade.** Parent `abort()` → parent signal fires → composite signal fires → child `OpenRouterAgentRun` aborts → cascades all the way down the chain.
- **Recursion cap.** `parent.currentSubagentDepth + 1 >= maxSubagentDepth` (default 3) → reject with `{ error: 'max subagent depth (3) exceeded', subagentSessionId }`. Tunable via `OpenRouterAgentRun({ maxSubagentDepth })`. The cap is threaded into every spawned child so it stays uniform across the whole chain.
- **Parallel fan-out via `spawn_subagents` (plural).** Phase 4.9 adds a sibling tool — see the [Parallel subagents](#parallel-subagents) subsection below. The singular `spawn_subagent` remains the right tool for one-off delegation. Per-subagent `model` / `permission_mode` / `allowed_tools` / `disallowed_tools` / `effort` overrides shipped in Phase 4.8 (see the schema table above); Phase 5.4 wired `effort` end-to-end into the child's `callModel` request.
- **Ignored with custom `tools`.** When the parent run is constructed with a custom `tools` array, `enableSubagents` is a no-op (callers wire their own `spawn_subagent` / `spawn_subagents` via `spawnSubagentTool` / `spawnSubagentsTool({ runSubagent, … })` if they need them).

##### Parallel subagents

Phase 4.9: opt-in `spawn_subagents` (plural) built-in tool, bundled alongside `spawn_subagent` whenever `OpenRouterAgentRun({ enableSubagents: true })` is set. Lets the parent model delegate **multiple independent subtasks** to child agents that run concurrently, with a concurrency cap and per-child failure isolation. Results return in submission order regardless of completion order; aggregate cost and token totals sum across successful children only.

```ts
const run = new OpenRouterAgentRun({
  apiKey,
  sessionId: randomUUID(),
  prompt: 'Use spawn_subagents to research three approaches in parallel.',
  enableSubagents: true, // bundles BOTH spawn_subagent and spawn_subagents
  maxParallelSubagents: 4, // optional; default 4 — at most 4 children in flight at once
});
```

Tool input schema (zod):

| Field       | Type            | Required | Default | Description                                                                                                                                                                                                                                                                                                                                                   |
| ----------- | --------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subagents` | `Array<…>` (≥1) | yes      | —       | 1 to `MAX_PARALLEL_BATCH_SIZE` (=16) entries. Each element accepts the same per-spec fields as `spawn_subagent` — `description` (required) plus optional `tools` / `instructions` / `max_turns` / `max_budget_usd` / `model` / `permission_mode` / `allowed_tools` / `disallowed_tools` / `effort`. Per-spec overrides propagate independently to each child. |

Tool result:

```ts
{
  results: Array<
    | { status: 'success'; subagentSessionId: string; output: SubagentResultSummary }
    | {
        status: 'error';
        subagentSessionId: string;
        output: SubagentResultSummary | null;
        error: string;
      }
    | {
        status: 'aborted';
        subagentSessionId: string;
        output: SubagentResultSummary | null;
        error: 'aborted';
      }
  >;
  aggregatedUsage: {
    usd: number;
    tokensIn: number;
    tokensOut: number;
    totalTokens: number;
  }
  durationMs: number;
}
```

Key invariants:

- **Concurrency cap.** Inline promise pool (no `p-limit` dep) honors the `maxParallelSubagents` ctor option (default `4`). Submitting an array longer than the cap queues the extras; results still return in submission order.
- **Per-child failure isolation.** A child that throws, hits a non-success terminal status, or rejects at the depth cap is captured as a single `{ status: 'error', error }` envelope without disturbing siblings — no fail-fast. The aggregate cost / tokens sum SUCCESSFUL envelopes only.
- **Abort cascade.** Each child's signal is composed via `AbortSignal.any([parentSignal, subagentInternalCtl.signal])`, so the parent's `abort()` fans out into every in-flight child. Aborted children surface `status: 'aborted'` (mapped from the underlying `reason: 'aborted'`) so the parent model can distinguish cancellation from other failures.
- **Recursion cap.** Reuses the same `maxSubagentDepth` gate as `spawn_subagent`. A depth-N parent at the cap rejects EACH spec with a per-child `{ status: 'error', error: 'max subagent depth (N) exceeded' }` envelope and STILL fires a matched `SubagentStart` / `SubagentEnd` pair per child so audit consumers see the rejection.
- **Lifecycle hooks.** `SubagentStart` / `SubagentEnd` fire once per child (no new event types). Pairs may interleave when children run in parallel — consumers must correlate on `subagentSessionId`.
- **Budget propagation.** Each child inherits the parent's `maxBudgetUsd` independently by default; per-spec `max_budget_usd` overrides per-child. The aggregate `usd` may therefore exceed any single child's cap, but no single child can exceed its own.
- **Schema ceiling.** The array is capped at `MAX_PARALLEL_BATCH_SIZE = 16` at parse time — comfortably larger than the default concurrency pool so typical fan-outs have headroom without inviting runaway batches.

### `accountInfo(opts)`

Look up an OpenRouter key's label, usage, and credit limit.

```ts
import { accountInfo } from 'openrouter-agent-coder';

const info = await accountInfo({ apiKey });
// → { provider: 'openrouter', label: 'sk-…', usageUsd: 12.34, limitUsd: 100 } | null
```

Returns `null` for 401/403 (invalid key); throws for other HTTP failures. Optional `baseUrl` override.

### `supportedModels(opts)`

List models the OR endpoint advertises.

```ts
import { supportedModels } from 'openrouter-agent-coder';

const models = await supportedModels({ apiKey });
// → [{ value: '~anthropic/claude-sonnet-latest', displayName: '…', description: '…' }, …]
```

Throws on non-OK responses. Optional `baseUrl` override.

### `allTools`

The bundled tool preset — `allTools({ cwd, signal })` returns the twelve client tools below, context-bound. It is the default value for `OpenRouterAgentRun`'s `tools` option; you only need to reference it directly when composing a custom tool array.

### Custom tools

For host code adding its own tools, the library re-exports a Claude-Agent-SDK-shaped `tool()` helper that takes a Zod schema and a typed `execute` callback:

```ts
import { z } from 'zod/v4';
import { OpenRouterAgentRun, allTools, tool, createSdkMcpServer } from 'openrouter-agent-coder';

const fetchIssue = tool({
  name: 'fetch_issue',
  description: 'Fetch a GitHub issue by repo + number',
  inputSchema: z.object({
    repo: z.string().describe('owner/name slug'),
    number: z.number().int().positive(),
  }),
  execute: async ({ repo, number }) => {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues/${number}`);
    return await res.json();
  },
});

const run = new OpenRouterAgentRun({
  apiKey: process.env.OPENROUTER_API_KEY!,
  sessionId: 'my-session',
  prompt: 'Summarize Cybourgeoisie/openrouter-agent-coder issue #44',
  tools: [...allTools({ cwd: process.cwd() }), fetchIssue],
});
```

Zod validation runs before `execute`; an invalid input is surfaced as `tool_result.isError = true` with a message naming the tool and the offending field (the run keeps going). Tools built via `tool()` integrate with `canUseTool`, `onHook`, `allowedTools`/`disallowedTools`, and `permissionMode` exactly like the built-ins.

`createSdkMcpServer({ name, version, tools })` bundles a group of tools into a named, versioned value bag (`{ name, version, tools }`). The `tools` field spreads straight into `OpenRouterAgentRunOptions['tools']`:

```ts
const issueServer = createSdkMcpServer({
  name: 'github-issues',
  version: '0.1.0',
  tools: [fetchIssue],
});

new OpenRouterAgentRun({
  /* … */ tools: [...allTools({ cwd: process.cwd() }), ...issueServer.tools],
});
```

Pair this with the [MCP server integration](#mcp-server-integration) section below to wire SDK-defined tools alongside real external MCP servers (`stdio` subprocesses, Streamable HTTP / SSE endpoints, or `.mcp.json`-discovered ones) in the same run.

### MCP server integration

Phase 5.2 ships full Model Context Protocol (MCP) support — `OpenRouterAgentRun` can spawn one or more MCP servers per run, list their tools/resources/prompts, route the model's tool calls to the originating server, and tear everything down when the run ends. The integration is **public API-stable** as of Phase 5.2.5; transports and config-discovery are wrapped around [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) (lazy-loaded, so users without configured MCP servers pay zero cold-start cost).

#### Quick start

```ts
import { OpenRouterAgentRun, loadMcpConfig } from 'openrouter-agent-coder';

const servers = await loadMcpConfig({ cwd: process.cwd() });
const run = new OpenRouterAgentRun({
  apiKey: process.env.OPENROUTER_API_KEY!,
  sessionId: 'demo',
  prompt: 'Summarise my open Linear issues.',
  mcpServers: servers,
});
for await (const ev of run) {
  /* … */
}
```

#### Constructor options

| Option            | Type                         | Default | Behaviour                                                                                                                                                                                                       |
| ----------------- | ---------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcpServers`      | `readonly McpServerConfig[]` | —       | Explicit server list. Use the discriminated union returned by `loadMcpConfig()` or build entries by hand. Overrides `autoDiscoverMcp` when set (even `[]` opts out of discovery entirely).                      |
| `autoDiscoverMcp` | `boolean`                    | `false` | When `mcpServers` is undefined, set to `true` to run `loadMcpConfig({ cwd })` at iter start and spawn whatever it returns. Defaults to `false` so a library consumer never auto-spawns user processes silently. |

#### `.mcp.json` config file

`loadMcpConfig()` is a pure async loader for `.mcp.json` discovery in two scopes:

- **`'user'`** — `<os.homedir()>/.mcp.json` (NOT `process.env.HOME`).
- **`'project'`** — walk up from `cwd` reading `<dir>/.mcp.json` at each level, stopping at the first `.git` ancestor or after 10 directories. Deeper-dir entries override shallower-dir entries by server name.

Default scope order is `['user', 'project']` so project entries override user entries (full replacement, not deep merge). When `cwd` is omitted the project scope is silently skipped — the codebase preserves a single `process.cwd()` resolution point at the agent boundary.

```jsonc
// .mcp.json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["server.js"],
      "env": { "FOO": "bar" },
      // "transport": "stdio" — optional; inferred from `command`/`url`
    },
    "remote": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer …" },
    },
  },
}
```

Each loaded entry includes a `source` field with the absolute path of the originating file. Schema violations (missing both `command` and `url`, having both, invalid URL, etc.) throw with the file path in the message.

#### Transports

Two transport variants are supported, selected by the entry's shape:

- **`stdio`** (selected by `command`): spawns a subprocess and speaks MCP over its stdin/stdout. Use for local MCP servers shipped as executables or scripts.
- **`http`** (selected by `url`): speaks MCP over HTTP. Internally this maps to one of two SDK transports — by default the **modern Streamable HTTP** transport (HTTP POST for sending, GET + SSE for streamed responses, stateful sessions via `Mcp-Session-Id`, resumable via `Last-Event-ID`). The legacy plain **SSE** transport is also supported by the underlying `McpHttpClient` for back-compat with servers that haven't migrated yet — see below.

Low-level transport clients (`McpStdioClient`, `McpHttpClient`) live under `openrouter-agent-coder/dist/mcp/`. Both expose the same surface (`connect` / `close` / `listTools` / `callTool` / `listResources` / `readResource` / `listPrompts` / `getPrompt`, each accepting a trailing `signal?: AbortSignal`); reach for them directly only when you need MCP I/O outside an `OpenRouterAgentRun`.

A custom factory can swap the SDK transport for any subclass of `Transport` — when wiring a custom `mcpServers` array by hand, hosts that need the deprecated SSE transport can supply their own `McpHttpClient({ transport: 'sse', … })`.

#### Tool naming and dispatch

Each server's tools surface in the run's tool array under the prefixed name `<serverName>__<toolName>` — two underscores. Two servers exposing the same `toolName` therefore land on distinct prefixed names (`linear__list_issues` and `github__list_issues` coexist with no collision). The separator is exported as `MCP_TOOL_NAME_SEPARATOR` from `openrouter-agent-coder/dist/mcp/bridge.js`. Tool calls the model issues against a prefixed name are routed back to the originating server's `callTool` — schema is passed through verbatim (the bridge stores the MCP `inputSchema` on a `z.unknown().meta(...)` Zod schema so the OR SDK's `convertZodToJsonSchema` emits the original JSON Schema to the model unchanged; the MCP server validates inputs at its own JSON-RPC boundary).

#### Lifecycle

The bridge spawns lazily at the top of `iterate()` — after the `Setup` hook fires, before the first `callModel` — and tears down in the generator's `finally` block (success / abort / mid-stream throw all reach the same cleanup path). Lifecycle is **per-run**: no pooling across runs that share a `sessionId`. Connections close when the run ends.

Three hook events publish bridge state through the run's `onHook` callback:

| Event                                | Fires when                                                                                                                                                                                      | Payload                                                                                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `McpServerStart`                     | One per server, immediately after its JSON-RPC `initialize` handshake succeeds and the bridge has finished `listTools`/`listResources`/`listPrompts`. Init failures do **not** fire this event. | `{ serverName, transport: 'stdio' \| 'streamableHttp' \| 'sse', capabilities: { tools, resources, prompts } }` (capability counts only). |
| `McpServerStop`                      | One per server, at bridge teardown. Only servers that previously fired `McpServerStart` fire `McpServerStop` (symmetric — failed-init servers fire neither).                                    | `{ serverName, durationMs, reason: 'closed' \| 'error' \| 'aborted' }`.                                                                  |
| `Notification` (`mcp_server_failed`) | One per server whose handshake failed (`spawn ENOENT`, HTTP 401, `tools/list` rejection, etc.). The bridge also logs at `warn` level.                                                           | Standard `Notification` envelope with `level: 'warn'`, `message: 'mcp_server_failed'`, `context: { name, transport, source, error }`.    |

The `reason` field on `McpServerStop` distinguishes:

- `'closed'` — normal teardown at the end of a successful run.
- `'error'` — the underlying `client.close()` threw.
- `'aborted'` — the run-level signal was aborted at close time (mid-stream cancel).

All three events are audit-only — return values are ignored and a thrown handler is logged + swallowed (the run continues). `durationMs` uses `Date.now()` (millisecond precision); no `performance.now()`.

#### Init-failure policy

A single server failing its handshake does **not** crash the run. The bridge logs at `warn` level, fires the `mcp_server_failed` Notification, and continues with the remaining servers — the run still produces output from its built-in tools plus the surviving MCP servers.

#### Permissions

MCP tools flow through every existing gate. `canUseTool` sees the prefixed name (`canUseTool('srv__danger', input)`). `disallowedTools: ['srv__danger']` matches verbatim — the rule grammar was extended in 5.2.4 to accept any name containing `__`. Scoped patterns (`Bash(npm *)` syntax) are **not** supported for MCP tools (the bridge has no per-server arg-key registry); use a plain prefixed name or write a `canUseTool` callback.

#### Per-call cancellation

The OR SDK's `ToolExecuteContext` carries an optional `signal` — the bridge composes it with the bridge's lifecycle signal so a per-call abort cancels just that one MCP request without tearing the client down. The bridge's lifecycle `signal` (the run's composite abort signal) propagates into every transport — aborting the run also tears every server down.

#### Opt-in discovery

```ts
const run = new OpenRouterAgentRun({
  apiKey: process.env.OPENROUTER_API_KEY!,
  sessionId: 'demo',
  prompt: 'Summarise my open Linear issues.',
  autoDiscoverMcp: true, // walk ./.mcp.json + ~/.mcp.json at iter start
});
```

## Tools shipped with the library

Client tools (execute in the host process):

| Tool                | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read_file`         | Read file contents.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `write_file`        | Write/create files (auto-creates parent dirs).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `edit_file`         | Find-and-replace a unique string in a file.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `list_directory`    | List files and directories.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `grep_files`        | Search file contents by regex across a tree. Optional `before_context`/`after_context`/`context` (capped at 20/side), `type` filetype filter (e.g. `'ts'`, `'py'` — unions with `file_glob`), and `output_mode` (`'content'` default, `'files_with_matches'`, `'count'`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `run_command`       | Execute shell commands. Optional `description` (advisory) and `timeout_ms` (default 30s, clamped to 10 min) fields; SIGTERM + 250ms grace on timeout / abort.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `glob`              | Find files by glob pattern across a directory tree. Supports `**/foo` (recursive, zero-or-more segments), `*` per-segment wildcard, `?` single-char, and `[a-z]` character classes. Optional `case_sensitive` (default `true`). Returns sorted relative paths, capped at 1000.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `ask_user_question` | Ask the user a multiple-choice clarifying question and wait for their answer. Inputs: `question` (string), `options` (2–26 entries; each `{ label, preview? }`), optional `allow_free_text`, optional `timeout_ms` (default 300 000, clamped to 600 000). Requires `onAskUserQuestion` on `OpenRouterAgentRun` — without it the tool resolves with `{ error: 'no host handler registered for ask_user_question' }`. See ["Host integration"](#host-integration--asking-the-user-questions).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `task_create`       | Append a task to the agent's in-run task list. Inputs: `content` (string, imperative), optional `activeForm` (present-continuous form shown while in_progress). Returns `{ id }` (UUID). Fires the `Notification` hook with the full latest list (level=info, message=`tasks_changed`). See ["Host integration — task tracking"](#host-integration--task-tracking).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `task_update`       | Update a task in the in-run task list. Inputs: `taskId` (required), `state` (`pending` / `in_progress` / `completed` / `cancelled`), optional `content` (rewrites the description when provided). Returns `{}` on success or `{ error: 'unknown task id: <id>' }`. Fires the same `Notification` hook with the full latest list.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `edit_notebook`     | Edit a Jupyter notebook (`.ipynb`) by cell index. Inputs: `path`, `operation` (`replace_source` / `insert` / `delete` / `change_type`), `cell_index` (0-based; for `insert`, `cells.length` appends), optional `new_source` (required for `replace_source` + `insert`), optional `new_cell_type` (`code` / `markdown`; required for `insert` + `change_type`). Normalizes `source` to canonical `string[]` shape on write. Returns `{ ok: true, cells: <count> }` on success or `{ error: ... }` on validation / IO failures.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `monitor`           | Spawn a background shell command and capture its stdout/stderr line-by-line. Inputs: `command` (string), optional `cwd`, optional `pattern` (JS regex — only matching lines are captured; invalid regex resolves with `{ error: 'invalid pattern: ...' }`), optional `max_lines` (default 1000, clamped to 10 000), optional `max_duration_ms` (default 60 000, clamped to 600 000). Stops on natural exit (`truncated: false`), line-cap hit, duration-cap elapse, or `ctx.signal` abort (all three forced-stop paths SIGTERM the child with a 250ms SIGKILL grace and mark `truncated: true`, `exitCode: null`). Returns `{ exitCode, lines: [{stream, text}], truncated, durationMs }`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `spawn_subagent`    | **Opt-in** via `OpenRouterAgentRun({ enableSubagents: true })` (NOT in the default bundle). Delegate a focused subtask to a child `OpenRouterAgentRun`. Inputs: `description` (prompt, required), optional `tools?: string[]` whitelist that narrows the inherited pool (unknown names dropped), optional `instructions` / `max_turns` / `max_budget_usd` overrides, plus Phase 4.8 per-subagent overrides `model` / `permission_mode` / `allowed_tools` / `disallowed_tools` / `effort` (each REPLACES the parent's resolved value on the child run; `effort` is a stored-but-no-op stub pending Phase 5.4). Subagent events do not bleed into the parent's `for await` — captured internally and surfaced as a single `tool_result` carrying `{ subagentSessionId, status, text, costUsd?, durationMs?, usage?, reason? }`. Depth-cap rejection (`maxSubagentDepth = 3` default, chain of at most parent → sub → sub-sub) returns `{ error: 'max subagent depth (3) exceeded', subagentSessionId }`. Fires `SubagentStart` / `SubagentEnd` on the parent's `onHook` (matched pair, even on depth-cap rejection). See the [Subagents](#subagents) subsection.          |
| `spawn_subagents`   | **Opt-in** via `OpenRouterAgentRun({ enableSubagents: true })` — bundled alongside `spawn_subagent`. Phase 4.9 plural variant: delegate MULTIPLE independent subtasks to child agents in parallel through an inline concurrency-capped promise pool. Input: `subagents: Array<spec>` (1 to `MAX_PARALLEL_BATCH_SIZE` = 16) where each spec accepts the same fields as the singular tool (per-spec `model` / `permission_mode` / `allowed_tools` / etc. propagate independently). Concurrency cap defaults to `maxParallelSubagents = 4` (configurable). No fail-fast — per-child failures isolate (envelope `{ status: 'success' \| 'error' \| 'aborted', subagentSessionId, output, error? }`); aggregate cost / tokens sum SUCCESS envelopes only. Parent abort fans out into every in-flight child (`AbortSignal.any` composition). Recursion-depth cap reuses the singular tool's gate — depth-N parent at the cap rejects each spec with the same `'max subagent depth (N) exceeded'` error envelope. Returns `{ results, aggregatedUsage: { usd, tokensIn, tokensOut, totalTokens }, durationMs }`. See the [Parallel subagents](#parallel-subagents) subsection. |

Server-side tools (execute on OpenRouter's backend, injected via SDK hooks):

| Tool         | Purpose                                            |
| ------------ | -------------------------------------------------- |
| `datetime`   | Returns the current date and time.                 |
| `web_search` | Searches the web for real-time information.        |
| `web_fetch`  | Fetches full content from a URL (web page or PDF). |

### Server-side tools caveat

`canUseTool` **cannot gate** `web_search`, `web_fetch`, or `datetime`. These tools execute inside the OpenRouter backend, not the local process, so the permission wrapper never sees their invocations. If you need to forbid them, omit them from the run (custom `tools` array) or filter on the response side.
