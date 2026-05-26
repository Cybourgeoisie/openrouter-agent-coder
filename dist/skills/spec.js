/**
 * Phase 5.7 — Skill spec types and validators.
 *
 * Mirrors the cross-vendor `agentskills.io/specification` shape plus Claude
 * Code's extension fields (per [spike 5.S4](../../plans/spikes/5.S4-skills-commands-plugins.md)).
 * Skill metadata is parsed once at discovery time via {@link parseSkillFrontmatter}
 * and stored on a {@link SkillInfo} record alongside the raw markdown body.
 *
 * **Frontmatter shape** (YAML between `---` markers at the top of `SKILL.md`):
 *
 * | Field                      | Required | Notes                                                                                            |
 * | -------------------------- | -------- | ------------------------------------------------------------------------------------------------ |
 * | `name`                     | yes      | lowercase letters/digits/hyphens, 1–64 chars; **must match the directory name** when present.    |
 * | `description`              | no       | freeform; surfaced in the system-prompt listing.                                                  |
 * | `when_to_use`              | no       | appended to description in the listing (Claude Code parity).                                      |
 * | `license`                  | no       | freeform.                                                                                         |
 * | `compatibility`            | no       | freeform (≤500 chars).                                                                            |
 * | `metadata`                 | no       | arbitrary string→string map.                                                                      |
 * | `allowed-tools`            | no       | space-separated rule list — same syntax as Phase 3.2's {@link compileRule}.                       |
 * | `argument-hint`            | no       | autocomplete hint (e.g. `[issue-number]`).                                                        |
 * | `arguments`                | no       | named positional list. Either a YAML list or a space-separated string is accepted.                |
 * | `disable-model-invocation` | no       | when `true`, the skill is hidden from the model's listing block (host can still invoke by name).  |
 * | `user-invocable`           | no       | defaults to `true`; setting `false` hides the skill from any host `/`-menu (model-only).          |
 * | `model`                    | no       | per-skill model override forwarded to the underlying `callModel` call.                            |
 * | `effort`                   | no       | per-skill reasoning-depth override; see {@link EffortLevel}.                                      |
 * | `context`                  | no       | `'fork'` to route through the Phase 4.7 subagent runner instead of inline render.                 |
 * | `agent`                    | no       | subagent type when `context: 'fork'`; unknown types fall back to `'general-purpose'`.             |
 * | `paths`                    | no       | glob filters (string or array). Accepted but not yet used for auto-activation.                    |
 * | `shell`                    | no       | `'bash'` (default) or `'powershell'`. v1 always runs `bash`; the field is parsed for future use.  |
 *
 * **Unknown fields are accepted and ignored** so a SKILL.md written against a
 * newer Claude Code build that adds fields we don't model loads cleanly here.
 */
import { z } from 'zod/v4';
/**
 * Regex for a valid skill name. Lowercase letters and digits, optionally
 * separated by single hyphens; 1–64 chars total. No leading/trailing or
 * consecutive hyphens. Verbatim from the agentskills.io spec.
 */
export const SKILL_NAME_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
/**
 * Hard cap on the `description` field (chars). Mirrors the agentskills.io spec
 * limit; values that exceed it are rejected at parse time so a malformed skill
 * fails loudly rather than silently truncating in the listing block.
 */
export const MAX_DESCRIPTION_CHARS = 1024;
/**
 * Hard cap on the `when_to_use` field (chars). Picked to match
 * `description` — Claude Code documents a combined 1,536-char cap on the
 * listing entry; capping each contributor at 1,024 keeps the math simple.
 */
export const MAX_WHEN_TO_USE_CHARS = 1024;
/** Hard cap on the `compatibility` field (chars). agentskills.io spec value. */
export const MAX_COMPATIBILITY_CHARS = 500;
const EFFORT_VALUES = ['xhigh', 'high', 'medium', 'low', 'minimal', 'none'];
/**
 * Zod validator for the parsed-then-camelCased frontmatter. Use
 * {@link parseSkillFrontmatter} to go from raw YAML → this shape (handles the
 * kebab-case → camelCase rewrite + dual-shape acceptance for `arguments` /
 * `paths` / `allowed-tools`); this schema is the type guard applied AFTER
 * that rewrite.
 *
 * Unknown fields are passed through (`.passthrough()`) so a SKILL.md written
 * for a newer Claude Code build with extra frontmatter keys still loads
 * without erroring.
 */
export const skillFrontmatterSchema = z
    .object({
    name: z
        .string()
        .regex(SKILL_NAME_REGEX, 'skill `name` must be 1–64 chars of lowercase letters/digits/hyphens, no leading/trailing/consecutive hyphens'),
    description: z.string().max(MAX_DESCRIPTION_CHARS).optional(),
    whenToUse: z.string().max(MAX_WHEN_TO_USE_CHARS).optional(),
    license: z.string().optional(),
    compatibility: z.string().max(MAX_COMPATIBILITY_CHARS).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    allowedTools: z.string().optional(),
    argumentHint: z.string().optional(),
    arguments: z.array(z.string()).optional(),
    disableModelInvocation: z.boolean().optional(),
    userInvocable: z.boolean().optional(),
    model: z.string().min(1).optional(),
    effort: z.enum(EFFORT_VALUES).optional(),
    context: z.literal('fork').optional(),
    agent: z.string().min(1).optional(),
    paths: z.array(z.string()).optional(),
    shell: z.enum(['bash', 'powershell']).optional(),
})
    .passthrough();
//# sourceMappingURL=spec.js.map