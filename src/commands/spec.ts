/**
 * Phase 5.6 — Slash command spec types.
 *
 * A slash command is a flat-file degenerate skill: the frontmatter shape is
 * the same {@link SkillFrontmatter} surface (re-exported for parity), and the
 * substitution helper is reused wholesale from {@link ../skills/substitution}.
 * The only differences vs. a skill:
 *
 * - File layout — commands live as `commands/<name>.md` (and `commands/<dir>/<name>.md`
 *   for subdir namespacing). Skills live as `skills/<name>/SKILL.md`.
 * - Invocation path — commands are HOST-invoked (host CLI parses `/foo bar`
 *   and feeds the resolved body to {@link OpenRouterAgentRun} as the next
 *   prompt). Skills are MODEL-invoked via the Phase 5.7 `Skill` tool.
 * - Frontmatter is OPTIONAL — a body-only `.md` file is a valid command; its
 *   name is inferred from the filename.
 */

import type { SkillFrontmatter } from '../skills/spec.js';

/**
 * Origin of a {@link CommandInfo} entry, mirroring {@link SkillSource} with
 * one additional value — `'skill'` for entries surfaced by the converged-menu
 * pass when a {@link SkillLoader} is supplied to the command loader.
 */
export type CommandSource = 'user' | 'project' | 'plugin' | 'skill' | 'builtin';

/**
 * One discovered slash command. Returned by {@link CommandLoader.list}.
 *
 * Frontmatter fields ride on the record but are NOT re-exposed verbatim — the
 * listing surface intentionally narrows to `name` / `description` /
 * `argumentHint` so a host CLI's autocomplete view matches Claude Code's
 * `/`-menu shape.
 */
export interface CommandInfo {
  /** Qualified name — `<dir>:<name>` for subdir / plugin namespacing, bare otherwise. */
  name: string;
  description?: string;
  argumentHint?: string;
  source: CommandSource;
  /**
   * Absolute path to the discovered file. For converged-menu skill entries this
   * is the underlying `SKILL.md` path.
   */
  path: string;
}

/**
 * Re-export of the skill frontmatter shape — slash commands accept the same
 * keys. Surface kept under the `CommandFrontmatter` alias so 5.6's public API
 * doesn't force consumers to import the skills module to talk about commands.
 */
export type CommandFrontmatter = SkillFrontmatter;
