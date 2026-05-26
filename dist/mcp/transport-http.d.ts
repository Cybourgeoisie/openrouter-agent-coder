/**
 * Phase 5.2.2 — MCP HTTP + SSE transport.
 *
 * Thin async wrapper around `@modelcontextprotocol/sdk`'s `Client` driven by
 * either `StreamableHTTPClientTransport` (modern, preferred) or
 * `SSEClientTransport` (deprecated, kept for back-compat). The transport is
 * chosen by the `transport: 'streamableHttp' | 'sse'` discriminator on the
 * constructor options.
 *
 * The SDK is loaded via dynamic `import()` inside [[McpHttpClient.connect]],
 * so users without MCP servers configured pay zero cold-start cost (and
 * `node_modules/@modelcontextprotocol/sdk` only has to exist on disk if
 * `connect()` is actually called).
 *
 * The public surface (`connect`/`close`/`listTools`/`callTool`/
 * `listResources`/`readResource`/`listPrompts`/`getPrompt`) mirrors
 * [[McpStdioClient]] in `transport-stdio.ts` exactly — Card 5.2.4's
 * tool-bridge consumes the two interchangeably via a structural type.
 *
 * Not wired into agent runs yet — Card 5.2.4 owns the tool bridge and Card
 * 5.2.5 owns lifecycle hooks. This module is preview-stage public surface.
 */
import type { CallToolResult, GetPromptResult, ListPromptsResult, ListResourcesResult, ListToolsResult, ReadResourceResult, ServerCapabilities, Implementation } from '@modelcontextprotocol/sdk/types.js';
import type { McpHttpClientOptions } from './spec.js';
/**
 * HTTP MCP client. Wraps the chosen transport, the JSON-RPC handshake, and the
 * passthrough request methods we need for the tool-bridge work in 5.2.4.
 *
 * Lifecycle:
 *   const client = new McpHttpClient({
 *     transport: 'streamableHttp',
 *     url: 'https://example.com/mcp',
 *   });
 *   await client.connect();
 *   const { tools } = await client.listTools();
 *   await client.close();
 */
export declare class McpHttpClient {
    private readonly opts;
    private client?;
    private transport?;
    private closed;
    private connectStarted;
    private lifecycleAbortListener?;
    constructor(opts: McpHttpClientOptions);
    /**
     * Opens the chosen HTTP transport and completes the MCP `initialize`
     * handshake. Idempotent in a narrow sense — calling twice is an error.
     *
     * The optional `signal` cancels this specific handshake call. It composes
     * with the lifecycle signal passed to the constructor — whichever fires
     * first aborts the SDK request; only the lifecycle signal closes the
     * transport.
     */
    connect(signal?: AbortSignal): Promise<void>;
    /** Idempotent — calling on an already-closed client is a no-op. */
    close(): Promise<void>;
    /** Server capabilities advertised during `initialize`. `undefined` before connect. */
    getServerCapabilities(): ServerCapabilities | undefined;
    /** Server name+version pair from `initialize`. `undefined` before connect. */
    getServerVersion(): Implementation | undefined;
    /**
     * Streamable HTTP session ID (server-issued via `Mcp-Session-Id`). Always
     * `undefined` on the deprecated SSE transport and before `connect()`.
     */
    getSessionId(): string | undefined;
    listTools(signal?: AbortSignal): Promise<ListToolsResult>;
    callTool(name: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult>;
    listResources(signal?: AbortSignal): Promise<ListResourcesResult>;
    readResource(uri: string, signal?: AbortSignal): Promise<ReadResourceResult>;
    listPrompts(signal?: AbortSignal): Promise<ListPromptsResult>;
    getPrompt(name: string, args?: Record<string, string>, signal?: AbortSignal): Promise<GetPromptResult>;
    private buildTransport;
    private requestOptions;
    private requireClient;
}
//# sourceMappingURL=transport-http.d.ts.map