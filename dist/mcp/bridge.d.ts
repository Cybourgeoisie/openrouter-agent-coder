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
import { type Tool } from '@openrouter/agent';
import type { McpServerConfig } from './config.js';
import type { LoggerFn } from './spec.js';
import type { HookEvent, HookPayload } from '../events.js';
/** Default separator joining `<serverName>` and `<toolName>` in prefixed tool names. */
export declare const MCP_TOOL_NAME_SEPARATOR = "__";
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
    /**
     * Phase 5.2.5: optional — used by the bridge to populate the
     * `capabilities.resources` count on the `McpServerStart` hook payload.
     * Missing method (or a rejected call) is treated as `0` so servers that
     * don't advertise a `resources` capability do not block init.
     */
    listResources?(signal?: AbortSignal): Promise<{
        resources: ReadonlyArray<unknown>;
    }>;
    /**
     * Phase 5.2.5: optional — used by the bridge to populate the
     * `capabilities.prompts` count on the `McpServerStart` hook payload.
     * Missing method (or a rejected call) is treated as `0`.
     */
    listPrompts?(signal?: AbortSignal): Promise<{
        prompts: ReadonlyArray<unknown>;
    }>;
    callTool(name: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<{
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
    notify?: (level: 'info' | 'warn' | 'error', message: string, context?: unknown) => Promise<void> | void;
    /**
     * Phase 5.2.5: lifecycle-emitter for the `McpServerStart` and
     * `McpServerStop` hook events. The agent wires this to its
     * `safeFireHook` so subscribers observe MCP server lifecycle through the
     * same channel as every other hook event. Audit-only — return value
     * ignored, throws swallowed inside `safeFireHook`. Omitted by callers
     * who don't care about the events; the bridge itself never branches on
     * the presence of this callback for anything other than the fire.
     */
    onLifecycle?: (event: Extract<HookEvent, 'McpServerStart' | 'McpServerStop'>, payload: Extract<HookPayload, {
        event: 'McpServerStart' | 'McpServerStop';
    }>) => void | Promise<void>;
    /** Run-level abort signal. Composes with per-call signals. */
    signal?: AbortSignal;
    /** Test seam — defaults to {@link defaultClientFactory}. */
    clientFactory?: McpClientFactory;
}
/**
 * Default client factory — picks {@link McpStdioClient} or
 * {@link McpHttpClient} based on the {@link McpServerConfig}'s `transport`
 * discriminator. Pure (no side-effects beyond constructing the wrapper —
 * spawn / network I/O happens on `connect()`).
 */
export declare function defaultClientFactory(server: McpServerConfig): McpBridgeClient;
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
export declare class McpBridge {
    private readonly opts;
    private readonly factory;
    /** Successfully-initialised server entries. Empty before `init()`. */
    private entries;
    /** Tools exposed to the agent loop. Empty before `init()`. */
    private wrappedTools;
    private initStarted;
    private closed;
    constructor(opts: McpBridgeOptions);
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
    init(): Promise<void>;
    /**
     * Tear down every initialised server. Safe to call before `init()` (no-op)
     * and safe to call multiple times. Per-server `close()` errors are
     * swallowed — a teardown loop must complete for every server even if one
     * misbehaves.
     */
    close(): Promise<void>;
    /** Tools exposed by all successfully-initialised servers. Empty until `init()` resolves. */
    get tools(): readonly Tool[];
    /**
     * Names of servers whose handshake succeeded — i.e. the ones whose tools
     * are present in {@link tools}. Exposed primarily for tests; the agent
     * never branches on this.
     */
    get serverNames(): readonly string[];
    /**
     * Phase 5.5: flat catalog of every successfully-listed MCP tool — used by
     * the `tool_search` index to score by raw `name` / `description` and
     * stringify the original `inputSchema` for the `schema_preview` field.
     * Each entry's `name` is the prefixed `<serverName>__<toolName>` (matches
     * the wrapped Tool's name in {@link tools}); `server` is the originating
     * server's name. Empty until {@link init} resolves; reflects only the
     * subset of servers whose handshake succeeded.
     *
     * Exposed off the bridge (not derived from the wrapped {@link tools}) so
     * the search index sees the raw MCP JSON Schema without having to reach
     * into the Zod-meta wrapper {@link mapMcpToolToTool} stores on each Tool.
     */
    get catalog(): ReadonlyArray<{
        name: string;
        server: string;
        description?: string;
        inputSchema?: unknown;
    }>;
}
/**
 * Dispatcher signature for {@link mapMcpToolToTool}. The bridge supplies a
 * closure over the originating server's `callTool` so the wrapped Tool's
 * execute doesn't need to know which client it came from.
 */
export type McpCallToolDispatch = (toolName: string, args: Record<string, unknown> | undefined, signal?: AbortSignal) => Promise<{
    isError?: boolean;
    content?: unknown;
    [k: string]: unknown;
}>;
/**
 * Wrap an MCP `Tool` (as returned by `client.listTools()`) as a
 * `@openrouter/agent` `Tool`. The wrapped tool's `name` is the prefixed form
 * `<serverName>__<toolName>` — two servers exposing the same `toolName`
 * therefore land on distinct prefixed names with no collision. The
 * `inputSchema` is stored as a `z.unknown().meta(jsonSchema)` so the OR SDK's
 * Zod→JSON-Schema converter emits the original MCP JSON Schema to the model
 * untouched.
 */
export declare function mapMcpToolToTool(serverName: string, mcpTool: {
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
}, dispatch: McpCallToolDispatch): Tool;
//# sourceMappingURL=bridge.d.ts.map