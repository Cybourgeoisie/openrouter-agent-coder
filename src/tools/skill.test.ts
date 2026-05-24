import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  skillTool,
  splitAllowedTools,
  buildSkillListing,
  type ActiveSkillContext,
  type SkillToolResult,
} from './skill.js';
import { createSkillLoader, type SkillLoader } from '../skills/loader.js';
import type { SkillInfo } from '../skills/spec.js';
import type { SubstitutionContext } from '../skills/substitution.js';

let ROOT: string;

beforeEach(async () => {
  ROOT = await mkdtemp(join(tmpdir(), 'skill-tool-test-'));
});

afterEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

async function writeSkill(name: string, yaml: string, body: string): Promise<void> {
  await mkdir(join(ROOT, '.git'), { recursive: true });
  const dir = join(ROOT, '.claude', 'skills', name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), `---\n${yaml}\n---\n${body}`, 'utf8');
}

function buildSubstitution(args: readonly string[]): SubstitutionContext {
  return { arguments: args, sessionId: 's', projectDir: ROOT };
}

async function buildLoader(): Promise<SkillLoader> {
  return createSkillLoader({ cwd: ROOT, home: join(ROOT, 'no-home') });
}

describe('splitAllowedTools', () => {
  it('splits on whitespace', () => {
    expect(splitAllowedTools('Read Write')).toEqual(['Read', 'Write']);
  });

  it('keeps parenthesised patterns atomic', () => {
    expect(splitAllowedTools('Bash(git status) Read')).toEqual(['Bash(git status)', 'Read']);
  });

  it('handles trailing whitespace', () => {
    expect(splitAllowedTools('  Read   Write  ')).toEqual(['Read', 'Write']);
  });
});

describe('buildSkillListing', () => {
  function fakeSkill(name: string, source: SkillInfo['source'], description?: string): SkillInfo {
    return {
      name,
      source,
      location: '/fake',
      frontmatter: {
        name,
        ...(description !== undefined && { description }),
      },
      body: '',
    };
  }

  it('produces an empty string for no skills', () => {
    expect(buildSkillListing([], 1024)).toBe('');
  });

  it('omits disableModelInvocation skills', () => {
    const skills: SkillInfo[] = [
      {
        name: 'hidden',
        source: 'project',
        location: '/x',
        frontmatter: { name: 'hidden', disableModelInvocation: true },
        body: '',
      },
    ];
    expect(buildSkillListing(skills, 1024)).toBe('');
  });

  it('drops lowest-priority entries to stay under budget', () => {
    const longA = 'a'.repeat(60);
    const longB = 'b'.repeat(60);
    const skills: SkillInfo[] = [
      fakeSkill('keep', 'user', longA),
      fakeSkill('drop', 'project', longB),
    ];
    // 80 chars fits one ~70-char entry but not two. Project entry drops.
    const listing = buildSkillListing(skills, 80);
    expect(listing).toContain('keep');
    expect(listing).not.toContain('drop');
  });

  it('returns empty when budget cannot fit even the highest-precedence entry', () => {
    // budgetChars: 1 forces the drop loop to evict every entry. kept === 0
    // branch returns '' so no `## Available Skills` header is emitted.
    const skills: SkillInfo[] = [fakeSkill('a', 'user', 'whatever')];
    expect(buildSkillListing(skills, 1)).toBe('');
  });

  it('sorts by source precedence then alphabetically', () => {
    const skills: SkillInfo[] = [
      fakeSkill('z-user', 'user'),
      fakeSkill('a-project', 'project'),
      fakeSkill('a-user', 'user'),
    ];
    const listing = buildSkillListing(skills, 1024);
    const lines = listing.split('\n').filter((l) => l.startsWith('-'));
    expect(lines[0]).toContain('a-user');
    expect(lines[1]).toContain('z-user');
    expect(lines[2]).toContain('a-project');
  });
});

