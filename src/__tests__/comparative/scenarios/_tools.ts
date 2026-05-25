// Shared tool fixtures for the canonical comparative-parity scenarios
// (Phase 6.5a). Recommended ambiguity call #3: one file, three tool shapes,
// reused across scenarios — `echo`, `counter`, `rm`. Phase 6.5b extends the
// registry with `read`, `write`, `flakyFetch`, `shell` for scenarios #5–#8.
//
// Each tool ships TWO definitions because the SDKs declare tools through
// different surfaces:
//
//   - **OR side** registers tools via `OpenRouterAgentRun.tools` (typed as
//     `@openrouter/agent`'s `Tool[]`). Tool names go on the wire verbatim,
//     so `echo` is `echo` in the request body and on `tool_use`.
//
//   - **Anthropic side** registers tools via `mcpServers` on the
//     `claude-agent-sdk` `query()` options. The SDK prefixes every MCP tool
//     with `mcp__<server>__` before exposing it to the model; what hits
//     `/v1/messages` is `mcp__harness__echo`, and the model emits
//     `tool_use.name = "mcp__harness__echo"` back. Scripts on the Anthropic
//     wire must use the prefixed name; canonicalization strips the prefix
//     so the comparator sees the same semantic call on both sides.
//
// Tool semantics are **scripted, not lived**. The model in this harness is
// the emulator — it ALWAYS returns the scripted tool_use call regardless of
// what the handler does. The handler's only job is to return a deterministic
// `tool_result` payload so the next-turn request body hashes the same way
// every run. Side effects (file deletion, real network) would defeat that.

import { z } from 'zod/v4';
import { tool as orTool, type Tool as OrTool } from '@openrouter/agent';
import {
  tool as anthropicTool,
  createSdkMcpServer,
  type SdkMcpToolDefinition,
  type McpSdkServerConfigWithInstance,
} from '@anthropic-ai/claude-agent-sdk';

/**
 * MCP server name carried in the `mcp__<server>__<tool>` prefix on the
 * Anthropic side. Centralized so scripts + canonicalize agree on the exact
 * string. Changing this here MUST be matched by the scenario JSONs.
 */
export const MCP_SERVER_NAME = 'harness';

/** Build the prefixed name used on the Anthropic wire for a given bare tool name. */
export function anthropicToolName(bareName: string): string {
  return `mcp__${MCP_SERVER_NAME}__${bareName}`;
}

/** Stateful per-scenario factory: each call returns a fresh counter starting at 0. */
function makeCounterState(): { next: () => number } {
  let n = 0;
  return {
    next: () => {
      n += 1;
      return n;
    },
  };
}

// ----- OR-side tool factories -----
//
// Each factory returns a fresh tool bound to its own state (relevant for
// `counter`). The harness builds these per-scenario so tests don't share
// counter state across scenarios.

function orEcho(): OrTool {
  return orTool({
    name: 'echo',
    description: 'Echoes the given text back to the caller. Deterministic, no side effects.',
    inputSchema: z.object({ text: z.string() }),
    execute: ({ text }) => text,
  });
}

function orCounter(): OrTool {
  const state = makeCounterState();
  return orTool({
    name: 'counter',
    description:
      'Returns the next integer in a per-scenario monotonic counter. Starts at 1; increments each call.',
    inputSchema: z.object({}),
    execute: () => state.next(),
  });
}

function orRm(): OrTool {
  return orTool({
    name: 'rm',
    description: 'Deletes a file at the given path. Returns "ok" on success.',
    inputSchema: z.object({ path: z.string() }),
    // Scripted-only: never touch the filesystem from a comparative test.
    // The model in the emulator is the only thing driving this; the result
    // string is a deterministic stub that the next turn's prompt hashes
    // against.
    execute: () => 'ok',
  });
}

// Phase 6.5b additions: read / write / flakyFetch / shell. All scripted-only
// — they never touch the real filesystem or network. `flakyFetch` is the only
// one with per-scenario state; the rest are pure stubs.

function orRead(): OrTool {
  return orTool({
    name: 'read',
    description: 'Reads the file at the given path. Returns a fixed stub string.',
    inputSchema: z.object({ path: z.string() }),
    // Canon stub — never touches disk. Plan-mode scenario #5 uses this as
    // the "filter-passes" tool to assert reads still dispatch.
    execute: () => 'file contents stub',
  });
}

function orWrite(): OrTool {
  return orTool({
    name: 'write',
    description: 'Writes content to the file at the given path. Returns "ok" on success.',
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    // Ambiguity call #4: pure no-op. The test is about the plan-mode filter
    // short-circuiting the call BEFORE dispatch — the body of `execute` is
    // never reached when the filter denies, so the return value is canon
    // only for "what if the filter let it through" paranoia paths.
    execute: () => 'ok',
  });
}

/**
 * Per-scenario stateful flakyFetch factory: throws on first invocation,
 * succeeds on every subsequent call. Used by scenario #7 to exercise the
 * "tool error mid-loop → SDK feeds is_error=true back → model retries"
 * round-trip on both SDKs.
 */
function orFlakyFetch(): OrTool {
  const state = makeCounterState();
  return orTool({
    name: 'flakyFetch',
    description:
      'Fetches the given URL. Throws on the first call (simulated transient failure); succeeds on retry.',
    inputSchema: z.object({ url: z.string() }),
    execute: () => {
      const n = state.next();
      if (n === 1) {
        // The error message is canon — the SDK wraps this into a
        // tool_result with is_error=true, and the script's turn-1 entry
        // hashes against the request body that includes the error string.
        throw new Error('flakyFetch transient failure');
      }
      return 'fetched stub body';
    },
  });
}

