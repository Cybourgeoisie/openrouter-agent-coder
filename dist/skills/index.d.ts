/**
 * Phase 5.7 — public skills surface. Re-exports the spec types,
 * discovery loader, and substitution helper as a single import path.
 */
export { SKILL_NAME_REGEX, MAX_DESCRIPTION_CHARS, MAX_WHEN_TO_USE_CHARS, MAX_COMPATIBILITY_CHARS, skillFrontmatterSchema, } from './spec.js';
export type { SkillFrontmatter, SkillInfo, SkillSource } from './spec.js';
export { createSkillLoader, loadSkills, parseSkillFile, parseYamlFrontmatter, normalizeFrontmatterKeys, splitFrontmatter, splitShellArgs, MAX_PROJECT_WALK_DEPTH, } from './loader.js';
export type { SkillLoader, SkillLoaderOptions } from './loader.js';
export { renderSkillBody, substituteVariables, substituteArguments, DEFAULT_SHELL_TIMEOUT_MS, SHELL_DISABLED_MARKER, } from './substitution.js';
export type { SubstitutionContext } from './substitution.js';
//# sourceMappingURL=index.d.ts.map