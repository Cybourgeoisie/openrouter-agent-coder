import { describe, it, expect } from 'vitest';
import { pluginManifestSchema, PLUGIN_NAME_REGEX, PLUGIN_DEFAULT_PATHS } from './spec.js';

describe('pluginManifestSchema', () => {
  it('accepts a manifest with only `name`', () => {
    const result = pluginManifestSchema.safeParse({ name: 'code-review' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('code-review');
    }
  });

  it('rejects manifest missing `name`', () => {
    const result = pluginManifestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects invalid `name` (uppercase / underscore / trailing hyphen)', () => {
    for (const bad of ['Foo', 'foo_bar', 'foo-', '-foo', '']) {
      const result = pluginManifestSchema.safeParse({ name: bad });
      expect(result.success).toBe(false);
    }
  });

  it('accepts a full manifest matching the docs reference', () => {
    const result = pluginManifestSchema.safeParse({
      name: 'security-guidance',
      version: '1.0.0',
      description: 'Security reminder hooks',
      author: { name: 'Boris', email: 'b@anthropic.com' },
      skills: ['extras/skills'],
      commands: 'extras/commands',
      hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [] }] },
      mcpServers: { foo: { command: 'node' } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skills).toEqual(['extras/skills']);
      expect(result.data.commands).toBe('extras/commands');
    }
  });

  it('accepts string `author`', () => {
    const result = pluginManifestSchema.safeParse({ name: 'foo', author: 'Anthropic <support>' });
    expect(result.success).toBe(true);
  });

  it('passes through unknown top-level keys (forward-compat)', () => {
    const result = pluginManifestSchema.safeParse({ name: 'foo', futureField: 'still-loads' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).futureField).toBe('still-loads');
    }
  });

  it('accepts v2-deferred fields (userConfig / dependencies / experimental)', () => {
    const result = pluginManifestSchema.safeParse({
      name: 'foo',
      userConfig: { apiKey: { type: 'string', sensitive: true } },
      dependencies: ['other-plugin', { name: 'pinned', version: '1.0' }],
      experimental: { themes: ['dark.json'], monitors: 'monitors/' },
    });
    expect(result.success).toBe(true);
  });

  it('PLUGIN_NAME_REGEX validates the same way the schema does', () => {
    expect(PLUGIN_NAME_REGEX.test('code-review')).toBe(true);
    expect(PLUGIN_NAME_REGEX.test('a')).toBe(true);
    expect(PLUGIN_NAME_REGEX.test('Foo')).toBe(false);
    expect(PLUGIN_NAME_REGEX.test('foo-')).toBe(false);
  });

  it('PLUGIN_DEFAULT_PATHS exposes the documented defaults', () => {
    expect(PLUGIN_DEFAULT_PATHS.skills).toBe('skills');
    expect(PLUGIN_DEFAULT_PATHS.commands).toBe('commands');
    expect(PLUGIN_DEFAULT_PATHS.hooks).toBe('hooks/hooks.json');
    expect(PLUGIN_DEFAULT_PATHS.mcpServers).toBe('.mcp.json');
  });
});
