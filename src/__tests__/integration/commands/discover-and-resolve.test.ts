/**
 * Phase 5.6 integration test — drives the public `createCommandLoader` surface
 * end-to-end on a real temp directory tree: project + user + plugin scopes
 * with subdir namespacing, then exercises {@link CommandLoader.list} and
 * {@link CommandLoader.resolve} against the discovered set.
 *
 * Mirrors the host-side wiring shown in the README: a CLI calls `resolve()`
 * with the raw `/`-line and feeds the resulting `body` straight into
 * `OpenRouterAgentRun({ prompt: resolved.body })`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCommandLoader, createSkillLoader } from '../../../index.js';

let ROOT: string;
let PROJECT: string;
let HOME: string;
let PLUGIN: string;

beforeAll(async () => {
  ROOT = await mkdtemp(join(tmpdir(), 'cmd-int-'));
  PROJECT = join(ROOT, 'project');
  HOME = join(ROOT, 'home');
  PLUGIN = join(ROOT, 'plugin');

  // .git boundary so the project walker stops at PROJECT.
  await mkdir(join(PROJECT, '.git'), { recursive: true });

  // Project commands (flat + subdir + converged-menu test fixture).
  await writeMd(
    join(PROJECT, '.claude', 'commands', 'review.md'),
    '---\ndescription: review pending diff\nargument-hint: <pr-number>\n---\nReviewing #$1',
  );
  await writeMd(
    join(PROJECT, '.claude', 'commands', 'git', 'commit.md'),
    '---\ndescription: open a commit\n---\ncommit body: $ARGUMENTS',
  );

  // User commands (one collides with project to prove project wins).
  await writeMd(join(HOME, '.claude', 'commands', 'mine.md'), 'body-only command from user scope');
  await writeMd(
    join(HOME, '.claude', 'commands', 'review.md'),
    '---\ndescription: from user (should LOSE)\n---\nshould not surface',
  );

  // Plugin commands (always namespaced).
  await writeMd(
    join(PLUGIN, 'commands', 'deploy.md'),
    '---\ndescription: deploy via plugin\n---\nplugin deploy body',
  );

  // A skill — only surfaces when skillLoader is wired into the command loader.
  const skillDir = join(PROJECT, '.claude', 'skills', 'autosearch');
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, 'SKILL.md'),
    '---\nname: autosearch\ndescription: a model-invokable skill\n---\nskill body',
    'utf8',
  );
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

async function writeMd(path: string, body: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, body, 'utf8');
}

describe('integration: command discovery + resolve', () => {
  it('discovers project + user + plugin commands with project>user precedence', async () => {
    const loader = createCommandLoader({
      cwd: PROJECT,
      home: HOME,
      pluginRoots: [{ name: 'acme', root: PLUGIN }],
    });
    const list = await loader.list();
    const byName = Object.fromEntries(list.map((c) => [c.name, c]));
    expect(byName['review']).toMatchObject({
      source: 'project',
      description: 'review pending diff',
      argumentHint: '<pr-number>',
    });
    expect(byName['git:commit']).toMatchObject({ source: 'project' });
    expect(byName['mine']).toMatchObject({ source: 'user' });
    expect(byName['acme:deploy']).toMatchObject({ source: 'plugin' });
    // Skill should NOT appear without skillLoader.
    expect(byName['autosearch']).toBeUndefined();
  });

  it('end-to-end resolve produces a substituted body ready for OpenRouterAgentRun', async () => {
    const loader = createCommandLoader({
      cwd: PROJECT,
      home: HOME,
      pluginRoots: [{ name: 'acme', root: PLUGIN }],
    });
    const got = await loader.resolve('review 137');
    expect(got).toBeDefined();
    expect(got!.name).toBe('review');
    expect(got!.args).toEqual(['137']);
    expect(got!.body).toBe('Reviewing #137');

    // Namespaced resolve.
    const nested = await loader.resolve('git:commit feat: foo');
    expect(nested).toBeDefined();
    expect(nested!.body).toContain('commit body: feat: foo');

    // Unknown command → undefined, not throw.
    expect(await loader.resolve('nope')).toBeUndefined();
  });

  it('converged menu surfaces skills as commands when skillLoader is wired in', async () => {
    const skillLoader = createSkillLoader({ cwd: PROJECT, home: HOME });
    const loader = createCommandLoader({
      cwd: PROJECT,
      home: HOME,
      pluginRoots: [{ name: 'acme', root: PLUGIN }],
      skillLoader,
    });
    const list = await loader.list();
    const skillEntry = list.find((c) => c.name === 'autosearch');
    expect(skillEntry).toMatchObject({
      source: 'skill',
      description: 'a model-invokable skill',
    });
  });
});
