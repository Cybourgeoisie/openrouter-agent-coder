/**
 * Phase 5.2.4 — MCP tool bridge.
 *
 * Spawns each configured MCP server (via 5.2.1 stdio / 5.2.2 http transports),
 * runs the JSON-RPC `initialize` handshake, lists each server's tools, and
 * wraps them as `Tool` objects consumable by `OpenRouterAgentRun`. Tool calls
 * the model issues on a `<serverName>__<toolName>` name are routed back to the
 * originating server's `callTool`.
 *
 * Lifecycle is per-run (no pooling): the agent constructs a bridge with the
 * resolved server list, calls `init()` once at the top of `iterate()` (after
 * the `Setup` hook so the host can audit/observe), then `close()` from the
 * `finally` block. `close()` is idempotent and safe to call before `init()`.
 *
 * Init-failure policy: a single server that fails its handshake DOES NOT
 * crash the run. The bridge logs (via `logger`), fires a `Notification` hook
 * (via `notify`) with `level: 'warn'`, and continues with the remaining
 * servers. This matches the issue's "server-on-error doesn't crash the run"
 * acceptance criterion.
 *
 * Schema mapping is passthrough — the MCP server's `inputSchema` (a JSON
 * Schema object) is stored verbatim on a `z.unknown().meta(...)` Zod schema
 * so the OR SDK's `convertZodToJsonSchema` emits the same JSON Schema to the
 * model. The bridge does NOT validate the model's arguments against the JSON
 * Schema — that is the MCP server's responsibility (which it does at the
 * JSON-RPC boundary).
 */

import { z } from 'zod/v4';
import { tool as sdkTool, type Tool } from '@openrouter/agent';

import type { McpServerConfig } from './config.js';
import type { LoggerFn } from './spec.js';
import { McpStdioClient } from './transport-stdio.js';
import { McpHttpClient } from './transport-http.js';

/** Default separator joining `<serverName>` and `<toolName>` in prefixed tool names. */
export const MCP_TOOL_NAME_SEPARATOR = '__';

/**
 * Structural interface satisfied by both {@link McpStdioClient} and
 * {@link McpHttpClient}. The bridge only ever depends on the methods listed
 * here, so consumers can stub it for tests without instantiating the SDK.
 */