function orShell(): OrTool {
  return orTool({
    name: 'shell',
    description: 'Runs the given shell command. Returns "ok" on success.',
    inputSchema: z.object({ cmd: z.string() }),
    // Scripted-only — never spawns a real shell. The hook-block scenario #8
    // denies this tool at the canUseTool layer so `execute` is never reached
    // on the canon path.
    execute: () => 'ok',
  });
}

// ----- Anthropic-side MCP tool factories -----

function anthropicEcho(): SdkMcpToolDefinition<any> {
  return anthropicTool(
    'echo',
    'Echoes the given text back to the caller. Deterministic, no side effects.',
    { text: z.string() },
    async ({ text }) => ({
      content: [{ type: 'text', text }],
    }),
  );
}

function anthropicCounter(): SdkMcpToolDefinition<any> {
  const state = makeCounterState();
  return anthropicTool(
    'counter',
    'Returns the next integer in a per-scenario monotonic counter. Starts at 1; increments each call.',
    {},
    async () => {
      const n = state.next();
      return { content: [{ type: 'text', text: String(n) }] };
    },
  );
}

function anthropicRm(): SdkMcpToolDefinition<any> {
  return anthropicTool(
    'rm',
    'Deletes a file at the given path. Returns "ok" on success.',
    { path: z.string() },
    // Same scripted-only contract as the OR side: never touch disk. If the
    // permission layer fires first (scenario #4), the handler is never
    // called — that's the parity claim the scenario asserts.
    async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  );
}

function anthropicRead(): SdkMcpToolDefinition<any> {
  return anthropicTool(
    'read',
    'Reads the file at the given path. Returns a fixed stub string.',
    { path: z.string() },
    async () => ({ content: [{ type: 'text', text: 'file contents stub' }] }),
  );
}

function anthropicWrite(): SdkMcpToolDefinition<any> {
  return anthropicTool(
    'write',
    'Writes content to the file at the given path. Returns "ok" on success.',
    { path: z.string(), content: z.string() },
    async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  );
}

function anthropicFlakyFetch(): SdkMcpToolDefinition<any> {
  const state = makeCounterState();
  return anthropicTool(
    'flakyFetch',
    'Fetches the given URL. Throws on the first call (simulated transient failure); succeeds on retry.',
    { url: z.string() },
    async () => {
      const n = state.next();
      if (n === 1) {
        // MCP SDK wraps the throw into a tool_result with isError=true
        // (same shape the OR-side throw produces). Identical bytes flow
        // back to the model on both sides — that's the parity claim.
        throw new Error('flakyFetch transient failure');
      }
      return { content: [{ type: 'text', text: 'fetched stub body' }] };
    },
  );
}

function anthropicShell(): SdkMcpToolDefinition<any> {
  return anthropicTool(
    'shell',
    'Runs the given shell command. Returns "ok" on success.',
    { cmd: z.string() },
    async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  );
}

// ----- Public registry -----

/**
 * The set of fixture tools available to canonical scenarios. Scenarios
 * declare which names they want; the harness instantiates only those.
 *
 * NOT a hard whitelist — adding a new fixture means adding entries here +
 * scenarios that reference them. The Zod schema in `scenarios.ts` validates
 * scenario JSONs against this registry's keys.
 */
export const HARNESS_TOOL_NAMES = [
  'echo',
  'counter',
  'rm',
  'read',
  'write',
  'flakyFetch',
  'shell',
] as const;
export type HarnessToolName = (typeof HARNESS_TOOL_NAMES)[number];

const OR_FACTORIES: Record<HarnessToolName, () => OrTool> = {
  echo: orEcho,
  counter: orCounter,
  rm: orRm,
  read: orRead,
  write: orWrite,
  flakyFetch: orFlakyFetch,
  shell: orShell,
};

const ANTHROPIC_FACTORIES: Record<HarnessToolName, () => SdkMcpToolDefinition<any>> = {
  echo: anthropicEcho,
  counter: anthropicCounter,
  rm: anthropicRm,
  read: anthropicRead,
  write: anthropicWrite,
  flakyFetch: anthropicFlakyFetch,
  shell: anthropicShell,
};

export interface HarnessTools {
  /** Tools to pass into `OpenRouterAgentRun.tools`. */
  orTools: OrTool[];
  /** Anthropic MCP server config to drop into `query()` `options.mcpServers`. */
  anthropicMcpServer: McpSdkServerConfigWithInstance | null;
  /** The prefixed names a scenario should pass to `Options.allowedTools`. */
  anthropicAllowedToolNames: string[];
}

/**
 * Build a tool-pair set for a scenario given its declared tool names.
 *
 * Returns null `anthropicMcpServer` when no tools are requested — the agent
 * SDK rejects an empty MCP server config and `mcpServers: undefined` is the
 * scenario-#1 default (no-tool happy path).
 */
export function buildHarnessTools(names: readonly HarnessToolName[]): HarnessTools {
  if (names.length === 0) {
    return { orTools: [], anthropicMcpServer: null, anthropicAllowedToolNames: [] };
  }
  const orTools = names.map((n) => OR_FACTORIES[n]());
  const anthropicTools = names.map((n) => ANTHROPIC_FACTORIES[n]());
  const anthropicMcpServer = createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: '0.0.0',
    tools: anthropicTools,
  });
  return {
    orTools,
    anthropicMcpServer,
    anthropicAllowedToolNames: names.map(anthropicToolName),
  };
}
