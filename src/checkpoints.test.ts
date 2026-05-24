import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createCheckpoint,
  listCheckpoints,
  restoreCheckpoint,
  encodePath,
  decodePath,
  MAX_CHECKPOINTS_PER_SESSION,
} from './checkpoints.js';

const TMP = join(import.meta.dirname, '../.test-tmp/checkpoints');

beforeEach(async () => {
  await mkdir(TMP, { recursive: true });
});

afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('path encoding', () => {
  it('round-trips absolute paths', () => {
    const original = '/tmp/foo/bar.txt';
    const encoded = encodePath(original);
    expect(encoded).not.toContain('/');
    expect(decodePath(encoded)).toBe(original);
  });

  it('round-trips nested paths', () => {
    const original = '/a/b/c/d/e';
    expect(decodePath(encodePath(original))).toBe(original);
  });

  it('handles paths without slashes', () => {
    expect(decodePath(encodePath('justaname'))).toBe('justaname');
  });
});

describe('createCheckpoint → listCheckpoints → restoreCheckpoint round-trip', () => {
  it('snapshots a single file and restores it after mutation', async () => {
    const sessionId = 'sess-1';
    const logsRoot = join(TMP, 'logs');
    const file = join(TMP, 'data.txt');
    await writeFile(file, 'original-bytes', 'utf-8');

    const cp = await createCheckpoint(sessionId, logsRoot, [file]);
    expect(cp.checkpointId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(cp.files).toHaveLength(1);
    expect(cp.files[0]?.existed).toBe(true);
    expect(cp.files[0]?.originalPath).toBe(file);

    // Mutate the live file.
    await writeFile(file, 'mutated-bytes', 'utf-8');
    expect(await readFile(file, 'utf-8')).toBe('mutated-bytes');

    const listed = await listCheckpoints(sessionId, logsRoot);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.checkpointId).toBe(cp.checkpointId);

    const restored = await restoreCheckpoint(cp.checkpointId, sessionId, logsRoot);
    expect(restored.filesRestored).toEqual([file]);
    expect(await readFile(file, 'utf-8')).toBe('original-bytes');
  });

  it('returns [] for sessions with no checkpoints directory', async () => {
    const out = await listCheckpoints('no-such-session', join(TMP, 'empty-logs'));
    expect(out).toEqual([]);
  });

  it('propagates non-ENOENT errors from readdir (e.g. ENOTDIR when the path is a file)', async () => {
    // Create a session whose `checkpoints` path is a regular file, not a
    // directory — readdir then fails with ENOTDIR (not ENOENT) and the
    // function rethrows.
    const sessionId = 'sess-broken';
    const logsRoot = join(TMP, 'logs');
    await mkdir(join(logsRoot, sessionId), { recursive: true });
    await writeFile(join(logsRoot, sessionId, 'checkpoints'), 'not-a-dir', 'utf-8');
    await expect(listCheckpoints(sessionId, logsRoot)).rejects.toMatchObject({ code: 'ENOTDIR' });
  });
});

describe('multiple checkpoints — restore middle one', () => {
  it('rewinds the file to the state captured by the chosen checkpoint', async () => {
    const sessionId = 'sess-mid';
    const logsRoot = join(TMP, 'logs');
    const file = join(TMP, 'multi.txt');

    await writeFile(file, 'v1', 'utf-8');
    const cp1 = await createCheckpoint(sessionId, logsRoot, [file]);
    // Force distinct timestamps for list ordering.
    await new Promise((r) => setTimeout(r, 10));

    await writeFile(file, 'v2', 'utf-8');
    const cp2 = await createCheckpoint(sessionId, logsRoot, [file]);
    await new Promise((r) => setTimeout(r, 10));

    await writeFile(file, 'v3', 'utf-8');
    await createCheckpoint(sessionId, logsRoot, [file]);

    const listed = await listCheckpoints(sessionId, logsRoot);
    expect(listed.map((c) => c.checkpointId)).toEqual([
      cp1.checkpointId,
      cp2.checkpointId,
      listed[2]?.checkpointId,
    ]);

    await restoreCheckpoint(cp2.checkpointId, sessionId, logsRoot);
    expect(await readFile(file, 'utf-8')).toBe('v2');
  });
});

