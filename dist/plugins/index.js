/**
 * Phase 5.8 — Plugin module public surface.
 *
 * A plugin is a directory bundling additional skills, slash commands, MCP
 * servers, and hooks for an {@link OpenRouterAgentRun}. See {@link loadPlugins}
 * for the discovery entry point and {@link LoadedPlugin} for the aggregate
 * shape consumers wire into the agent.
 */
export { loadPlugins, PLUGIN_MCP_NAMESPACE_SEPARATOR } from './loader.js';
export { pluginManifestSchema, PLUGIN_NAME_REGEX, PLUGIN_DEFAULT_PATHS } from './spec.js';
//# sourceMappingURL=index.js.map