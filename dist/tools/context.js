/**
 * Fallback context for tool factories invoked without the agent runtime
 * (e.g. direct unit tests). Tests pass absolute paths, so `path.resolve` on
 * `cwd: '.'` is effectively a no-op.
 */
export const DEFAULT_TOOL_CONTEXT = { cwd: '.' };
//# sourceMappingURL=context.js.map