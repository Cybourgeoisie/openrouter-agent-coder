/**
 * Execution context threaded into every built-in client tool at registration
 * time. Tools resolve relative `path` arguments against `cwd` and abort
 * in-flight work when `signal` fires.
 */
export interface ToolContext {
  /** Working directory tools should resolve relative paths against. */
  cwd: string;
  /** Composite abort signal from the owning run. */
  signal?: AbortSignal;
}

/**
 * Fallback context for tool factories invoked without the agent runtime
 * (e.g. direct unit tests). Tests pass absolute paths, so `path.resolve` on
 * `cwd: '.'` is effectively a no-op.
 */
export const DEFAULT_TOOL_CONTEXT: ToolContext = { cwd: '.' };
