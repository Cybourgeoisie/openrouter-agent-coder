/**
 * Phase 5.2.1 — MCP stdio transport.
 *
 * Thin async wrapper around `@modelcontextprotocol/sdk`'s `Client` +
 * `StdioClientTransport`. The SDK is loaded via dynamic `import()` inside
 * [[McpStdioClient.connect]], so users without MCP servers configured pay
 * zero cold-start cost (and `node_modules/@modelcontextprotocol/sdk` only
 * has to exist on disk if `connect()` is actually called).
 *
 * Not wired into agent runs yet — Card 5.2.4 owns the tool bridge and Card
 * 5.2.5 owns lifecycle hooks. This module is preview-stage public surface.
 */
import type { CallToolResult, GetPromptResult, ListPromptsResult, ListResourcesResult, ListToolsResult, ReadResourceResult, ServerCapabilities, Implementation } from '@modelcontextprotocol/sdk/types.js';
import type { McpStdioClientOptions } from './spec.js';
/**
 * Stdio MCP client. Wraps subprocess spawn, JSON-RPC handshake, and the
 * passthrough request methods we need for the tool-bridge work in 5.2.4.
 *
 * Lifecycle:
 *   const client = new McpStdioClient({ command: 'node', args: ['server.mjs'] });
 *   await client.connect();
 *   const { tools } = await client.listTools();
 *   await client.close();
 */
export declare class McpStdioClient {
    private readonly opts;
    private client?;
    private transport?;
    private closed;
    private connectStarted;
    private lifecycleAbortListener?;
    constructor(opts: McpStdioClientOptions);
    /**
     * Spawns the subprocess, opens the stdio transport, and completes the MCP
     * `initialize` handshake. Idempotent in a narrow sense — calling twice is
     * an error (the SDK's `Client.connect` itself errors if called twice).
     *
     * The optional `signal` cancels this specific handshake call. It composes
     * with the lifecycle signal passed to the constructor — whichever fires
     * first aborts the SDK request.
     */
    connect(signal?: AbortSignal): Promise<void>;
    /** Idempotent — calling on an already-closed client is a no-op. */
    close(): Promise<void>;
    /** Server capabilities advertised during `initialize`. `undefined` before connect. */
    getServerCapabilities(): ServerCapabilities | undefined;
    /** Server name+version pair from `initialize`. `undefined` before connect. */
    getServerVersion(): Implementation | undefined;
    listTools(signal?: AbortSignal): Promise<ListToolsResult>;
    callTool(name: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult>;
    listResources(signal?: AbortSignal): Promise<ListResourcesResult>;
    readResource(uri: string, signal?: AbortSignal): Promise<ReadResourceResult>;
    listPrompts(signal?: AbortSignal): Promise<ListPromptsResult>;
    getPrompt(name: string, args?: Record<string, string>, signal?: AbortSignal): Promise<GetPromptResult>;
    private requestOptions;
    private requireClient;
}
//# sourceMappingURL=transport-stdio.d.ts.map