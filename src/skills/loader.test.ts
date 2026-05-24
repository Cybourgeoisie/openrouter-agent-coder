import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSkillLoader,
  loadSkills,
  parseSkillFile,
  parseYamlFrontmatter,
  normalizeFrontmatterKeys,
  splitShellArgs,
  MAX_PROJECT_WALK_DEPTH,
} from './loader.js';

let ROOT: string;

beforeEach(async () => {
  ROOT = await mkdtemp(join(tmpdir(), 'skill-loader-test-'));
});

afterEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

async function writeSkill(
  baseDir: string,
  name: string,
  yaml: string,
  body: string,
): Promise<void> {
  const dir = join(baseDir, name);
  await mkdir(dir, { recursive: true });
  const content = `---\n${yaml}\n---\n${body}`;
  await writeFile(join(dir, 'SKILL.md'), content, 'utf8');
}

describe('parseYamlFrontmatter', () => {
  it('parses scalar key/value pairs', () => {
    expect(parseYamlFrontmatter('name: foo\ndescription: bar')).toEqual({
      name: 'foo',
      description: 'bar',
    });
  });

  it('parses inline arrays', () => {
    expect(parseYamlFrontmatter('paths: [a, b, c]')).toEqual({ paths: ['a', 'b', 'c'] });
  });

  it('parses empty inline arrays', () => {
    expect(parseYamlFrontmatter('paths: []')).toEqual({ paths: [] });
  });

  it('parses inline arrays with quoted strings', () => {
    expect(parseYamlFrontmatter('paths: ["a, b", "c"]')).toEqual({ paths: ['a, b', 'c'] });
  });

  it('parses block lists', () => {
    expect(parseYamlFrontmatter('arguments:\n  - foo\n  - bar')).toEqual({
      arguments: ['foo', 'bar'],
    });
  });

  it('parses nested maps', () => {
    expect(parseYamlFrontmatter('metadata:\n  author: me\n  ver: 1\n\n  blank: ok')).toEqual({
      metadata: { author: 'me', ver: 1, blank: 'ok' },
    });
  });

  it('parses literal-style block scalar (|)', () => {
    expect(parseYamlFrontmatter('description: |\n  line one\n  line two')).toEqual({
      description: 'line one\nline two',
    });
  });

  it('parses folded-style block scalar (>)', () => {
    expect(parseYamlFrontmatter('description: >\n  line one\n  line two')).toEqual({
      description: 'line one line two',
    });
  });

  it('parses booleans, numbers, nulls, and quoted strings', () => {
    expect(
      parseYamlFrontmatter(
        [
          'flag: true',
          'fl2: yes',
          'no2: no',
          'count: 7',
          'pi: 3.14',
          'nope: null',
          'quoted: "with: colon"',
        ].join('\n'),
      ),
    ).toEqual({
      flag: true,
      fl2: true,
      no2: false,
      count: 7,
      pi: 3.14,
      nope: null,
      quoted: 'with: colon',
    });
  });

  it('skips comment lines and blank lines', () => {
    expect(parseYamlFrontmatter('# leading comment\nname: foo\n\n# tail\n  indent-only')).toEqual({
      name: 'foo',
    });
  });

  it('treats empty value as empty string', () => {
    // A blank value with nothing nested → ''
    expect(parseYamlFrontmatter('name: foo\nbarrier:\n')).toEqual({ name: 'foo', barrier: '' });
  });

  it('throws on a malformed line', () => {
    expect(() => parseYamlFrontmatter('not a key')).toThrow(/no colon/);
  });

  it('throws on malformed nested key', () => {
    expect(() => parseYamlFrontmatter('metadata:\n  bad line no colon')).toThrow(/nested/);
  });
});

