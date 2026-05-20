import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileTool } from './read-file.js';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const TMP = join(import.meta.dirname, '../../.test-tmp/read-file');

beforeEach(async () => {
  await mkdir(TMP, { recursive: true });
});

afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
});

const execute = readFileTool.function.execute as (params: { path: string }) => Promise<{ content: string; path: string }>;

describe('read_file tool', () => {
  it('has correct name and description', () => {
    expect(readFileTool.function.name).toBe('read_file');
    expect(readFileTool.function.description).toContain('Read the contents');
  });

  it('reads a file and returns its content', async () => {
    const filePath = join(TMP, 'hello.txt');
    await writeFile(filePath, 'hello world', 'utf-8');

    const result = await execute({ path: filePath });
    expect(result.content).toBe('hello world');
    expect(result.path).toBe(filePath);
  });

  it('reads utf-8 content with special characters', async () => {
    const filePath = join(TMP, 'unicode.txt');
    const content = 'Hello 🌍\nLine 2\tTab';
    await writeFile(filePath, content, 'utf-8');

    const result = await execute({ path: filePath });
    expect(result.content).toBe(content);
  });

  it('throws when file does not exist', async () => {
    await expect(execute({ path: join(TMP, 'nonexistent.txt') })).rejects.toThrow();
  });
});
