export interface SessionLog {
    sessionId: string;
    startedAt: string;
    /**
     * Working directory captured at session-creation time. Optional so older
     * session.json files (written before Phase 1.6) still parse cleanly.
     */
    cwd?: string;
    /**
     * Set when this session was created by forking another (Phase 4.5). Carries
     * the source session id; omitted on root sessions so legacy session.json
     * files (and any new root run) round-trip unchanged.
     */
    parentSessionId?: string;
}
export interface RequestLog {
    sessionId: string;
    requestId: string;
    prompt: string;
    timestamp: string;
}
export interface GenerationLog {
    sessionId: string;
    requestId: string;
    generationId: string;
    response: unknown;
    timestamp: string;
}
export declare function createSessionId(): string;
export declare function createRequestId(): string;
export declare function createGenerationId(): string;
export declare function logSessionStart(logsRoot: string, sessionId: string, cwd: string, parentSessionId?: string): Promise<void>;
export declare function readSessionLog(logsRoot: string, sessionId: string): Promise<SessionLog>;
export declare function logRequest(logsRoot: string, entry: RequestLog): Promise<void>;
export declare function logGeneration(logsRoot: string, entry: GenerationLog): Promise<void>;
//# sourceMappingURL=logger.d.ts.map