describe('normalizeFrontmatterKeys', () => {
  it('rewrites kebab-case → camelCase', () => {
    expect(normalizeFrontmatterKeys({ 'when-to-use': 'X', 'argument-hint': 'Y' })).toEqual({
      whenToUse: 'X',
      argumentHint: 'Y',
    });
  });

  it('accepts arguments as a space-separated string OR a list', () => {
    expect(normalizeFrontmatterKeys({ arguments: 'a b' })).toEqual({ arguments: ['a', 'b'] });
    expect(normalizeFrontmatterKeys({ arguments: ['a', 'b'] })).toEqual({ arguments: ['a', 'b'] });
  });

  it('accepts paths as comma-separated OR a list', () => {
    expect(normalizeFrontmatterKeys({ paths: 'a,b,c' })).toEqual({ paths: ['a', 'b', 'c'] });
    expect(normalizeFrontmatterKeys({ paths: ['a'] })).toEqual({ paths: ['a'] });
  });

  it('joins allowed-tools list into a single string', () => {
    expect(normalizeFrontmatterKeys({ 'allowed-tools': ['Bash(git:*)', 'Read'] })).toEqual({
      allowedTools: 'Bash(git:*) Read',
    });
  });
});

describe('parseSkillFile', () => {
  it('parses a minimal SKILL.md', () => {
    const raw = '---\nname: foo\ndescription: hi\n---\nbody text';
    const { frontmatter, body } = parseSkillFile(raw, 'foo');
    expect(frontmatter.name).toBe('foo');
    expect(frontmatter.description).toBe('hi');
    expect(body).toBe('body text');
  });

  it('accepts a BOM-prefixed file', () => {
    const raw = '﻿---\nname: foo\n---\nbody';
    const { frontmatter, body } = parseSkillFile(raw, 'foo');
    expect(frontmatter.name).toBe('foo');
    expect(body).toBe('body');
  });

  it('rejects when dir name does not match', () => {
    const raw = '---\nname: foo\n---\nbody';
    expect(() => parseSkillFile(raw, 'bar')).toThrow(/parent directory/);
  });

  it('rejects bad frontmatter (zod validation failure)', () => {
    const raw = '---\nname: BadName\n---\nbody';
    expect(() => parseSkillFile(raw, 'BadName')).toThrow(/validation failed/);
  });

  it('throws when frontmatter block is missing the closing fence', () => {
    const raw = '---\nname: foo\nbody no fence';
    expect(() => parseSkillFile(raw, 'foo')).toThrow(/closing/);
  });

  it('throws when there is no frontmatter block', () => {
    const raw = '# no frontmatter\njust body';
    expect(() => parseSkillFile(raw, 'foo')).toThrow(/missing YAML frontmatter/);
  });

  it('treats a file with only the opening fence (no newline after) as missing frontmatter', () => {
    // `---` with no trailing newline → splitFrontmatter returns yaml: null.
    expect(() => parseSkillFile('---', 'foo')).toThrow(/missing YAML frontmatter/);
  });
});

