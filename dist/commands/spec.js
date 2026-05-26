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
export {};
//# sourceMappingURL=spec.js.map