describe('skillTool — execute', () => {
  it('returns the rendered body for an inline-context skill', async () => {
    await writeSkill('do-stuff', 'name: do-stuff', 'BODY $1');
    const loader = await buildLoader();
    const tool = skillTool({ loader, buildContext: buildSubstitution });
    const exec = (tool.function as { execute: (i: unknown) => Promise<unknown> }).execute;
    const out = (await exec({ name: 'do-stuff', arguments: 'hello' })) as SkillToolResult;
    expect(out.name).toBe('do-stuff');
    expect(out.content).toBe('BODY hello');
    expect(out.error).toBeUndefined();
  });

  it('returns an error envelope for unknown skill names', async () => {
    const loader = await buildLoader();
    const tool = skillTool({ loader, buildContext: buildSubstitution });
    const exec = (tool.function as { execute: (i: unknown) => Promise<unknown> }).execute;
    const out = (await exec({ name: 'nope' })) as SkillToolResult;
    expect(out.error).toBe('unknown skill');
    expect(out.content).toContain('skill not found');
  });

  it('fires onSkillLoaded for successful renders', async () => {
    await writeSkill('audit', 'name: audit', 'OK');
    const loader = await buildLoader();
    const loaded: string[] = [];
    const tool = skillTool({
      loader,
      buildContext: buildSubstitution,
      onSkillLoaded: (s) => {
        loaded.push(s.name);
      },
    });
    const exec = (tool.function as { execute: (i: unknown) => Promise<unknown> }).execute;
    await exec({ name: 'audit' });
    expect(loaded).toEqual(['audit']);
  });

  it('installs and disposes ActiveSkillContext around the render', async () => {
    await writeSkill('locked', 'name: locked\nallowed-tools: Bash(git:*) Read', 'BODY');
    const loader = await buildLoader();
    let active: ActiveSkillContext | undefined;
    const seen: ActiveSkillContext[] = [];
    const tool = skillTool({
      loader,
      buildContext: buildSubstitution,
      onSkillActive: (cx) => {
        active = cx;
        seen.push(cx);
        return () => {
          active = undefined;
        };
      },
    });
    const exec = (tool.function as { execute: (i: unknown) => Promise<unknown> }).execute;
    await exec({ name: 'locked' });
    expect(active).toBeUndefined(); // disposer ran
    expect(seen).toHaveLength(1);
    expect(seen[0]!.name).toBe('locked');
    expect(seen[0]!.allowedToolsNarrowing).toEqual(['Bash(git:*)', 'Read']);
  });

  it('routes context:fork through the runSubagent runner', async () => {
    await writeSkill('forked', 'name: forked\ncontext: fork', 'PROMPT $1');
    const loader = await buildLoader();
    let receivedPrompt = '';
    const tool = skillTool({
      loader,
      buildContext: buildSubstitution,
      runSubagent: async (cfg) => {
        receivedPrompt = cfg.prompt;
        return { status: 'success', text: 'sub-output' };
      },
    });
    const exec = (tool.function as { execute: (i: unknown) => Promise<unknown> }).execute;
    const out = (await exec({ name: 'forked', arguments: 'hi' })) as SkillToolResult;
    expect(receivedPrompt).toBe('PROMPT hi');
    expect(out.content).toBe('sub-output');
    expect(out.subagentSessionId).toMatch(/skill:/);
  });

  it('falls back to inline render when context:fork is set but no runner is wired', async () => {
    await writeSkill('forked-no-runner', 'name: forked-no-runner\ncontext: fork', 'INLINE $1');
    const loader = await buildLoader();
    const tool = skillTool({ loader, buildContext: buildSubstitution });
    const exec = (tool.function as { execute: (i: unknown) => Promise<unknown> }).execute;
    const out = (await exec({ name: 'forked-no-runner', arguments: 'x' })) as SkillToolResult;
    expect(out.content).toBe('INLINE x');
    expect(out.error).toContain('runSubagent not wired');
  });

  it('falls back to general-purpose when frontmatter.agent is unknown', async () => {
    await writeSkill('mystery', 'name: mystery\ncontext: fork\nagent: never-heard-of-it', 'B');
    const loader = await buildLoader();
    const logs: Array<{ level: string; msg: string }> = [];
    const tool = skillTool({
      loader,
      buildContext: buildSubstitution,
      runSubagent: async () => ({ status: 'success', text: 'ok' }),
      knownSubagentTypes: ['general-purpose'],
      logger: (level, msg) => logs.push({ level, msg }),
    });
    const exec = (tool.function as { execute: (i: unknown) => Promise<unknown> }).execute;
    await exec({ name: 'mystery' });
    expect(logs.some((l) => /unknown agent type/.test(l.msg))).toBe(true);
  });

  it('surfaces a subagent runner throw as an error envelope', async () => {
    await writeSkill('crash', 'name: crash\ncontext: fork', 'B');
    const loader = await buildLoader();
    const tool = skillTool({
      loader,
      buildContext: buildSubstitution,
      runSubagent: async () => {
        throw new Error('boom');
      },
    });
    const exec = (tool.function as { execute: (i: unknown) => Promise<unknown> }).execute;
    const out = (await exec({ name: 'crash' })) as SkillToolResult;
    expect(out.error).toBe('boom');
    expect(out.content).toContain('subagent threw');
  });

  it('reports non-success subagent status via the error envelope', async () => {
    await writeSkill('partial', 'name: partial\ncontext: fork', 'B');
    const loader = await buildLoader();
    const tool = skillTool({
      loader,
      buildContext: buildSubstitution,
      runSubagent: async () => ({ status: 'max_turns', text: 'partial', reason: 'cap' }),
    });
    const exec = (tool.function as { execute: (i: unknown) => Promise<unknown> }).execute;
    const out = (await exec({ name: 'partial' })) as SkillToolResult;
    expect(out.error).toBe('cap');
    expect(out.content).toBe('partial');
  });

  it('returns an error envelope when the render throws (e.g. shell error)', async () => {
    await writeSkill('rend-fail', 'name: rend-fail', 'BODY');
    const loader = await buildLoader();
    const tool = skillTool({
      loader,
      buildContext: () => {
        // Throw from buildContext to simulate a render-time failure.
        throw new Error('substitution boom');
      },
    });
    const exec = (tool.function as { execute: (i: unknown) => Promise<unknown> }).execute;
    const out = (await exec({ name: 'rend-fail' })) as SkillToolResult;
    expect(out.error).toBe('substitution boom');
    expect(out.content).toContain('render failed');
  });
});

describe('buildSkillListing — listing entry shape', () => {
  it('renders entries with `when_to_use` appended when description is also present', () => {
    const out = buildSkillListing(
      [
        {
          name: 'have-both',
          source: 'project',
          location: '/x',
          frontmatter: { name: 'have-both', description: 'desc', whenToUse: 'use it' },
          body: '',
        },
      ],
      1024,
    );
    expect(out).toContain('desc — when to use: use it');
  });

  it('renders entries with only `when_to_use` when description is missing', () => {
    const out = buildSkillListing(
      [
        {
          name: 'when-only',
          source: 'project',
          location: '/x',
          frontmatter: { name: 'when-only', whenToUse: 'standalone' },
          body: '',
        },
      ],
      1024,
    );
    expect(out).toContain('when to use: standalone');
    // No leading em-dash before "when to use" when description is empty.
    expect(out).toMatch(/- `when-only` — when to use: standalone/);
  });

  it('renders bare name when neither description nor when_to_use is set', () => {
    const out = buildSkillListing(
      [
        {
          name: 'bare',
          source: 'project',
          location: '/x',
          frontmatter: { name: 'bare' },
          body: '',
        },
      ],
      1024,
    );
    expect(out).toMatch(/- `bare`$/m);
  });
});