describe('createSkillLoader — discovery', () => {
  it('finds project-scope skills under .claude/skills/', async () => {
    await mkdir(join(ROOT, '.git'), { recursive: true });
    await writeSkill(
      join(ROOT, '.claude', 'skills'),
      'project-skill',
      'name: project-skill\ndescription: a project skill',
      'body',
    );
    const loader = createSkillLoader({ cwd: ROOT, home: join(ROOT, 'no-home') });
    const list = await loader.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe('project-skill');
    expect(list[0]!.source).toBe('project');
  });

  it('finds user-scope skills under <home>/.claude/skills/', async () => {
    const fakeHome = join(ROOT, 'home');
    await mkdir(fakeHome, { recursive: true });
    await writeSkill(
      join(fakeHome, '.claude', 'skills'),
      'user-skill',
      'name: user-skill',
      'user body',
    );
    const loader = createSkillLoader({ cwd: ROOT, home: fakeHome });
    const list = await loader.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe('user-skill');
    expect(list[0]!.source).toBe('user');
  });

  it('user scope overrides project scope on name collision', async () => {
    const fakeHome = join(ROOT, 'home');
    await mkdir(join(ROOT, '.git'), { recursive: true });
    await writeSkill(
      join(ROOT, '.claude', 'skills'),
      'shared',
      'name: shared\ndescription: project',
      'PROJ',
    );
    await writeSkill(
      join(fakeHome, '.claude', 'skills'),
      'shared',
      'name: shared\ndescription: user',
      'USER',
    );
    const loader = createSkillLoader({ cwd: ROOT, home: fakeHome });
    const skill = await loader.get('shared');
    expect(skill?.source).toBe('user');
    expect(skill?.body).toBe('USER');
  });

  it('namespaces plugin skills as <plugin>:<name>', async () => {
    const pluginRoot = join(ROOT, 'plugins', 'myplug');
    await writeSkill(join(pluginRoot, 'skills'), 'do-it', 'name: do-it', 'body');
    const loader = createSkillLoader({
      cwd: ROOT,
      home: join(ROOT, 'no-home'),
      pluginRoots: [{ name: 'myplug', root: pluginRoot }],
    });
    const list = await loader.list();
    expect(list[0]!.name).toBe('myplug:do-it');
    expect(list[0]!.source).toBe('plugin');
    expect(list[0]!.pluginName).toBe('myplug');
  });

  it('skips skills with malformed frontmatter, logging at warn', async () => {
    const logs: Array<{ level: string; msg: string }> = [];
    await mkdir(join(ROOT, '.git'), { recursive: true });
    await writeSkill(join(ROOT, '.claude', 'skills'), 'bad', 'name: BadName', 'body');
    await writeSkill(join(ROOT, '.claude', 'skills'), 'good', 'name: good', 'body');
    const loader = createSkillLoader({
      cwd: ROOT,
      home: join(ROOT, 'no-home'),
      logger: (level, msg) => logs.push({ level, msg }),
    });
    const list = await loader.list();
    expect(list.map((s) => s.name)).toEqual(['good']);
    expect(logs.some((l) => l.level === 'warn' && /invalid frontmatter/.test(l.msg))).toBe(true);
  });

  it('returns empty when no skills are present', async () => {
    const loader = createSkillLoader({ cwd: ROOT, home: join(ROOT, 'no-home') });
    expect(await loader.list()).toEqual([]);
  });

  it('caches the listing across repeated list() calls', async () => {
    await mkdir(join(ROOT, '.git'), { recursive: true });
    await writeSkill(join(ROOT, '.claude', 'skills'), 'cached', 'name: cached', 'body');
    const loader = createSkillLoader({ cwd: ROOT, home: join(ROOT, 'no-home') });
    const a = await loader.list();
    const b = await loader.list();
    expect(a).toEqual(b);
  });

  it('caps the walk-up at MAX_PROJECT_WALK_DEPTH (no infinite climb)', () => {
    // Documentation/regression hook — the constant must remain at the
    // documented ceiling so the discovery walk never tries to climb past
    // a deep filesystem when no `.git` is found.
    expect(MAX_PROJECT_WALK_DEPTH).toBe(10);
  });
});

describe('SkillLoader.render', () => {
  it('substitutes ${CLAUDE_SKILL_DIR} from the discovered skill location', async () => {
    await mkdir(join(ROOT, '.git'), { recursive: true });
    await writeSkill(
      join(ROOT, '.claude', 'skills'),
      'show',
      'name: show',
      'dir=${CLAUDE_SKILL_DIR}',
    );
    const loader = createSkillLoader({ cwd: ROOT, home: join(ROOT, 'no-home') });
    const out = await loader.render('show', {
      arguments: [],
      sessionId: 's',
      projectDir: ROOT,
    });
    expect(out).toContain(join(ROOT, '.claude', 'skills', 'show'));
  });

  it('respects an explicit skillDir on the substitution context', async () => {
    await mkdir(join(ROOT, '.git'), { recursive: true });
    await writeSkill(
      join(ROOT, '.claude', 'skills'),
      'pinned',
      'name: pinned',
      '${CLAUDE_SKILL_DIR}',
    );
    const loader = createSkillLoader({ cwd: ROOT, home: join(ROOT, 'no-home') });
    const out = await loader.render('pinned', {
      arguments: [],
      sessionId: 's',
      projectDir: ROOT,
      skillDir: '/explicit/override',
    });
    expect(out).toBe('/explicit/override');
  });

  it('throws when the skill is unknown', async () => {
    const loader = createSkillLoader({ cwd: ROOT, home: join(ROOT, 'no-home') });
    await expect(
      loader.render('missing', { arguments: [], sessionId: 's', projectDir: ROOT }),
    ).rejects.toThrow(/skill not found/);
  });
});

