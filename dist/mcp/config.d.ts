/**
 * Phase 5.2.3 — MCP `.mcp.json` discovery.
 *
 * Pure async loader that finds, parses, and validates `.mcp.json` config
 * files in two scopes — `'user'` (`os.homedir()/.mcp.json`) and `'project'`
 * (walk up from `cwd` to the first `.git` ancestor, depth-capped). Returns a
 * deterministically-sorted flat list of validated server entries with the
 * originating file path stamped on each for debuggability.
 *
 * No side effects beyond `readFile` — does NOT spawn servers, mutate
 * `process.env`, or call `process.cwd()`. The 5.2.4 tool-bridge owns spawn
 * and lifecycle; this module is the read-only config layer.
 *
 * Walker mirrors `src/context-discovery.ts` (Phase 3.4): same depth cap,
 * same `.git` boundary semantics, same silent treatment of missing files.
 * Composition order (`user → project`) and override-by-name semantics mirror
 * Phase 3.4's specific-wins layering.
 */
/** Cap on the number of directories walked when resolving the project scope. */
export declare const MAX_PROJECT_WALK_DEPTH = 10;
/** Recognized scopes. Default order applied by {@link loadMcpConfig}. */
export type McpConfigScope = 'user' | 'project';
/**
 * stdio MCP server entry. Validated and normalized — `transport: 'stdio'` is
 * always set on the output, even when the input file omitted the field (the
 * loader infers from `command` presence).
 */
export interface McpStdioServerConfig {
    /** Discriminator. Always `'stdio'` on the output. */
    transport: 'stdio';
    /** Server name (object key under `mcpServers`). */
    name: string;
    /** Executable to spawn. */
    command: string;
    /** Argv passed to the executable. Omitted when absent in the source file. */
    args?: string[];
    /** Environment forwarded to the child. Omitted when absent in the source file. */
    env?: Record<string, string>;
    /** Absolute path to the `.mcp.json` this entry was loaded from. */
    source: string;
}
/**
 * HTTP MCP server entry. The 5.2.4 tool-bridge maps this to one of the SDK
 * transports in `src/mcp/spec.ts` (defaults to `'streamableHttp'`; SSE
 * fallback is a bridge-layer concern, not a config-layer one).
 */
export interface McpHttpServerConfig {
    /** Discriminator. Always `'http'` on the output. */
    transport: 'http';
    /** Server name (object key under `mcpServers`). */
    name: string;
    /** Endpoint URL (URL-validated at parse time). */
    url: string;
    /** Extra headers sent on every request. Omitted when absent in the source file. */
    headers?: Record<string, string>;
    /** Absolute path to the `.mcp.json` this entry was loaded from. */
    source: string;
}
/** Discriminated union of validated server entries. */
export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;
export interface LoadMcpConfigOptions {
    /**
     * Working directory the project walker starts from. When omitted the
     * project scope is silently skipped — the user scope (if requested) still
     * loads. This preserves the single-`process.cwd()`-call invariant: the
     * caller decides what `cwd` means.
     */
    cwd?: string;
    /**
     * Scopes to load and the order they apply in. Later entries override
     * earlier entries by SERVER NAME (full replacement, not deep merge).
     * Defaults to `['user', 'project']` so project entries win over user
     * entries.
     */
    scopes?: readonly McpConfigScope[];
}
/**
 * Load and merge `.mcp.json` config from the requested scopes. Pure async —
 * the only side effects are filesystem reads.
 *
 * Behavior:
 *
 * - **Missing files** are silent (return empty for that scope).
 * - **Malformed JSON** throws with the offending file path in the message.
 * - **Schema violations** throw a `ZodError` whose path includes the
 *   offending server name (caller-facing surface — the 5.2.4 bridge will
 *   wrap this in a user-friendly notification).
 * - **Override-by-name** is full replacement, not deep merge. A `'project'`
 *   entry named `foo` completely supplants a `'user'` entry named `foo`.
 * - **Walker order**: walk from `cwd` upward, reading `.mcp.json` at each
 *   level, stopping at the first `.git` ancestor (read the boundary dir
 *   then stop) or at depth {@link MAX_PROJECT_WALK_DEPTH}. Deeper-dir
 *   entries override shallower-dir entries by name (specific wins, matches
 *   Phase 3.4 `composeInstructions`).
 *
 * Output is sorted by `name` for deterministic ordering, so callers can
 * snapshot-test or hash the result without sort instability.
 */
export declare function loadMcpConfig(opts?: LoadMcpConfigOptions): Promise<McpServerConfig[]>;
//# sourceMappingURL=config.d.ts.map