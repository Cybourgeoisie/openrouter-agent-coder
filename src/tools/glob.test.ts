import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { globTool } from './glob.js';
import { writeFile, mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';

const TMP = join(import.meta.dirname, '../../.test-tmp/glob');

beforeEach(async () => {
  await mkdir(TMP, { recursive: true });
});

afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
});

const tool = globTool();
type GlobInput = {
  pattern: string;
  path: string;
  case_sensitive: boolean;
};
type GlobResult = {
  pattern: string;
  path: string;
  matches: string[];
  matchCount: number;
  truncated: boolean;
};
const execute = tool.function.execute as (params: GlobInput) => Promise<GlobResult>;

describe('glob tool', () => {
  it('has correct name and description', () => {
    expect(tool.function.name).toBe('glob');
    expect(tool.function.description).toContain('glob pattern');
  });

  it('matches `**/*.ts` recursively across nested dirs', async () => {
    await writeFile(join(TMP, 'top.ts'), '', 'utf-8');
    await mkdir(join(TMP, 'a/b'), { recursive: true });
    await writeFile(join(TMP, 'a/mid.ts'), '', 'utf-8');
    await writeFile(join(TMP, 'a/b/deep.ts'), '', 'utf-8');
    await writeFile(join(TMP, 'a/b/skip.md'), '', 'utf-8');

    const result = await execute({ pattern: '**/*.ts', path: TMP, case_sensitive: true });

    expect(result.matchCount).toBe(3);
    expect(result.matches).toEqual(['a/b/deep.ts', 'a/mid.ts', 'top.ts']);
    expect(result.truncated).toBe(false);
  });

  it('matches `*.ts` flat — does not recurse into subdirs', async () => {
    await writeFile(join(TMP, 'a.ts'), '', 'utf-8');
    await writeFile(join(TMP, 'b.ts'), '', 'utf-8');
    await mkdir(join(TMP, 'sub'), { recursive: true });
    await writeFile(join(TMP, 'sub/c.ts'), '', 'utf-8');

    const result = await execute({ pattern: '*.ts', path: TMP, case_sensitive: true });

    expect(result.matches).toEqual(['a.ts', 'b.ts']);
  });

  it('matches scoped `src/**/*.test.ts` pattern', async () => {
    await mkdir(join(TMP, 'src/tools'), { recursive: true });
    await mkdir(join(TMP, 'src/utils'), { recursive: true });
    await mkdir(join(TMP, 'other'), { recursive: true });

    await writeFile(join(TMP, 'src/tools/a.test.ts'), '', 'utf-8');
    await writeFile(join(TMP, 'src/utils/b.test.ts'), '', 'utf-8');
    await writeFile(join(TMP, 'src/tools/a.ts'), '', 'utf-8'); // not a test
    await writeFile(join(TMP, 'other/c.test.ts'), '', 'utf-8'); // wrong root

    const result = await execute({
      pattern: 'src/**/*.test.ts',
      path: TMP,
      case_sensitive: true,
    });

    expect(result.matches).toEqual(['src/tools/a.test.ts', 'src/utils/b.test.ts']);
  });

  it('case_sensitive: false — `*.TS` matches `.ts` files', async () => {
    await writeFile(join(TMP, 'a.ts'), '', 'utf-8');
    await writeFile(join(TMP, 'b.ts'), '', 'utf-8');

    const result = await execute({ pattern: '*.TS', path: TMP, case_sensitive: false });

    expect(result.matches).toEqual(['a.ts', 'b.ts']);
  });

  it('case_sensitive: true (default) — `*.TS` does NOT match `.ts` files', async () => {
    await writeFile(join(TMP, 'a.ts'), '', 'utf-8');
    await writeFile(join(TMP, 'B.TS'), '', 'utf-8');

    const result = await execute({ pattern: '*.TS', path: TMP, case_sensitive: true });

    expect(result.matches).toEqual(['B.TS']);
  });

  it('skips node_modules, dist, coverage, and hidden files/dirs', async () => {
    await mkdir(join(TMP, 'node_modules/pkg'), { recursive: true });
    await mkdir(join(TMP, 'dist'), { recursive: true });
    await mkdir(join(TMP, 'coverage'), { recursive: true });
    await mkdir(join(TMP, '.git'), { recursive: true });
    await mkdir(join(TMP, 'sub'), { recursive: true });

    await writeFile(join(TMP, 'node_modules/pkg/index.ts'), '', 'utf-8');
    await writeFile(join(TMP, 'dist/bundle.ts'), '', 'utf-8');
    await writeFile(join(TMP, 'coverage/c.ts'), '', 'utf-8');
    await writeFile(join(TMP, '.git/HEAD.ts'), '', 'utf-8');
    await writeFile(join(TMP, '.hidden.ts'), '', 'utf-8');
    await writeFile(join(TMP, 'real.ts'), '', 'utf-8');
    await writeFile(join(TMP, 'sub/nested.ts'), '', 'utf-8');

    // Hidden dir nested inside a regular dir is also skipped.
    await mkdir(join(TMP, 'sub/.cache'), { recursive: true });
    await writeFile(join(TMP, 'sub/.cache/x.ts'), '', 'utf-8');

    const result = await execute({ pattern: '**/*.ts', path: TMP, case_sensitive: true });

    expect(result.matches).toEqual(['real.ts', 'sub/nested.ts']);
  });

  it('caps at MAX_MATCHES=1000 and sets truncated=true', async () => {
    // 1100 files at the root — exceeds the 1000 cap.
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 1100; i++) {
      writes.push(writeFile(join(TMP, `f${i.toString().padStart(5, '0')}.ts`), '', 'utf-8'));
    }
    await Promise.all(writes);

    const result = await execute({ pattern: '*.ts', path: TMP, case_sensitive: true });

    expect(result.matches.length).toBe(1000);
    expect(result.matchCount).toBe(1000);
    expect(result.truncated).toBe(true);
  });

  it('honors ctx.signal pre-aborted — throws cancellation promptly', async () => {
    const controller = new AbortController();
    controller.abort();
    const cancellable = globTool({ cwd: TMP, signal: controller.signal });
    type Exec = (params: GlobInput) => Promise<GlobResult>;
    const exec = cancellable.function.execute as Exec;

    await expect(exec({ pattern: '**/*.ts', path: TMP, case_sensitive: true })).rejects.toThrow(
      'glob cancelled',
    );
  });

  it('honors ctx.signal aborted mid-walk', async () => {
    // Build a moderately deep tree so the walk takes multiple BFS levels.
    for (let i = 0; i < 5; i++) {
      const dir = join(TMP, `d${i}/e${i}/f${i}`);
      await mkdir(dir, { recursive: true });
      for (let j = 0; j < 20; j++) {
        await writeFile(join(dir, `file${j}.ts`), '', 'utf-8');
      }
    }

    const controller = new AbortController();
    const cancellable = globTool({ cwd: TMP, signal: controller.signal });
    type Exec = (params: GlobInput) => Promise<GlobResult>;
    const exec = cancellable.function.execute as Exec;

    // Schedule abort on the next tick so the walk has started.
    setImmediate(() => controller.abort());

    await expect(exec({ pattern: '**/*.ts', path: TMP, case_sensitive: true })).rejects.toThrow(
      'glob cancelled',
    );
  });

  it('produces stable output ordering across runs', async () => {
    await mkdir(join(TMP, 'a/b'), { recursive: true });
    await mkdir(join(TMP, 'z'), { recursive: true });
    await writeFile(join(TMP, 'a/b/x.ts'), '', 'utf-8');
    await writeFile(join(TMP, 'a/y.ts'), '', 'utf-8');
    await writeFile(join(TMP, 'z/w.ts'), '', 'utf-8');
    await writeFile(join(TMP, 'top.ts'), '', 'utf-8');

    const r1 = await execute({ pattern: '**/*.ts', path: TMP, case_sensitive: true });
    const r2 = await execute({ pattern: '**/*.ts', path: TMP, case_sensitive: true });

    expect(r1.matches).toEqual(r2.matches);
    expect(r1.matches).toEqual(['a/b/x.ts', 'a/y.ts', 'top.ts', 'z/w.ts']);
  });

  it('resolves relative `path` against ctx.cwd (not process.cwd)', async () => {
    // Create a sub-fixture under TMP, then call with cwd=TMP and path='inner'.
    const inner = join(TMP, 'inner');
    await mkdir(inner, { recursive: true });
    await writeFile(join(inner, 'a.ts'), '', 'utf-8');
    await writeFile(join(inner, 'b.ts'), '', 'utf-8');
    // Decoy file at TMP root that should NOT be picked up.
    await writeFile(join(TMP, 'decoy.ts'), '', 'utf-8');

    const cwdScoped = globTool({ cwd: TMP });
    type Exec = (params: GlobInput) => Promise<GlobResult>;
    const exec = cwdScoped.function.execute as Exec;

    const result = await exec({ pattern: '*.ts', path: 'inner', case_sensitive: true });

    expect(result.matches).toEqual(['a.ts', 'b.ts']);
  });

  it('returns pattern and path in the result', async () => {
    await writeFile(join(TMP, 'a.ts'), '', 'utf-8');

    const result = await execute({ pattern: '*.ts', path: TMP, case_sensitive: true });

    expect(result.pattern).toBe('*.ts');
    expect(result.path).toBe(TMP);
  });

  it('returns empty matches when nothing matches', async () => {
    await writeFile(join(TMP, 'a.md'), '', 'utf-8');

    const result = await execute({ pattern: '**/*.ts', path: TMP, case_sensitive: true });

    expect(result.matches).toEqual([]);
    expect(result.matchCount).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it('treats symlinks (neither file nor dir) as non-matches', async () => {
    await writeFile(join(TMP, 'real.ts'), '', 'utf-8');
    // Symlink to a non-existent target — Dirent reports type "symlink"
    // (neither `isDirectory()` nor `isFile()` returns true), so it falls
    // through both branches with no effect.
    await symlink(join(TMP, 'does-not-exist'), join(TMP, 'broken.ts'));

    const result = await execute({ pattern: '*.ts', path: TMP, case_sensitive: true });

    expect(result.matches).toEqual(['real.ts']);
  });

  it('swallows readdir errors on missing root and returns empty', async () => {
    const result = await execute({
      pattern: '**/*.ts',
      path: join(TMP, 'does-not-exist'),
      case_sensitive: true,
    });

    expect(result.matches).toEqual([]);
    expect(result.matchCount).toBe(0);
  });

  it('supports `?` single-char wildcard', async () => {
    await writeFile(join(TMP, 'a.ts'), '', 'utf-8');
    await writeFile(join(TMP, 'b.ts'), '', 'utf-8');
    await writeFile(join(TMP, 'ab.ts'), '', 'utf-8');

    const result = await execute({ pattern: '?.ts', path: TMP, case_sensitive: true });

    // `?` matches one char — `a.ts`/`b.ts` match, `ab.ts` does not.
    expect(result.matches).toEqual(['a.ts', 'b.ts']);
  });

  it('supports `**` not followed by `/` as plain greedy wildcard', async () => {
    await mkdir(join(TMP, 'a/b'), { recursive: true });
    await writeFile(join(TMP, 'a/b/deep.ts'), '', 'utf-8');
    await writeFile(join(TMP, 'a/foo.ts'), '', 'utf-8');
    await writeFile(join(TMP, 'top.ts'), '', 'utf-8');

    // `a/**` (no trailing `/`) → `^a/.*$` — matches anything under `a/`.
    const result = await execute({ pattern: 'a/**', path: TMP, case_sensitive: true });

    expect(result.matches.sort()).toEqual(['a/b/deep.ts', 'a/foo.ts']);
  });

  it('treats an unmatched `[` as a literal character', async () => {
    await writeFile(join(TMP, '[abc.ts'), '', 'utf-8');
    await writeFile(join(TMP, 'other.ts'), '', 'utf-8');

    // No closing `]` → `[` is escaped as a literal.
    const result = await execute({ pattern: '[abc.ts', path: TMP, case_sensitive: true });

    expect(result.matches).toEqual(['[abc.ts']);
  });

  it('supports `[!...]` negated character classes', async () => {
    await writeFile(join(TMP, 'a.ts'), '', 'utf-8');
    await writeFile(join(TMP, 'b.ts'), '', 'utf-8');
    await writeFile(join(TMP, 'c.ts'), '', 'utf-8');

    // `[!a].ts` → matches single non-`a` char before `.ts`.
    const result = await execute({ pattern: '[!a].ts', path: TMP, case_sensitive: true });

    expect(result.matches).toEqual(['b.ts', 'c.ts']);
  });

  it('supports `[a-z]` character classes', async () => {
    await writeFile(join(TMP, 'a.ts'), '', 'utf-8');
    await writeFile(join(TMP, 'b.ts'), '', 'utf-8');
    await writeFile(join(TMP, 'A.ts'), '', 'utf-8'); // uppercase — excluded by class
    await writeFile(join(TMP, '1.ts'), '', 'utf-8'); // digit — excluded

    const result = await execute({ pattern: '[a-z].ts', path: TMP, case_sensitive: true });

    expect(result.matches).toEqual(['a.ts', 'b.ts']);
  });
});
