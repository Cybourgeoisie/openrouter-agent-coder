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

const tool = readFileTool();
const execute = tool.function.execute as (params: {
  path: string;
  start_line?: number;
  end_line?: number;
}) => Promise<{
  content: string;
  path: string;
  start_line?: number;
  end_line?: number;
  total_lines?: number;
  truncated?: boolean;
  notice?: string;
}>;

describe('read_file tool', () => {
  it('has correct name and description', () => {
    expect(tool.function.name).toBe('read_file');
    expect(tool.function.description).toContain('Read the contents');
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

  // ── size-cap tests (Tier 1: byte cap / Tier 2: line cap / Tier 3: token cap) ─

  it('rejects files larger than the 10MB byte cap before reading', async () => {
    const filePath = join(TMP, 'huge.txt');
    // 10MB + 1 byte. Single fixed-width line so the byte cap is what fires,
    // not the line cap or the token cap.
    const oversize = 'x'.repeat(10 * 1024 * 1024 + 1);
    await writeFile(filePath, oversize, 'utf-8');

    await expect(execute({ path: filePath })).rejects.toThrow(/exceeds maximum allowed size/);
    await expect(execute({ path: filePath })).rejects.toThrow(/start_line and end_line/);
  });

  it('accepts a file exactly at the byte cap', async () => {
    const filePath = join(TMP, 'edge.txt');
    // Exactly 10MB. Single line of 'x' so neither the line cap (1 line)
    // nor the token cap (10MB / 4 ≈ 2.6M tokens) is the focus here — we
    // expect the token cap to actually fire next, but Tier 1 should pass.
    const atCap = 'x'.repeat(10 * 1024 * 1024);
    await writeFile(filePath, atCap, 'utf-8');

    // Tier 1 passes (= cap, not >), Tier 3 will trip — error must point
    // at start_line/end_line, not at the byte cap.
    await expect(execute({ path: filePath })).rejects.toThrow(/exceeds maximum allowed tokens/);
  });

  it('truncates to the first 2000 lines when no range is given on a 3000-line file', async () => {
    const filePath = join(TMP, 'long.txt');
    // 3000 short lines — within the byte cap and within the token cap when
    // truncated to 2000 lines (2000 * ~3 chars / 4 ≈ 1500 estimated tokens).
    const lines = Array.from({ length: 3000 }, (_, i) => `L${i + 1}`);
    await writeFile(filePath, lines.join('\n'), 'utf-8');

    const result = await execute({ path: filePath });

    expect(result.truncated).toBe(true);
    expect(result.total_lines).toBe(3000);
    expect(result.start_line).toBe(1);
    expect(result.end_line).toBe(2000);
    expect(result.notice).toContain('truncated to the first 2000 lines');
    expect(result.notice).toContain("Don't tell the user");
    // Content has 2000 lines (no trailing newline added)
    expect(result.content.split('\n')).toHaveLength(2000);
    expect(result.content.split('\n')[0]).toBe('L1');
    expect(result.content.split('\n')[1999]).toBe('L2000');
  });

  it('does not flag truncation when a file is at or under the 2000-line default', async () => {
    const filePath = join(TMP, 'short.txt');
    const lines = Array.from({ length: 2000 }, (_, i) => `L${i + 1}`);
    await writeFile(filePath, lines.join('\n'), 'utf-8');

    const result = await execute({ path: filePath });

    expect(result.truncated).toBeUndefined();
    expect(result.notice).toBeUndefined();
    expect(result.content.split('\n')).toHaveLength(2000);
  });

  it('rejects on the token estimate when content is dense enough to blow context', async () => {
    const filePath = join(TMP, 'dense.txt');
    // Single line of 200KB. Under the byte cap (10MB). One line, so the
    // default line-cap (2000) is irrelevant. 200000 / 4 = 50000 estimated
    // tokens — well over the 25000 cap.
    await writeFile(filePath, 'x'.repeat(200_000), 'utf-8');

    await expect(execute({ path: filePath })).rejects.toThrow(/exceeds maximum allowed tokens/);
    await expect(execute({ path: filePath })).rejects.toThrow(/start_line and end_line/);
  });

  it('explicit range bypasses the line cap but still trips the token cap when too dense', async () => {
    const filePath = join(TMP, 'long-and-dense.txt');
    // 100 lines of 2000 chars each = 200KB total. Asking for all 100 lines
    // explicitly. Estimated tokens 50k → over cap.
    const lines = Array.from({ length: 100 }, () => 'x'.repeat(2000));
    await writeFile(filePath, lines.join('\n'), 'utf-8');

    await expect(execute({ path: filePath, start_line: 1, end_line: 100 })).rejects.toThrow(
      /exceeds maximum allowed tokens/,
    );
    // But asking for a narrower slice (10 lines = ~5k tokens) succeeds.
    const ok = await execute({ path: filePath, start_line: 1, end_line: 10 });
    expect(ok.start_line).toBe(1);
    expect(ok.end_line).toBe(10);
  });
});
