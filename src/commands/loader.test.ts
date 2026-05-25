import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCommandLoader, parseCommandFile, COMMAND_NAMESPACE_SEPARATOR } from './loader.js';
import { createSkillLoader } from '../skills/loader.js';

let ROOT: string;

beforeEach(async () => {
  ROOT = await mkdtemp(join(tmpdir(), 'cmd-loader-test-'));
});

afterEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

async function writeCommand(baseDir: string, relPath: string, contents: string): Promise<string> {
  const full = join(baseDir, relPath);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, contents, 'utf8');
  return full;
}

describe('parseCommandFile', () => {
  it('returns inferred name when frontmatter is absent', () => {
    const { frontmatter, body } = parseCommandFile('just body\nline two\n', 'foo');
    expect(frontmatter.name).toBe('foo');
    expect(body).toBe('just body\nline two\n');
  });

  it('parses a minimal command with frontmatter', () => {
    const raw = '---\nname: foo\ndescription: do the thing\nargument-hint: <thing>\n---\nbody $1';
    const { frontmatter, body } = parseCommandFile(raw, 'foo');
    expect(frontmatter.name).toBe('foo');
    expect(frontmatter.description).toBe('do the thing');
    expect(frontmatter.argumentHint).toBe('<thing>');
    expect(body).toBe('body $1');
  });

  it('auto-injects name from filename when frontmatter omits it', () => {
    const raw = '---\ndescription: no name field\n---\nbody';
    const { frontmatter } = parseCommandFile(raw, 'foo');
    expect(frontmatter.name).toBe('foo');
  });

  it('throws when the frontmatter block is opened but never closed', () => {
    const raw = '---\nname: foo\nbody but no fence';
    expect(() => parseCommandFile(raw, 'foo')).toThrow(/closing/);
  });

  it('throws when frontmatter fails validation', () => {
    const raw = '---\nname: BadName\n---\nbody';
    expect(() => parseCommandFile(raw, 'BadName')).toThrow(/validation failed/);
  });
});

