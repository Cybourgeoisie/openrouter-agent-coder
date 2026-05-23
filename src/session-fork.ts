import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { SessionLog } from './logging/logger.js';

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
export async function forkSession(opts: ForkSessionOptions): Promise<ForkSessionResult> {
  const { sessionId, logsRoot } = opts;
  const newSessionId = opts.newSessionId ?? randomUUID();

  const srcStatePath = join(logsRoot, sessionId, 'state.json');
  let raw: string;
  try {
    raw = await readFile(srcStatePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `cannot fork in-memory session: ${sessionId} has no on-disk state at ${srcStatePath}`,
        { cause: err },
      );
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
  let srcCwd: string | undefined;
  try {
    const srcSessionRaw = await readFile(join(logsRoot, sessionId, 'session.json'), 'utf-8');
    const srcSession = JSON.parse(srcSessionRaw) as SessionLog;
    srcCwd = srcSession.cwd;
  } catch {
    srcCwd = undefined;
  }

  const dstSession: SessionLog = {
    sessionId: newSessionId,
    startedAt: new Date().toISOString(),
    parentSessionId: sessionId,
    ...(srcCwd !== undefined && { cwd: srcCwd }),
  };
  await writeFile(
    join(logsRoot, newSessionId, 'session.json'),
    JSON.stringify(dstSession, null, 2),
  );

  return { sessionId: newSessionId };
}
