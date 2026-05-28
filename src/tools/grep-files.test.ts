import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { grepFilesTool } from './grep-files.js';
import { writeFile, mkdir, rm, symlink, chmod } from 'node:fs/promises';
import { join } from 'node:path';

const TMP = join(import.meta.dirname, '../../.test-tmp/grep-files');

async function restoreModes(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    const { readdir, stat } = await import('node:fs/promises');
    await chmod(path, 0o755);
    let entries: string[];
    try {
      entries = await readdir(path);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(path, name);
      try {
        const s = await stat(full);
        await chmod(full, 0o755);
        if (s.isDirectory()) await restoreModes(full);
      } catch {
        // ignore broken symlinks etc.
      }
    }
  } catch {
    // ignore
  }
}

beforeEach(async () => {
  await mkdir(TMP, { recursive: true });
});

afterEach(async () => {
  await restoreModes(TMP);
  await rm(TMP, { recursive: true, force: true });
});

const tool = grepFilesTool();
type GrepInput = {
  pattern: string;
  path: string;
  file_glob: string;
  case_sensitive?: boolean;
  type?: string;
  before_context?: number;
  after_context?: number;
  context?: number;
  output_mode?: 'content' | 'files_with_matches' | 'count';
};
type ContentResult = {
  pattern: string;
  path: string;
  matchCount: number;
  truncated: boolean;
  matches: Array<{
    file: string;
    line: number;
    text: string;
    before?: string[];
    after?: string[];
  }>;
};
type FilesResult = {
  pattern: string;
  path: string;
  mode: 'files_with_matches';
  files: string[];
  matchCount: number;
  truncated: boolean;
};
type CountResult = {
  pattern: string;
  path: string;
  mode: 'count';
  totalMatches: number;
  perFile: Array<{ file: string; count: number }>;
  truncated: boolean;
};
// Default-cast as ContentResult so existing tests keep working unchanged;
// mode-specific helpers below for the new files/count tests.
const execute = tool.function.execute as (params: GrepInput) => Promise<ContentResult>;
const executeFiles = tool.function.execute as (params: GrepInput) => Promise<FilesResult>;
const executeCount = tool.function.execute as (params: GrepInput) => Promise<CountResult>;

