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

| Option            | Type                | Required | Default                           | Description                                                                                                                                                                                                                                                                                                                                                            |
| ----------------- | ------------------- | -------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiKey`          | `string`            | yes      | —                                 | OpenRouter API key. No env fallback.                                                                                                                                                                                                                                                                                                                                   |
| `sessionId`       | `string`            | yes      | —                                 | Stable session id used for OR server-side session tracking and on-disk state.                                                                                                                                                                                                                                                                                          |
| `prompt`          | `string`            | yes      | —                                 | User prompt for this run.                                                                                                                                                                                                                                                                                                                                              |
| `instructions`    | `string`            | no       | `DEFAULT_INSTRUCTIONS`            | System instructions.                                                                                                                                                                                                                                                                                                                                                   |
| `model`           | `string`            | no       | `~anthropic/claude-sonnet-latest` | Model alias or id.                                                                                                                                                                                                                                                                                                                                                     |
| `cwd`             | `string`            | no       | `process.cwd()`                   | Working directory tools resolve relative paths against.                                                                                                                                                                                                                                                                                                                |
| `maxTurns`        | `number`            | no       | `25`                              | Max inner-loop turns.                                                                                                                                                                                                                                                                                                                                                  |
| `maxBudgetUsd`    | `number`            | no       | `1.0`                             | Max cumulative cost in USD.                                                                                                                                                                                                                                                                                                                                            |
| `tools`           | `readonly Tool[]`   | no       | `allTools({ cwd, signal })`       | Tools passed to the model. Custom tools are NOT context-bound — caller handles cwd/abort.                                                                                                                                                                                                                                                                              |
| `canUseTool`      | `CanUseTool`        | no       | _(allow all)_                     | Permission gate invoked before each client tool's execute. Server-side tools bypass this hook.                                                                                                                                                                                                                                                                         |
| `permissionMode`  | `PermissionMode`    | no       | _(allow all)_                     | Named preset — `'default'` / `'acceptEdits'` / `'bypassPermissions'` / `'plan'`. Translated to an internal `canUseTool`. Explicit `canUseTool` wins when both are set (and a `warn` log is emitted).                                                                                                                                                                   |
| `allowedTools`    | `readonly string[]` | no       | _(none)_                          | Pre-approve list. Plain name (`'read_file'` / `'Read'`) matches any invocation; scoped rules (`'Bash(npm *)'`, `'Edit(src/handlers.ts)'`) match a tool-specific argument. Layers on top of `permissionMode`; explicit `canUseTool` overrides both lists. Malformed rules throw at construction.                                                                        |
| `disallowedTools` | `readonly string[]` | no       | _(none)_                          | Deny list with the same grammar as `allowedTools`. Denials win over both `allowedTools` and `permissionMode`. Explicit `canUseTool` overrides this list. Malformed rules throw at construction.                                                                                                                                                                        |
| `onHook`          | `OnHook`            | no       | _(none)_                          | Lifecycle callback. Auto-fired in order `Setup` → `SessionStart` → `PreToolUse`/`PostToolUse` pairs → `SessionEnd` → `Stop`. `Notification` is caller-emitted (via `ctx.notify` or direct `onHook` calls). Audit-only — thrown errors are logged and swallowed.                                                                                                        |
| `signal`          | `AbortSignal`       | no       | _(none)_                          | External abort signal. Combined internally with the run's `abort()` method via `AbortSignal.any`.                                                                                                                                                                                                                                                                      |
| `logsRoot`        | `string`            | no       | `<cwd>/logs`                      | Directory for session logs.                                                                                                                                                                                                                                                                                                                                            |
| `baseUrl`         | `string`            | no       | OpenRouter production             | Override the OpenRouter API base URL.                                                                                                                                                                                                                                                                                                                                  |
| `appTitle`        | `string`            | no       | `openrouter-agent-coder`          | App title sent in OR client metadata.                                                                                                                                                                                                                                                                                                                                  |
| `logger`          | `AgentLogger`       | no       | _(silent)_                        | Diagnostic logger — `(level, message, fields?) => void`.                                                                                                                                                                                                                                                                                                               |
| `settingSources`  | `SettingSource[]`   | no       | `[]`                              | Opt-in context-discovery list — `'project'` (walks up from `cwd` reading `CLAUDE.md` / `.claude/CLAUDE.md`, stops at the first `.git` or 10 levels), `'user'` (`<os.homedir()>/.claude/CLAUDE.md`), `'local'` (`<cwd>/.claude/CLAUDE.local.md`). Discovered content is prepended to `instructions` in user → project → local order. Default `[]` performs no FS reads. |

### `AgentCoreEvent`

Discriminated union yielded by `for await (... of run)`. Narrow on `event.type`.

| Variant           | Payload                                              | Notes                                                                           |
| ----------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| `session_started` | `{ sessionId }`                                      | Fires once at the start of a run.                                               |
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

The bundled tool preset — `allTools({ cwd, signal })` returns the six client tools below, context-bound. It is the default value for `OpenRouterAgentRun`'s `tools` option; you only need to reference it directly when composing a custom tool array.

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

Today this is purely a value bag — real MCP transports (stdio / HTTP+SSE / `.mcp.json` discovery) come in Phase 5.2 of the [parity roadmap](./plans/claude-sdk-parity-roadmap.md).

## Tools shipped with the library

Client tools (execute in the host process):

| Tool             | Purpose                                                                                                                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read_file`      | Read file contents.                                                                                                                                                                                                                                                       |
| `write_file`     | Write/create files (auto-creates parent dirs).                                                                                                                                                                                                                            |
| `edit_file`      | Find-and-replace a unique string in a file.                                                                                                                                                                                                                               |
| `list_directory` | List files and directories.                                                                                                                                                                                                                                               |
| `grep_files`     | Search file contents by regex across a tree. Optional `before_context`/`after_context`/`context` (capped at 20/side), `type` filetype filter (e.g. `'ts'`, `'py'` — unions with `file_glob`), and `output_mode` (`'content'` default, `'files_with_matches'`, `'count'`). |
| `run_command`    | Execute shell commands. Optional `description` (advisory) and `timeout_ms` (default 30s, clamped to 10 min) fields; SIGTERM + 250ms grace on timeout / abort.                                                                                                             |

Server-side tools (execute on OpenRouter's backend, injected via SDK hooks):

| Tool         | Purpose                                            |
| ------------ | -------------------------------------------------- |
| `datetime`   | Returns the current date and time.                 |
| `web_search` | Searches the web for real-time information.        |
| `web_fetch`  | Fetches full content from a URL (web page or PDF). |

### Server-side tools caveat

`canUseTool` **cannot gate** `web_search`, `web_fetch`, or `datetime`. These tools execute inside the OpenRouter backend, not the local process, so the permission wrapper never sees their invocations. If you need to forbid them, omit them from the run (custom `tools` array) or filter on the response side.
