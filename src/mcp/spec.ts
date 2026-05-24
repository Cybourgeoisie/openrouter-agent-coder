/**
 * Phase 5.2.1 — Shared MCP types.
 *
 * Re-exports the slice of `@modelcontextprotocol/sdk/types.js` that downstream
 * cards (5.2.2 HTTP transport, 5.2.4 tool-bridge) will consume. Going through
 * this module keeps deep SDK subpath imports off the rest of the codebase so a
 * future vendor swap (or pin bump) is a one-file change.
 *
 * All re-exports are `type`-only — no runtime value is pulled in here, so this
 * module has zero side-effects on import. The SDK is loaded lazily inside
 * [[McpStdioClient.connect]] instead.
 */

export type {
  Tool,
  CallToolResult,
  CompatibilityCallToolResult,
  Resource,
  ResourceContents,
  TextResourceContents,
  BlobResourceContents,
  Prompt,
  PromptMessage,
  GetPromptResult,
  ReadResourceResult,
  ListToolsResult,
  ListResourcesResult,
  ListPromptsResult,
  ServerCapabilities,
  Implementation,
} from '@modelcontextprotocol/sdk/types.js';

export type LoggerFn = (
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  fields?: Record<string, unknown>,
) => void;

/** Constructor options for [[McpStdioClient]]. */
export interface McpStdioClientOptions {
  /** Executable to spawn (passed verbatim to `child_process.spawn`). */
  command: string;
  /** Argv passed to the executable. */
  args?: string[];
  /**
   * Environment variables forwarded to the child. When omitted, the SDK's
   * `getDefaultEnvironment()` allowlist applies — NOT the parent's full
   * environment.
   */
  env?: Record<string, string>;
  /**
   * Working directory for the child. Intentionally has no default — callers
   * must pass an explicit value if they need anything other than the parent
   * process's inherited working directory. The single source of cwd
   * resolution in this codebase lives at `src/agent.ts:457`; this module
   * deliberately does not duplicate it.
   */
  cwd?: string;
  /** Optional diagnostics sink. Receives child-process stderr lines. */
  logger?: LoggerFn;
  /**
   * Client-lifecycle abort signal. Pre-aborted: `connect()` rejects
   * synchronously. Fired during the handshake: the transport is closed and the
   * SDK's pending `initialize` rejects with an `AbortError`. Fired after
   * `connect()` resolves: the transport is still torn down and the client is
   * marked closed, so subsequent wrapper calls reject via the same path as a
   * post-`close()` call.
   *
   * For cancelling a single in-flight request without affecting the rest of
   * the client, pass a per-call `signal?` to the individual wrapper methods
   * (`listTools`, `callTool`, etc.). The lifecycle signal and per-call signal
   * compose — whichever fires first rejects the underlying SDK request.
   */
  signal?: AbortSignal;
}
