import { type Tool } from '@openrouter/agent';
import { z } from 'zod/v4';
/**
 * Configuration accepted by {@link tool}. Mirrors the Claude Agent SDK's
 * `tool()` shape so callers porting from `@anthropic-ai/claude-agent-sdk` can
 * keep the same object literal.
 */
export interface CustomToolConfig<TSchema extends z.ZodTypeAny> {
    /** Tool name exposed to the model. Must be unique within a tool array. */
    name: string;
    /** Human-readable description surfaced to the model. */
    description?: string;
    /**
     * Zod schema for the tool's input. Typically `z.object({...})`; any
     * `z.ZodTypeAny` is accepted to match Claude Agent SDK ergonomics, though
     * OpenRouter expects an object-shaped schema at the API layer.
     */
    inputSchema: TSchema;
    /**
     * Handler invoked with the validated input. The second argument receives the
     * SDK's `ToolExecuteContext` when the tool runs inside the agent loop.
     */
    execute: (input: z.infer<TSchema>, ctx?: unknown) => Promise<unknown> | unknown;
}
/**
 * Build a {@link Tool} from a Zod-typed config. Wraps the underlying
 * `@openrouter/agent` `tool()` factory with an input-validation layer that
 * surfaces Zod parse failures as `tool_result.isError = true` instead of
 * crashing the run.
 *
 * The Zod schema is converted to JSON Schema via Zod v4's built-in
 * `z.toJSONSchema` at call time (the SDK does the same when assembling the API
 * request). The `zod-to-json-schema` npm package is intentionally not pulled
 * in — Zod v4 ships the equivalent.
 */
export declare function tool<TSchema extends z.ZodTypeAny>(config: CustomToolConfig<TSchema>): Tool;
/**
 * In-process MCP-server-shaped value bag: a named, versioned bundle of
 * {@link Tool}s ready to spread into `OpenRouterAgentRunOptions['tools']`.
 *
 * NOTE: Real MCP transports (stdio / HTTP+SSE / `.mcp.json` discovery) come
 * in Phase 5.2 of the parity roadmap; for now this exists purely to match the
 * Claude Agent SDK's `createSdkMcpServer({ name, version, tools })` shape so
 * host code can build against the eventual surface.
 */
export interface SdkMcpServer {
    name: string;
    version: string;
    tools: readonly Tool[];
}
/** Config object for {@link createSdkMcpServer}. */
export interface CreateSdkMcpServerConfig {
    name: string;
    version: string;
    tools: readonly Tool[];
}
/**
 * Construct an {@link SdkMcpServer} value bag. The returned `tools` array is
 * what callers drop into `OpenRouterAgentRunOptions['tools']` — there is no
 * transport, registry, or lifecycle attached today (see Phase 5.2).
 */
export declare function createSdkMcpServer(config: CreateSdkMcpServerConfig): SdkMcpServer;
//# sourceMappingURL=custom-tools.d.ts.map