describe('createCommandLoader — discovery', () => {
  it('finds project-scope commands under .claude/commands/', async () => {
    await mkdir(join(ROOT, '.git'), { recursive: true });
    await writeCommand(
      join(ROOT, '.claude', 'commands'),
      'hello.md',
      '---\ndescription: greet\n---\nhi $1',
    );
    const loader = createCommandLoader({ cwd: ROOT, home: '/nonexistent-home' });
    const list = await loader.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      name: 'hello',
      description: 'greet',
      source: 'project',
    });
  });

  it('finds user-scope commands under <home>/.claude/commands/', async () => {
    const home = join(ROOT, 'home');
    await writeCommand(join(home, '.claude', 'commands'), 'mine.md', 'no frontmatter, body only');
    const projectDir = join(ROOT, 'proj');
    await mkdir(join(projectDir, '.git'), { recursive: true });
    const loader = createCommandLoader({ cwd: projectDir, home });
    const list = await loader.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'mine', source: 'user' });
  });

  it('project overrides user when names collide', async () => {
    const home = join(ROOT, 'home');
    await writeCommand(
      join(home, '.claude', 'commands'),
      'shared.md',
      '---\ndescription: from-user\n---\nuser body',
    );
    const projectDir = join(ROOT, 'proj');
    await mkdir(join(projectDir, '.git'), { recursive: true });
    await writeCommand(
      join(projectDir, '.claude', 'commands'),
      'shared.md',
      '---\ndescription: from-project\n---\nproject body',
    );
    const loader = createCommandLoader({ cwd: projectDir, home });
    const list = await loader.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      name: 'shared',
      source: 'project',
      description: 'from-project',
    });
  });

  it('namespaces subdirectory commands with `:`', async () => {
    await mkdir(join(ROOT, '.git'), { recursive: true });
    await writeCommand(join(ROOT, '.claude', 'commands'), 'git/commit.md', 'body');
    await writeCommand(join(ROOT, '.claude', 'commands'), 'git/branch/list.md', 'body');
    const loader = createCommandLoader({ cwd: ROOT, home: '/nonexistent-home' });
    const names = (await loader.list()).map((c) => c.name).sort();
    expect(names).toEqual(['git:branch:list', 'git:commit']);
    expect(COMMAND_NAMESPACE_SEPARATOR).toBe(':');
  });

  it('namespaces plugin commands as `<pluginName>:<command>`', async () => {
    const pluginRoot = join(ROOT, 'plugin');
    await writeCommand(join(pluginRoot, 'commands'), 'deploy.md', 'body');
    await writeCommand(join(pluginRoot, 'commands'), 'aws/ec2.md', 'body');
    const projectDir = join(ROOT, 'proj');
    await mkdir(join(projectDir, '.git'), { recursive: true });
    const loader = createCommandLoader({
      cwd: projectDir,
      home: '/nonexistent-home',
      pluginRoots: [{ name: 'acme', root: pluginRoot }],
    });
    const names = (await loader.list()).map((c) => c.name).sort();
    expect(names).toEqual(['acme:aws:ec2', 'acme:deploy']);
  });

  it('stops the project walk at a `.git` boundary', async () => {
    const inner = join(ROOT, 'a', 'b', 'inner');
    await mkdir(join(inner, '.git'), { recursive: true });
    // A command at the boundary is found.
    await writeCommand(join(inner, '.claude', 'commands'), 'inside.md', 'body');
    // A command ABOVE the boundary must NOT be discovered.
    await writeCommand(join(ROOT, 'a', '.claude', 'commands'), 'outside.md', 'body');
    const loader = createCommandLoader({ cwd: inner, home: '/nonexistent-home' });
    const names = (await loader.list()).map((c) => c.name).sort();
    expect(names).toEqual(['inside']);
  });

  it('caps the project walk depth', async () => {
    // Build a chain of 15 nested dirs with NO .git boundary; the walker should
    // stop at depth 10 and not see commands above that.
    let dir = ROOT;
    for (let i = 0; i < 15; i++) dir = join(dir, `d${i}`);
    await mkdir(dir, { recursive: true });
    // Place a command at the OUTERMOST root (depth 0 from ROOT). The walker
    // starts at `dir` and climbs at most 10 levels; ROOT is depth 15, so the
    // outer command MUST NOT be found.
    await writeCommand(join(ROOT, '.claude', 'commands'), 'far.md', 'body');
    const loader = createCommandLoader({ cwd: dir, home: '/nonexistent-home' });
    const list = await loader.list();
    expect(list).toEqual([]);
  });

  it('skips non-`.md` files in the commands directory', async () => {
    await mkdir(join(ROOT, '.git'), { recursive: true });
    await writeCommand(join(ROOT, '.claude', 'commands'), 'real.md', 'body');
    await writeCommand(join(ROOT, '.claude', 'commands'), 'readme.txt', 'notes');
    await writeCommand(join(ROOT, '.claude', 'commands'), 'no-extension', 'thing');
    const loader = createCommandLoader({ cwd: ROOT, home: '/nonexistent-home' });
    expect((await loader.list()).map((c) => c.name)).toEqual(['real']);
  });

  it('omits description / argumentHint from listing when frontmatter does not set them', async () => {
    await mkdir(join(ROOT, '.git'), { recursive: true });
    // body-only — no frontmatter
    await writeCommand(join(ROOT, '.claude', 'commands'), 'bare.md', 'just body');
    // frontmatter with description but no argument-hint
    await writeCommand(
      join(ROOT, '.claude', 'commands'),
      'desc-only.md',
      '---\ndescription: only desc\n---\nbody',
    );
    // frontmatter with argument-hint but no description
    await writeCommand(
      join(ROOT, '.claude', 'commands'),
      'hint-only.md',
      '---\nargument-hint: <thing>\n---\nbody',
    );
    const loader = createCommandLoader({ cwd: ROOT, home: '/nonexistent-home' });
    const list = await loader.list();
    const bare = list.find((c) => c.name === 'bare')!;
    expect(bare.description).toBeUndefined();
    expect(bare.argumentHint).toBeUndefined();
    const descOnly = list.find((c) => c.name === 'desc-only')!;
    expect(descOnly.description).toBe('only desc');
    expect(descOnly.argumentHint).toBeUndefined();
    const hintOnly = list.find((c) => c.name === 'hint-only')!;
    expect(hintOnly.description).toBeUndefined();
    expect(hintOnly.argumentHint).toBe('<thing>');
  });

  it('returns an empty list when no commands directory exists', async () => {
    await mkdir(join(ROOT, '.git'), { recursive: true });
    const loader = createCommandLoader({ cwd: ROOT, home: '/nonexistent-home' });
    expect(await loader.list()).toEqual([]);
  });

  it('walk terminates at the filesystem root when no `.git` boundary is found', async () => {
    // No .git anywhere up the chain. The walker climbs until parent === current
    // (fs root) and stops. Returns empty since no `.claude/commands/` exists.
    const loader = createCommandLoader({ cwd: ROOT, home: '/nonexistent-home' });
    await expect(loader.list()).resolves.toEqual([]);
  });

  it('defaults the user scope to os.homedir() when `home` is omitted', async () => {
    // We can't realistically write into the real home dir; just exercise the
    // branch and assert it doesn't blow up — discovery returns whatever (if
    // anything) lives at the real `~/.claude/commands/`.
    await mkdir(join(ROOT, '.git'), { recursive: true });
    const loader = createCommandLoader({ cwd: ROOT });
    await expect(loader.list()).resolves.toBeDefined();
  });

  it('logs a warning and continues when a subdirectory is unreadable', async () => {
    await mkdir(join(ROOT, '.git'), { recursive: true });
    await writeCommand(join(ROOT, '.claude', 'commands'), 'ok.md', 'body');
    const lockedDir = join(ROOT, '.claude', 'commands', 'locked');
    await mkdir(lockedDir, { recursive: true });
    // chmod 000 — readdir will EACCES on the locked subdir.
    await chmod(lockedDir, 0o000);
    try {
      const logs: Array<{ level: string; msg: string }> = [];
      const loader = createCommandLoader({
        cwd: ROOT,
        home: '/nonexistent-home',
        logger: (level, msg) => logs.push({ level, msg }),
      });
      const names = (await loader.list()).map((c) => c.name);
      expect(names).toEqual(['ok']);
      expect(logs.some((l) => l.level === 'warn' && /failed to read/.test(l.msg))).toBe(true);
    } finally {
      // restore so afterEach cleanup can remove the tree
      await chmod(lockedDir, 0o755);
    }
  });

  it('logs a warning and continues when an individual file is unreadable', async () => {
    await mkdir(join(ROOT, '.git'), { recursive: true });
    await writeCommand(join(ROOT, '.claude', 'commands'), 'ok.md', 'body');
    const lockedFile = join(ROOT, '.claude', 'commands', 'locked.md');
    await writeFile(lockedFile, 'body', 'utf8');
    await chmod(lockedFile, 0o000);
    try {
      const logs: Array<{ level: string; msg: string }> = [];
      const loader = createCommandLoader({
        cwd: ROOT,
        home: '/nonexistent-home',
        logger: (level, msg) => logs.push({ level, msg }),
      });
      const names = (await loader.list()).map((c) => c.name);
      expect(names).toEqual(['ok']);
      expect(logs.some((l) => l.level === 'warn' && /failed to read/.test(l.msg))).toBe(true);
    } finally {
      await chmod(lockedFile, 0o644);
    }
  });

  it('skips files with bad frontmatter and logs a warning', async () => {
    await mkdir(join(ROOT, '.git'), { recursive: true });
    await writeCommand(
      join(ROOT, '.claude', 'commands'),
      'good.md',
      '---\ndescription: ok\n---\nbody',
    );
    await writeCommand(
      join(ROOT, '.claude', 'commands'),
      'bad.md',
      '---\nname: BadName\n---\nbody',
    );
    const logs: Array<{ level: string; msg: string }> = [];
    const loader = createCommandLoader({
      cwd: ROOT,
      home: '/nonexistent-home',
      logger: (level, msg) => logs.push({ level, msg }),
    });
    const names = (await loader.list()).map((c) => c.name);
    expect(names).toEqual(['good']);
    expect(logs.some((l) => l.level === 'warn' && /invalid frontmatter/.test(l.msg))).toBe(true);
  });

  it('disableProjectCommands and disableUserCommands suppress those scopes', async () => {
    const home = join(ROOT, 'home');
    await writeCommand(join(home, '.claude', 'commands'), 'u.md', 'body');
    const projectDir = join(ROOT, 'proj');
    await mkdir(join(projectDir, '.git'), { recursive: true });
    await writeCommand(join(projectDir, '.claude', 'commands'), 'p.md', 'body');
    const both = createCommandLoader({ cwd: projectDir, home });
    expect((await both.list()).map((c) => c.name).sort()).toEqual(['p', 'u']);
    const noUser = createCommandLoader({ cwd: projectDir, home, disableUserCommands: true });
    expect((await noUser.list()).map((c) => c.name)).toEqual(['p']);
    const noProject = createCommandLoader({
      cwd: projectDir,
      home,
      disableProjectCommands: true,
    });
    expect((await noProject.list()).map((c) => c.name)).toEqual(['u']);
  });
});

