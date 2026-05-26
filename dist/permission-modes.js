const READ_ONLY_TOOLS = ['read_file', 'list_directory', 'grep_files', 'glob'];
const EDIT_TOOLS = ['write_file', 'edit_file'];
const ALLOWED_BY_MODE = {
    default: new Set(READ_ONLY_TOOLS),
    acceptEdits: new Set([...READ_ONLY_TOOLS, ...EDIT_TOOLS]),
    plan: new Set(READ_ONLY_TOOLS),
    bypassPermissions: null,
};
/**
 * Per-mode deny reason surfaced to the model via the `tool_result` payload.
 * `plan` carries copy that nudges the model toward drafting a textual plan
 * rather than retrying the blocked call; the other modes keep the canonical
 * generic phrasing. `bypassPermissions` never denies — its entry is unused
 * but present to keep the record total.
 */
const DENY_REASON_BY_MODE = {
    default: 'requires approval',
    acceptEdits: 'requires approval',
    plan: 'plan mode: read-only — propose edits in your reply',
    bypassPermissions: '',
};
/**
 * Translate a {@link PermissionMode} into a {@link CanUseTool} closure. The
 * allow-set and deny reason are captured once per call; the returned function
 * is allocation-free per tool decision. Denials surface the canonical Phase
 * 1.4 deny shape (`{ behavior: 'deny', reason: <mode-specific text> }`),
 * which the agent's permission wrapper turns into a
 * `JSON.stringify({ error, denied: true })` tool-result payload.
 */
export function permissionModeToCanUseTool(mode) {
    const allowed = ALLOWED_BY_MODE[mode];
    if (allowed === null) {
        return () => ({ behavior: 'allow' });
    }
    const reason = DENY_REASON_BY_MODE[mode];
    return (toolName) => allowed.has(toolName) ? { behavior: 'allow' } : { behavior: 'deny', reason };
}
//# sourceMappingURL=permission-modes.js.map