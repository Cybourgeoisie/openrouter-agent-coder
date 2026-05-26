/**
 * Phase 5.6 — slash-command discovery + resolve.
 *
 * A slash command is a flat-file degenerate skill. This loader walks the same
 * project / user / plugin precedence chain as {@link createSkillLoader}, but
 * targets `commands/*.md` files instead of `skills/<name>/SKILL.md`. Subdirs
 * under a `commands/` root are namespaced with `:` (so `commands/git/commit.md`
 * surfaces as `git:commit`).
 *
 * Precedence on name collision (high → low): project > user. Plugin commands
 * are always namespaced `<pluginName>:<name>` and therefore never collide with
 * project/user names.
 *
 * Frontmatter is OPTIONAL on commands (unlike skills). A `.md` file with no
 * `---` block is a valid body-only command; its name is derived from the
 * filename (sans `.md`) and the namespacing path.
 *
 * Reuses 5.7's parser end-to-end:
 *
 * - {@link splitFrontmatter} carves the YAML block off the raw body.
 * - {@link parseYamlFrontmatter} parses the YAML.
 * - {@link normalizeFrontmatterKeys} kebab-cases / widens dual-shape fields.
 * - {@link skillFrontmatterSchema} validates the result (Zod) — slash commands
 *   accept the same frontmatter surface as skills, so we share the schema.
 *
 * Render path: {@link renderSkillBody} from `../skills/substitution` is the
 * sole substitution engine. Commands do NOT fork it. The host's `resolve()`
 * call passes the already-shell-split positional args through to the
 * substitution context.
 *
 * Caller-decides-cwd invariant: `opts.cwd` and `opts.home` are required to
 * come from the host. The walker NEVER reads `process.cwd()` or `process.env.HOME`.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve, basename, extname, relative, sep } from 'node:path';
import * as os from 'node:os';
import { MAX_PROJECT_WALK_DEPTH, normalizeFrontmatterKeys, parseYamlFrontmatter, splitFrontmatter, splitShellArgs, } from '../skills/loader.js';
import { skillFrontmatterSchema } from '../skills/spec.js';
import { renderSkillBody } from '../skills/substitution.js';
/** Separator used when namespacing subdir / plugin commands. */
export const COMMAND_NAMESPACE_SEPARATOR = ':';
/**
 * Build a {@link CommandLoader} bound to the supplied discovery roots. The
 * loader is created synchronously; FS reads happen on the first call to
 * {@link CommandLoader.list} or {@link CommandLoader.resolve}.
 */
export function createCommandLoader(opts) {
    let cache = null;
    const ensureLoaded = async () => {
        if (cache)
            return cache;
        cache = await discoverCommands(opts);
        return cache;
    };
    return {
        async list() {
            const map = await ensureLoaded();
            const entries = [...map.values()].map(toInfo);
            // Converged-menu fold: surface every skill as a command of source:'skill'
            // unless a command of the same qualified name already exists.
            if (opts.skillLoader) {
                const skills = await opts.skillLoader.list();
                for (const skill of skills) {
                    if (map.has(skill.name))
                        continue;
                    entries.push(skillToCommandInfo(skill));
                }
            }
            entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
            return entries;
        },
        async resolve(input, ctx) {
            const map = await ensureLoaded();
            const tokens = splitShellArgs(input);
            if (tokens.length === 0)
                return undefined;
            const name = tokens[0];
            const args = tokens.slice(1);
            const record = map.get(name);
            if (!record)
                return undefined;
            const subCtx = {
                arguments: args,
                ...(ctx?.named !== undefined && { named: ctx.named }),
                sessionId: ctx?.sessionId ?? '',
                projectDir: opts.cwd,
                ...(ctx?.userConfig !== undefined && { userConfig: ctx.userConfig }),
                ...(ctx?.env !== undefined && { env: ctx.env }),
                ...(ctx?.signal !== undefined && { signal: ctx.signal }),
                ...(ctx?.cwd !== undefined && { cwd: ctx.cwd }),
                ...(opts.disableSkillShellExecution === true && { disableShellExecution: true }),
                skillDir: dirname(record.path),
            };
            const body = await renderSkillBody(record.body, subCtx);
            return { name, args, body };
        },
    };
}
function toInfo(rec) {
    return {
        name: rec.name,
        source: rec.source,
        path: rec.path,
        ...(rec.frontmatter.description !== undefined && {
            description: rec.frontmatter.description,
        }),
        ...(rec.frontmatter.argumentHint !== undefined && {
            argumentHint: rec.frontmatter.argumentHint,
        }),
    };
}
function skillToCommandInfo(skill) {
    return {
        name: skill.name,
        source: 'skill',
        path: skill.location,
        ...(skill.frontmatter.description !== undefined && {
            description: skill.frontmatter.description,
        }),
        ...(skill.frontmatter.argumentHint !== undefined && {
            argumentHint: skill.frontmatter.argumentHint,
        }),
    };
}
async function discoverCommands(opts) {
    const out = new Map();
    // Build in low → high precedence so later `.set()` overrides earlier:
    //   user (lowest) → project → plugin (always namespaced, never collides)
    if (opts.disableUserCommands !== true) {
        const homeDir = opts.home ?? os.homedir();
        for (const rec of await discoverScopedCommands(join(homeDir, '.claude', 'commands'), 'user', opts.logger)) {
            out.set(rec.name, rec);
        }
    }
    if (opts.disableProjectCommands !== true) {
        for (const rec of await discoverProjectCommands(opts.cwd, opts.logger)) {
            out.set(rec.name, rec);
        }
    }
    if (opts.pluginRoots && opts.pluginRoots.length > 0) {
        for (const { name: pluginName, root } of opts.pluginRoots) {
            for (const rec of await discoverScopedCommands(join(root, 'commands'), 'plugin', opts.logger, pluginName)) {
                out.set(rec.name, rec);
            }
        }
    }
    return out;
}
/**
 * Walk up from `cwd` collecting `.claude/commands/` discoveries at each
 * level. Stops at the first `.git` boundary or after
 * {@link MAX_PROJECT_WALK_DEPTH} levels, whichever is first.
 *
 * Returns shallowest-first so the caller's `Map.set` loop ends with the
 * deepest entry winning (mirrors the skill loader's monorepo rule).
 */
