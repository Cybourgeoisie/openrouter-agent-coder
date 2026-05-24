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
 * [[McpStdioClient.connect]] and [[McpHttpClient.connect]] instead.
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

/**
 * Constructor options for [[McpHttpClient]] when targeting the modern
 * Streamable HTTP transport (preferred). Per the MCP spec, this transport
 * uses HTTP POST for requests and HTTP GET + SSE for server-streamed
 * responses, supports stateful sessions via `Mcp-Session-Id`, and resumes
 * dropped streams via `Last-Event-ID` replay. The SDK class lives at
 * `@modelcontextprotocol/sdk/client/streamableHttp.js`
 * (`StreamableHTTPClientTransport`).
 */
export interface McpStreamableHttpClientOptions {
  /** Selects the Streamable HTTP transport. */
  transport: 'streamableHttp';
  /** Endpoint URL the SDK transport connects to (POST + GET/SSE). */
  url: string;
  /**
   * Extra headers to send on every HTTP request (POST + GET) the transport
   * issues. Merged into the SDK's `requestInit.headers`; the SDK adds its
   * own `Mcp-Session-Id` / `Last-Event-ID` headers on top where appropriate.
   */
  headers?: Record<string, string>;
  /**
   * Optional reconnection knobs forwarded to the SDK's transport. When
   * omitted the SDK defaults apply (initial 1s, factor 1.5, max 30s,
   * maxRetries 2). Exposed primarily so tests can disable retries.
   */
  reconnection?: {
    maxReconnectionDelay?: number;
    initialReconnectionDelay?: number;
    reconnectionDelayGrowFactor?: number;
    maxRetries?: number;
  };
  /** Optional diagnostics sink for transport-level errors. */
  logger?: LoggerFn;
  /**
   * Client-lifecycle abort signal. Pre-aborted: `connect()` rejects
   * synchronously. Fired mid-handshake or after `connect()` resolves: the
   * transport is closed and the client is marked closed, so subsequent
   * wrapper calls reject via the same path as a post-`close()` call.
   *
   * For cancelling a single in-flight request without affecting the rest of
   * the client, pass a per-call `signal?` to the individual wrapper methods
   * (`listTools`, `callTool`, etc.). The lifecycle signal and per-call signal
   * compose — whichever fires first rejects the underlying SDK request, but
   * ONLY the lifecycle signal tears down the transport.
   */
  signal?: AbortSignal;
}

/**
 * Constructor options for [[McpHttpClient]] when targeting the legacy SSE
 * transport. This transport is **deprecated** at the SDK level — prefer
 * `'streamableHttp'` for new servers. Kept for back-compat with servers
 * that haven't migrated yet. The SDK class lives at
 * `@modelcontextprotocol/sdk/client/sse.js` (`SSEClientTransport`); see
 * the deprecation note on its JSDoc.
 */
export interface McpSseClientOptions {
  /** Selects the (deprecated) SSE transport. */
  transport: 'sse';
  /** Endpoint URL the SDK transport connects to (GET = SSE stream, POST = send). */
  url: string;
  /** Extra headers passed to the SDK's `requestInit` (applied to the POST send path). */
  headers?: Record<string, string>;
  /** Optional diagnostics sink for transport-level errors. */
  logger?: LoggerFn;
  /**
   * Client-lifecycle abort signal. Same semantics as
   * [[McpStreamableHttpClientOptions.signal]] — pre-abort / mid-handshake /
   * post-connect aborts all close the transport.
   */
  signal?: AbortSignal;
}

/**
 * Constructor options for [[McpHttpClient]]. Discriminated on `transport`:
 *
 * - `'streamableHttp'` — modern Streamable HTTP (preferred). Supports
 *   stateful sessions, automatic reconnect with `Last-Event-ID` replay,
 *   and the optional OAuth flow when an auth provider is configured.
 * - `'sse'` — legacy plain SSE. Deprecated by the SDK; kept for back-compat
 *   with servers that haven't migrated yet.
 *
 * Card 5.2.4 (tool-bridge) consumes both shapes via this type, so a
 * `.mcp.json` entry only needs to select the transport key.
 */
export type McpHttpClientOptions = McpStreamableHttpClientOptions | McpSseClientOptions;
