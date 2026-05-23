import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, chmod } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  composeInstructions,
  COMPOSED_INSTRUCTIONS_CHAR_CAP,
  MAX_PROJECT_WALK_DEPTH,
  type SettingSource,
} from './context-discovery.js';

let ROOT: string;
let ORIGINAL_HOME: string | undefined;

beforeEach(async () => {
  ROOT = await mkdtemp(join(tmpdir(), 'ctx-discovery-test-'));
  ORIGINAL_HOME = process.env.HOME;
  // Redirect os.homedir() at a sandbox dir so the test never reaches the
  // real user's ~/.claude. os.homedir() honours $HOME on POSIX.
  process.env.HOME = join(ROOT, 'no-such-home');
});

afterEach(async () => {
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }
  await rm(ROOT, { recursive: true, force: true });
});

async function writeFileAt(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content, 'utf8');
}

describe('composeInstructions', () => {
  it('returns the supplied instructions unchanged when settingSources is empty', async () => {
    const out = await composeInstructions({
      cwd: ROOT,
      settingSources: [],
      instructions: 'BASE',
    });
    expect(out).toBe('BASE');
  });

  it('does not perform FS reads when settingSources is empty', async () => {
    // Drop a CLAUDE.md so a misbehaving impl that ignores the empty-source
    // short-circuit would surface it; if it shows up in the output, the early
    // return is broken.
    await writeFileAt(join(ROOT, 'CLAUDE.md'), 'PROJECT');
    await writeFileAt(join(ROOT, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const out = await composeInstructions({
      cwd: ROOT,
      settingSources: [],
      instructions: 'BASE',
    });
    expect(out).toBe('BASE');
    expect(out).not.toContain('PROJECT');
  });

  it('reads the project CLAUDE.md and prepends it to instructions', async () => {
    await writeFileAt(join(ROOT, 'CLAUDE.md'), 'PROJECT');
    await writeFileAt(join(ROOT, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const out = await composeInstructions({
      cwd: ROOT,
      settingSources: ['project'],
      instructions: 'BASE',
    });
    expect(out).toBe('PROJECT\n\nBASE');
  });

  it('reads .claude/CLAUDE.md as a project source', async () => {
    await writeFileAt(join(ROOT, '.claude', 'CLAUDE.md'), 'SCOPED');
    await writeFileAt(join(ROOT, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const out = await composeInstructions({
      cwd: ROOT,
      settingSources: ['project'],
      instructions: 'BASE',
    });
    expect(out).toBe('SCOPED\n\nBASE');
  });

  it('reads .claude/CLAUDE.local.md for the local source', async () => {
    await writeFileAt(join(ROOT, '.claude', 'CLAUDE.local.md'), 'LOCAL');
    const out = await composeInstructions({
      cwd: ROOT,
      settingSources: ['local'],
      instructions: 'BASE',
    });
    expect(out).toBe('LOCAL\n\nBASE');
  });

  it('reads the user CLAUDE.md via os.homedir()', async () => {
    const fakeHome = join(ROOT, 'fake-home');
    await writeFileAt(join(fakeHome, '.claude', 'CLAUDE.md'), 'USER');
    process.env.HOME = fakeHome;

    const out = await composeInstructions({
      cwd: ROOT,
      settingSources: ['user'],
      instructions: 'BASE',
    });
    expect(out).toBe('USER\n\nBASE');
  });

  it('composes user, project, local in that order before the instructions', async () => {
    const fakeHome = join(ROOT, 'fake-home');
    const workdir = join(ROOT, 'work');
    await writeFileAt(join(fakeHome, '.claude', 'CLAUDE.md'), 'USER');
    await writeFileAt(join(workdir, 'CLAUDE.md'), 'PROJECT');
    await writeFileAt(join(workdir, '.claude', 'CLAUDE.local.md'), 'LOCAL');
    await writeFileAt(join(workdir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    process.env.HOME = fakeHome;

    const out = await composeInstructions({
      cwd: workdir,
      // Intentionally reorder the input to verify the canonical output order.
      settingSources: ['local', 'user', 'project'] as SettingSource[],
      instructions: 'BASE',
    });
    expect(out).toBe('USER\n\nPROJECT\n\nLOCAL\n\nBASE');
  });

  it('dedupes repeated source entries', async () => {
    await writeFileAt(join(ROOT, 'CLAUDE.md'), 'PROJECT');
    await writeFileAt(join(ROOT, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const out = await composeInstructions({
      cwd: ROOT,
      settingSources: ['project', 'project'],
      instructions: 'BASE',
    });
    expect(out).toBe('PROJECT\n\nBASE');
  });

  it('walks up to a parent and stops at the first .git directory', async () => {
    const repoRoot = join(ROOT, 'repo');
    const childDir = join(repoRoot, 'a', 'b');
    await writeFileAt(join(repoRoot, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await writeFileAt(join(repoRoot, 'CLAUDE.md'), 'ROOT');
    await writeFileAt(join(childDir, 'CLAUDE.md'), 'CHILD');
    // CLAUDE.md outside the repo (one level above .git) must NOT be picked up.
    await writeFileAt(join(ROOT, 'CLAUDE.md'), 'OUTSIDE');

    const out = await composeInstructions({
      cwd: childDir,
      settingSources: ['project'],
      instructions: 'BASE',
    });

    expect(out).toContain('ROOT');
    expect(out).toContain('CHILD');
    expect(out).not.toContain('OUTSIDE');
    // Repo root should appear before the deeper-level block.
    expect(out.indexOf('ROOT')).toBeLessThan(out.indexOf('CHILD'));
  });

  it('caps the walk depth at MAX_PROJECT_WALK_DEPTH directories', async () => {
    // Build a chain deeper than the cap with no .git anywhere, and place a
    // CLAUDE.md beyond the cap that must NOT be picked up.
    const segments = Array.from({ length: MAX_PROJECT_WALK_DEPTH + 2 }, (_, i) => `d${i}`);
    const deep = join(ROOT, ...segments);
    await mkdir(deep, { recursive: true });
    const beyondCap = join(ROOT, 'd0');
    await writeFile(join(beyondCap, 'CLAUDE.md'), 'BEYOND', 'utf8');
    // And a CLAUDE.md just inside the cap so we know the walk reached _some_
    // ancestor levels.
    const withinCap = join(ROOT, 'd0', 'd1', 'd2');
    await writeFile(join(withinCap, 'CLAUDE.md'), 'WITHIN', 'utf8');

    const out = await composeInstructions({
      cwd: deep,
      settingSources: ['project'],
      instructions: 'BASE',
    });

    expect(out).toContain('WITHIN');
    expect(out).not.toContain('BEYOND');
  });

  it('is silent when no CLAUDE.md files exist anywhere', async () => {
    const out = await composeInstructions({
      cwd: ROOT,
      settingSources: ['user', 'project', 'local'],
      instructions: 'BASE',
    });
    expect(out).toBe('BASE');
  });

  it('silently ignores unreadable files (chmod 000)', async () => {
    const projectFile = join(ROOT, 'CLAUDE.md');
    await writeFile(projectFile, 'PROJECT', 'utf8');
    await writeFileAt(join(ROOT, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await chmod(projectFile, 0o000);
    // Skip the unreadable-file expectation when running as root (euid 0
    // bypasses POSIX permissions and would read the file regardless).
    const euid = typeof process.geteuid === 'function' ? process.geteuid() : -1;
    try {
      const out = await composeInstructions({
        cwd: ROOT,
        settingSources: ['project'],
        instructions: 'BASE',
      });
      if (euid === 0) {
        expect(out).toContain('PROJECT');
      } else {
        expect(out).toBe('BASE');
      }
    } finally {
      await chmod(projectFile, 0o600);
    }
  });

  it('emits a warn log and truncates from the oldest source when over the char cap', async () => {
    const fakeHome = join(ROOT, 'fake-home');
    const work = join(ROOT, 'work');
    // Roughly 30k chars per file — together they exceed the 50k cap.
    const big = 'x'.repeat(30_000);
    await writeFileAt(join(fakeHome, '.claude', 'CLAUDE.md'), 'USER-' + big);
    await writeFileAt(join(work, 'CLAUDE.md'), 'PROJECT-' + big);
    await writeFileAt(join(work, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    process.env.HOME = fakeHome;

    const logs: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
    const logger = (
      level: 'debug' | 'info' | 'warn' | 'error',
      message: string,
      fields?: Record<string, unknown>,
    ): void => {
      logs.push({ level, message, fields });
    };

    const out = await composeInstructions({
      cwd: work,
      settingSources: ['user', 'project'],
      instructions: 'BASE',
      logger,
    });

    // The user contribution is dropped first; project survives.
    expect(out).toContain('PROJECT-');
    expect(out).not.toContain('USER-');
    expect(out.length).toBeLessThanOrEqual(COMPOSED_INSTRUCTIONS_CHAR_CAP);
    const warn = logs.find((l) => l.level === 'warn');
    expect(warn).toBeDefined();
    expect(warn!.message).toBe('Composed instructions exceeded cap; truncated from oldest source');
    expect((warn!.fields as { capped: number; originalLen: number }).originalLen).toBeGreaterThan(
      COMPOSED_INSTRUCTIONS_CHAR_CAP,
    );
  });

  it('falls back to the bare instructions when even dropping every source is insufficient', async () => {
    // Use a synthetic source by stubbing the project walk to return a huge
    // file but then expect the bare-instructions fallback path. We do this by
    // setting up project + local + user all individually small, but the
    // instructions itself is over the cap.
    const bigInstructions = 'I'.repeat(COMPOSED_INSTRUCTIONS_CHAR_CAP + 100);
    await writeFileAt(join(ROOT, 'CLAUDE.md'), 'PROJECT');
    await writeFileAt(join(ROOT, '.git', 'HEAD'), 'ref: refs/heads/main\n');

    const logs: Array<{ level: string; message: string }> = [];
    const out = await composeInstructions({
      cwd: ROOT,
      settingSources: ['project'],
      instructions: bigInstructions,
      logger: (level, message): void => {
        logs.push({ level, message });
      },
    });
    expect(out).toBe(bigInstructions);
    expect(logs.find((l) => l.level === 'warn')).toBeDefined();
  });

  it('treats an empty instructions string as no trailing block (no stray separator)', async () => {
    await writeFileAt(join(ROOT, 'CLAUDE.md'), 'PROJECT');
    await writeFileAt(join(ROOT, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const out = await composeInstructions({
      cwd: ROOT,
      settingSources: ['project'],
      instructions: '',
    });
    expect(out).toBe('PROJECT');
  });

  it('exposes homedir() as a non-empty string on the host', () => {
    // Sanity check that node:os.homedir() returns something usable so the
    // user-source path is exercisable in production.
    expect(typeof homedir()).toBe('string');
    expect(homedir().length).toBeGreaterThan(0);
  });
});
