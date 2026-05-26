/**
 * Phase 5.7 — skill discovery walker and {@link SkillLoader} factory.
 *
 * Walks four roots in precedence order (highest first):
 *
 * 1. **Plugin roots** — caller-supplied `{ name, root }` entries. Skill names
 *    are namespaced as `<pluginName>:<skillName>`, so plugin skills never
 *    collide with project/user skills.
 * 2. **User scope** — `<home>/.claude/skills/<name>/SKILL.md`.
 * 3. **Project scope** — walks up from `opts.cwd` until a `.git` directory
 *    is found (or {@link MAX_PROJECT_WALK_DEPTH} levels, whichever is first).
 *    Every level's `.claude/skills/` is scanned; the *deepest* match wins
 *    (closest-to-cwd > closest-to-root) per the spike's monorepo support note.
 *
 * Precedence on name collision (per the spike's "enterprise > personal >
 * project" rule with no enterprise scope in v1): user > project. Plugin
 * skills are namespaced and therefore never collide.
 *
 * Discovery is async and lazy-ish — {@link createSkillLoader} returns an
 * uninstantiated handle; the first call to {@link SkillLoader.list} drives
 * the walk and caches the result.
 *
 * Caller-decides-cwd invariant: `opts.cwd` must be provided by the host.
 * The walker NEVER reads `process.cwd()`. Similarly, the user scope honors
 * `opts.home` (defaults to {@link os.homedir}) — the loader does not read
 * `process.env.HOME`.
 */
import { type SubstitutionContext } from './substitution.js';
import { type SkillFrontmatter, type SkillInfo } from './spec.js';
/** Cap on the number of directories walked when resolving the project scope. */
export declare const MAX_PROJECT_WALK_DEPTH = 10;
/** Options accepted by {@link createSkillLoader}. */
export interface SkillLoaderOptions {
    /** Project working directory — the walker climbs up from here. */
    cwd: string;
    /** Override for the user scope root. Defaults to `os.homedir()`. */
    home?: string;
    /**
     * Optional plugin roots (5.8 populates). Each entry contributes one
     * discovery root namespaced by `name`. By default the walker scans
     * `<root>/skills/`; pass `skillsDir` to override the location of the
     * discovery directory (used when a plugin manifest declares additional
     * `skills:` paths under {@link PluginManifest}).
     */
    pluginRoots?: ReadonlyArray<{
        name: string;
        root: string;
        skillsDir?: string;
    }>;
    /** When `true`, the user scope is skipped entirely. */
    disableUserSkills?: boolean;
    /** When `true`, the project scope is skipped entirely. */
    disableProjectSkills?: boolean;
    /**
     * Optional diagnostic logger. Malformed frontmatter / IO errors are logged
     * at `'warn'` level; the discovery walk never throws. Shape-compatible
     * with `AgentLogger` from `src/agent.ts`.
     */
    logger?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => void;
}
/**
 * Lifecycle interface returned by {@link createSkillLoader}. The agent uses
 * `list()` to build the listing block and `get()` / `render()` when the
 * `Skill` tool fires. `watch()` is a no-op stub in v1 — the live-reload
 * design lands in a follow-up.
 */
export interface SkillLoader {
    /** Return every discovered skill, sorted by qualified name. Cached. */
    list(): Promise<readonly SkillInfo[]>;
    /** Look up a single skill by its qualified name (or `undefined`). */
    get(name: string): Promise<SkillInfo | undefined>;
    /**
     * Render a skill body with the supplied substitution context, returning the
     * already-rendered string ready to feed into the model. Throws when the
     * skill is unknown — callers should call {@link get} first if they want a
     * silent miss.
     */
    render(name: string, ctx: SubstitutionContext): Promise<string>;
    /** v1 stub. Returns a no-op disposer. */
    watch(onChange: (event: {
        name: string;
        type: 'add' | 'remove' | 'update';
    }) => void): () => void;
}
/**
 * Build a {@link SkillLoader} bound to the supplied discovery roots. The
 * loader is created synchronously; FS reads happen on the first call to
 * {@link SkillLoader.list}.
 */
