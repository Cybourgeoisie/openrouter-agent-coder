/**
 * Phase 4.6 — File checkpointing.
 *
 * Snapshot a set of file paths under `<logsRoot>/<sessionId>/checkpoints/<id>/`,
 * list previously-recorded checkpoints, and atomically restore a checkpoint
 * back to the live tree.
 *
 * On-disk layout:
 *
 * ```
 * <logsRoot>/<sessionId>/checkpoints/
 *   <checkpointId>/
 *     manifest.json
 *     <encoded-path>.snapshot     # raw bytes; absent for tombstones
 * ```
 *
 * Path encoding: every `/` (and the leading `/` of absolute paths) is replaced
 * with the sentinel `__SLASH__`. The encoder is round-trippable and collision-
 * safe as long as user paths don't already contain the literal token
 * `__SLASH__` — none do in practice.
 */
import { copyFile, link, mkdir, readFile, readdir, rename, rm, stat, writeFile, } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
/** Hard upper bound on checkpoints retained per session — oldest evicted on overflow. */
export const MAX_CHECKPOINTS_PER_SESSION = 100;
const PATH_SLASH_TOKEN = '__SLASH__';
const SNAPSHOT_SUFFIX = '.snapshot';
const RESTORE_TMP_DIR = '.restore-tmp';
/**
 * Encode a filesystem path so it can be used as a single basename. The encoded
 * form replaces every `/` with `__SLASH__`. The leading `/` of an absolute
 * path is also encoded — the decoded form round-trips back to the original.
 */
