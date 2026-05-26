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
import type { EffortLevel } from '../agent.js';
/**
 * Regex for a valid skill name. Lowercase letters and digits, optionally
 * separated by single hyphens; 1–64 chars total. No leading/trailing or
 * consecutive hyphens. Verbatim from the agentskills.io spec.
 */
export declare const SKILL_NAME_REGEX: RegExp;
/**
 * Hard cap on the `description` field (chars). Mirrors the agentskills.io spec
 * limit; values that exceed it are rejected at parse time so a malformed skill
 * fails loudly rather than silently truncating in the listing block.
 */
export declare const MAX_DESCRIPTION_CHARS = 1024;
/**
 * Hard cap on the `when_to_use` field (chars). Picked to match
 * `description` — Claude Code documents a combined 1,536-char cap on the
 * listing entry; capping each contributor at 1,024 keeps the math simple.
 */
export declare const MAX_WHEN_TO_USE_CHARS = 1024;
/** Hard cap on the `compatibility` field (chars). agentskills.io spec value. */
export declare const MAX_COMPATIBILITY_CHARS = 500;
/** Where a skill came from in the precedence stack. */
export type SkillSource = 'user' | 'project' | 'plugin' | 'enterprise' | 'builtin';
/**
 * Parsed + validated frontmatter for a single `SKILL.md`. Keys use camelCase
 * for the public TypeScript shape; the raw YAML uses kebab-case for the
 * Claude Code extension fields (`when_to_use`, `allowed-tools`, etc.) — see
 * {@link parseSkillFrontmatter}.
 *
 * **Per-skill model / effort overrides** propagate into the underlying
 * `callModel` call when the model invokes the skill (see Card 4.8 for the
 * inheritance contract). They do NOT override the surrounding agent run's
 * settings for non-skill turns.
 */
export interface SkillFrontmatter {
    name: string;
    description?: string;
    whenToUse?: string;
    license?: string;
    compatibility?: string;
    metadata?: Record<string, string>;
    /** Space-separated allow list of tool rules; honored only while the skill is rendering. */
    allowedTools?: string;
    argumentHint?: string;
    /** Named positional arguments — accepts both YAML lists and space-separated strings. */
    arguments?: readonly string[];
    /** When `true`, the skill is hidden from the model-facing listing block. */
    disableModelInvocation?: boolean;
    /** Defaults to `true` when omitted. Hosts MAY consult this for `/`-menu filtering. */
    userInvocable?: boolean;
    model?: string;
    effort?: EffortLevel;
    /** `'fork'` routes the render through the Phase 4.7 subagent runner. */
    context?: 'fork';
    /** Subagent type when {@link context} is `'fork'`. */
    agent?: string;
    paths?: readonly string[];
    shell?: 'bash' | 'powershell';
}
/**
 * Discovered skill record. Carries the parsed frontmatter, the raw markdown
 * body (pre-substitution), the absolute filesystem path the body was read
 * from, and the originating {@link SkillSource}.
 *
 * `name` on this struct is the *qualified* name the loader exposes: an
 * unqualified `name` for project / user skills, or `<pluginName>:<name>` for
 * skills sourced from a plugin (per the spike's namespacing rule). The
 * unqualified name lives on `frontmatter.name`.
 */
export interface SkillInfo {
    name: string;
    source: SkillSource;
    pluginName?: string;
    location: string;
    frontmatter: SkillFrontmatter;
    body: string;
}
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
export declare const skillFrontmatterSchema: z.ZodObject<{
    name: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    whenToUse: z.ZodOptional<z.ZodString>;
    license: z.ZodOptional<z.ZodString>;
    compatibility: z.ZodOptional<z.ZodString>;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    allowedTools: z.ZodOptional<z.ZodString>;
    argumentHint: z.ZodOptional<z.ZodString>;
    arguments: z.ZodOptional<z.ZodArray<z.ZodString>>;
    disableModelInvocation: z.ZodOptional<z.ZodBoolean>;
    userInvocable: z.ZodOptional<z.ZodBoolean>;
    model: z.ZodOptional<z.ZodString>;
    effort: z.ZodOptional<z.ZodEnum<{
        xhigh: "xhigh";
        high: "high";
        medium: "medium";
        low: "low";
        minimal: "minimal";
        none: "none";
    }>>;
    context: z.ZodOptional<z.ZodLiteral<"fork">>;
    agent: z.ZodOptional<z.ZodString>;
    paths: z.ZodOptional<z.ZodArray<z.ZodString>>;
    shell: z.ZodOptional<z.ZodEnum<{
        bash: "bash";
        powershell: "powershell";
    }>>;
}, z.core.$loose>;
//# sourceMappingURL=spec.d.ts.map