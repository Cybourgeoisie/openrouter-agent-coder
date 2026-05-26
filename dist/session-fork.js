import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
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
export async function forkSession(opts) {
    const { sessionId, logsRoot } = opts;
    const newSessionId = opts.newSessionId ?? randomUUID();
    const srcStatePath = join(logsRoot, sessionId, 'state.json');
    let raw;
    try {
        raw = await readFile(srcStatePath, 'utf-8');
    }
    catch (err) {
        if (err.code === 'ENOENT') {
            throw new Error(`cannot fork in-memory session: ${sessionId} has no on-disk state at ${srcStatePath}`, { cause: err });
        }
        throw err;
    }
    const dstStatePath = join(logsRoot, newSessionId, 'state.json');
    await mkdir(dirname(dstStatePath), { recursive: true });
    const tmpPath = `${dstStatePath}.tmp`;
    await writeFile(tmpPath, raw);
    await rename(tmpPath, dstStatePath);
    // Best-effort source-session.json read; absence is non-fatal (legacy runs
    // pre-Phase 1.6 may have skipped it). cwd carries forward when present so
    // the forked session.json mirrors the source's working-dir record.
    let srcCwd;
    try {
        const srcSessionRaw = await readFile(join(logsRoot, sessionId, 'session.json'), 'utf-8');
        const srcSession = JSON.parse(srcSessionRaw);
        srcCwd = srcSession.cwd;
    }
    catch {
        srcCwd = undefined;
    }
    const dstSession = {
        sessionId: newSessionId,
        startedAt: new Date().toISOString(),
        parentSessionId: sessionId,
        ...(srcCwd !== undefined && { cwd: srcCwd }),
    };
    await writeFile(join(logsRoot, newSessionId, 'session.json'), JSON.stringify(dstSession, null, 2));
    return { sessionId: newSessionId };
}
//# sourceMappingURL=session-fork.js.map