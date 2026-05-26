import type { CanUseTool } from './agent.js';
export interface CompiledRule {
    /** Canonical tool name the rule targets. */
    toolName: string;
    /** True when this rule applies to the given tool input. */
    matches: (input: unknown) => boolean;
}
/**
 * Compile a single `allowedTools` / `disallowedTools` entry into a
 * {@link CompiledRule}.
 *
 * Grammar:
 * - Plain name: `'read_file'` or `'Read'` — matches every invocation of that tool.
 * - Scoped: `'<ToolName>(<pattern>)'` — pattern tested against a tool-specific
 *   argument (Bash → `command`, Edit/Write/Read/List → `path`, Grep →
 *   `pattern`). Bash patterns use `*` as a wildcard; the others are
 *   path-style globs (`*` excludes `/`, `**` spans directories).
 *
 * Throws on malformed input (missing closing paren, empty pattern, unknown
 * tool name) — validation is eager so callers see the error at construction.
 */
export declare function compileRule(rule: string): CompiledRule;
export interface ToolFilterParams {
    allowedTools?: readonly string[];
    disallowedTools?: readonly string[];
    /**
     * Optional fallback gate consulted when neither the allow nor deny list
     * matches a given tool call — typically the {@link permissionModeToCanUseTool}
     * closure derived from a {@link PermissionMode}.
     */
    modeGate?: CanUseTool;
}
/**
 * Compose `allowedTools` / `disallowedTools` into a single {@link CanUseTool}.
 *
 * Resolution order per call:
 * 1. Any matching `disallowedTools` rule → deny (deny wins).
 * 2. Any matching `allowedTools` rule → allow.
 * 3. `modeGate` (if supplied) decides.
 * 4. Otherwise → allow (matches the library's "no gating" backward-compat default).
 *
 * Rules are compiled eagerly — malformed input throws at this call site, not
 * later at first use.
 */
export declare function buildToolFilterCanUseTool(params: ToolFilterParams): CanUseTool;
//# sourceMappingURL=tool-filters.d.ts.map