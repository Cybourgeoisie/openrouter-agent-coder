import type { CanUseTool, CanUseToolResult } from './agent.js';

/**
 * Named permission preset applied to every client-tool invocation. Implemented
 * as a thin {@link CanUseTool} factory on top of the Phase 1.4 primitive — the
 * lower-level `canUseTool` constructor option still wins when both are
 * supplied.
 *
 * - `default` — read-only tools (`read_file`, `list_directory`, `grep_files`)
 *   pass; everything else is denied with reason `'requires approval'`.
 * - `acceptEdits` — read-only + edit-style writers (`write_file`, `edit_file`)
 *   pass; `run_command` is denied.
 * - `bypassPermissions` — allow every tool. Equivalent to omitting the option.
 * - `plan` — strictly read-only; even edit-style writers are denied. Source of
 *   truth for the Plan-mode card (3.3).
 *
 * Server-side tools (`datetime`, `web_search`, `web_fetch`) execute on
 * OpenRouter's backend and bypass `canUseTool` entirely, so no permission mode
 * can gate them.
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';

const READ_ONLY_TOOLS = ['read_file', 'list_directory', 'grep_files'] as const;
const EDIT_TOOLS = ['write_file', 'edit_file'] as const;

const ALLOWED_BY_MODE: Record<PermissionMode, ReadonlySet<string> | null> = {
  default: new Set<string>(READ_ONLY_TOOLS),
  acceptEdits: new Set<string>([...READ_ONLY_TOOLS, ...EDIT_TOOLS]),
  plan: new Set<string>(READ_ONLY_TOOLS),
  bypassPermissions: null,
};

/**
 * Translate a {@link PermissionMode} into a {@link CanUseTool} closure. The
 * allow-set is captured once per call; the returned function is allocation-free
 * per tool decision. Denials surface the canonical Phase 1.4 deny shape
 * (`{ behavior: 'deny', reason: 'requires approval' }`), which the agent's
 * permission wrapper turns into a `JSON.stringify({ error, denied: true })`
 * tool-result payload.
 */
export function permissionModeToCanUseTool(mode: PermissionMode): CanUseTool {
  const allowed = ALLOWED_BY_MODE[mode];
  if (allowed === null) {
    return (): CanUseToolResult => ({ behavior: 'allow' });
  }
  return (toolName: string): CanUseToolResult =>
    allowed.has(toolName)
      ? { behavior: 'allow' }
      : { behavior: 'deny', reason: 'requires approval' };
}
