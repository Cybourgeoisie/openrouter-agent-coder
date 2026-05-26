/**
 * Options for {@link forkSession}.
 *
 * `logsRoot` is required (no `<cwd>/logs` default) so the module never reads
 * the current working directory — the constructor-level default lives at the
 * `OpenRouterAgentRun` boundary instead (a single hard-rule call site).
 * Callers driving `forkSession` directly must supply the same `logsRoot` they
 * ran the source session under.
 */
export interface ForkSessionOptions {
    /** Source session id — must have an on-disk `state.json` under `<logsRoot>/<sessionId>/`. */
    sessionId: string;
    /** New session id; auto-minted (UUID v4) when omitted. */
    newSessionId?: string;
    /** Logs root the source session was written under. Required — no cwd default. */
    logsRoot: string;
}
export interface ForkSessionResult {
    sessionId: string;
}
/**
 * Fork a persisted session. Copies `state.json` (the OR
 * `previousResponseId` chain — that is sufficient to resume the conversation)
 * from `<logsRoot>/<sessionId>/` into a new directory under
 * `<logsRoot>/<newSessionId>/`, and writes a fresh `session.json` whose
 * `parentSessionId` points back at the source.
 *
 * Per-request subdirectories (`req_*` / `gen_*`) are NOT copied — the fork
 * inherits everything it needs via the OR `previousResponseId` already
 * captured in `state.json`. Concurrent forks are not coordinated: the function
 * assumes single-process use.
 *
 * Rejects with `Error('cannot fork in-memory session: ...')` when the source
 * `state.json` is missing (ENOENT). Other filesystem errors propagate
 * unchanged.
 */
export declare function forkSession(opts: ForkSessionOptions): Promise<ForkSessionResult>;
//# sourceMappingURL=session-fork.d.ts.map