import type { AgentLogger } from './agent.js';
/**
 * Identifier for a context-discovery source. Each value maps to a fixed
 * lookup strategy under {@link composeInstructions}:
 *
 * - `'project'` — walk up from `cwd` looking for `<dir>/CLAUDE.md` and
 *   `<dir>/.claude/CLAUDE.md` on each level. Stops at the first directory
 *   containing a `.git` entry, or at the filesystem root. Walk depth capped
 *   at {@link MAX_PROJECT_WALK_DEPTH}.
 * - `'user'` — `<os.homedir()>/.claude/CLAUDE.md`.
 * - `'local'` — `<cwd>/.claude/CLAUDE.local.md`.
 */
export type SettingSource = 'project' | 'user' | 'local';
/** Cap on the number of directories walked when resolving `'project'`. */
export declare const MAX_PROJECT_WALK_DEPTH = 10;
/** Cap on the composed instructions length (in characters). */
export declare const COMPOSED_INSTRUCTIONS_CHAR_CAP = 50000;
export interface ComposeInstructionsOptions {
    cwd: string;
    settingSources: readonly SettingSource[];
    instructions: string;
    logger?: AgentLogger;
}
/**
 * Compose system instructions by prepending discovered CLAUDE.md content
 * from the requested sources, in the order: user, project, local, then the
 * supplied `instructions` last. Missing or unreadable files are silently
 * ignored. When the composed result exceeds {@link COMPOSED_INSTRUCTIONS_CHAR_CAP},
 * earlier-source contributions are dropped (in user→project→local order) and
 * a `warn`-level log fires via the optional `logger`.
 *
 * Returns the original `instructions` unchanged when `settingSources` is empty
 * (no FS reads happen).
 */
export declare function composeInstructions(opts: ComposeInstructionsOptions): Promise<string>;
//# sourceMappingURL=context-discovery.d.ts.map