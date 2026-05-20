import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { grepFilesTool } from './grep-files.js';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const TMP = join(import.meta.dirname, '../../.test-tmp/grep-files');

beforeEach(async () => {
  await mkdir(TMP, { recursive: true });
});

afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
});

const execute = grepFilesTool.function.execute as (params: {
  pattern: string;
  path: string;
  file_glob: string;
  case_sensitive: boolean;
}) => Promise<{
  pattern: string;
  path: string;
  matchCount: number;
  truncated: boolean;
  matches: Array<{ file: string; line: number; text: string }>;
}>;

describe('grep_files tool', () => {
  it('has correct name and description', () => {
    expect(grepFilesTool.function.name).toBe('grep_files');
    expect(grepFilesTool.function.description).toContain('Search for a regex pattern');
  });

  it('finds a simple pattern in a single file', async () => {
    await writeFile(join(TMP, 'a.ts'), 'const x = 1;\nconst y = 2;\n', 'utf-8');

    const result = await execute({ pattern: 'const', path: TMP, file_glob: '*.ts', case_sensitive: true });

    expect(result.matchCount).toBe(2);
    expect(result.matches[0].file).toBe('a.ts');
    expect(result.matches[0].line).toBe(1);
    expect(result.matches[0].text).toBe('const x = 1;');
    expect(result.matches[1].line).toBe(2);
  });

  it('returns structured match objects with file, line, text', async () => {
    await writeFile(join(TMP, 'b.ts'), 'hello world\n', 'utf-8');

    const result = await execute({ pattern: 'hello', path: TMP, file_glob: '*', case_sensitive: true });

    expect(result.matches).toHaveLength(1);
    const m = result.matches[0];
    expect(m).toHaveProperty('file');
    expect(m).toHaveProperty('line');
    expect(m).toHaveProperty('text');
    expect(m.text).toBe('hello world');
  });

  it('searches across multiple files', async () => {
    await writeFile(join(TMP, 'one.ts'), 'import foo\n', 'utf-8');
    await writeFile(join(TMP, 'two.ts'), 'import bar\n', 'utf-8');
    await writeFile(join(TMP, 'three.ts'), 'export baz\n', 'utf-8');

    const result = await execute({ pattern: 'import', path: TMP, file_glob: '*.ts', case_sensitive: true });

    expect(result.matchCount).toBe(2);
    const files = result.matches.map((m) => m.file).sort();
    expect(files).toEqual(['one.ts', 'two.ts']);
  });

  it('filters files by file_glob', async () => {
    await writeFile(join(TMP, 'code.ts'), 'needle\n', 'utf-8');
    await writeFile(join(TMP, 'notes.md'), 'needle\n', 'utf-8');

    const result = await execute({ pattern: 'needle', path: TMP, file_glob: '*.ts', case_sensitive: true });

    expect(result.matchCount).toBe(1);
    expect(result.matches[0].file).toBe('code.ts');
  });

  it('is case-sensitive by default', async () => {
    await writeFile(join(TMP, 'c.ts'), 'Hello\nhello\nHELLO\n', 'utf-8');

    const result = await execute({ pattern: 'hello', path: TMP, file_glob: '*.ts', case_sensitive: true });

    expect(result.matchCount).toBe(1);
    expect(result.matches[0].text).toBe('hello');
  });

  it('respects case_sensitive: false', async () => {
    await writeFile(join(TMP, 'd.ts'), 'Hello\nhello\nHELLO\n', 'utf-8');

    const result = await execute({ pattern: 'hello', path: TMP, file_glob: '*.ts', case_sensitive: false });

    expect(result.matchCount).toBe(3);
  });

  it('supports regex patterns', async () => {
    await writeFile(join(TMP, 'e.ts'), 'foo123\nbar456\nbaz\n', 'utf-8');

    const result = await execute({ pattern: '\\d+', path: TMP, file_glob: '*.ts', case_sensitive: true });

    expect(result.matchCount).toBe(2);
  });

  it('throws on invalid regex', async () => {
    await expect(
      execute({ pattern: '[invalid', path: TMP, file_glob: '*', case_sensitive: true }),
    ).rejects.toThrow('Invalid regex pattern');
  });

  it('returns zero matches when pattern not found', async () => {
    await writeFile(join(TMP, 'f.ts'), 'nothing here\n', 'utf-8');

    const result = await execute({ pattern: 'zzznomatch', path: TMP, file_glob: '*', case_sensitive: true });

    expect(result.matchCount).toBe(0);
    expect(result.matches).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it('searches recursively into subdirectories', async () => {
    const sub = join(TMP, 'sub');
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, 'deep.ts'), 'findme\n', 'utf-8');

    const result = await execute({ pattern: 'findme', path: TMP, file_glob: '*.ts', case_sensitive: true });

    expect(result.matchCount).toBe(1);
    expect(result.matches[0].file).toBe('sub/deep.ts');
  });

  it('skips node_modules directory', async () => {
    const nm = join(TMP, 'node_modules', 'pkg');
    await mkdir(nm, { recursive: true });
    await writeFile(join(nm, 'index.ts'), 'findme\n', 'utf-8');
    await writeFile(join(TMP, 'real.ts'), 'findme\n', 'utf-8');

    const result = await execute({ pattern: 'findme', path: TMP, file_glob: '*.ts', case_sensitive: true });

    expect(result.matchCount).toBe(1);
    expect(result.matches[0].file).toBe('real.ts');
  });

  it('returns correct line numbers (1-indexed)', async () => {
    await writeFile(join(TMP, 'g.ts'), 'line one\nline two\nfound here\nline four\n', 'utf-8');

    const result = await execute({ pattern: 'found here', path: TMP, file_glob: '*', case_sensitive: true });

    expect(result.matches[0].line).toBe(3);
  });

  it('includes path and pattern in the result', async () => {
    await writeFile(join(TMP, 'h.ts'), 'x\n', 'utf-8');

    const result = await execute({ pattern: 'x', path: TMP, file_glob: '*', case_sensitive: true });

    expect(result.pattern).toBe('x');
    expect(result.path).toBe(TMP);
  });
});