describe('grep_files tool', () => {
  it('has correct name and description', () => {
    expect(tool.function.name).toBe('grep_files');
    expect(tool.function.description).toContain('Search for a regex pattern');
  });

  it('finds a simple pattern in a single file', async () => {
    await writeFile(join(TMP, 'a.ts'), 'const x = 1;\nconst y = 2;\n', 'utf-8');

    const result = await execute({
      pattern: 'const',
      path: TMP,
      file_glob: '*.ts',
      case_sensitive: true,
    });

    expect(result.matchCount).toBe(2);
    expect(result.matches[0].file).toBe('a.ts');
    expect(result.matches[0].line).toBe(1);
    expect(result.matches[0].text).toBe('const x = 1;');
    expect(result.matches[1].line).toBe(2);
  });

  it('returns structured match objects with file, line, text', async () => {
    await writeFile(join(TMP, 'b.ts'), 'hello world\n', 'utf-8');

    const result = await execute({
      pattern: 'hello',
      path: TMP,
      file_glob: '*',
      case_sensitive: true,
    });

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

    const result = await execute({
      pattern: 'import',
      path: TMP,
      file_glob: '*.ts',
      case_sensitive: true,
    });

    expect(result.matchCount).toBe(2);
    const files = result.matches.map((m) => m.file).sort();
    expect(files).toEqual(['one.ts', 'two.ts']);
  });

  it('filters files by file_glob', async () => {
    await writeFile(join(TMP, 'code.ts'), 'needle\n', 'utf-8');
    await writeFile(join(TMP, 'notes.md'), 'needle\n', 'utf-8');

    const result = await execute({
      pattern: 'needle',
      path: TMP,
      file_glob: '*.ts',
      case_sensitive: true,
    });

    expect(result.matchCount).toBe(1);
    expect(result.matches[0].file).toBe('code.ts');
  });

  it('is case-insensitive by default', async () => {
    await writeFile(join(TMP, 'c.ts'), 'Hello\nhello\nHELLO\n', 'utf-8');

    const result = await execute({
      pattern: 'hello',
      path: TMP,
      file_glob: '*.ts',
    });

    expect(result.matchCount).toBe(3);
  });

  it('respects case_sensitive: true', async () => {
    await writeFile(join(TMP, 'c.ts'), 'Hello\nhello\nHELLO\n', 'utf-8');

    const result = await execute({
      pattern: 'hello',
      path: TMP,
      file_glob: '*.ts',
      case_sensitive: true,
    });

    expect(result.matchCount).toBe(1);
    expect(result.matches[0].text).toBe('hello');
  });

  it('respects case_sensitive: false', async () => {
    await writeFile(join(TMP, 'd.ts'), 'Hello\nhello\nHELLO\n', 'utf-8');

    const result = await execute({
      pattern: 'hello',
      path: TMP,
      file_glob: '*.ts',
      case_sensitive: false,
    });

    expect(result.matchCount).toBe(3);
  });

  it('supports regex patterns', async () => {
    await writeFile(join(TMP, 'e.ts'), 'foo123\nbar456\nbaz\n', 'utf-8');

    const result = await execute({
      pattern: '\\d+',
      path: TMP,
      file_glob: '*.ts',
      case_sensitive: true,
    });

    expect(result.matchCount).toBe(2);
  });

  it('throws on invalid regex', async () => {
    await expect(
      execute({ pattern: '[invalid', path: TMP, file_glob: '*', case_sensitive: true }),
    ).rejects.toThrow('Invalid regex pattern');
  });

  it('returns zero matches when pattern not found', async () => {
    await writeFile(join(TMP, 'f.ts'), 'nothing here\n', 'utf-8');

    const result = await execute({
      pattern: 'zzznomatch',
      path: TMP,
      file_glob: '*',
      case_sensitive: true,
    });

    expect(result.matchCount).toBe(0);
    expect(result.matches).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it('searches recursively into subdirectories', async () => {
    const sub = join(TMP, 'sub');
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, 'deep.ts'), 'findme\n', 'utf-8');

    const result = await execute({
      pattern: 'findme',
      path: TMP,
      file_glob: '*.ts',
      case_sensitive: true,
    });

    expect(result.matchCount).toBe(1);
    expect(result.matches[0].file).toBe('sub/deep.ts');
  });

  it('skips node_modules directory', async () => {
    const nm = join(TMP, 'node_modules', 'pkg');
    await mkdir(nm, { recursive: true });
    await writeFile(join(nm, 'index.ts'), 'findme\n', 'utf-8');
    await writeFile(join(TMP, 'real.ts'), 'findme\n', 'utf-8');

    const result = await execute({
      pattern: 'findme',
      path: TMP,
      file_glob: '*.ts',
      case_sensitive: true,
    });

    expect(result.matchCount).toBe(1);
    expect(result.matches[0].file).toBe('real.ts');
  });

  it('returns correct line numbers (1-indexed)', async () => {
    await writeFile(join(TMP, 'g.ts'), 'line one\nline two\nfound here\nline four\n', 'utf-8');

    const result = await execute({
      pattern: 'found here',
      path: TMP,
      file_glob: '*',
      case_sensitive: true,
    });

    expect(result.matches[0].line).toBe(3);
  });

  it('includes path and pattern in the result', async () => {
    await writeFile(join(TMP, 'h.ts'), 'x\n', 'utf-8');

    const result = await execute({ pattern: 'x', path: TMP, file_glob: '*', case_sensitive: true });

    expect(result.pattern).toBe('x');
    expect(result.path).toBe(TMP);
  });

  describe('filesystem error fallbacks', () => {
    const isRoot = process.getuid?.() === 0;
    const skipChmod = process.platform === 'win32' || isRoot;

    it.skipIf(skipChmod)('swallows readdir errors on unreadable subdirectory', async () => {
      await writeFile(join(TMP, 'top.ts'), 'findme\n', 'utf-8');
      const locked = join(TMP, 'locked');
      await mkdir(locked);
      await writeFile(join(locked, 'hidden.ts'), 'findme\n', 'utf-8');
      await chmod(locked, 0o000);

      const result = await execute({
        pattern: 'findme',
        path: TMP,
        file_glob: '*.ts',
        case_sensitive: true,
      });

      expect(result.matchCount).toBe(1);
      expect(result.matches[0].file).toBe('top.ts');
    });

    it('skips entries whose stat() rejects (broken symlink)', async () => {
      await writeFile(join(TMP, 'real.ts'), 'findme\n', 'utf-8');
      await symlink(join(TMP, 'does-not-exist'), join(TMP, 'broken.ts'));

      const result = await execute({
        pattern: 'findme',
        path: TMP,
        file_glob: '*.ts',
        case_sensitive: true,
      });

      expect(result.matchCount).toBe(1);
      expect(result.matches[0].file).toBe('real.ts');
    });

    it.skipIf(skipChmod)('skips unreadable files and continues to other matches', async () => {
      await writeFile(join(TMP, 'readable.ts'), 'findme\n', 'utf-8');
      const locked = join(TMP, 'locked.ts');
      await writeFile(locked, 'findme\n', 'utf-8');
      await chmod(locked, 0o000);

      const result = await execute({
        pattern: 'findme',
        path: TMP,
        file_glob: '*.ts',
        case_sensitive: true,
      });

      expect(result.matchCount).toBe(1);
      expect(result.matches[0].file).toBe('readable.ts');
    });
  });

  describe('output modes', () => {
    it("default 'content' mode shape unchanged", async () => {
      await writeFile(join(TMP, 'a.ts'), 'hello\nfoo\nhello\n', 'utf-8');
      const result = await execute({
        pattern: 'hello',
        path: TMP,
        file_glob: '*.ts',
        case_sensitive: true,
      });
      expect(result.matchCount).toBe(2);
      expect(result.matches).toHaveLength(2);
      expect(result.matches[0]).toEqual({ file: 'a.ts', line: 1, text: 'hello' });
      expect(result.truncated).toBe(false);
    });

    it("'files_with_matches' returns unique file paths plus matchCount", async () => {
      await writeFile(join(TMP, 'a.ts'), 'hit\nhit\n', 'utf-8');
      await writeFile(join(TMP, 'b.ts'), 'hit\n', 'utf-8');
      await writeFile(join(TMP, 'c.ts'), 'miss\n', 'utf-8');

      const result = await executeFiles({
        pattern: 'hit',
        path: TMP,
        file_glob: '*.ts',
        case_sensitive: true,
        output_mode: 'files_with_matches',
      });

      expect(result.mode).toBe('files_with_matches');
      expect(result.files.sort()).toEqual(['a.ts', 'b.ts']);
      expect(result.matchCount).toBe(3);
      expect(result.truncated).toBe(false);
    });

    it("'count' returns per-file counts and totalMatches", async () => {
      await writeFile(join(TMP, 'a.ts'), 'x\nx\nx\n', 'utf-8');
      await writeFile(join(TMP, 'b.ts'), 'x\n', 'utf-8');

      const result = await executeCount({
        pattern: 'x',
        path: TMP,
        file_glob: '*.ts',
        case_sensitive: true,
        output_mode: 'count',
      });

      expect(result.mode).toBe('count');
      expect(result.totalMatches).toBe(4);
      const sorted = [...result.perFile].sort((a, b) => a.file.localeCompare(b.file));
      expect(sorted).toEqual([
        { file: 'a.ts', count: 3 },
        { file: 'b.ts', count: 1 },
      ]);
    });
  });

  describe('context lines', () => {
    it('before_context: 2 returns the two preceding lines', async () => {
      await writeFile(join(TMP, 'a.ts'), 'one\ntwo\nthree\nMATCH\nfour\nfive\n', 'utf-8');
      const result = await execute({
        pattern: 'MATCH',
        path: TMP,
        file_glob: '*.ts',
        case_sensitive: true,
        before_context: 2,
      });
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].before).toEqual(['two', 'three']);
      expect(result.matches[0].after).toBeUndefined();
    });

    it('after_context: 2 returns the two following lines', async () => {
      await writeFile(join(TMP, 'a.ts'), 'one\nMATCH\ntwo\nthree\nfour\n', 'utf-8');
      const result = await execute({
        pattern: 'MATCH',
        path: TMP,
        file_glob: '*.ts',
        case_sensitive: true,
        after_context: 2,
      });
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].after).toEqual(['two', 'three']);
      expect(result.matches[0].before).toBeUndefined();
    });

    it('context: 3 sets both before and after to 3', async () => {
      await writeFile(join(TMP, 'a.ts'), 'a\nb\nc\nd\nMATCH\ne\nf\ng\nh\n', 'utf-8');
      const result = await execute({
        pattern: 'MATCH',
        path: TMP,
        file_glob: '*.ts',
        case_sensitive: true,
        context: 3,
      });
      expect(result.matches[0].before).toEqual(['b', 'c', 'd']);
      expect(result.matches[0].after).toEqual(['e', 'f', 'g']);
    });

    it('explicit before_context overrides context for that side only', async () => {
      await writeFile(join(TMP, 'a.ts'), 'a\nb\nc\nd\nMATCH\ne\nf\ng\nh\n', 'utf-8');
      const result = await execute({
        pattern: 'MATCH',
        path: TMP,
        file_glob: '*.ts',
        case_sensitive: true,
        context: 3,
        before_context: 1,
      });
      expect(result.matches[0].before).toEqual(['d']);
      expect(result.matches[0].after).toEqual(['e', 'f', 'g']);
    });

    it('treats negative context as 0 (lower clamp)', async () => {
      await writeFile(join(TMP, 'a.ts'), 'one\nMATCH\ntwo\n', 'utf-8');
      const result = await execute({
        pattern: 'MATCH',
        path: TMP,
        file_glob: '*.ts',
        case_sensitive: true,
        before_context: -3,
        after_context: -3,
      });
      // -3 clamps to 0 → no before/after arrays.
      expect(result.matches[0].before).toBeUndefined();
      expect(result.matches[0].after).toBeUndefined();
    });

    it('silently clamps oversized context values to 20', async () => {
      // 30 preceding lines then MATCH; clamped to 20 should return last 20.
      const preLines = Array.from({ length: 30 }, (_, i) => `line${i + 1}`);
      await writeFile(join(TMP, 'a.ts'), `${preLines.join('\n')}\nMATCH\n`, 'utf-8');
      const result = await execute({
        pattern: 'MATCH',
        path: TMP,
        file_glob: '*.ts',
        case_sensitive: true,
        before_context: 100,
      });
      expect(result.matches[0].before).toHaveLength(20);
      expect(result.matches[0].before![0]).toBe('line11');
      expect(result.matches[0].before![19]).toBe('line30');
    });

    it('handles match within first lines of file (before-buffer not full)', async () => {
      await writeFile(join(TMP, 'a.ts'), 'MATCH\nfollowing\n', 'utf-8');
      const result = await execute({
        pattern: 'MATCH',
        path: TMP,
        file_glob: '*.ts',
        case_sensitive: true,
        before_context: 5,
        after_context: 5,
      });
      expect(result.matches[0].before).toEqual([]);
      expect(result.matches[0].after).toEqual(['following', '']);
    });
  });

  describe('filetype filter', () => {
    it("type: 'ts' matches both .ts and .tsx files", async () => {
      await writeFile(join(TMP, 'a.ts'), 'needle\n', 'utf-8');
      await writeFile(join(TMP, 'b.tsx'), 'needle\n', 'utf-8');
      await writeFile(join(TMP, 'c.md'), 'needle\n', 'utf-8');

      const result = await execute({
        pattern: 'needle',
        path: TMP,
        // Sentinel non-matching glob to prove the union with type is doing the work.
        file_glob: '__none__',
        case_sensitive: true,
        type: 'ts',
      });

      expect(result.matchCount).toBe(2);
      expect(result.matches.map((m) => m.file).sort()).toEqual(['a.ts', 'b.tsx']);
    });

    it('union with file_glob — file matches if EITHER includes it', async () => {
      await writeFile(join(TMP, 'a.ts'), 'needle\n', 'utf-8');
      await writeFile(join(TMP, 'b.py'), 'needle\n', 'utf-8');
      await writeFile(join(TMP, 'c.json'), 'no match here\n', 'utf-8');

      const result = await execute({
        pattern: 'needle',
        // file_glob matches only .py; type='ts' adds the .ts side.
        path: TMP,
        file_glob: '*.py',
        case_sensitive: true,
        type: 'ts',
      });

      expect(result.matchCount).toBe(2);
      expect(result.matches.map((m) => m.file).sort()).toEqual(['a.ts', 'b.py']);
    });

    it('unknown type is silently ignored', async () => {
      await writeFile(join(TMP, 'a.ts'), 'needle\n', 'utf-8');
      await writeFile(join(TMP, 'b.md'), 'needle\n', 'utf-8');

      const result = await execute({
        pattern: 'needle',
        path: TMP,
        file_glob: '*.ts',
        case_sensitive: true,
        type: 'xyz-not-a-real-type',
      });

      // Behaves exactly like no `type` — only file_glob matters.
      expect(result.matchCount).toBe(1);
      expect(result.matches[0].file).toBe('a.ts');
    });
  });

  describe('MAX_MATCHES truncation across modes', () => {
    async function writeBigCorpus(): Promise<void> {
      // 5 files × 60 lines each = 300 matches, well above the 200 cap.
      for (let f = 0; f < 5; f++) {
        const lines = Array.from({ length: 60 }, () => 'HIT').join('\n');
        await writeFile(join(TMP, `f${f}.ts`), lines + '\n', 'utf-8');
      }
    }

    it("'content' mode honors MAX_MATCHES and sets truncated", async () => {
      await writeBigCorpus();
      const result = await execute({
        pattern: 'HIT',
        path: TMP,
        file_glob: '*.ts',
        case_sensitive: true,
      });
      expect(result.matches.length).toBe(200);
      expect(result.matchCount).toBe(200);
      expect(result.truncated).toBe(true);
    });

    it("'files_with_matches' mode honors MAX_MATCHES (matchCount capped, truncated set)", async () => {
      await writeBigCorpus();
      const result = await executeFiles({
        pattern: 'HIT',
        path: TMP,
        file_glob: '*.ts',
        case_sensitive: true,
        output_mode: 'files_with_matches',
      });
      // Even though all 5 files have matches, we cap before scanning the last
      // ones — 200 matches at 60/file = first 4 files fully, none of the 5th.
      // The exact number of files surfaced depends on file walk order which is
      // FS-dependent; the invariant is matchCount == 200 and truncated == true.
      expect(result.matchCount).toBe(200);
      expect(result.truncated).toBe(true);
      expect(result.files.length).toBeGreaterThan(0);
      expect(result.files.length).toBeLessThanOrEqual(5);
    });

    it("'count' mode honors MAX_MATCHES (totalMatches capped, truncated set)", async () => {
      await writeBigCorpus();
      const result = await executeCount({
        pattern: 'HIT',
        path: TMP,
        file_glob: '*.ts',
        case_sensitive: true,
        output_mode: 'count',
      });
      expect(result.totalMatches).toBe(200);
      expect(result.truncated).toBe(true);
      const sum = result.perFile.reduce((acc, p) => acc + p.count, 0);
      expect(sum).toBe(200);
    });
  });
});