async function discoverProjectCommands(cwd, logger) {
    const visited = [];
    let current = resolve(cwd);
    for (let depth = 0; depth < MAX_PROJECT_WALK_DEPTH; depth++) {
        visited.push(current);
        if (await pathExists(join(current, '.git')))
            break;
        const parent = dirname(current);
        if (parent === current)
            break;
        current = parent;
    }
    const out = [];
    for (const dir of visited.reverse()) {
        const scoped = await discoverScopedCommands(join(dir, '.claude', 'commands'), 'project', logger);
        for (const rec of scoped)
            out.push(rec);
    }
    return out;
}
/**
 * Recursively walk a single `commands/` root collecting every `*.md`. Subdir
 * paths are converted into the namespace prefix — `git/commit.md` →
 * `git:commit`, `git/branch/list.md` → `git:branch:list`.
 *
 * Plugin commands are additionally prefixed with `<pluginName>:` (so the same
 * `git/commit.md` under a plugin named `acme` surfaces as `acme:git:commit`).
 */
async function discoverScopedCommands(root, source, logger, pluginName) {
    if (!(await pathExists(root)))
        return [];
    const out = [];
    await walk(root, root);
    return out;
    async function walk(dir, base) {
        let dirents;
        try {
            dirents = await readdir(dir, { withFileTypes: true });
        }
        catch (err) {
            logger?.('warn', `command discovery: failed to read ${dir}`, { err: String(err) });
            return;
        }
        for (const d of dirents) {
            const full = join(dir, d.name);
            if (d.isDirectory()) {
                await walk(full, base);
                continue;
            }
            if (!d.isFile() || extname(d.name) !== '.md')
                continue;
            const rec = await parseCommand(full, base, source, logger, pluginName);
            if (rec)
                out.push(rec);
        }
    }
}
async function parseCommand(fullPath, base, source, logger, pluginName) {
    let raw;
    try {
        raw = await readFile(fullPath, 'utf8');
    }
    catch (err) {
        logger?.('warn', `command discovery: failed to read ${fullPath}`, { err: String(err) });
        return undefined;
    }
    const rel = relative(base, fullPath);
    const segments = rel.split(sep);
    const filename = segments.pop();
    const inferredName = basename(filename, '.md');
    const namespaceSegments = [...segments, inferredName];
    if (pluginName)
        namespaceSegments.unshift(pluginName);
    const qualifiedName = namespaceSegments.join(COMMAND_NAMESPACE_SEPARATOR);
    let frontmatter;
    let body;
    try {
        const parsed = parseCommandFile(raw, inferredName);
        frontmatter = parsed.frontmatter;
        body = parsed.body;
    }
    catch (err) {
        // parseCommandFile only throws `Error` instances (zod validation, yaml
        // parser, or our own throws), so we extract `.message` directly without a
        // defensive non-Error branch.
        logger?.('warn', `command discovery: invalid frontmatter at ${fullPath}`, {
            err: err.message,
        });
        return undefined;
    }
    return {
        name: qualifiedName,
        source,
        path: fullPath,
        frontmatter,
        body,
    };
}
/**
 * Parse one `.md` command file. Frontmatter is OPTIONAL — files with no
 * leading `---` block are returned with `frontmatter: { name: inferredName }`
 * and `body` set to the raw file contents.
 *
 * When frontmatter IS present, it is normalized + validated against the
 * shared {@link skillFrontmatterSchema}. The `name` field is auto-injected
 * from the filename when omitted; explicit `name:` values are honored as-is
 * (we do NOT enforce the directory-name match invariant skills have, since
 * commands are flat files and the filename is the canonical identifier).
 *
 * Exported for unit tests.
 */
export function parseCommandFile(raw, inferredName) {
    const { yaml, body } = splitFrontmatter(raw);
    if (yaml === null) {
        return {
            frontmatter: { name: inferredName },
            body: raw,
        };
    }
    const rawFm = parseYamlFrontmatter(yaml);
    const camel = normalizeFrontmatterKeys(rawFm);
    if (camel.name === undefined)
        camel.name = inferredName;
    const parsed = skillFrontmatterSchema.safeParse(camel);
    if (!parsed.success) {
        throw new Error(`frontmatter validation failed: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
    }
    return { frontmatter: parsed.data, body };
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