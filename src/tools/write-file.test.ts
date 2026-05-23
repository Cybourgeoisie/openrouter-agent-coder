import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileTool } from './write-file.js';
import { readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listCheckpoints, restoreCheckpoint } from '../checkpoints.js';

const TMP = join(import.meta.dirname, '../../.test-tmp/write-file');

beforeEach(async () => {
  await mkdir(TMP, { recursive: true });
});

afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
});

const tool = writeFileTool();
const execute = tool.function.execute as (params: {
  path: string;
  content: string;
}) => Promise<{ path: string; bytesWritten: number }>;

describe('write_file tool', () => {
  it('has correct name', () => {
    expect(tool.function.name).toBe('write_file');
  });

  it('writes content to a new file', async () => {
    const filePath = join(TMP, 'output.txt');
    const result = await execute({ path: filePath, content: 'test content' });

    expect(result.path).toBe(filePath);
    expect(result.bytesWritten).toBe(Buffer.byteLength('test content', 'utf-8'));

    const written = await readFile(filePath, 'utf-8');
    expect(written).toBe('test content');
  });

  it('creates parent directories automatically', async () => {
    const filePath = join(TMP, 'deep', 'nested', 'dir', 'file.txt');
    await execute({ path: filePath, content: 'nested' });

    const written = await readFile(filePath, 'utf-8');
    expect(written).toBe('nested');
  });

  it('overwrites an existing file', async () => {
    const filePath = join(TMP, 'overwrite.txt');
    await execute({ path: filePath, content: 'first' });
    await execute({ path: filePath, content: 'second' });

    const written = await readFile(filePath, 'utf-8');
    expect(written).toBe('second');
  });

  it('reports correct byte count for multi-byte characters', async () => {
    const filePath = join(TMP, 'emoji.txt');
    const content = '🌍';
    const result = await execute({ path: filePath, content });
    expect(result.bytesWritten).toBe(4);
  });

  it('does NOT checkpoint when ctx.checkpoint is false and the tool call omits the flag', async () => {
    const sessionId = 'sess-no-cp';
    const logsRoot = join(TMP, 'logs');
    const filePath = join(TMP, 'file.txt');
    await writeFile(filePath, 'before', 'utf-8');

    const ctxTool = writeFileTool({
      cwd: '.',
      sessionId,
      logsRoot,
      checkpoint: false,
      persistSession: true,
    });
    const exec = ctxTool.function.execute as (i: unknown) => Promise<unknown>;
    await exec({ path: filePath, content: 'after' });

    const list = await listCheckpoints(sessionId, logsRoot);
    expect(list).toHaveLength(0);
  });

  it('auto-checkpoints when ctor ctx.checkpoint is true', async () => {
    const sessionId = 'sess-ctor-cp';
    const logsRoot = join(TMP, 'logs');
    const filePath = join(TMP, 'autosnap.txt');
    await writeFile(filePath, 'pristine', 'utf-8');

    const ctxTool = writeFileTool({
      cwd: '.',
      sessionId,
      logsRoot,
      checkpoint: true,
      persistSession: true,
    });
    const exec = ctxTool.function.execute as (i: unknown) => Promise<unknown>;
    await exec({ path: filePath, content: 'mutated' });

    const list = await listCheckpoints(sessionId, logsRoot);
    expect(list).toHaveLength(1);
    const cp = list[0]!;

    // Restore wipes the mutation and re-installs the pre-write bytes.
    await restoreCheckpoint(cp.checkpointId, sessionId, logsRoot);
    expect(await readFile(filePath, 'utf-8')).toBe('pristine');
  });

  it('per-call checkpoint:true overrides ctor checkpoint:false', async () => {
    const sessionId = 'sess-call-cp';
    const logsRoot = join(TMP, 'logs');
    const filePath = join(TMP, 'call-override.txt');
    await writeFile(filePath, 'baseline', 'utf-8');

    const ctxTool = writeFileTool({
      cwd: '.',
      sessionId,
      logsRoot,
      checkpoint: false, // ctor default off
      persistSession: true,
    });
    const exec = ctxTool.function.execute as (i: unknown) => Promise<unknown>;
    await exec({ path: filePath, content: 'next', checkpoint: true });

    const list = await listCheckpoints(sessionId, logsRoot);
    expect(list).toHaveLength(1);
    await restoreCheckpoint(list[0]!.checkpointId, sessionId, logsRoot);
    expect(await readFile(filePath, 'utf-8')).toBe('baseline');
  });

  it('per-call checkpoint:false overrides ctor checkpoint:true', async () => {
    const sessionId = 'sess-call-off';
    const logsRoot = join(TMP, 'logs');
    const filePath = join(TMP, 'no-cp.txt');
    await writeFile(filePath, 'baseline', 'utf-8');

    const ctxTool = writeFileTool({
      cwd: '.',
      sessionId,
      logsRoot,
      checkpoint: true, // ctor wants checkpoints
      persistSession: true,
    });
    const exec = ctxTool.function.execute as (i: unknown) => Promise<unknown>;
    await exec({ path: filePath, content: 'next', checkpoint: false });

    expect(await listCheckpoints(sessionId, logsRoot)).toHaveLength(0);
  });

  it('silently skips checkpoint when checkpoint:true but sessionId/logsRoot absent (factory-only use)', async () => {
    const filePath = join(TMP, 'no-ctx.txt');
    await writeFile(filePath, 'orig', 'utf-8');
    // No sessionId / logsRoot threaded in — checkpoint request silently
    // becomes a no-op (no warn, no throw). Exercises the implicit-else of
    // the `else if (ctx.sessionId && ctx.logsRoot)` branch.
    const ctxTool = writeFileTool({ cwd: '.', checkpoint: true });
    const exec = ctxTool.function.execute as (i: unknown) => Promise<unknown>;
    await exec({ path: filePath, content: 'next' });
    expect(await readFile(filePath, 'utf-8')).toBe('next');
  });

  it('logs a warn and skips checkpoint when persistSession is false', async () => {
    const sessionId = 'sess-ephemeral-cp';
    const logsRoot = join(TMP, 'logs');
    const filePath = join(TMP, 'eph.txt');
    await writeFile(filePath, 'orig', 'utf-8');

    const logger = vi.fn();
    const ctxTool = writeFileTool({
      cwd: '.',
      sessionId,
      logsRoot,
      checkpoint: true,
      persistSession: false,
      logger,
    });
    const exec = ctxTool.function.execute as (i: unknown) => Promise<unknown>;
    await exec({ path: filePath, content: 'mut' });

    // Write succeeded.
    expect(await readFile(filePath, 'utf-8')).toBe('mut');
    // No checkpoints/ dir created — listCheckpoints returns [] gracefully.
    expect(await listCheckpoints(sessionId, logsRoot)).toEqual([]);
    // Warn log fired.
    const warns = logger.mock.calls.filter((c) => c[0] === 'warn');
    expect(warns.some((c) => /persistSession is false/.test(c[1] ?? ''))).toBe(true);
  });
});
