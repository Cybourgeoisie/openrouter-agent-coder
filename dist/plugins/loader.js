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
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import * as os from 'node:os';
import { pluginManifestSchema, PLUGIN_DEFAULT_PATHS, } from './spec.js';
/** Namespace separator used to qualify plugin-sourced MCP server names. */
export const PLUGIN_MCP_NAMESPACE_SEPARATOR = ':';
/**
 * Resolve each plugin directory into a {@link LoadedPlugin}. Failures are
 * logged + skipped; the returned array contains only the surviving plugins.
 */
export async function loadPlugins(opts) {
    const home = opts.home ?? os.homedir();
    const out = [];
    for (const rawDir of opts.pluginDirs) {
        const root = resolve(rawDir);
        try {
            const plugin = await loadOnePlugin(root, home, opts.logger);
            if (plugin)
                out.push(plugin);
        }
        catch (err) {
            opts.logger?.('warn', `plugin load failed: ${root}`, {
                err: err instanceof Error ? err.message : String(err),
            });
        }
    }
    return out;
}
async function loadOnePlugin(root, home, logger) {
    if (!(await pathExists(root))) {
        logger?.('warn', `plugin directory does not exist: ${root}`);
        return undefined;
    }
    const manifestPath = join(root, '.claude-plugin', 'plugin.json');
    let manifest;
    if (await pathExists(manifestPath)) {
        const raw = await readFile(manifestPath, 'utf8');
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch (err) {
            throw new Error(`plugin manifest at ${manifestPath} is not valid JSON: ${err.message}`, { cause: err });
        }
        const result = pluginManifestSchema.safeParse(parsed);
        if (!result.success) {
            throw new Error(`plugin manifest validation failed at ${manifestPath}: ${result.error.issues[0]?.message ?? 'unknown'}`);
        }
        manifest = result.data;
    }
    else {
        // Auto-discovery: derive the plugin name from the directory base name.
        const dirName = root.split(/[\\/]/).filter(Boolean).pop() ?? '';
        const result = pluginManifestSchema.safeParse({ name: dirName });
        if (!result.success) {
            throw new Error(`auto-discovered plugin name "${dirName}" is invalid (${result.error.issues[0]?.message ?? 'unknown'})`);
        }
        manifest = result.data;
    }
    const skillRoots = resolveSkillRoots(root, manifest);
    const commandRoots = resolveReplaceableRoots(root, manifest.commands, PLUGIN_DEFAULT_PATHS.commands);
    const agentRoots = resolveReplaceableRoots(root, manifest.agents, PLUGIN_DEFAULT_PATHS.agents);
    const hookConfigs = await resolveHookConfigs(root, manifest, logger);
    const mcpServers = await resolveMcpServers(root, manifest, logger);
    const dataDir = join(home, '.claude', 'plugins', 'data', manifest.name);
    return {
        manifest,
        root,
        dataDir,
        skillRoots,
        commandRoots,
        agentRoots,
        hookConfigs,
        mcpServers,
    };
}
/**
 * Resolve skill discovery roots. `manifest.skills` ADDS to the default
 * `<root>/skills`, dedup'd while preserving order. Missing directories are
 * kept in the output (the skill loader silently no-ops on absent roots).
 */
function resolveSkillRoots(root, manifest) {
    const seen = new Set();
    const out = [];
    const push = (p) => {
        const abs = isAbsolute(p) ? p : join(root, p);
        if (seen.has(abs))
            return;
        seen.add(abs);
        out.push(abs);
    };
    push(PLUGIN_DEFAULT_PATHS.skills);
    if (manifest.skills !== undefined) {
        const extras = Array.isArray(manifest.skills) ? manifest.skills : [manifest.skills];
        for (const p of extras)
            push(p);
    }
    return out;
}
/**
 * `commands` / `agents` manifest fields REPLACE the default path. Returning the
 * default when the field is absent keeps the loader's invariant: every plugin
 * always advertises one discovery root per replaceable component.
 */
function resolveReplaceableRoots(root, manifestField, defaultRelativePath) {
    if (manifestField === undefined) {
        return [join(root, defaultRelativePath)];
    }
    const paths = Array.isArray(manifestField) ? manifestField : [manifestField];
    return paths.map((p) => (isAbsolute(p) ? p : join(root, p)));
}
/**
 * Resolve `hooks` to a {@link PluginHookConfig} array. The manifest field may
 * be either:
 *
 * - A string — relative or absolute path to a `hooks.json`-shaped file.
 * - An object — inline hook map (already parsed).
 * - Undefined — fall back to `<root>/hooks/hooks.json` when present.
 */
