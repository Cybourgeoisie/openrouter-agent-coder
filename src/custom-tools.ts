import { tool as sdkTool, type Tool } from '@openrouter/agent';
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
export function tool<TSchema extends z.ZodTypeAny>(config: CustomToolConfig<TSchema>): Tool {
  const { name, description, inputSchema, execute } = config;
  // Eagerly verify the schema is convertible. Surfacing a malformed schema at
  // tool-definition time beats a confusing API-layer error mid-run.
  z.toJSONSchema(inputSchema);

  const wrappedExecute = async (rawInput: unknown, ctx?: unknown): Promise<unknown> => {
    const parsed = (inputSchema as z.ZodType).safeParse(rawInput);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ');
      throw new Error(`Invalid input for tool "${name}": ${issues}`);
    }
    return execute(parsed.data as z.infer<TSchema>, ctx);
  };

  // The SDK's `tool()` types `inputSchema` as `$ZodObject<$ZodShape>` whereas
  // we widen to `z.ZodTypeAny` to mirror Claude's ergonomics; cast at the
  // boundary so the call type-checks. Behaviour is unchanged: the SDK stores
  // the schema on `Tool.function.inputSchema` and converts via `toJSONSchema`
  // when sending tool definitions to OpenRouter.
  return sdkTool({
    name,
    ...(description !== undefined ? { description } : {}),
    inputSchema: inputSchema as unknown as Parameters<typeof sdkTool>[0]['inputSchema'],
    execute: wrappedExecute,
  } as Parameters<typeof sdkTool>[0]) as Tool;
}

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
export function createSdkMcpServer(config: CreateSdkMcpServerConfig): SdkMcpServer {
  return {
    name: config.name,
    version: config.version,
    tools: config.tools,
  };
}
