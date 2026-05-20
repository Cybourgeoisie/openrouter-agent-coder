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

const execute = readFileTool.function.execute as (params: {
  path: string;
  start_line?: number;
  end_line?: number;
}) => Promise<{
  content: string;
  path: string;
  start_line?: number;
  end_line?: number;
  total_lines?: number;
}>;

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

  // ── line-range tests ────────────────────────────────────────────────────

  it('returns a specific line range when start_line and end_line are given', async () => {
    const filePath = join(TMP, 'lines.txt');
    await writeFile(filePath, 'line1\nline2\nline3\nline4\nline5\n', 'utf-8');

    const result = await execute({ path: filePath, start_line: 2, end_line: 4 });
    expect(result.content).toBe('line2\nline3\nline4');
    expect(result.start_line).toBe(2);
    expect(result.end_line).toBe(4);
    expect(result.total_lines).toBe(6); // trailing newline creates empty 6th element
  });

  it('reads from start_line to end of file when only start_line is given', async () => {
    const filePath = join(TMP, 'tail.txt');
    await writeFile(filePath, 'a\nb\nc\nd\n', 'utf-8');

    const result = await execute({ path: filePath, start_line: 3 });
    expect(result.content).toBe('c\nd\n'); // lines 3-5 (trailing newline produces empty 5th)
    expect(result.start_line).toBe(3);
  });

  it('reads from beginning to end_line when only end_line is given', async () => {
    const filePath = join(TMP, 'head.txt');
    await writeFile(filePath, 'a\nb\nc\nd\n', 'utf-8');

    const result = await execute({ path: filePath, end_line: 2 });
    expect(result.content).toBe('a\nb');
    expect(result.end_line).toBe(2);
  });

  it('returns total_lines in ranged reads', async () => {
    const filePath = join(TMP, 'count.txt');
    await writeFile(filePath, 'one\ntwo\nthree\n', 'utf-8');

    const result = await execute({ path: filePath, start_line: 1, end_line: 1 });
    expect(result.total_lines).toBe(4); // 3 lines + trailing empty
  });

  it('throws when start_line is out of range', async () => {
    const filePath = join(TMP, 'short.txt');
    await writeFile(filePath, 'only one line', 'utf-8');

    await expect(execute({ path: filePath, start_line: 99 })).rejects.toThrow('out of range');
  });

  it('throws when end_line is less than start_line', async () => {
    const filePath = join(TMP, 'inv.txt');
    await writeFile(filePath, 'a\nb\nc\n', 'utf-8');

    await expect(execute({ path: filePath, start_line: 3, end_line: 1 })).rejects.toThrow(
      'end_line',
    );
  });

  it('a single-line read returns exactly that line', async () => {
    const filePath = join(TMP, 'single.txt');
    await writeFile(filePath, 'first\nsecond\nthird\n', 'utf-8');

    const result = await execute({ path: filePath, start_line: 2, end_line: 2 });
    expect(result.content).toBe('second');
  });
});
