/**
 * Phase 5.8 — Plugin discovery + manifest loader.
 *
 * Walks a caller-supplied list of plugin directories, resolves the optional
 * `.claude-plugin/plugin.json` manifest (auto-discovers from the directory name
 * when absent), and aggregates the plugin's contributions into a
 * {@link LoadedPlugin} shape ready for the agent to fold into the existing
 * skill / command / MCP / hook registries.
 *
 * Composition semantics (per Claude Code docs):
 *
 * - `skills` — **adds to** the default `<root>/skills/` discovery root.
 * - `commands`, `agents` — **replace** the default location entirely.
 * - `hooks`, `mcpServers` — accept either an inline object or a file path
 *   relative to the plugin root. Inline wins by-name on collision (the file
 *   shape is not deep-merged with the inline shape; pick one).
 *
 * Failure policy (mirror MCP init-failure pattern from Phase 5.2.4): a single
 * plugin failing to parse logs a warning via the supplied `logger` and is
 * SKIPPED — the loader continues with surviving plugins.
 *
 * Substitution of `${CLAUDE_PLUGIN_ROOT}` inside hook commands / MCP server
 * commands happens at the consumer site (the agent), not here. This loader
 * returns paths and command strings verbatim.
 */
import { type LoadedPlugin } from './spec.js';
/** Namespace separator used to qualify plugin-sourced MCP server names. */
export declare const PLUGIN_MCP_NAMESPACE_SEPARATOR = ":";
/** Options accepted by {@link loadPlugins}. */
export interface LoadPluginsOptions {
    /** Absolute paths to plugin directories. Each entry produces at most one {@link LoadedPlugin}. */
    pluginDirs: readonly string[];
    /**
     * Override for the user-scope home directory. Defaults to {@link os.homedir}.
     * `${CLAUDE_PLUGIN_DATA}` resolves to `<home>/.claude/plugins/data/<name>/`.
     */
    home?: string;
    /**
     * Optional diagnostic logger. Manifest / IO failures log at `'warn'` and the
     * offending plugin is skipped. Shape-compatible with `AgentLogger`.
     */
    logger?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => void;
}
/**
 * Resolve each plugin directory into a {@link LoadedPlugin}. Failures are
 * logged + skipped; the returned array contains only the surviving plugins.
 */
export declare function loadPlugins(opts: LoadPluginsOptions): Promise<LoadedPlugin[]>;
//# sourceMappingURL=loader.d.ts.map