async function resolveHookConfigs(root, manifest, logger) {
    const out = [];
    const pushFile = async (path) => {
        if (!(await pathExists(path)))
            return;
        const raw = await readFile(path, 'utf8');
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch (err) {
            logger?.('warn', `plugin ${manifest.name}: failed to parse hooks file at ${path}`, {
                err: err.message,
            });
            return;
        }
        const hookMap = extractHookMap(parsed);
        if (hookMap) {
            out.push({ pluginName: manifest.name, source: path, hooks: hookMap });
        }
    };
    if (manifest.hooks === undefined) {
        await pushFile(join(root, PLUGIN_DEFAULT_PATHS.hooks));
    }
    else if (typeof manifest.hooks === 'string') {
        const path = isAbsolute(manifest.hooks) ? manifest.hooks : join(root, manifest.hooks);
        await pushFile(path);
    }
    else {
        // Inline object — accept top-level `hooks: {...}` envelope OR a bare
        // event-keyed map (both shapes appear in the wild).
        const hookMap = extractHookMap(manifest.hooks);
        if (hookMap) {
            out.push({
                pluginName: manifest.name,
                source: join(root, '.claude-plugin', 'plugin.json'),
                hooks: hookMap,
            });
        }
    }
    return out;
}
/**
 * Accept either `{ hooks: { PreToolUse: [...] } }` (the file shape used by
 * `anthropics/claude-code/plugins/security-guidance/hooks/hooks.json`) or a
 * bare `{ PreToolUse: [...] }` map. Returns the inner event-keyed map.
 */
function extractHookMap(parsed) {
    if (parsed === null || typeof parsed !== 'object')
        return undefined;
    const obj = parsed;
    if ('hooks' in obj && obj.hooks && typeof obj.hooks === 'object') {
        return obj.hooks;
    }
    return obj;
}
/**
 * Resolve `mcpServers` to a list of {@link McpServerConfig} entries.
 *
 * - Inline object — Claude Code's `.mcp.json` shape (`{ mcpServers: { name: {...} } }`).
 * - String — relative or absolute path to such a file.
 * - Undefined — fall back to `<root>/.mcp.json` when present.
 *
 * Names are namespaced `<pluginName>:<serverName>` so plugin-sourced servers
 * never collide with user/project-scope entries.
 */
async function resolveMcpServers(root, manifest, logger) {
    let raw;
    let source;
    if (manifest.mcpServers === undefined) {
        const path = join(root, PLUGIN_DEFAULT_PATHS.mcpServers);
        if (!(await pathExists(path)))
            return [];
        source = path;
        try {
            raw = JSON.parse(await readFile(path, 'utf8'));
        }
        catch (err) {
            logger?.('warn', `plugin ${manifest.name}: failed to parse .mcp.json at ${path}`, {
                err: err.message,
            });
            return [];
        }
    }
    else if (typeof manifest.mcpServers === 'string') {
        const path = isAbsolute(manifest.mcpServers)
            ? manifest.mcpServers
            : join(root, manifest.mcpServers);
        if (!(await pathExists(path))) {
            logger?.('warn', `plugin ${manifest.name}: mcpServers path does not exist: ${path}`);
            return [];
        }
        source = path;
        try {
            raw = JSON.parse(await readFile(path, 'utf8'));
        }
        catch (err) {
            logger?.('warn', `plugin ${manifest.name}: failed to parse mcpServers file at ${path}`, {
                err: err.message,
            });
            return [];
        }
    }
    else {
        raw = { mcpServers: manifest.mcpServers };
        source = join(root, '.claude-plugin', 'plugin.json');
    }
    const envelope = raw;
    const inner = envelope?.mcpServers ?? raw;
    if (!inner || typeof inner !== 'object')
        return [];
    const out = [];
    for (const [serverName, entry] of Object.entries(inner)) {
        if (!entry || typeof entry !== 'object')
            continue;
        const e = entry;
        const namespacedName = `${manifest.name}${PLUGIN_MCP_NAMESPACE_SEPARATOR}${serverName}`;
        if (typeof e.command === 'string') {
            const cfg = {
                transport: 'stdio',
                name: namespacedName,
                command: e.command,
                source,
            };
            if (Array.isArray(e.args))
                cfg.args = e.args.map(String);
            if (e.env && typeof e.env === 'object') {
                cfg.env = Object.fromEntries(Object.entries(e.env).map(([k, v]) => [k, String(v)]));
            }
            out.push(cfg);
        }
        else if (typeof e.url === 'string') {
            const cfg = {
                transport: 'http',
                name: namespacedName,
                url: e.url,
                source,
            };
            if (e.headers && typeof e.headers === 'object') {
                cfg.headers = Object.fromEntries(Object.entries(e.headers).map(([k, v]) => [k, String(v)]));
            }
            out.push(cfg);
        }
        else {
            logger?.('warn', `plugin ${manifest.name}: server ${serverName} has neither command nor url`);
        }
    }
    return out;
}
async function pathExists(path) {
    try {
        await stat(path);
        return true;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=loader.js.map