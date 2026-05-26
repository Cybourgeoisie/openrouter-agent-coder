/**
 * Diagnostic logger signature mirrors `AgentLogger` from `./agent.js` but is
 * declared inline to keep this module dependency-free of `agent.ts` (avoids
 * a circular import: write_file → checkpoints → agent → tools → write_file).
 */
export type CheckpointLogger = (level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
/** Hard upper bound on checkpoints retained per session — oldest evicted on overflow. */
export declare const MAX_CHECKPOINTS_PER_SESSION = 100;
/** One file's record in a checkpoint manifest. */
export interface CheckpointFile {
    /** The original absolute path the file lived at when the checkpoint was created. */
    originalPath: string;
    /** Path-encoded basename used for the on-disk snapshot file (sans `.snapshot`). */
    encodedName: string;
    /** False when the file did not exist at checkpoint time; restore unlinks the path. */
    existed: boolean;
    /** Size in bytes of the snapshotted file. Omitted when `existed: false`. */
    size?: number;
    /** mtime (ms since epoch) of the snapshotted file. Omitted when `existed: false`. */
    mtimeMs?: number;
}
/** A single checkpoint's metadata. */
export interface Checkpoint {
    /** Unique id (UUID v4). */
    checkpointId: string;
    /** ISO 8601 timestamp the checkpoint was created. */
    timestamp: string;
    /** Files captured in this checkpoint. */
    files: CheckpointFile[];
}
export interface RestoreCheckpointResult {
    /** Original paths of files that were restored (overwritten) or unlinked (tombstone). */
    filesRestored: string[];
}
/**
 * Encode a filesystem path so it can be used as a single basename. The encoded
 * form replaces every `/` with `__SLASH__`. The leading `/` of an absolute
 * path is also encoded — the decoded form round-trips back to the original.
 */
export declare function encodePath(p: string): string;
/** Inverse of {@link encodePath}. */
export declare function decodePath(p: string): string;
/**
 * Snapshot a set of file paths into a new checkpoint directory under
 * `<logsRoot>/<sessionId>/checkpoints/`.
 *
 * Per-file behaviour:
 * - File exists → copy its bytes to a `.snapshot` companion; manifest records
 *   `existed: true`, `size`, `mtimeMs`.
 * - File missing → no `.snapshot` written; manifest records `existed: false`.
 *   Restoring this entry unlinks the live path if it currently exists.
 *
 * Optimisation: when a prior checkpoint in this session already snapshotted
 * the same path and the live file's `size` + `mtimeMs` match exactly, the new
 * checkpoint reuses the prior snapshot via `link()` (hard-link) rather than
 * re-copying the bytes. Falls back to `copyFile` on EXDEV / unsupported FS.
 *
 * Cap: when the total checkpoint count for this session would exceed
 * {@link MAX_CHECKPOINTS_PER_SESSION}, the oldest checkpoints are deleted
 * (entire directory tree) until the count is back at the cap.
 */
export declare function createCheckpoint(sessionId: string, logsRoot: string, files: string[], options?: {
    logger?: CheckpointLogger;
}): Promise<Checkpoint>;
/**
 * List all checkpoints recorded for a session, sorted ascending by timestamp
 * (oldest first). Returns an empty array when the session has no
 * `checkpoints/` directory yet.
 */
export declare function listCheckpoints(sessionId: string, logsRoot: string): Promise<Checkpoint[]>;
/**
 * Restore a checkpoint by id. Atomic across all files in the checkpoint:
 *
 * 1. Stage every restore destination into `<checkpointDir>/.restore-tmp/`
 *    (copy bytes from the `.snapshot` file).
 * 2. Once every staged file is ready, `rename()` each into place over the
 *    live path. `rename` is atomic on POSIX within a single filesystem.
 * 3. After all renames succeed, unlink any tombstoned paths whose live file
 *    is currently present.
 *
 * If anything goes wrong during phase 1, the `.restore-tmp/` directory is
 * removed and the error is rethrown — the live tree is untouched. Phase-2
 * failures leave the partial-restore state on disk (renames already applied
 * are not undone) and rethrow.
 */
export declare function restoreCheckpoint(checkpointId: string, sessionId: string, logsRoot: string): Promise<RestoreCheckpointResult>;
//# sourceMappingURL=checkpoints.d.ts.map