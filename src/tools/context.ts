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
  /**
   * Emit a `Notification` hook from inside a tool's execute. No-op when the
   * owning {@link OpenRouterAgentRun} was constructed without an `onHook`
   * callback, so callers can call this unconditionally. The promise resolves
   * after the hook returns (or immediately, when no `onHook` is wired).
   */
  notify?: (level: 'info' | 'warn' | 'error', message: string, context?: unknown) => Promise<void>;
}

/**
 * Fallback context for tool factories invoked without the agent runtime
 * (e.g. direct unit tests). Tests pass absolute paths, so `path.resolve` on
 * `cwd: '.'` is effectively a no-op.
 */
export const DEFAULT_TOOL_CONTEXT: ToolContext = { cwd: '.' };
