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
import { type SkillLoader } from '../skills/loader.js';
import { type SkillFrontmatter } from '../skills/spec.js';
import type { CommandInfo } from './spec.js';
/** Separator used when namespacing subdir / plugin commands. */
export declare const COMMAND_NAMESPACE_SEPARATOR = ":";
/** Options accepted by {@link createCommandLoader}. */
export interface CommandLoaderOptions {
    /** Project working directory — the walker climbs from here. */
    cwd: string;
    /** Override for the user scope root. Defaults to `os.homedir()`. */
    home?: string;
    /** Optional plugin roots; commands under `<root>/commands/` are namespaced `<name>:<command>`. */
    pluginRoots?: ReadonlyArray<{
        name: string;
        root: string;
    }>;
    /**
     * Converged-menu hook (opencode pattern). When supplied, {@link CommandLoader.list}
     * folds every skill the loader knows about into the listing as a command of
     * `source: 'skill'`. When a command of the same qualified name already
     * exists, the command WINS — the skill is suppressed from the menu.
     *
     * Opt-in; defaults to `undefined` (no skill folding).
     */
    skillLoader?: SkillLoader;
    /**
     * Skip the user scope entirely. Useful for tests / sandboxed hosts.
     */
    disableUserCommands?: boolean;
    /**
     * Skip the project scope entirely.
     */
    disableProjectCommands?: boolean;
    /**
     * Propagates into the {@link SubstitutionContext.disableShellExecution}
     * field handed to {@link renderSkillBody} when {@link CommandLoader.resolve}
     * fires. Matches the skill loader's `disableSkillShellExecution` knob.
     */
    disableSkillShellExecution?: boolean;
    /**
     * Optional diagnostic logger. Discovery / parse failures are logged at
     * `'warn'` level; the walk itself never throws.
     */
    logger?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => void;
}
/** Resolved-command output returned by {@link CommandLoader.resolve}. */
export interface ResolvedCommand {
    /** Qualified name as discovered (post-namespacing). */
    name: string;
    /** Positional arguments parsed from the raw input via {@link splitShellArgs}. */
    args: string[];
    /** Rendered body, post-substitution. Ready to hand to `OpenRouterAgentRun({ prompt })`. */
    body: string;
}
/** Lifecycle interface returned by {@link createCommandLoader}. */
export interface CommandLoader {
    /**
     * Return every discovered command, sorted by qualified name. When
     * {@link CommandLoaderOptions.skillLoader} is set, skill entries are folded
     * in at `source: 'skill'`. Cached after the first call.
     */
    list(): Promise<readonly CommandInfo[]>;
    /**
     * Resolve a raw input line (the slice AFTER the leading `/`) into a
     * concrete `{ name, args, body }`. Returns `undefined` when no command of
     * that qualified name is known — callers (host CLIs) should surface a
     * "no such command" message and continue, NOT throw.
     *
     * Substitution is performed via {@link renderSkillBody} with a
     * {@link SubstitutionContext} built from the shell-split args.
     */
    resolve(input: string, ctx?: ResolveContext): Promise<ResolvedCommand | undefined>;
}
/**
 * Optional substitution context overrides for {@link CommandLoader.resolve}.
 * The loader supplies sensible defaults for every field (sessionId derived
 * from a small UUID, projectDir = `opts.cwd`, etc.) — callers only need to
 * supply this when they want to feed the rendered body a real session id,
 * named arguments, or a per-invocation abort signal.
 */
export interface ResolveContext {
    /** Threaded through to {@link SubstitutionContext.sessionId}. */
    sessionId?: string;
    /** Named bindings layered on top of the positional args parsed from `input`. */
    named?: Readonly<Record<string, string>>;
    /** Per-invocation user-config map for `${user_config.<key>}`. */
    userConfig?: Readonly<Record<string, string | number | boolean>>;
    /** Narrow env passthrough for generic `${VAR}` expansion. */
    env?: Readonly<Record<string, string>>;
    /** Per-invocation abort signal — propagates to any inline `` !`cmd` ``. */
    signal?: AbortSignal;
    /** Override the substitution working dir. Defaults to `opts.cwd`. */
    cwd?: string;
}
/**
 * Build a {@link CommandLoader} bound to the supplied discovery roots. The
 * loader is created synchronously; FS reads happen on the first call to
 * {@link CommandLoader.list} or {@link CommandLoader.resolve}.
 */
export declare function createCommandLoader(opts: CommandLoaderOptions): CommandLoader;
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
export declare function parseCommandFile(raw: string, inferredName: string): {
    frontmatter: SkillFrontmatter;
    body: string;
};
//# sourceMappingURL=loader.d.ts.map