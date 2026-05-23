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
| `onHook`          | `OnHook`            | no       | _(none)_                          | Lifecycle callback fired on `SessionStart`, `PreToolUse`, `PostToolUse`, `SessionEnd`. Audit-only.                                                                                                                                                                                                                                                                     |
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

```ts
const run = new OpenRouterAgentRun({
  apiKey,
  sessionId,
  prompt,
  onHook: async (event, payload) => {
    if (event === 'PreToolUse') console.log(`→ ${payload.toolName}`, payload.input);
    if (event === 'SessionEnd') console.log(`done: ${payload.status} ($${payload.costUsd})`);
  },
});
```

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

## Tools shipped with the library

Client tools (execute in the host process):

| Tool             | Purpose                                                               |
| ---------------- | --------------------------------------------------------------------- |
| `read_file`      | Read file contents.                                                   |
| `write_file`     | Write/create files (auto-creates parent dirs).                        |
| `edit_file`      | Find-and-replace a unique string in a file.                           |
| `list_directory` | List files and directories.                                           |
| `grep_files`     | Search file contents by regex across a tree.                          |
| `run_command`    | Execute shell commands (30s timeout; SIGTERM + 250ms grace on abort). |

Server-side tools (execute on OpenRouter's backend, injected via SDK hooks):

| Tool         | Purpose                                            |
| ------------ | -------------------------------------------------- |
| `datetime`   | Returns the current date and time.                 |
| `web_search` | Searches the web for real-time information.        |
| `web_fetch`  | Fetches full content from a URL (web page or PDF). |

### Server-side tools caveat

`canUseTool` **cannot gate** `web_search`, `web_fetch`, or `datetime`. These tools execute inside the OpenRouter backend, not the local process, so the permission wrapper never sees their invocations. If you need to forbid them, omit them from the run (custom `tools` array) or filter on the response side.
