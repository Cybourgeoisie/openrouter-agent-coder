import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { listDirectoryTool } from './list-directory.js';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const TMP = join(import.meta.dirname, '../../.test-tmp/list-dir');

beforeEach(async () => {
  await mkdir(TMP, { recursive: true });
});

afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
});

const tool = listDirectoryTool();
const execute = tool.function.execute as (params: {
  path: string;
}) => Promise<{ path: string; entries: string[] }>;

describe('list_directory tool', () => {
  it('has correct name', () => {
    expect(tool.function.name).toBe('list_directory');
  });

  it('lists files and directories', async () => {
    await writeFile(join(TMP, 'file.txt'), 'x', 'utf-8');
    await mkdir(join(TMP, 'subdir'));

    const result = await execute({ path: TMP });
    expect(result.entries).toContain('file.txt');
    expect(result.entries).toContain('subdir/');
  });

  it('appends trailing slash to directories', async () => {
    await mkdir(join(TMP, 'mydir'));

    const result = await execute({ path: TMP });
    const dirEntry = result.entries.find((e) => e.startsWith('mydir'));
    expect(dirEntry).toBe('mydir/');
  });

  it('returns empty array for empty directory', async () => {
    const emptyDir = join(TMP, 'empty');
    await mkdir(emptyDir);

    const result = await execute({ path: emptyDir });
    expect(result.entries).toEqual([]);
  });

  it('throws when directory does not exist', async () => {
    await expect(execute({ path: join(TMP, 'nope') })).rejects.toThrow();
  });
});
