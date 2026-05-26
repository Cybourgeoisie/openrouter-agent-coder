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
    /**
     * Session id of the owning run, threaded in by `agent.ts` so checkpointing
     * tools (write_file, edit_file with Phase 4.6 `checkpoint: true`) can
     * locate the session's `checkpoints/` directory. Undefined for tool
     * factories used in isolation (unit tests).
     */
    sessionId?: string;
    /**
     * Logs root the owning run was constructed against — paired with
     * {@link sessionId} so checkpointing can find
     * `<logsRoot>/<sessionId>/checkpoints/`. Undefined for tool factories used
     * in isolation.
     */
    logsRoot?: string;
    /**
     * When `true`, write_file and edit_file create a pre-write checkpoint of
     * their target path before mutating it. Per-tool-call `checkpoint` input
     * overrides this value (the call argument wins). Undefined / false → no
     * auto-checkpoint.
     */
    checkpoint?: boolean;
    /**
     * When false, the owning run is in-memory only and on-disk checkpoints
     * cannot be written. Threaded through so write_file/edit_file can skip
     * the checkpoint step with a `warn` log instead of writing snapshots to
     * a directory the rest of the run doesn't populate.
     */
    persistSession?: boolean;
    /**
     * Optional diagnostic logger forwarded from the owning run so checkpoint
     * eviction + persist-session no-op warnings have somewhere to land.
     */
    logger?: (level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}
/**
 * Fallback context for tool factories invoked without the agent runtime
 * (e.g. direct unit tests). Tests pass absolute paths, so `path.resolve` on
 * `cwd: '.'` is effectively a no-op.
 */
export declare const DEFAULT_TOOL_CONTEXT: ToolContext;
//# sourceMappingURL=context.d.ts.map