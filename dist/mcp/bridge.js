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
import { tool as sdkTool } from '@openrouter/agent';
import { McpStdioClient } from './transport-stdio.js';
import { McpHttpClient } from './transport-http.js';
/** Default separator joining `<serverName>` and `<toolName>` in prefixed tool names. */
export const MCP_TOOL_NAME_SEPARATOR = '__';
/**
 * Default client factory — picks {@link McpStdioClient} or
 * {@link McpHttpClient} based on the {@link McpServerConfig}'s `transport`
 * discriminator. Pure (no side-effects beyond constructing the wrapper —
 * spawn / network I/O happens on `connect()`).
 */
export function defaultClientFactory(server) {
    if (server.transport === 'stdio') {
        return new McpStdioClient({
            command: server.command,
            ...(server.args !== undefined && { args: server.args }),
            ...(server.env !== undefined && { env: server.env }),
        });
    }
    // HTTP config carries no explicit transport selector — default to the
    // modern Streamable HTTP transport. Hosts wanting deprecated SSE can wire
    // their own factory until 5.2.5 exposes a finer-grained config field.
    return new McpHttpClient({
        transport: 'streamableHttp',
        url: server.url,
        ...(server.headers !== undefined && { headers: server.headers }),
    });
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
    opts;
    factory;
    /** Successfully-initialised server entries. Empty before `init()`. */
    entries = [];
    /** Tools exposed to the agent loop. Empty before `init()`. */
    wrappedTools = [];
    initStarted = false;
    closed = false;
    constructor(opts) {
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
    async init() {
        if (this.closed)
            return;
        if (this.initStarted) {
            this.opts.logger?.('debug', '[mcp:bridge] init() already called — skipping');
            return;
        }
        this.initStarted = true;
        if (this.opts.servers.length === 0)
            return;
        if (this.opts.signal?.aborted)
            return;
        // Spawn servers in parallel — each one's handshake is independent. Errors
        // are caught per-server so one slow/failing server doesn't block the rest.
        const settled = await Promise.all(this.opts.servers.map(async (server) => {
            const client = this.factory(server);
            try {
                await client.connect(this.opts.signal);
                const { tools } = await client.listTools(this.opts.signal);
                // Phase 5.2.5: fetch resource + prompt counts for the
                // `McpServerStart` capabilities payload. A server that does not
                // advertise the corresponding capability typically rejects with a
                // JSON-RPC `-32601` (Method not found); allSettled + 0 fallback
                // keeps the hook payload populated without forcing the server to
                // implement every list method.
                const [resourcesSettled, promptsSettled] = await Promise.allSettled([
                    client.listResources?.(this.opts.signal) ?? Promise.resolve({ resources: [] }),
                    client.listPrompts?.(this.opts.signal) ?? Promise.resolve({ prompts: [] }),
                ]);
                const resourcesCount = resourcesSettled.status === 'fulfilled'
                    ? (resourcesSettled.value.resources?.length ?? 0)
                    : 0;
                const promptsCount = promptsSettled.status === 'fulfilled' ? (promptsSettled.value.prompts?.length ?? 0) : 0;
                const transport = server.transport === 'stdio' ? 'stdio' : 'streamableHttp';
                const startedAt = Date.now();
                const entry = {
                    serverName: server.name,
                    transport,
                    client,
                    tools,
                    startedAt,
                };
                // Audit-only — return value ignored. The agent's wired
                // `safeFireHook` already swallows throws, but mirror the `notify`
                // pattern below: a throwing custom-wired emitter must not tip a
                // successful handshake into the failure path.
                try {
                    await this.opts.onLifecycle?.('McpServerStart', {
                        event: 'McpServerStart',
                        serverName: server.name,
                        transport,
                        capabilities: {
                            tools: tools.length,
                            resources: resourcesCount,
                            prompts: promptsCount,
                        },
                    });
                }
                catch {
                    /* lifecycle hook throws are observability-only; do not derail init */
                }
                return entry;
            }
            catch (err) {
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
                }
                catch {
                    // notify failures must not derail bridge init — they only matter
                    // for host observability and are already captured in the log.
                }
                // Best-effort teardown — the client may have spawned a subprocess
                // (stdio) or opened a socket (http) before failing later in the
                // handshake / listTools step.
                try {
                    await client.close();
                }
                catch {
                    /* ignore — already on the failure path */
                }
                return null;
            }
        }));
        this.entries = settled.filter((e) => e !== null);
        this.wrappedTools = this.entries.flatMap((entry) => entry.tools.map((mcpTool) => mapMcpToolToTool(entry.serverName, mcpTool, (toolName, args, signal) => entry.client.callTool(toolName, args, signal))));
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
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        const entries = this.entries;
        this.entries = [];
        this.wrappedTools = [];
        // Phase 5.2.5: snapshot the run-level signal's aborted state ONCE before
        // tearing servers down. If the bridge is being torn down because the
        // outer run was aborted, every `McpServerStop` should report
        // `reason: 'aborted'` even when the per-server close itself succeeds
        // (the run abort is the proximate cause of the teardown, not a per-
        // server error). Per-server close throws still surface as `'error'`.
        const aborted = this.opts.signal?.aborted === true;
        await Promise.all(entries.map(async (entry) => {
            let reason = aborted ? 'aborted' : 'closed';
            try {
                await entry.client.close();
            }
            catch (err) {
                reason = 'error';
                this.opts.logger?.('debug', `[mcp:bridge] close() of ${entry.serverName} threw — swallowing`, { error: err instanceof Error ? err.message : String(err) });
            }
            const durationMs = Date.now() - entry.startedAt;
            // Audit-only — same swallow-on-throw semantics as McpServerStart.
            try {
                await this.opts.onLifecycle?.('McpServerStop', {
                    event: 'McpServerStop',
                    serverName: entry.serverName,
                    durationMs,
                    reason,
                });
            }
            catch {
                /* lifecycle hook throws are observability-only; do not derail close */
            }
        }));
    }
    /** Tools exposed by all successfully-initialised servers. Empty until `init()` resolves. */
    get tools() {
        return this.wrappedTools;
    }
    /**
     * Names of servers whose handshake succeeded — i.e. the ones whose tools
     * are present in {@link tools}. Exposed primarily for tests; the agent
     * never branches on this.
     */
    get serverNames() {
        return this.entries.map((e) => e.serverName);
    }
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
    get catalog() {
        const out = [];
        for (const entry of this.entries) {
            for (const mcpTool of entry.tools) {
                const prefixed = `${entry.serverName}${MCP_TOOL_NAME_SEPARATOR}${mcpTool.name}`;
                const item = {
                    name: prefixed,
                    server: entry.serverName,
                };
                if (mcpTool.description !== undefined)
                    item.description = mcpTool.description;
                if (mcpTool.inputSchema !== undefined)
                    item.inputSchema = mcpTool.inputSchema;
                out.push(item);
            }
        }
        return out;
    }
}
/**
 * Wrap an MCP `Tool` (as returned by `client.listTools()`) as a
 * `@openrouter/agent` `Tool`. The wrapped tool's `name` is the prefixed form
 * `<serverName>__<toolName>` — two servers exposing the same `toolName`
 * therefore land on distinct prefixed names with no collision. The
 * `inputSchema` is stored as a `z.unknown().meta(jsonSchema)` so the OR SDK's
 * Zod→JSON-Schema converter emits the original MCP JSON Schema to the model
 * untouched.
 */
export function mapMcpToolToTool(serverName, mcpTool, dispatch) {
    const prefixed = `${serverName}${MCP_TOOL_NAME_SEPARATOR}${mcpTool.name}`;
    const passthroughSchema = z.unknown().meta(mcpTool.inputSchema);
    const execute = async (input, ctx) => {
        // ctx is the SDK's ToolExecuteContext — narrow defensively. The bridge
        // only needs an optional per-call AbortSignal off ctx.signal.
        const signal = ctx?.signal;
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
        inputSchema: passthroughSchema,
        execute,
    });
}
function isPlainRecord(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}
//# sourceMappingURL=bridge.js.map