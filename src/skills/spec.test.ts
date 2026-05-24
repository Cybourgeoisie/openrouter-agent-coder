import { describe, it, expect } from 'vitest';
import {
  SKILL_NAME_REGEX,
  skillFrontmatterSchema,
  MAX_DESCRIPTION_CHARS,
  MAX_WHEN_TO_USE_CHARS,
  MAX_COMPATIBILITY_CHARS,
} from './spec.js';

describe('SKILL_NAME_REGEX', () => {
  it.each([['a'], ['skill'], ['my-skill'], ['a1'], ['a'.repeat(64)], ['1abc-2']])(
    'accepts %s',
    (name) => {
      expect(SKILL_NAME_REGEX.test(name)).toBe(true);
    },
  );

  it.each([
    [''],
    ['A'],
    ['MyTool'],
    ['-skill'],
    ['skill-'],
    ['a'.repeat(65)],
    ['skill name'],
    ['skill_name'],
  ])('rejects %s', (name) => {
    expect(SKILL_NAME_REGEX.test(name)).toBe(false);
  });
});

describe('skillFrontmatterSchema', () => {
  it('accepts a minimal valid frontmatter', () => {
    const parsed = skillFrontmatterSchema.parse({ name: 'foo' });
    expect(parsed.name).toBe('foo');
  });

  it('rejects when name fails the regex', () => {
    const r = skillFrontmatterSchema.safeParse({ name: 'BadName' });
    expect(r.success).toBe(false);
  });

  it('rejects oversize description', () => {
    const r = skillFrontmatterSchema.safeParse({
      name: 'ok',
      description: 'x'.repeat(MAX_DESCRIPTION_CHARS + 1),
    });
    expect(r.success).toBe(false);
  });

  it('rejects oversize when_to_use', () => {
    const r = skillFrontmatterSchema.safeParse({
      name: 'ok',
      whenToUse: 'x'.repeat(MAX_WHEN_TO_USE_CHARS + 1),
    });
    expect(r.success).toBe(false);
  });

  it('rejects oversize compatibility', () => {
    const r = skillFrontmatterSchema.safeParse({
      name: 'ok',
      compatibility: 'x'.repeat(MAX_COMPATIBILITY_CHARS + 1),
    });
    expect(r.success).toBe(false);
  });

  it('accepts the full Claude Code extension surface', () => {
    const parsed = skillFrontmatterSchema.parse({
      name: 'do-it',
      description: 'desc',
      whenToUse: 'use when',
      license: 'MIT',
      compatibility: 'unix',
      metadata: { author: 'me' },
      allowedTools: 'Bash(git:*) Read',
      argumentHint: '[file]',
      arguments: ['file', 'flag'],
      disableModelInvocation: false,
      userInvocable: true,
      model: '~anthropic/claude-sonnet-latest',
      effort: 'high',
      context: 'fork',
      agent: 'general-purpose',
      paths: ['src/**'],
      shell: 'bash',
    });
    expect(parsed.context).toBe('fork');
    expect(parsed.effort).toBe('high');
  });

  it('passes through unknown fields without erroring', () => {
    const parsed = skillFrontmatterSchema.parse({
      name: 'ok',
      future_field: 42,
    });
    expect((parsed as Record<string, unknown>).future_field).toBe(42);
  });
});