describe('createCommandLoader — resolve', () => {
  async function setupSimple(): Promise<string> {
    await mkdir(join(ROOT, '.git'), { recursive: true });
    await writeCommand(
      join(ROOT, '.claude', 'commands'),
      'echo.md',
      '---\ndescription: echo\n---\nfirst=$1 all=$ARGUMENTS',
    );
    return ROOT;
  }

  it('returns undefined for an unknown command', async () => {
    await setupSimple();
    const loader = createCommandLoader({ cwd: ROOT, home: '/nonexistent-home' });
    expect(await loader.resolve('does-not-exist')).toBeUndefined();
  });

  it('returns undefined when the input is empty/whitespace', async () => {
    await setupSimple();
    const loader = createCommandLoader({ cwd: ROOT, home: '/nonexistent-home' });
    expect(await loader.resolve('')).toBeUndefined();
    expect(await loader.resolve('   ')).toBeUndefined();
  });

  it('resolves a bare command with no args', async () => {
    await setupSimple();
    const loader = createCommandLoader({ cwd: ROOT, home: '/nonexistent-home' });
    const got = await loader.resolve('echo');
    expect(got).toBeDefined();
    expect(got!.name).toBe('echo');
    expect(got!.args).toEqual([]);
    expect(got!.body).toBe('first= all=');
  });

  it('resolves positional args via shell-style splitting', async () => {
    await setupSimple();
    const loader = createCommandLoader({ cwd: ROOT, home: '/nonexistent-home' });
    const got = await loader.resolve('echo bar baz');
    expect(got!.args).toEqual(['bar', 'baz']);
    expect(got!.body).toBe('first=bar all=bar baz');
  });

  it('groups quoted arg tokens', async () => {
    await setupSimple();
    const loader = createCommandLoader({ cwd: ROOT, home: '/nonexistent-home' });
    const got = await loader.resolve('echo "a b" c');
    expect(got!.args).toEqual(['a b', 'c']);
    expect(got!.body).toBe('first=a b all=a b c');
  });

  it('substitutes named bindings from the resolve context', async () => {
    await mkdir(join(ROOT, '.git'), { recursive: true });
    await writeCommand(join(ROOT, '.claude', 'commands'), 'named.md', 'hello $who from $where');
    const loader = createCommandLoader({ cwd: ROOT, home: '/nonexistent-home' });
    const got = await loader.resolve('named', {
      named: { who: 'alice', where: 'earth' },
    });
    expect(got!.body).toBe('hello alice from earth');
  });

  it('propagates disableSkillShellExecution into substitution', async () => {
    await mkdir(join(ROOT, '.git'), { recursive: true });
    await writeCommand(join(ROOT, '.claude', 'commands'), 'shellish.md', 'before !`echo hi` after');
    const loader = createCommandLoader({
      cwd: ROOT,
      home: '/nonexistent-home',
      disableSkillShellExecution: true,
    });
    const got = await loader.resolve('shellish');
    expect(got!.body).toContain('[shell command execution disabled by policy]');
    expect(got!.body).not.toContain('hi');
  });

  it('threads sessionId / userConfig / env / cwd / signal through to substitution', async () => {
    await mkdir(join(ROOT, '.git'), { recursive: true });
    await writeCommand(
      join(ROOT, '.claude', 'commands'),
      'vars.md',
      'session=${CLAUDE_SESSION_ID} cfg=${user_config.tier} env=${MY_ENV}',
    );
    const loader = createCommandLoader({ cwd: ROOT, home: '/nonexistent-home' });
    const ac = new AbortController();
    const got = await loader.resolve('vars', {
      sessionId: 'sess-1',
      userConfig: { tier: 'gold' },
      env: { MY_ENV: 'production' },
      signal: ac.signal,
      cwd: ROOT,
    });
    expect(got!.body).toBe('session=sess-1 cfg=gold env=production');
  });

  it('resolves namespaced commands by qualified name', async () => {
    await mkdir(join(ROOT, '.git'), { recursive: true });
    await writeCommand(join(ROOT, '.claude', 'commands'), 'git/commit.md', 'commit body');
    const loader = createCommandLoader({ cwd: ROOT, home: '/nonexistent-home' });
    const got = await loader.resolve('git:commit');
    expect(got).toBeDefined();
    expect(got!.body).toBe('commit body');
  });
});

