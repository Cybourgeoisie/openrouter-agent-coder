import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileTool } from './write-file.js';
import { readFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const TMP = join(import.meta.dirname, '../../.test-tmp/write-file');

beforeEach(async () => {
  await mkdir(TMP, { recursive: true });
});

afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
});

const execute = writeFileTool.function.execute as (params: {
  path: string;
  content: string;
}) => Promise<{ path: string; bytesWritten: number }>;

describe('write_file tool', () => {
  it('has correct name', () => {
    expect(writeFileTool.function.name).toBe('write_file');
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
});