export declare function createSkillLoader(opts: SkillLoaderOptions): SkillLoader;
/**
 * Split a SKILL.md into its frontmatter object + body string, validating the
 * frontmatter against {@link skillFrontmatterSchema} and enforcing the
 * directory-name match invariant.
 *
 * Throws on:
 *
 * - Missing or malformed frontmatter block (no opening `---`, no closing
 *   `---`, malformed YAML).
 * - `name` missing / failing regex.
 * - `name` mismatching the parent dir.
 */
export declare function parseSkillFile(raw: string, expectedDirName: string): {
    frontmatter: SkillFrontmatter;
    body: string;
};
/**
 * Hand-rolled YAML-frontmatter splitter. Accepts the standard `---\n...\n---`
 * convention plus a trailing newline (or its absence). Returns `yaml=null`
 * when the file does not open with `---`.
 *
 * Exported so {@link ../commands/loader.ts} can reuse the same splitter
 * without duplicating the BOM / fence-edge handling.
 */
export declare function splitFrontmatter(raw: string): {
    yaml: string | null;
    body: string;
};
/**
 * Tiny YAML subset parser. Supports:
 *
 * - `key: value` scalar pairs (single-line).
 * - `key: [a, b, c]` inline arrays.
 * - Multi-line block lists (`key:\n  - a\n  - b`).
 * - `key: |` and `key: >` multi-line block scalars (literal preserved as-is).
 * - Booleans (`true`/`false`/`yes`/`no`) and integer literals.
 * - `key:\n  nested: value` one-level-nested maps (used by `metadata`).
 *
 * This is intentionally minimal — SKILL.md frontmatter is a flat key/value
 * surface in practice. For richer YAML we'd bring in `yaml` (~150KB), which
 * the spike flags as acceptable but not required. Quoting is honored for both
 * single- and double-quoted scalars; backslash escapes are NOT expanded
 * (frontmatter values are file paths and short strings, not encoded blobs).
 *
 * Exported for unit tests.
 */
export declare function parseYamlFrontmatter(input: string): Record<string, unknown>;
/**
 * Normalize raw YAML keys (kebab-case, snake_case) into the camelCase shape
 * {@link skillFrontmatterSchema} validates. Also widens dual-shape fields:
 *
 * - `arguments` accepts both a YAML list (`[a, b]`) and a space-separated
 *   string (`a b`).
 * - `paths` accepts both a YAML list and a comma-separated string.
 * - `allowed-tools` accepts both a YAML list and a space-separated string
 *   (the schema keeps it as a string for downstream rule-compile).
 *
 * Exported for tests.
 */
export declare function normalizeFrontmatterKeys(raw: Record<string, unknown>): Record<string, unknown>;
/**
 * Convenience wrapper around {@link createSkillLoader} that immediately
 * resolves to the discovered skills. Equivalent to `createSkillLoader(opts).list()`.
 * Exported for hosts that just want a one-shot list at startup.
 */
export declare function loadSkills(opts: SkillLoaderOptions): Promise<readonly SkillInfo[]>;
/**
 * Quote-aware shell-style splitter used by host code to turn a raw `/skill foo
 * "bar baz"` input line into the positional arguments array the substitution
 * helper expects. Exported here so commands (5.6) can reuse it.
 *
 * Behaviour:
 *
 * - Splits on whitespace OUTSIDE quotes.
 * - Recognises both `'` and `"` quotes; the surrounding quotes are stripped.
 * - Backslash escapes `\\"` and `\\'` inside the matching quote style.
 * - Unterminated quotes are treated as terminating at end-of-input (no throw).
 */
export declare function splitShellArgs(input: string): string[];
//# sourceMappingURL=loader.d.ts.map