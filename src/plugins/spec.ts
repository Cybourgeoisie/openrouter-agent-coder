/**
 * Phase 5.8 — Plugin manifest types and validators.
 *
 * A plugin is a directory that contributes additional skills, slash commands,
 * MCP servers, and hooks to an {@link OpenRouterAgentRun}. The optional manifest
 * lives at `<plugin>/.claude-plugin/plugin.json`. When absent, the plugin is
 * auto-discovered with the directory name as its `name`.
 *
 * The schema below mirrors the Claude Code plugins reference
 * (https://code.claude.com/docs/en/plugins-reference, observed 2026-05-24).
 * v1 honors a subset of the manifest:
 *
 * | Field          | v1 behavior                                                         |
 * | -------------- | ------------------------------------------------------------------- |
 * | `name`         | required; namespaces every contribution                             |
 * | `skills`       | adds to default `skills/` discovery root                            |
 * | `commands`     | replaces default `commands/` discovery root                         |
 * | `agents`       | replaces default `agents/` discovery root (not consumed in v1)      |
 * | `hooks`        | replaces default `hooks/hooks.json`; inline object or file path     |
 * | `mcpServers`   | replaces default `.mcp.json`; inline object or file path            |
 * | `outputStyles` | accepted-but-ignored (v2)                                           |
 * | `lspServers`   | accepted-but-ignored (v2; LSP not on the parity roadmap)            |
 * | `userConfig`   | accepted-but-ignored (v2; prompt-on-enable / keychain integration)  |
 * | `dependencies` | accepted-but-ignored (v2; transitive plugin resolver)               |
 * | `experimental` | accepted-but-ignored (v2; themes + monitors)                        |
 *
 * The `passthrough()` modifier means a manifest written against a newer Claude
 * Code build with extra top-level keys still loads cleanly.
 */

import { z } from 'zod/v4';
import type { McpServerConfig } from '../mcp/config.js';

/**
 * Regex for a valid plugin name. Same constraints as a skill name — lowercase
 * letters/digits/hyphens, 1–64 chars, no leading/trailing/consecutive hyphens.
 * Mirrors the Claude Code docs ("identifier-safe").
 */
export const PLUGIN_NAME_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** Default per-component locations resolved when the manifest omits the field. */
export const PLUGIN_DEFAULT_PATHS = {
  skills: 'skills',
  commands: 'commands',
  agents: 'agents',
  hooks: 'hooks/hooks.json',
  mcpServers: '.mcp.json',
} as const;

const authorSchema = z
  .object({
    name: z.string().optional(),
    email: z.string().optional(),
    url: z.string().optional(),
  })
  .passthrough();

const stringOrStringArray = z.union([z.string(), z.array(z.string())]);

/**
 * Zod validator for `.claude-plugin/plugin.json`. Only `name` is required;
 * every other field is optional. Unknown top-level keys are passed through
 * (matches Claude Code's "warnings, not errors" stance on schema drift).
 *
 * v2-deferred fields (`userConfig`, `dependencies`, `experimental`,
 * `lspServers`, `outputStyles`) are accepted by the schema but not consumed
 * by the v1 loader — they pass through to {@link PluginManifest} so a host
 * inspecting the parsed manifest can surface them.
 */
export const pluginManifestSchema = z
  .object({
    name: z
      .string()
      .regex(
        PLUGIN_NAME_REGEX,
        'plugin `name` must be 1–64 chars of lowercase letters/digits/hyphens, no leading/trailing/consecutive hyphens',
      ),
    displayName: z.string().optional(),
    version: z.string().optional(),
    description: z.string().optional(),
    author: z.union([z.string(), authorSchema]).optional(),
    homepage: z.string().optional(),
    repository: z.string().optional(),
    license: z.string().optional(),
    keywords: z.array(z.string()).optional(),

    // Component overrides (v1 honored).
    skills: stringOrStringArray.optional(),
    commands: stringOrStringArray.optional(),
    agents: stringOrStringArray.optional(),
    hooks: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
    mcpServers: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),

    // v2-deferred — accepted-but-ignored.
    outputStyles: stringOrStringArray.optional(),
    lspServers: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
    userConfig: z.record(z.string(), z.unknown()).optional(),
    dependencies: z
      .array(z.union([z.string(), z.object({ name: z.string() }).passthrough()]))
      .optional(),
    experimental: z
      .object({
        themes: stringOrStringArray.optional(),
        monitors: stringOrStringArray.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/** TypeScript shape produced by {@link pluginManifestSchema}. */
export type PluginManifest = z.infer<typeof pluginManifestSchema>;

/**
 * Hook configuration entry parsed from a plugin's `hooks/hooks.json` (or
 * inline `hooks` field in the manifest). The shape mirrors Claude Code's
 * documented hook format — a top-level keyed-by-event object whose values are
 * arrays of `{ matcher?, hooks: [...] }` triggers.
 *
 * The v1 plugin loader returns these verbatim on {@link LoadedPlugin.hookConfigs}.
 * The agent integration COMPOSES them with the user-supplied `onHook` callback
 * via `safeFireHook` broadcast (no collision possible — every hook fires).
 */
export interface PluginHookConfig {
  /** Plugin that contributed this hook configuration. */
  pluginName: string;
  /** Absolute path to the source file (the manifest itself or `hooks/hooks.json`). */
  source: string;
  /** Raw hook map keyed by event name (`PreToolUse`, `PostToolUse`, …). */
  hooks: Record<string, unknown>;
}

/**
 * Aggregated plugin contributions ready to be folded into the agent's
 * skill/command/MCP/hook registries. Produced by {@link loadPlugins}.
 */
export interface LoadedPlugin {
  /** Parsed manifest. Auto-discovered plugins get a minimal `{ name }` manifest. */
  manifest: PluginManifest;
  /** Absolute path to the plugin's root directory. Resolves `${CLAUDE_PLUGIN_ROOT}`. */
  root: string;
  /** Absolute path to the plugin's data dir. Resolves `${CLAUDE_PLUGIN_DATA}`. v1 v: path string only — directory is not auto-created. */
  dataDir: string;
  /** Resolved skill discovery roots. Default `<root>/skills` plus any `manifest.skills` entries. */
  skillRoots: string[];
  /** Resolved command discovery roots. Default `<root>/commands` UNLESS `manifest.commands` is set (which replaces it). */
  commandRoots: string[];
  /** Resolved agent discovery roots. Same replace semantics as commands. v1: not consumed by the agent runner. */
  agentRoots: string[];
  /** Parsed hook configs (one entry per plugin that contributed). */
  hookConfigs: PluginHookConfig[];
  /** MCP server entries parsed from the plugin's `.mcp.json` (or inline `mcpServers`). Namespaced `<pluginName>:<serverName>`. */
  mcpServers: McpServerConfig[];
}