describe('createSkillLoader — option toggles', () => {
  it('disableProjectSkills skips the project walk entirely', async () => {
    await mkdir(join(ROOT, '.git'), { recursive: true });
    await writeSkill(join(ROOT, '.claude', 'skills'), 'proj-only', 'name: proj-only', 'body');
    const loader = createSkillLoader({
      cwd: ROOT,
      home: join(ROOT, 'no-home'),
      disableProjectSkills: true,
    });
    expect(await loader.list()).toEqual([]);
  });

  it('disableUserSkills skips the user walk', async () => {
    const fakeHome = join(ROOT, 'home');
    await writeSkill(join(fakeHome, '.claude', 'skills'), 'user-only', 'name: user-only', 'body');
    const loader = createSkillLoader({
      cwd: ROOT,
      home: fakeHome,
      disableUserSkills: true,
    });
    expect(await loader.list()).toEqual([]);
  });

  it('walks up to the first .git ancestor when project is in a subdir', async () => {
    const sub = join(ROOT, 'sub', 'nested');
    await mkdir(sub, { recursive: true });
    await mkdir(join(ROOT, '.git'), { recursive: true });
    await writeSkill(join(ROOT, '.claude', 'skills'), 'root-skill', 'name: root-skill', 'body');
    const loader = createSkillLoader({ cwd: sub, home: join(ROOT, 'no-home') });
    const list = await loader.list();
    expect(list.map((s) => s.name)).toEqual(['root-skill']);
  });

  it('skips SKILL.md entries that fail to read (warn-and-continue)', async () => {
    // Write a SKILL.md as a directory — read() will fail with EISDIR.
    await mkdir(join(ROOT, '.git'), { recursive: true });
    const dir = join(ROOT, '.claude', 'skills', 'broken');
    await mkdir(dir, { recursive: true });
    await mkdir(join(dir, 'SKILL.md'), { recursive: true });
    const logs: Array<{ level: string; msg: string }> = [];
    const loader = createSkillLoader({
      cwd: ROOT,
      home: join(ROOT, 'no-home'),
      logger: (level, msg) => logs.push({ level, msg }),
    });
    expect(await loader.list()).toEqual([]);
    expect(logs.some((l) => /failed to read/.test(l.msg))).toBe(true);
  });

  it('skips skill subdirs without a SKILL.md', async () => {
    await mkdir(join(ROOT, '.git'), { recursive: true });
    await mkdir(join(ROOT, '.claude', 'skills', 'empty-dir'), { recursive: true });
    const loader = createSkillLoader({ cwd: ROOT, home: join(ROOT, 'no-home') });
    expect(await loader.list()).toEqual([]);
  });
});

describe('splitShellArgs', () => {
  it('splits on whitespace', () => {
    expect(splitShellArgs('a b c')).toEqual(['a', 'b', 'c']);
  });

  it('respects double quotes', () => {
    expect(splitShellArgs('a "b c" d')).toEqual(['a', 'b c', 'd']);
  });

  it('respects single quotes', () => {
    expect(splitShellArgs("a 'b c'")).toEqual(['a', 'b c']);
  });

  it('handles empty input', () => {
    expect(splitShellArgs('')).toEqual([]);
  });

  it('tolerates unterminated quotes (no throw)', () => {
    expect(splitShellArgs('a "b c')).toEqual(['a', 'b c']);
  });

  it('honors backslash escapes for the matching quote', () => {
    // `\\"` inside a double-quoted run yields a literal `"`.
    expect(splitShellArgs('"a\\"b"')).toEqual(['a"b']);
    expect(splitShellArgs("'a\\'b'")).toEqual(["a'b"]);
  });

  it('collapses runs of whitespace between args', () => {
    expect(splitShellArgs('  a   b\t\tc  ')).toEqual(['a', 'b', 'c']);
  });
});

describe('loadSkills', () => {
  it('is a one-shot wrapper around createSkillLoader().list()', async () => {
    await mkdir(join(ROOT, '.git'), { recursive: true });
    await writeSkill(join(ROOT, '.claude', 'skills'), 'one', 'name: one', 'body');
    const list = await loadSkills({ cwd: ROOT, home: join(ROOT, 'no-home') });
    expect(list).toHaveLength(1);
  });
});

describe('SkillLoader.watch', () => {
  it('is a no-op stub that returns a disposer', () => {
    const loader = createSkillLoader({ cwd: ROOT, home: join(ROOT, 'no-home') });
    const dispose = loader.watch(() => undefined);
    expect(typeof dispose).toBe('function');
    expect(() => dispose()).not.toThrow();
  });
});
