import { tool as sdkTool } from '@openrouter/agent';
import { z } from 'zod/v4';
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
export function tool(config) {
    const { name, description, inputSchema, execute } = config;
    // Eagerly verify the schema is convertible. Surfacing a malformed schema at
    // tool-definition time beats a confusing API-layer error mid-run.
    z.toJSONSchema(inputSchema);
    const wrappedExecute = async (rawInput, ctx) => {
        const parsed = inputSchema.safeParse(rawInput);
        if (!parsed.success) {
            const issues = parsed.error.issues
                .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
                .join('; ');
            throw new Error(`Invalid input for tool "${name}": ${issues}`);
        }
        return execute(parsed.data, ctx);
    };
    // The SDK's `tool()` types `inputSchema` as `$ZodObject<$ZodShape>` whereas
    // we widen to `z.ZodTypeAny` to mirror Claude's ergonomics; cast at the
    // boundary so the call type-checks. Behaviour is unchanged: the SDK stores
    // the schema on `Tool.function.inputSchema` and converts via `toJSONSchema`
    // when sending tool definitions to OpenRouter.
    return sdkTool({
        name,
        ...(description !== undefined ? { description } : {}),
        inputSchema: inputSchema,
        execute: wrappedExecute,
    });
}
/**
 * Construct an {@link SdkMcpServer} value bag. The returned `tools` array is
 * what callers drop into `OpenRouterAgentRunOptions['tools']` — there is no
 * transport, registry, or lifecycle attached today (see Phase 5.2).
 */
export function createSdkMcpServer(config) {
    return {
        name: config.name,
        version: config.version,
        tools: config.tools,
    };
}
//# sourceMappingURL=custom-tools.js.map