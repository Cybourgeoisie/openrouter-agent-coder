import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { editFileTool } from './edit-file.js';
import { writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const TMP = join(import.meta.dirname, '../../.test-tmp/edit-file');

beforeEach(async () => {
  await mkdir(TMP, { recursive: true });
});

afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
});

const execute = editFileTool.function.execute as (params: {
  path: string;
  old_string: string;
  new_string: string;
}) => Promise<{ path: string; replaced: boolean }>;

describe('edit_file tool', () => {
  it('has correct name', () => {
    expect(editFileTool.function.name).toBe('edit_file');
  });

  it('replaces a unique string', async () => {
    const filePath = join(TMP, 'edit.txt');
    await writeFile(filePath, 'hello world', 'utf-8');

    const result = await execute({
      path: filePath,
      old_string: 'hello',
      new_string: 'goodbye',
    });

    expect(result.replaced).toBe(true);
    const content = await readFile(filePath, 'utf-8');
    expect(content).toBe('goodbye world');
  });

  it('throws when old_string is not found', async () => {
    const filePath = join(TMP, 'missing.txt');
    await writeFile(filePath, 'hello world', 'utf-8');

    await expect(
      execute({ path: filePath, old_string: 'nonexistent', new_string: 'x' }),
    ).rejects.toThrow('old_string not found');
  });

  it('throws when old_string appears multiple times', async () => {
    const filePath = join(TMP, 'dupe.txt');
    await writeFile(filePath, 'aaa bbb aaa', 'utf-8');

    await expect(execute({ path: filePath, old_string: 'aaa', new_string: 'ccc' })).rejects.toThrow(
      'found 2 times',
    );
  });

  it('handles multi-line replacements', async () => {
    const filePath = join(TMP, 'multiline.txt');
    await writeFile(filePath, 'line1\nline2\nline3', 'utf-8');

    await execute({
      path: filePath,
      old_string: 'line2\nline3',
      new_string: 'replaced',
    });

    const content = await readFile(filePath, 'utf-8');
    expect(content).toBe('line1\nreplaced');
  });

  it('throws when file does not exist', async () => {
    await expect(
      execute({ path: join(TMP, 'nope.txt'), old_string: 'a', new_string: 'b' }),
    ).rejects.toThrow();
  });
});
