import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  readSessionRegistry,
  appendSessionToRegistry,
  setSessionFirstPrompt,
  getLastSession,
} from './session-registry.js';

const LOG_BASE = join(process.cwd(), 'logs');
const REGISTRY_PATH = join(LOG_BASE, 'sessions.json');

let snapshotBefore: string | null = null;

async function backupRegistry(): Promise<void> {
  try {
    snapshotBefore = await readFile(REGISTRY_PATH, 'utf-8');
  } catch {
    snapshotBefore = null;
  }
}

async function restoreRegistry(): Promise<void> {
  const { writeFile } = await import('node:fs/promises');
  if (snapshotBefore !== null) {
    await writeFile(REGISTRY_PATH, snapshotBefore);
  } else {
    await rm(REGISTRY_PATH, { force: true });
  }
}

afterEach(async () => {
  await restoreRegistry();
});

describe('readSessionRegistry', () => {
  it('returns an empty array when the file does not exist', async () => {
    await backupRegistry();
    await rm(REGISTRY_PATH, { force: true });
    const entries = await readSessionRegistry();
    expect(entries).toEqual([]);
  });
});

describe('appendSessionToRegistry', () => {
  it('creates the registry file and appends the entry', async () => {
    await backupRegistry();
    await rm(REGISTRY_PATH, { force: true });

    const entry = { sessionId: 'sess_test_aaa', startedAt: '2024-01-01T00:00:00.000Z' };
    await appendSessionToRegistry(entry);
    const entries = await readSessionRegistry();
    const match = entries.find((e) => e.sessionId === 'sess_test_aaa');
    expect(match).toEqual(entry);
  });

  it('appends multiple sessions in insertion order', async () => {
    await backupRegistry();
    await rm(REGISTRY_PATH, { force: true });

    await appendSessionToRegistry({ sessionId: 'sess_t1', startedAt: '2024-01-01T00:00:00.000Z' });
    await appendSessionToRegistry({ sessionId: 'sess_t2', startedAt: '2024-01-02T00:00:00.000Z' });
    await appendSessionToRegistry({ sessionId: 'sess_t3', startedAt: '2024-01-03T00:00:00.000Z' });
    const entries = await readSessionRegistry();
    const ids = entries.map((e) => e.sessionId);
    expect(ids).toEqual(['sess_t1', 'sess_t2', 'sess_t3']);
  });

  it('does not duplicate an already-registered session', async () => {
    await backupRegistry();
    await rm(REGISTRY_PATH, { force: true });

    const entry = { sessionId: 'sess_dup', startedAt: '2024-01-01T00:00:00.000Z' };
    await appendSessionToRegistry(entry);
    await appendSessionToRegistry(entry);
    const entries = await readSessionRegistry();
    expect(entries.filter((e) => e.sessionId === 'sess_dup')).toHaveLength(1);
  });

  it('writes valid JSON to disk', async () => {
    await backupRegistry();
    await rm(REGISTRY_PATH, { force: true });

    await appendSessionToRegistry({
      sessionId: 'sess_json',
      startedAt: '2024-01-01T00:00:00.000Z',
    });
    const raw = await readFile(REGISTRY_PATH, 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});

describe('setSessionFirstPrompt', () => {
  it('sets the firstPrompt field on the matching entry', async () => {
    await backupRegistry();
    await rm(REGISTRY_PATH, { force: true });

    await appendSessionToRegistry({ sessionId: 'sess_p1', startedAt: '2024-01-01T00:00:00.000Z' });
    await setSessionFirstPrompt('sess_p1', 'hello world');
    const entries = await readSessionRegistry();
    const match = entries.find((e) => e.sessionId === 'sess_p1');
    expect(match?.firstPrompt).toBe('hello world');
  });

  it('does not overwrite an existing firstPrompt', async () => {
    await backupRegistry();
    await rm(REGISTRY_PATH, { force: true });

    await appendSessionToRegistry({ sessionId: 'sess_p2', startedAt: '2024-01-01T00:00:00.000Z' });
    await setSessionFirstPrompt('sess_p2', 'first');
    await setSessionFirstPrompt('sess_p2', 'second');
    const entries = await readSessionRegistry();
    const match = entries.find((e) => e.sessionId === 'sess_p2');
    expect(match?.firstPrompt).toBe('first');
  });

  it('is a no-op when sessionId is not found', async () => {
    await backupRegistry();
    await rm(REGISTRY_PATH, { force: true });

    await expect(setSessionFirstPrompt('sess_missing', 'prompt')).resolves.toBeUndefined();
    const entries = await readSessionRegistry();
    expect(entries).toHaveLength(0);
  });
});

describe('getLastSession', () => {
  it('returns null when the registry is empty', async () => {
    await backupRegistry();
    await rm(REGISTRY_PATH, { force: true });

    const last = await getLastSession();
    expect(last).toBeNull();
  });

  it('returns the last appended entry', async () => {
    await backupRegistry();
    await rm(REGISTRY_PATH, { force: true });

    await appendSessionToRegistry({
      sessionId: 'sess_first',
      startedAt: '2024-01-01T00:00:00.000Z',
    });
    await appendSessionToRegistry({
      sessionId: 'sess_last',
      startedAt: '2024-01-02T00:00:00.000Z',
    });
    const last = await getLastSession();
    expect(last?.sessionId).toBe('sess_last');
  });

  it('reflects the most recently appended session after multiple writes', async () => {
    await backupRegistry();
    await rm(REGISTRY_PATH, { force: true });

    for (let i = 1; i <= 5; i++) {
      await appendSessionToRegistry({
        sessionId: `sess_${i}`,
        startedAt: `2024-01-0${i}T00:00:00.000Z`,
      });
    }
    const last = await getLastSession();
    expect(last?.sessionId).toBe('sess_5');
  });
});
