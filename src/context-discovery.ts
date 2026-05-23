import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import * as os from 'node:os';
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
export const MAX_PROJECT_WALK_DEPTH = 10;

/** Cap on the composed instructions length (in characters). */
export const COMPOSED_INSTRUCTIONS_CHAR_CAP = 50_000;

export interface ComposeInstructionsOptions {
  cwd: string;
  settingSources: readonly SettingSource[];
  instructions: string;
  logger?: AgentLogger;
}

interface SourceContribution {
  source: SettingSource;
  content: string;
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
export async function composeInstructions(opts: ComposeInstructionsOptions): Promise<string> {
  const { cwd, settingSources, instructions, logger } = opts;
  if (settingSources.length === 0) return instructions;

  // Deduplicate while preserving caller order, then walk in the canonical
  // composition order (user → project → local) regardless of the input order
  // so the final string layout is deterministic.
  const requested = new Set<SettingSource>(settingSources);
  const contributions: SourceContribution[] = [];

  if (requested.has('user')) {
    const content = await readFileSafe(join(os.homedir(), '.claude', 'CLAUDE.md'));
    if (content !== null) contributions.push({ source: 'user', content });
  }
  if (requested.has('project')) {
    const projectContent = await collectProjectContent(cwd);
    if (projectContent !== '') contributions.push({ source: 'project', content: projectContent });
  }
  if (requested.has('local')) {
    const content = await readFileSafe(join(cwd, '.claude', 'CLAUDE.local.md'));
    if (content !== null) contributions.push({ source: 'local', content });
  }

  return composeWithCap(contributions, instructions, logger);
}

function composeWithCap(
  contributions: SourceContribution[],
  instructions: string,
  logger: AgentLogger | undefined,
): string {
  const joined = joinPieces(contributions, instructions);
  if (joined.length <= COMPOSED_INSTRUCTIONS_CHAR_CAP) return joined;

  const originalLen = joined.length;
  let working = [...contributions];
  // Truncate from the oldest source first (user → project → local). The
  // constructor's `instructions` is never dropped — it is the authoritative
  // contribution.
  while (working.length > 0) {
    working = working.slice(1);
    const candidate = joinPieces(working, instructions);
    if (candidate.length <= COMPOSED_INSTRUCTIONS_CHAR_CAP) {
      logger?.('warn', 'Composed instructions exceeded cap; truncated from oldest source', {
        capped: candidate.length,
        originalLen,
      });
      return candidate;
    }
  }
  // Even with all sources dropped the instructions alone is over cap. Return
  // the bare instructions and log accordingly.
  logger?.('warn', 'Composed instructions exceeded cap; truncated from oldest source', {
    capped: instructions.length,
    originalLen,
  });
  return instructions;
}

function joinPieces(contributions: SourceContribution[], instructions: string): string {
  const parts = contributions.map((c) => c.content);
  if (instructions.length > 0) parts.push(instructions);
  return parts.join('\n\n');
}

async function readFileSafe(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function collectProjectContent(cwd: string): Promise<string> {
  const startDir = resolve(cwd);
  // Walk from cwd upward, recording (flat, scoped) per level. After the walk
  // we reverse so the outermost directory (repo root or walk-cap terminus)
  // appears first and the cwd-most-specific block appears last — matching
  // the "more specific overrides more general" layering convention.
  const levels: string[] = [];
  let current = startDir;
  for (let depth = 0; depth < MAX_PROJECT_WALK_DEPTH; depth++) {
    const flat = await readFileSafe(join(current, 'CLAUDE.md'));
    if (flat !== null) levels.push(flat);
    const scoped = await readFileSafe(join(current, '.claude', 'CLAUDE.md'));
    if (scoped !== null) levels.push(scoped);

    if (await pathExists(join(current, '.git'))) break;

    const parent = dirname(current);
    if (parent === current) break; // reached filesystem root
    current = parent;
  }
  return levels.reverse().join('\n\n');
}
