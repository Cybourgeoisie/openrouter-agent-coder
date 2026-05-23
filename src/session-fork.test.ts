import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { forkSession } from './session-fork.js';
import { logSessionStart, readSessionLog } from './logging/logger.js';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let LOGS_ROOT: string;

beforeEach(async () => {
  LOGS_ROOT = await mkdtemp(join(tmpdir(), 'session-fork-test-'));
});

afterEach(async () => {
  await rm(LOGS_ROOT, { recursive: true, force: true });
});

interface ConvoState {
  previousResponseId?: string;
  messages?: unknown[];
}

async function seedSession(
  sessionId: string,
  state: ConvoState,
  cwd = '/tmp/source-cwd',
): Promise<void> {
  const dir = join(LOGS_ROOT, sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'state.json'), JSON.stringify(state, null, 2));
  await logSessionStart(LOGS_ROOT, sessionId, cwd);
}

describe('forkSession', () => {
  it('round-trips state.json bytes and stamps session.json with parentSessionId + fresh startedAt', async () => {
    const sourceId = 'src-session-happy';
    await seedSession(sourceId, { previousResponseId: 'resp-42', messages: [{ role: 'user' }] });
    const sourceSession = await readSessionLog(LOGS_ROOT, sourceId);
    // Force the fork's timestamp to be strictly greater than the source's.
    await new Promise((r) => setTimeout(r, 5));

    const { sessionId: forkedId } = await forkSession({ sessionId: sourceId, logsRoot: LOGS_ROOT });

    const srcStateBytes = await readFile(join(LOGS_ROOT, sourceId, 'state.json'));
    const forkStateBytes = await readFile(join(LOGS_ROOT, forkedId, 'state.json'));
    expect(forkStateBytes.equals(srcStateBytes)).toBe(true);

    const forkSessionLog = await readSessionLog(LOGS_ROOT, forkedId);
    expect(forkSessionLog.parentSessionId).toBe(sourceId);
    expect(forkSessionLog.sessionId).toBe(forkedId);
    expect(forkSessionLog.cwd).toBe('/tmp/source-cwd');
    expect(new Date(forkSessionLog.startedAt).getTime()).toBeGreaterThan(
      new Date(sourceSession.startedAt).getTime(),
    );
  });

  it('forked state.json is independent of the source (no aliasing)', async () => {
    const sourceId = 'src-session-indep';
    await seedSession(sourceId, { previousResponseId: 'resp-orig' });
    const { sessionId: forkedId } = await forkSession({ sessionId: sourceId, logsRoot: LOGS_ROOT });

    // Mutate the fork.
    await writeFile(
      join(LOGS_ROOT, forkedId, 'state.json'),
      JSON.stringify({ previousResponseId: 'resp-MUTATED' }, null, 2),
    );

    const srcReload = JSON.parse(
      await readFile(join(LOGS_ROOT, sourceId, 'state.json'), 'utf-8'),
    ) as ConvoState;
    expect(srcReload.previousResponseId).toBe('resp-orig');
  });

  it('mints a UUID v4 newSessionId when omitted', async () => {
    const sourceId = 'src-session-uuid';
    await seedSession(sourceId, { previousResponseId: 'r' });
    const { sessionId } = await forkSession({ sessionId: sourceId, logsRoot: LOGS_ROOT });
    expect(sessionId).toMatch(UUID_V4_RE);
  });

  it('honors an explicit newSessionId', async () => {
    const sourceId = 'src-session-explicit';
    await seedSession(sourceId, { previousResponseId: 'r' });
    const { sessionId } = await forkSession({
      sessionId: sourceId,
      newSessionId: 'my-chosen-fork-id',
      logsRoot: LOGS_ROOT,
    });
    expect(sessionId).toBe('my-chosen-fork-id');
    const s = await stat(join(LOGS_ROOT, 'my-chosen-fork-id', 'state.json'));
    expect(s.isFile()).toBe(true);
  });

  it('rejects with the in-memory error when source state.json is missing', async () => {
    const missingId = 'never-persisted';
    const expectedPath = join(LOGS_ROOT, missingId, 'state.json');
    await expect(forkSession({ sessionId: missingId, logsRoot: LOGS_ROOT })).rejects.toThrowError(
      `cannot fork in-memory session: ${missingId} has no on-disk state at ${expectedPath}`,
    );
  });

  it('round-trips parentSessionId via readSessionLog', async () => {
    const sourceId = 'src-session-readback';
    await seedSession(sourceId, { previousResponseId: 'r' });
    const { sessionId: forkedId } = await forkSession({
      sessionId: sourceId,
      newSessionId: 'fork-readback',
      logsRoot: LOGS_ROOT,
    });
    const log = await readSessionLog(LOGS_ROOT, forkedId);
    expect(log.parentSessionId).toBe(sourceId);
    // Root session lacks the field — guard the back-compat path.
    const srcLog = await readSessionLog(LOGS_ROOT, sourceId);
    expect(srcLog.parentSessionId).toBeUndefined();
  });

  it('tolerates a missing source session.json (cwd carry-forward is best-effort)', async () => {
    // State.json present, session.json absent — possible if a run wrote state
    // but crashed before session.json (or the file was deleted). Fork should
    // still succeed; cwd is just omitted from the forked session.json.
    const sourceId = 'src-no-session-json';
    const dir = join(LOGS_ROOT, sourceId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'state.json'), JSON.stringify({ previousResponseId: 'r' }));

    const { sessionId: forkedId } = await forkSession({
      sessionId: sourceId,
      logsRoot: LOGS_ROOT,
    });
    const log = await readSessionLog(LOGS_ROOT, forkedId);
    expect(log.parentSessionId).toBe(sourceId);
    expect(log.cwd).toBeUndefined();
  });

  it('propagates non-ENOENT filesystem errors unchanged', async () => {
    // Simulate by passing a directory path where state.json should be a file.
    // readFile against a directory throws EISDIR, not ENOENT — exercises the
    // "other errors propagate" branch.
    const sourceId = 'src-eisdir';
    const stateDir = join(LOGS_ROOT, sourceId, 'state.json');
    await mkdir(stateDir, { recursive: true });
    await expect(forkSession({ sessionId: sourceId, logsRoot: LOGS_ROOT })).rejects.toThrowError(
      /EISDIR|illegal operation/i,
    );
  });
});
