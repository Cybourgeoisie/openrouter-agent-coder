# OpenRouter Agent Coder

A CLI code editing agent built natively on the [OpenRouter Agent SDK](https://openrouter.ai/docs/agent-sdk/overview). Give it a prompt, and it reads, writes, and edits files — running shell commands as needed — all from your terminal.

## Quick Start

```bash
npm install --include=dev
npm run build

export OPENROUTER_API_KEY="your-key-here"

# Single prompt
node dist/index.js "Add error handling to src/server.ts"

# Piped input
echo "Write unit tests for utils.ts" | node dist/index.js

# Interactive REPL
node dist/index.js
```

## How It Works

The agent uses OpenRouter's `callModel()` to run an agentic loop: the model receives your prompt, decides which tools to call, executes them, and repeats until the task is done or a stop condition fires.

Every conversation gets a **session ID** passed to OpenRouter for server-side tracking. State is persisted locally so sessions can be resumed, and every API response is logged to disk.

### Tools

| Tool | Description |
|---|---|
| `read_file` | Read file contents |
| `write_file` | Write/create files (auto-creates parent dirs) |
| `edit_file` | Find-and-replace a unique string in a file |
| `list_directory` | List files and directories |
| `run_command` | Execute shell commands (30s timeout) |

### Logging

Every API response is saved to a structured log directory:

```
logs/
  <session_id>/
    session.json
    state.json
    <request_id>/
      request.json
      <generation_id>/
        response.json    # Full API response (model, tokens, cost, output)
```

## Configuration

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

| Env Variable | Default | Description |
|---|---|---|
| `OPENROUTER_API_KEY` | **(required)** | Your OpenRouter API key |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | API base URL (override for local/staging) |
| `OR_MODEL` | `~anthropic/claude-sonnet-latest` | Model to use |
| `OR_MAX_STEPS` | `25` | Max agentic steps per prompt |
| `OR_MAX_COST` | `1.00` | Max cost in USD per prompt |
| `OR_SESSION_ID` | *(auto-generated)* | Resume a previous session |

## Development

```bash
npm run dev            # Run via tsx (no compile step)
npm run build          # Compile TypeScript to dist/
npm test               # Run tests (vitest)
npm run test:watch     # Watch mode
npm run test:coverage  # Coverage with enforced thresholds
```

### Project Structure

```
src/
  index.ts              CLI entry point (REPL, single-prompt, pipe)
  agent.ts              Agent core — callModel with tools & streaming
  tools/
    read-file.ts        read_file tool
    write-file.ts       write_file tool
    edit-file.ts        edit_file tool
    list-directory.ts   list_directory tool
    run-command.ts      run_command tool
    index.ts            Barrel export
  logging/
    logger.ts           Structured logging to disk
  state/
    file-state.ts       FileStateAccessor (atomic writes)
```

### Testing

Tests live alongside source files as `*.test.ts`. Coverage thresholds are enforced:

- Statements: 80% | Branches: 70% | Functions: 90% | Lines: 80%

## Built With

- [@openrouter/agent](https://openrouter.ai/docs/agent-sdk/overview) — Agent SDK with `callModel()`, tool orchestration, state persistence
- [Zod v4](https://zod.dev) — Tool input schema validation
- [Vitest](https://vitest.dev) — Test runner
- TypeScript, Node.js (ESM)

## Further Reading

- [OpenRouter Agent SDK Docs](https://openrouter.ai/docs/agent-sdk/overview)
- [Building Long-Horizon Agents](https://openrouter.ai/docs/cookbook/building-agents/long-horizon-agents)