describe('createCommandLoader — converged menu (opencode pattern)', () => {
  it('folds skills into the listing as source:"skill" when skillLoader is supplied', async () => {
    // Project root has one command.
    await mkdir(join(ROOT, '.git'), { recursive: true });
    await writeCommand(
      join(ROOT, '.claude', 'commands'),
      'cmd-only.md',
      '---\ndescription: i am a command\n---\nbody',
    );
    // And one skill under .claude/skills/<name>/SKILL.md.
    const skillDir = join(ROOT, '.claude', 'skills', 'skill-only');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: skill-only\ndescription: i am a skill\n---\nskill body',
      'utf8',
    );
    const skillLoader = createSkillLoader({ cwd: ROOT, home: '/nonexistent-home' });
    const cmdLoader = createCommandLoader({
      cwd: ROOT,
      home: '/nonexistent-home',
      skillLoader,
    });
    const list = await cmdLoader.list();
    expect(list.map((c) => `${c.name}:${c.source}`).sort()).toEqual([
      'cmd-only:project',
      'skill-only:skill',
    ]);
  });

  it('propagates argumentHint from the underlying skill', async () => {
    await mkdir(join(ROOT, '.git'), { recursive: true });
    const skillDir = join(ROOT, '.claude', 'skills', 'with-hint');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: with-hint\ndescription: x\nargument-hint: <issue>\n---\nbody',
      'utf8',
    );
    const skillLoader = createSkillLoader({ cwd: ROOT, home: '/nonexistent-home' });
    const cmdLoader = createCommandLoader({
      cwd: ROOT,
      home: '/nonexistent-home',
      skillLoader,
    });
    const list = await cmdLoader.list();
    expect(list[0]).toMatchObject({ source: 'skill', argumentHint: '<issue>' });
  });

  it('folded skills omit description/argumentHint when the skill frontmatter does not set them', async () => {
    await mkdir(join(ROOT, '.git'), { recursive: true });
    const skillDir = join(ROOT, '.claude', 'skills', 'minimal');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: minimal\n---\nbody', 'utf8');
    const skillLoader = createSkillLoader({ cwd: ROOT, home: '/nonexistent-home' });
    const cmdLoader = createCommandLoader({
      cwd: ROOT,
      home: '/nonexistent-home',
      skillLoader,
    });
    const list = await cmdLoader.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'minimal', source: 'skill' });
    expect(list[0]!.description).toBeUndefined();
    expect(list[0]!.argumentHint).toBeUndefined();
  });

  it('command wins when the same qualified name exists as both', async () => {
    await mkdir(join(ROOT, '.git'), { recursive: true });
    await writeCommand(
      join(ROOT, '.claude', 'commands'),
      'twin.md',
      '---\ndescription: command-wins\n---\ncmd body',
    );
    const skillDir = join(ROOT, '.claude', 'skills', 'twin');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: twin\ndescription: skill-loses\n---\nskill body',
      'utf8',
    );
    const skillLoader = createSkillLoader({ cwd: ROOT, home: '/nonexistent-home' });
    const cmdLoader = createCommandLoader({
      cwd: ROOT,
      home: '/nonexistent-home',
      skillLoader,
    });
    const list = await cmdLoader.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      name: 'twin',
      source: 'project',
      description: 'command-wins',
    });
  });

  it('list() is cached across calls', async () => {
    await mkdir(join(ROOT, '.git'), { recursive: true });
    await writeCommand(join(ROOT, '.claude', 'commands'), 'one.md', 'body');
    const loader = createCommandLoader({ cwd: ROOT, home: '/nonexistent-home' });
    const a = await loader.list();
    // Add a new file AFTER the first list() call — the cache should NOT pick it up.
    await writeCommand(join(ROOT, '.claude', 'commands'), 'two.md', 'body');
    const b = await loader.list();
    expect(a.map((c) => c.name)).toEqual(['one']);
    expect(b.map((c) => c.name)).toEqual(['one']);
  });
});