describe('cap enforcement', () => {
  it('evicts oldest checkpoints beyond MAX_CHECKPOINTS_PER_SESSION', async () => {
    const sessionId = 'sess-cap';
    const logsRoot = join(TMP, 'logs');
    const file = join(TMP, 'cap.txt');
    await writeFile(file, 'x', 'utf-8');

    const ids: string[] = [];
    // Create MAX + 1 checkpoints. The +1 should evict the first one.
    const total = MAX_CHECKPOINTS_PER_SESSION + 1;
    const warnLog = vi.fn();
    for (let i = 0; i < total; i++) {
      // Touch the file each iteration so each checkpoint actually snapshots
      // distinct bytes (also bypasses the mtime+size hard-link fast path).
      await writeFile(file, `iter-${i}`, 'utf-8');
      const cp = await createCheckpoint(sessionId, logsRoot, [file], { logger: warnLog });
      ids.push(cp.checkpointId);
      // Ensure each checkpoint gets a distinct ISO ms timestamp so eviction
      // (which sorts ascending) deterministically picks the first one.
      await new Promise((r) => setTimeout(r, 2));
    }
    const listed = await listCheckpoints(sessionId, logsRoot);
    expect(listed).toHaveLength(MAX_CHECKPOINTS_PER_SESSION);

    const evictedId = ids[0]!;
    expect(listed.find((c) => c.checkpointId === evictedId)).toBeUndefined();

    // Evicted checkpoint dir is gone from disk.
    await expect(stat(join(logsRoot, sessionId, 'checkpoints', evictedId))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    // Warn log emitted with evictedId + sessionId.
    const warnCalls = warnLog.mock.calls.filter((c) => c[0] === 'warn');
    expect(
      warnCalls.some((c) => c[2]?.checkpointId === evictedId && c[2]?.sessionId === sessionId),
    ).toBe(true);
  });
});

describe('atomicity on restore', () => {
  it('cleans up .restore-tmp when a phase-2 rename fails (target is a non-empty directory)', async () => {
    const sessionId = 'sess-atom';
    const logsRoot = join(TMP, 'logs');
    const fileA = join(TMP, 'a.txt');
    const fileB = join(TMP, 'b.txt');
    await writeFile(fileA, 'origA', 'utf-8');
    await writeFile(fileB, 'origB', 'utf-8');

    const cp = await createCheckpoint(sessionId, logsRoot, [fileA, fileB]);

    await writeFile(fileA, 'mutA', 'utf-8');
    // Replace fileB with a non-empty directory so rename(tmpFile, fileB) fails.
    await rm(fileB, { force: true });
    await mkdir(fileB);
    await writeFile(join(fileB, 'sentinel'), 'block-the-rename', 'utf-8');

    await expect(restoreCheckpoint(cp.checkpointId, sessionId, logsRoot)).rejects.toThrow();

    // The .restore-tmp directory is removed by finally even on phase-2 error.
    await expect(
      stat(join(logsRoot, sessionId, 'checkpoints', cp.checkpointId, '.restore-tmp')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cleans up .restore-tmp and leaves live tree untouched when phase-1 fails', async () => {
    const sessionId = 'sess-atom2';
    const logsRoot = join(TMP, 'logs');
    const file = join(TMP, 'a.txt');
    await writeFile(file, 'origA', 'utf-8');
    const cp = await createCheckpoint(sessionId, logsRoot, [file]);
    await writeFile(file, 'mutA', 'utf-8');

    // Delete the snapshot file so copyFile in phase 1 fails — phase 2 never
    // runs, .restore-tmp gets cleaned up, and the live file is untouched.
    await rm(
      join(logsRoot, sessionId, 'checkpoints', cp.checkpointId, `${encodePath(file)}.snapshot`),
    );

    await expect(restoreCheckpoint(cp.checkpointId, sessionId, logsRoot)).rejects.toThrow();

    expect(await readFile(file, 'utf-8')).toBe('mutA');
    await expect(
      stat(join(logsRoot, sessionId, 'checkpoints', cp.checkpointId, '.restore-tmp')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('tombstone restore', () => {
  it('unlinks a path that did not exist when the checkpoint was created', async () => {
    const sessionId = 'sess-tomb';
    const logsRoot = join(TMP, 'logs');
    const file = join(TMP, 'phantom.txt');

    // File doesn't exist at checkpoint time.
    const cp = await createCheckpoint(sessionId, logsRoot, [file]);
    expect(cp.files[0]?.existed).toBe(false);

    // Create the file post-checkpoint.
    await writeFile(file, 'created-after-cp', 'utf-8');
    expect(await readFile(file, 'utf-8')).toBe('created-after-cp');

    // Restore should remove it.
    const restored = await restoreCheckpoint(cp.checkpointId, sessionId, logsRoot);
    expect(restored.filesRestored).toContain(file);
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('tolerates a tombstoned path that is already gone at restore time', async () => {
    const sessionId = 'sess-tomb2';
    const logsRoot = join(TMP, 'logs');
    const file = join(TMP, 'still-phantom.txt');
    const cp = await createCheckpoint(sessionId, logsRoot, [file]);
    // File never appeared — restore should still resolve cleanly.
    await expect(restoreCheckpoint(cp.checkpointId, sessionId, logsRoot)).resolves.toBeDefined();
  });
});

describe('mtime + size fast-path (hard-link reuse)', () => {
  it('reuses the prior snapshot when the live file is unchanged', async () => {
    const sessionId = 'sess-fast';
    const logsRoot = join(TMP, 'logs');
    const file = join(TMP, 'unchanged.txt');
    await writeFile(file, 'identical-bytes', 'utf-8');

    const cp1 = await createCheckpoint(sessionId, logsRoot, [file]);
    const cp2 = await createCheckpoint(sessionId, logsRoot, [file]);

    const enc = encodePath(file);
    const snap1 = join(logsRoot, sessionId, 'checkpoints', cp1.checkpointId, `${enc}.snapshot`);
    const snap2 = join(logsRoot, sessionId, 'checkpoints', cp2.checkpointId, `${enc}.snapshot`);

    const s1 = await stat(snap1);
    const s2 = await stat(snap2);
    // Hard-linked entries share an inode (nlink ≥ 2).
    expect(s1.ino).toBe(s2.ino);
    expect(s1.nlink).toBeGreaterThanOrEqual(2);

    // Both restore paths yield identical bytes.
    await writeFile(file, 'mutated', 'utf-8');
    await restoreCheckpoint(cp2.checkpointId, sessionId, logsRoot);
    expect(await readFile(file, 'utf-8')).toBe('identical-bytes');

    await writeFile(file, 'mutated-again', 'utf-8');
    await restoreCheckpoint(cp1.checkpointId, sessionId, logsRoot);
    expect(await readFile(file, 'utf-8')).toBe('identical-bytes');
  });

  it('writes a fresh snapshot when mtime/size changed since the prior checkpoint', async () => {
    const sessionId = 'sess-fast2';
    const logsRoot = join(TMP, 'logs');
    const file = join(TMP, 'changing.txt');
    await writeFile(file, 'aaa', 'utf-8');
    const cp1 = await createCheckpoint(sessionId, logsRoot, [file]);

    await writeFile(file, 'bbbb', 'utf-8');
    const cp2 = await createCheckpoint(sessionId, logsRoot, [file]);

    const enc = encodePath(file);
    const s1 = await stat(
      join(logsRoot, sessionId, 'checkpoints', cp1.checkpointId, `${enc}.snapshot`),
    );
    const s2 = await stat(
      join(logsRoot, sessionId, 'checkpoints', cp2.checkpointId, `${enc}.snapshot`),
    );
    expect(s1.ino).not.toBe(s2.ino);
  });
});

describe('restoreCheckpoint error path', () => {
  it('throws when the checkpoint id is unknown', async () => {
    const sessionId = 'sess-x';
    const logsRoot = join(TMP, 'logs');
    await mkdir(join(logsRoot, sessionId, 'checkpoints'), { recursive: true });
    await expect(restoreCheckpoint('nonsense-id', sessionId, logsRoot)).rejects.toThrow(
      /checkpoint not found/,
    );
  });
});

describe('createCheckpoint — multiple files and deduplication', () => {
  it('deduplicates repeated paths in the input list', async () => {
    const sessionId = 'sess-dedup';
    const logsRoot = join(TMP, 'logs');
    const file = join(TMP, 'dup.txt');
    await writeFile(file, 'one', 'utf-8');
    const cp = await createCheckpoint(sessionId, logsRoot, [file, file, file]);
    expect(cp.files).toHaveLength(1);
  });

  it('falls through to copyFile (no fast-path link) when no prior snapshot exists for that path', async () => {
    // Snapshot file A, then snapshot file B (different path) — when B's
    // checkpoint runs, findPriorSnapshot walks all prior checkpoints and
    // finds nothing for B's originalPath, returning null. Just exercising
    // the null-return code path.
    const sessionId = 'sess-nofast';
    const logsRoot = join(TMP, 'logs');
    const fileA = join(TMP, 'A.txt');
    const fileB = join(TMP, 'B.txt');
    await writeFile(fileA, 'aaa', 'utf-8');
    await writeFile(fileB, 'bbb', 'utf-8');
    await createCheckpoint(sessionId, logsRoot, [fileA]);
    const cp = await createCheckpoint(sessionId, logsRoot, [fileB]);
    expect(cp.files[0]?.originalPath).toBe(fileB);
  });

  it('skips non-directory entries inside checkpoints/', async () => {
    const sessionId = 'sess-stray';
    const logsRoot = join(TMP, 'logs');
    const file = join(TMP, 'real.txt');
    await writeFile(file, 'data', 'utf-8');
    const cp = await createCheckpoint(sessionId, logsRoot, [file]);

    // Leave a stray file alongside the checkpoint directory — listCheckpoints
    // should skip it without erroring (entry.isDirectory() === false branch).
    await writeFile(join(logsRoot, sessionId, 'checkpoints', 'stray.txt'), 'noise', 'utf-8');

    const list = await listCheckpoints(sessionId, logsRoot);
    expect(list).toHaveLength(1);
    expect(list[0]?.checkpointId).toBe(cp.checkpointId);
  });
});