export interface McpBridgeClient {
  connect(signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
  listTools(signal?: AbortSignal): Promise<{
    tools: ReadonlyArray<{
      name: string;
      description?: string;
      inputSchema: Record<string, unknown>;
    }>;
  }>;
  callTool(
    name: string,
    args?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{
    isError?: boolean;
    content?: unknown;
    [k: string]: unknown;
  }>;
}

/**
 * Hook for swapping the real SDK-backed clients out for in-memory stubs in
 * tests. Returns a {@link McpBridgeClient} for the given server config.
 * Defaults to {@link defaultClientFactory} — production callers should not
 * pass this themselves.
 */
export type McpClientFactory = (server: McpServerConfig) => McpBridgeClient;

export interface McpBridgeOptions {
  /** Resolved server list. Empty array yields a no-op bridge. */
  servers: readonly McpServerConfig[];
  /** Optional diagnostics sink. Receives one line per init success/failure. */
  logger?: LoggerFn;
  /**
   * Hook used by the bridge to push a `Notification` to the host when a
   * server's `init` fails. The agent wires this to its `safeFireHook` so the
   * host sees the warning through the same channel as any other tool-side
   * notification. No-op when omitted.
   */
  notify?: (
    level: 'info' | 'warn' | 'error',
    message: string,
    context?: unknown,
  ) => Promise<void> | void;
  /** Run-level abort signal. Composes with per-call signals. */
  signal?: AbortSignal;
  /** Test seam — defaults to {@link defaultClientFactory}. */
  clientFactory?: McpClientFactory;
}

/**
 * Live mapping of a successfully-initialised MCP server. The bridge keeps one
 * entry per server (skipping the ones whose `init` rejected) and uses
 * `entry.client.callTool` to route dispatches.
 */
interface BridgeEntry {
  serverName: string;
  client: McpBridgeClient;
  tools: ReadonlyArray<{
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
  }>;
}

/**
 * Default client factory — picks {@link McpStdioClient} or
 * {@link McpHttpClient} based on the {@link McpServerConfig}'s `transport`
 * discriminator. Pure (no side-effects beyond constructing the wrapper —
 * spawn / network I/O happens on `connect()`).
 */
export function defaultClientFactory(server: McpServerConfig): McpBridgeClient {
  if (server.transport === 'stdio') {
    return new McpStdioClient({
      command: server.command,
      ...(server.args !== undefined && { args: server.args }),
      ...(server.env !== undefined && { env: server.env }),
    }) as unknown as McpBridgeClient;
  }
  // HTTP config carries no explicit transport selector — default to the
  // modern Streamable HTTP transport. Hosts wanting deprecated SSE can wire
  // their own factory until 5.2.5 exposes a finer-grained config field.
  return new McpHttpClient({
    transport: 'streamableHttp',
    url: server.url,
    ...(server.headers !== undefined && { headers: server.headers }),
  }) as unknown as McpBridgeClient;
}

/**
 * Per-run MCP server pool + tool dispatcher. Owned by an
 * {@link OpenRouterAgentRun} — one bridge per run, never shared across runs.
 *
 * Usage:
 *
 * ```ts
 * const bridge = new McpBridge({ servers, logger, notify, signal });
 * await bridge.init();             // spawns all servers, lists tools
 * const tools = bridge.tools;      // pass into callModel({ tools })
 * try {
 *   // ...run iteration...
 * } finally {
 *   await bridge.close();          // tears down all servers
 * }
 * ```
 */
export class McpBridge {
  private readonly opts: McpBridgeOptions;
  private readonly factory: McpClientFactory;
  /** Successfully-initialised server entries. Empty before `init()`. */
  private entries: BridgeEntry[] = [];
  /** Tools exposed to the agent loop. Empty before `init()`. */
  private wrappedTools: Tool[] = [];
  private initStarted = false;
  private closed = false;

  constructor(opts: McpBridgeOptions) {
    this.opts = opts;
    this.factory = opts.clientFactory ?? defaultClientFactory;
  }

  /**
   * Spawn every configured server, complete its handshake, list its tools,
   * and wrap each tool as a `Tool` consumable by the agent loop.
   *
   * Per-server failures are logged and surfaced via {@link McpBridgeOptions.notify}
   * but DO NOT throw — the bridge continues with the remaining servers. A
   * server with a successful handshake but a failing `listTools` is treated
   * the same way (transport closed, notification emitted, run continues).
   *
   * Idempotent in a narrow sense: calling `init()` twice on the same instance
   * is a no-op on the second call (and a warning log). Pre-aborted signal
   * → bridge stays empty, no spawn attempts.
   */
  async init(): Promise<void> {
    if (this.closed) return;
    if (this.initStarted) {
      this.opts.logger?.('debug', '[mcp:bridge] init() already called — skipping');
      return;
    }
    this.initStarted = true;

    if (this.opts.servers.length === 0) return;
    if (this.opts.signal?.aborted) return;

    // Spawn servers in parallel — each one's handshake is independent. Errors
    // are caught per-server so one slow/failing server doesn't block the rest.
    const settled = await Promise.all(
      this.opts.servers.map(async (server): Promise<BridgeEntry | null> => {
        const client = this.factory(server);
        try {
          await client.connect(this.opts.signal);
          const { tools } = await client.listTools(this.opts.signal);
          return { serverName: server.name, client, tools };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.opts.logger?.('warn', `[mcp:bridge] server ${server.name} failed: ${message}`, {
            name: server.name,
            transport: server.transport,
            source: server.source,
          });
          try {
            await this.opts.notify?.('warn', 'mcp_server_failed', {
              name: server.name,
              transport: server.transport,
              source: server.source,
              error: message,
            });
          } catch {
            // notify failures must not derail bridge init — they only matter
            // for host observability and are already captured in the log.
          }
          // Best-effort teardown — the client may have spawned a subprocess
          // (stdio) or opened a socket (http) before failing later in the
          // handshake / listTools step.
          try {
            await client.close();
          } catch {
            /* ignore — already on the failure path */
          }
          return null;
        }
      }),
    );

    this.entries = settled.filter((e): e is BridgeEntry => e !== null);
    this.wrappedTools = this.entries.flatMap((entry) =>
      entry.tools.map((mcpTool) =>
        mapMcpToolToTool(entry.serverName, mcpTool, (toolName, args, signal) =>
          entry.client.callTool(toolName, args, signal),
        ),
      ),
    );

    if (this.entries.length > 0) {
      this.opts.logger?.('debug', `[mcp:bridge] initialised ${this.entries.length} server(s)`, {
        servers: this.entries.map((e) => ({ name: e.serverName, toolCount: e.tools.length })),
      });
    }
  }

  /**
   * Tear down every initialised server. Safe to call before `init()` (no-op)
   * and safe to call multiple times. Per-server `close()` errors are
   * swallowed — a teardown loop must complete for every server even if one
   * misbehaves.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const entries = this.entries;
    this.entries = [];
    this.wrappedTools = [];
    await Promise.all(
      entries.map(async (entry) => {
        try {
          await entry.client.close();
        } catch (err) {
          this.opts.logger?.(
            'debug',
            `[mcp:bridge] close() of ${entry.serverName} threw — swallowing`,
            { error: err instanceof Error ? err.message : String(err) },
          );
        }
      }),
    );
  }

  /** Tools exposed by all successfully-initialised servers. Empty until `init()` resolves. */
  get tools(): readonly Tool[] {
    return this.wrappedTools;
  }

  /**
   * Names of servers whose handshake succeeded — i.e. the ones whose tools
   * are present in {@link tools}. Exposed primarily for tests; the agent
   * never branches on this.
   */
  get serverNames(): readonly string[] {
    return this.entries.map((e) => e.serverName);
  }
}

/**
 * Dispatcher signature for {@link mapMcpToolToTool}. The bridge supplies a
 * closure over the originating server's `callTool` so the wrapped Tool's
 * execute doesn't need to know which client it came from.
 */
export type McpCallToolDispatch = (
  toolName: string,
  args: Record<string, unknown> | undefined,
  signal?: AbortSignal,
) => Promise<{ isError?: boolean; content?: unknown; [k: string]: unknown }>;

/**
 * Wrap an MCP `Tool` (as returned by `client.listTools()`) as a
 * `@openrouter/agent` `Tool`. The wrapped tool's `name` is the prefixed form
 * `<serverName>__<toolName>` — two servers exposing the same `toolName`
 * therefore land on distinct prefixed names with no collision. The
 * `inputSchema` is stored as a `z.unknown().meta(jsonSchema)` so the OR SDK's
 * Zod→JSON-Schema converter emits the original MCP JSON Schema to the model
 * untouched.
 */
export function mapMcpToolToTool(
  serverName: string,
  mcpTool: { name: string; description?: string; inputSchema: Record<string, unknown> },
  dispatch: McpCallToolDispatch,
): Tool {
  const prefixed = `${serverName}${MCP_TOOL_NAME_SEPARATOR}${mcpTool.name}`;
  const passthroughSchema = z.unknown().meta(mcpTool.inputSchema);

  const execute = async (input: unknown, ctx?: unknown): Promise<unknown> => {
    // ctx is the SDK's ToolExecuteContext — narrow defensively. The bridge
    // only needs an optional per-call AbortSignal off ctx.signal.
    const signal = (ctx as { signal?: AbortSignal } | undefined)?.signal;
    const args = isPlainRecord(input) ? input : undefined;
    const result = await dispatch(mcpTool.name, args, signal);
    // The MCP CallToolResult has `isError?: boolean` and `content`. When
    // `isError === true`, surface that to the agent loop as a thrown error
    // so the run sees `tool_result.isError = true` — matching how built-in
    // tools signal failure.
    if (result.isError === true) {
      throw new Error(JSON.stringify({ error: 'mcp_tool_error', result }));
    }
    return result;
  };

  return sdkTool({
    name: prefixed,
    ...(mcpTool.description !== undefined ? { description: mcpTool.description } : {}),
    inputSchema: passthroughSchema as unknown as Parameters<typeof sdkTool>[0]['inputSchema'],
    execute,
  } as Parameters<typeof sdkTool>[0]) as Tool;
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