export function encodePath(p) {
    return p.replace(/\//g, PATH_SLASH_TOKEN);
}
/** Inverse of {@link encodePath}. */
export function decodePath(p) {
    return p.split(PATH_SLASH_TOKEN).join('/');
}
function sessionCheckpointsDir(logsRoot, sessionId) {
    return join(logsRoot, sessionId, 'checkpoints');
}
function checkpointDir(logsRoot, sessionId, checkpointId) {
    return join(sessionCheckpointsDir(logsRoot, sessionId), checkpointId);
}
async function readManifest(dir) {
    try {
        const raw = await readFile(join(dir, 'manifest.json'), 'utf-8');
        const parsed = JSON.parse(raw);
        return parsed;
    }
    catch {
        return null;
    }
}
/**
 * Find the most recent checkpoint in this session that recorded `originalPath`
 * as an existing file. Used by the mtime+size fast path during create.
 */
async function findPriorSnapshot(logsRoot, sessionId, originalPath, existingCheckpoints) {
    // Newest first. `existingCheckpoints` is sorted ascending by timestamp.
    for (let i = existingCheckpoints.length - 1; i >= 0; i--) {
        const cp = existingCheckpoints[i];
        const match = cp.files.find((f) => f.originalPath === originalPath && f.existed);
        if (match)
            return { checkpointId: cp.checkpointId, file: match };
    }
    return null;
}
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
export async function createCheckpoint(sessionId, logsRoot, files, options = {}) {
    const checkpointId = randomUUID();
    const timestamp = new Date().toISOString();
    const dir = checkpointDir(logsRoot, sessionId, checkpointId);
    await mkdir(dir, { recursive: true });
    // Pre-fetch the session's existing checkpoints once — used for both the
    // fast-path lookup and the post-write eviction step.
    const existing = await listCheckpoints(sessionId, logsRoot);
    const seen = new Set();
    const fileRecords = [];
    for (const original of files) {
        const abs = resolve(original);
        if (seen.has(abs))
            continue;
        seen.add(abs);
        const encodedName = encodePath(abs);
        const snapshotPath = join(dir, `${encodedName}${SNAPSHOT_SUFFIX}`);
        let liveStat;
        try {
            liveStat = await stat(abs);
        }
        catch {
            liveStat = null;
        }
        if (!liveStat || !liveStat.isFile()) {
            fileRecords.push({ originalPath: abs, encodedName, existed: false });
            continue;
        }
        const size = liveStat.size;
        const mtimeMs = liveStat.mtimeMs;
        // Fast-path: hard-link to a prior snapshot when mtime+size are unchanged.
        const prior = await findPriorSnapshot(logsRoot, sessionId, abs, existing);
        let reusedViaLink = false;
        if (prior && prior.file.size === size && prior.file.mtimeMs === mtimeMs) {
            const priorSnapshot = join(checkpointDir(logsRoot, sessionId, prior.checkpointId), `${prior.file.encodedName}${SNAPSHOT_SUFFIX}`);
            try {
                await link(priorSnapshot, snapshotPath);
                reusedViaLink = true;
            }
            catch {
                // EXDEV (cross-filesystem), EPERM, prior snapshot missing, or unsupported
                // FS — fall through to a regular copy below.
            }
        }
        if (!reusedViaLink) {
            await copyFile(abs, snapshotPath);
        }
        fileRecords.push({
            originalPath: abs,
            encodedName,
            existed: true,
            size,
            mtimeMs,
        });
    }
    const manifest = { checkpointId, timestamp, files: fileRecords };
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    // Cap enforcement: the just-created checkpoint is the (existing.length + 1)th.
    const projectedCount = existing.length + 1;
    if (projectedCount > MAX_CHECKPOINTS_PER_SESSION) {
        const toEvict = projectedCount - MAX_CHECKPOINTS_PER_SESSION;
        // existing is sorted ascending by timestamp — oldest first.
        const victims = existing.slice(0, toEvict);
        for (const victim of victims) {
            const victimDir = checkpointDir(logsRoot, sessionId, victim.checkpointId);
            await rm(victimDir, { recursive: true, force: true });
            options.logger?.('warn', 'checkpoint evicted', {
                checkpointId: victim.checkpointId,
                sessionId,
            });
        }
    }
    return manifest;
}
/**
 * List all checkpoints recorded for a session, sorted ascending by timestamp
 * (oldest first). Returns an empty array when the session has no
 * `checkpoints/` directory yet.
 */
export async function listCheckpoints(sessionId, logsRoot) {
    const root = sessionCheckpointsDir(logsRoot, sessionId);
    let entries;
    try {
        entries = await readdir(root, { withFileTypes: true });
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return [];
        throw err;
    }
    const checkpoints = [];
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        const manifest = await readManifest(join(root, entry.name));
        if (manifest)
            checkpoints.push(manifest);
    }
    checkpoints.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return checkpoints;
}
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
export async function restoreCheckpoint(checkpointId, sessionId, logsRoot) {
    const dir = checkpointDir(logsRoot, sessionId, checkpointId);
    const manifest = await readManifest(dir);
    if (!manifest) {
        throw new Error(`checkpoint not found: ${checkpointId} (session ${sessionId})`);
    }
    const tmpDir = join(dir, RESTORE_TMP_DIR);
    // Wipe any leftover tmp dir from a previous failed restore.
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    const restoreOps = [];
    const tombstones = [];
    try {
        for (const file of manifest.files) {
            if (!file.existed) {
                tombstones.push(file.originalPath);
                continue;
            }
            const snapshotPath = join(dir, `${file.encodedName}${SNAPSHOT_SUFFIX}`);
            const tmpPath = join(tmpDir, `${file.encodedName}${SNAPSHOT_SUFFIX}`);
            await copyFile(snapshotPath, tmpPath);
            restoreOps.push({ tmp: tmpPath, dest: file.originalPath, originalPath: file.originalPath });
        }
    }
    catch (err) {
        await rm(tmpDir, { recursive: true, force: true });
        throw err;
    }
    // Phase 2: rename staged files into place + unlink tombstones.
    const filesRestored = [];
    try {
        for (const op of restoreOps) {
            await mkdir(dirname(op.dest), { recursive: true });
            await rename(op.tmp, op.dest);
            filesRestored.push(op.originalPath);
        }
        for (const t of tombstones) {
            // rm({ force: true }) is a no-op when the path is already absent —
            // a tombstoned-but-never-recreated file satisfies its tombstone either
            // way. Always records the path as "restored" so callers see the full
            // manifest reflected in the result.
            await rm(t, { force: true });
            filesRestored.push(t);
        }
    }
    finally {
        await rm(tmpDir, { recursive: true, force: true });
    }
    return { filesRestored };
}
//# sourceMappingURL=checkpoints.js.map