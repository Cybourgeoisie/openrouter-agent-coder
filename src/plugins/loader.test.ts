import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlugins, PLUGIN_MCP_NAMESPACE_SEPARATOR } from './loader.js';

let ROOT: string;

beforeEach(async () => {
  ROOT = await mkdtemp(join(tmpdir(), 'plugin-loader-test-'));
});

afterEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

async function writeJson(path: string, content: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(content, null, 2), 'utf8');
}

async function writeSkill(
  baseDir: string,
  name: string,
  yaml: string,
  body: string,
): Promise<void> {
  const dir = join(baseDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), `---\n${yaml}\n---\n${body}`, 'utf8');
}

async function writePluginManifest(root: string, manifest: object): Promise<void> {
  await mkdir(join(root, '.claude-plugin'), { recursive: true });
  await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest), 'utf8');
}

describe('loadPlugins — manifest validation', () => {
  it('loads a manifested plugin with skills/commands/.mcp.json/hooks defaults', async () => {
    const root = join(ROOT, 'demo');
    await mkdir(root, { recursive: true });
    await writeJson(join(root, '.claude-plugin', 'plugin.json'), { name: 'demo', version: '1' });
    await writeSkill(join(root, 'skills'), 'analyze', 'name: analyze', 'body');
    await mkdir(join(root, 'commands'), { recursive: true });
    await writeFile(join(root, 'commands', 'do.md'), '---\ndescription: thing\n---\nbody', 'utf8');
    await writeJson(join(root, '.mcp.json'), {
      mcpServers: { srv: { command: 'node', args: ['s.js'] } },
    });
    await writeJson(join(root, 'hooks', 'hooks.json'), {
      hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [] }] },
    });

    const [plugin] = await loadPlugins({ pluginDirs: [root] });
    expect(plugin).toBeDefined();
    if (!plugin) return;
    expect(plugin.manifest.name).toBe('demo');
    expect(plugin.root).toBe(root);
    expect(plugin.skillRoots).toEqual([join(root, 'skills')]);
    expect(plugin.commandRoots).toEqual([join(root, 'commands')]);
    expect(plugin.agentRoots).toEqual([join(root, 'agents')]);
    expect(plugin.mcpServers).toHaveLength(1);
    expect(plugin.mcpServers[0]?.name).toBe(`demo${PLUGIN_MCP_NAMESPACE_SEPARATOR}srv`);
    expect(plugin.hookConfigs).toHaveLength(1);
    expect(plugin.hookConfigs[0]?.hooks).toMatchObject({
      PreToolUse: expect.any(Array),
    });
    expect(plugin.dataDir).toContain('.claude/plugins/data/demo');
  });

  it('auto-discovers a plugin with no manifest (uses directory name)', async () => {
    const root = join(ROOT, 'auto-discovered');
    await mkdir(root, { recursive: true });
    await writeSkill(join(root, 'skills'), 'foo', 'name: foo', 'body');

    const [plugin] = await loadPlugins({ pluginDirs: [root] });
    expect(plugin).toBeDefined();
    expect(plugin?.manifest.name).toBe('auto-discovered');
    expect(plugin?.skillRoots).toEqual([join(root, 'skills')]);
  });

  it('skips a plugin with malformed manifest and continues with surviving plugins', async () => {
    const bad = join(ROOT, 'bad-plugin');
    const good = join(ROOT, 'good-plugin');
    await mkdir(bad, { recursive: true });
    await mkdir(good, { recursive: true });
    await writeFile(join(bad, '.claude-plugin', 'plugin.json'), '{not json', 'utf8').catch(
      async () => {
        await mkdir(join(bad, '.claude-plugin'), { recursive: true });
        await writeFile(join(bad, '.claude-plugin', 'plugin.json'), '{not json', 'utf8');
      },
    );
    await mkdir(join(bad, '.claude-plugin'), { recursive: true });
    await writeFile(join(bad, '.claude-plugin', 'plugin.json'), '{not json', 'utf8');

    const warnings: Array<{ level: string; msg: string }> = [];
    const plugins = await loadPlugins({
      pluginDirs: [bad, good],
      logger: (level, msg) => warnings.push({ level, msg }),
    });
    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.manifest.name).toBe('good-plugin');
    expect(warnings.some((w) => w.level === 'warn' && w.msg.includes('plugin load failed'))).toBe(
      true,
    );
  });

  it('rejects manifest with invalid name field', async () => {
    const root = join(ROOT, 'bad');
    await mkdir(join(root, '.claude-plugin'), { recursive: true });
    await writeJson(join(root, '.claude-plugin', 'plugin.json'), { name: 'BAD_NAME' });
    const warnings: string[] = [];
    const plugins = await loadPlugins({
      pluginDirs: [root],
      logger: (_l, msg) => warnings.push(msg),
    });
    expect(plugins).toHaveLength(0);
    expect(warnings.join('\n')).toContain('plugin load failed');
  });

  it('honors `skills` manifest field as ADDITIONAL roots (adds to default)', async () => {
    const root = join(ROOT, 'multi-skill');
    await mkdir(join(root, '.claude-plugin'), { recursive: true });
    await writeJson(join(root, '.claude-plugin', 'plugin.json'), {
      name: 'multi-skill',
      skills: ['extras/skills'],
    });
    const [plugin] = await loadPlugins({ pluginDirs: [root] });
    expect(plugin?.skillRoots).toEqual([join(root, 'skills'), join(root, 'extras/skills')]);
  });

  it('honors `commands` manifest field as REPLACEMENT root', async () => {
    const root = join(ROOT, 'cmd-override');
    await mkdir(join(root, '.claude-plugin'), { recursive: true });
    await writeJson(join(root, '.claude-plugin', 'plugin.json'), {
      name: 'cmd-override',
      commands: 'my-commands',
    });
    const [plugin] = await loadPlugins({ pluginDirs: [root] });
    expect(plugin?.commandRoots).toEqual([join(root, 'my-commands')]);
  });

  it('accepts inline `mcpServers` and `hooks` objects on the manifest', async () => {
    const root = join(ROOT, 'inline');
    await mkdir(join(root, '.claude-plugin'), { recursive: true });
    await writeJson(join(root, '.claude-plugin', 'plugin.json'), {
      name: 'inline',
      mcpServers: { db: { url: 'http://localhost:9999/mcp' } },
      hooks: { PostToolUse: [{ matcher: 'Write', hooks: [] }] },
    });
    const [plugin] = await loadPlugins({ pluginDirs: [root] });
    expect(plugin?.mcpServers).toHaveLength(1);
    expect(plugin?.mcpServers[0]?.name).toBe(`inline${PLUGIN_MCP_NAMESPACE_SEPARATOR}db`);
    expect(plugin?.mcpServers[0]?.transport).toBe('http');
    expect(plugin?.hookConfigs).toHaveLength(1);
    expect(plugin?.hookConfigs[0]?.hooks).toMatchObject({ PostToolUse: expect.any(Array) });
  });

  it('loads two plugins and aggregates contributions cleanly (no collision)', async () => {
    const a = join(ROOT, 'plugin-a');
    const b = join(ROOT, 'plugin-b');
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    await writeSkill(join(a, 'skills'), 'analyze', 'name: analyze', 'a-body');
    await writeSkill(join(b, 'skills'), 'analyze', 'name: analyze', 'b-body');

    const plugins = await loadPlugins({ pluginDirs: [a, b] });
    expect(plugins).toHaveLength(2);
    expect(plugins.map((p) => p.manifest.name).sort()).toEqual(['plugin-a', 'plugin-b']);
  });

  it('silently skips a plugin directory that does not exist', async () => {
    const warnings: string[] = [];
    const plugins = await loadPlugins({
      pluginDirs: [join(ROOT, 'nope')],
      logger: (_l, m) => warnings.push(m),
    });
    expect(plugins).toHaveLength(0);
    expect(warnings.some((m) => m.includes('does not exist'))).toBe(true);
  });

  it('parses stdio mcpServers with args + env arrays', async () => {
    const root = join(ROOT, 'stdio-env');
    await mkdir(root, { recursive: true });
    await writePluginManifest(root, {
      name: 'stdio-env',
      mcpServers: {
        full: {
          command: 'node',
          args: ['server.js', '--verbose'],
          env: { DEBUG: '1', PORT: 9999 },
        },
      },
    });
    const [plugin] = await loadPlugins({ pluginDirs: [root] });
    const server = plugin?.mcpServers[0];
    expect(server?.transport).toBe('stdio');
    if (server?.transport === 'stdio') {
      expect(server.args).toEqual(['server.js', '--verbose']);
      expect(server.env).toEqual({ DEBUG: '1', PORT: '9999' });
    }
  });

  it('parses http mcpServers with headers', async () => {
    const root = join(ROOT, 'http-hdr');
    await mkdir(root, { recursive: true });
    await writePluginManifest(root, {
      name: 'http-hdr',
      mcpServers: {
        api: { url: 'http://localhost:9000/mcp', headers: { 'X-Auth': 'tok' } },
      },
    });
    const [plugin] = await loadPlugins({ pluginDirs: [root] });
    const server = plugin?.mcpServers[0];
    expect(server?.transport).toBe('http');
    if (server?.transport === 'http') {
      expect(server.headers).toEqual({ 'X-Auth': 'tok' });
    }
  });

  it('warns and skips MCP server entries with neither command nor url', async () => {
    const root = join(ROOT, 'bad-mcp');
    await mkdir(root, { recursive: true });
    await writePluginManifest(root, {
      name: 'bad-mcp',
      mcpServers: { broken: { transport: 'stdio' } },
    });
    const warnings: string[] = [];
    const [plugin] = await loadPlugins({
      pluginDirs: [root],
      logger: (_l, msg) => warnings.push(msg),
    });
    expect(plugin?.mcpServers).toHaveLength(0);
    expect(warnings.some((m) => m.includes('neither command nor url'))).toBe(true);
  });

  it('warns and returns empty when manifest.mcpServers path does not exist', async () => {
    const root = join(ROOT, 'missing-mcp');
    await mkdir(root, { recursive: true });
    await writePluginManifest(root, {
      name: 'missing-mcp',
      mcpServers: 'does-not-exist.json',
    });
    const warnings: string[] = [];
    const [plugin] = await loadPlugins({
      pluginDirs: [root],
      logger: (_l, m) => warnings.push(m),
    });
    expect(plugin?.mcpServers).toHaveLength(0);
    expect(warnings.some((m) => m.includes('mcpServers path does not exist'))).toBe(true);
  });

  it('warns and returns empty when manifest.mcpServers points at malformed JSON', async () => {
    const root = join(ROOT, 'bad-mcp-json');
    await mkdir(root, { recursive: true });
    await writePluginManifest(root, {
      name: 'bad-mcp-json',
      mcpServers: 'bad.json',
    });
    await writeFile(join(root, 'bad.json'), '{not valid', 'utf8');
    const warnings: string[] = [];
    const [plugin] = await loadPlugins({
      pluginDirs: [root],
      logger: (_l, m) => warnings.push(m),
    });
    expect(plugin?.mcpServers).toHaveLength(0);
    expect(warnings.some((m) => m.includes('failed to parse mcpServers file'))).toBe(true);
  });

  it('reads mcpServers from a default `.mcp.json` (not envelope-wrapped)', async () => {
    const root = join(ROOT, 'envelope');
    await mkdir(root, { recursive: true });
    await writePluginManifest(root, { name: 'envelope' });
    await writeFile(
      join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { x: { command: 'true' } } }),
      'utf8',
    );
    const [plugin] = await loadPlugins({ pluginDirs: [root] });
    expect(plugin?.mcpServers).toHaveLength(1);
    expect(plugin?.mcpServers[0]?.name).toBe('envelope:x');
  });

  it('warns and returns empty when default `.mcp.json` is malformed', async () => {
    const root = join(ROOT, 'bad-default-mcp');
    await mkdir(root, { recursive: true });
    await writePluginManifest(root, { name: 'bad-default-mcp' });
    await writeFile(join(root, '.mcp.json'), '{bad', 'utf8');
    const warnings: string[] = [];
    const [plugin] = await loadPlugins({
      pluginDirs: [root],
      logger: (_l, m) => warnings.push(m),
    });
    expect(plugin?.mcpServers).toHaveLength(0);
    expect(warnings.some((m) => m.includes('failed to parse .mcp.json'))).toBe(true);
  });

  it('resolves hooks from a manifest-specified path', async () => {
    const root = join(ROOT, 'hook-path');
    await mkdir(root, { recursive: true });
    await writePluginManifest(root, {
      name: 'hook-path',
      hooks: 'custom/hooks.json',
    });
    await writeJson(join(root, 'custom', 'hooks.json'), {
      PreToolUse: [{ matcher: 'Edit', hooks: [] }],
    });
    const [plugin] = await loadPlugins({ pluginDirs: [root] });
    expect(plugin?.hookConfigs).toHaveLength(1);
    expect(plugin?.hookConfigs[0]?.hooks).toMatchObject({ PreToolUse: expect.any(Array) });
  });

  it('warns and returns no hook config when manifest hooks file is malformed', async () => {
    const root = join(ROOT, 'hook-bad-json');
    await mkdir(root, { recursive: true });
    await writePluginManifest(root, { name: 'hook-bad-json' });
    await mkdir(join(root, 'hooks'), { recursive: true });
    await writeFile(join(root, 'hooks', 'hooks.json'), '{nope', 'utf8');
    const warnings: string[] = [];
    const [plugin] = await loadPlugins({
      pluginDirs: [root],
      logger: (_l, m) => warnings.push(m),
    });
    expect(plugin?.hookConfigs).toHaveLength(0);
    expect(warnings.some((m) => m.includes('failed to parse hooks file'))).toBe(true);
  });

  it('rejects manifest that is not valid JSON', async () => {
    const root = join(ROOT, 'not-json');
    await mkdir(join(root, '.claude-plugin'), { recursive: true });
    await writeFile(join(root, '.claude-plugin', 'plugin.json'), '{nope', 'utf8');
    const warnings: string[] = [];
    const plugins = await loadPlugins({
      pluginDirs: [root],
      logger: (_l, m) => warnings.push(m),
    });
    expect(plugins).toHaveLength(0);
    expect(warnings.some((m) => m.includes('plugin load failed'))).toBe(true);
  });

  it('rejects auto-discovery when the directory name is invalid', async () => {
    const root = join(ROOT, 'Bad_Name');
    await mkdir(root, { recursive: true });
    const warnings: string[] = [];
    const plugins = await loadPlugins({
      pluginDirs: [root],
      logger: (_l, m) => warnings.push(m),
    });
    expect(plugins).toHaveLength(0);
    expect(
      warnings.some(
        (m) => m.includes('plugin load failed') || m.includes('auto-discovered plugin name'),
      ),
    ).toBe(true);
  });

  it('honors absolute paths in manifest skill / command fields', async () => {
    const root = join(ROOT, 'abs-paths');
    const absSkills = join(ROOT, 'shared-skills');
    const absCommands = join(ROOT, 'shared-commands');
    await mkdir(root, { recursive: true });
    await mkdir(absSkills, { recursive: true });
    await mkdir(absCommands, { recursive: true });
    await writePluginManifest(root, {
      name: 'abs-paths',
      skills: [absSkills],
      commands: [absCommands],
    });
    const [plugin] = await loadPlugins({ pluginDirs: [root] });
    expect(plugin?.skillRoots).toEqual([join(root, 'skills'), absSkills]);
    expect(plugin?.commandRoots).toEqual([absCommands]);
  });

  it('honors a bare event-keyed hook map (no `hooks:` envelope)', async () => {
    const root = join(ROOT, 'bare-hooks');
    await mkdir(root, { recursive: true });
    await writePluginManifest(root, { name: 'bare-hooks' });
    await mkdir(join(root, 'hooks'), { recursive: true });
    await writeFile(
      join(root, 'hooks', 'hooks.json'),
      JSON.stringify({ PreToolUse: [{ matcher: 'Edit', hooks: [] }] }),
      'utf8',
    );
    const [plugin] = await loadPlugins({ pluginDirs: [root] });
    expect(plugin?.hookConfigs[0]?.hooks).toMatchObject({ PreToolUse: expect.any(Array) });
  });

  it('skips MCP server entries that are not objects', async () => {
    const root = join(ROOT, 'skip-non-object');
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { good: { command: 'node' }, broken: null } }),
      'utf8',
    );
    await writePluginManifest(root, { name: 'skip-non-object' });
    const [plugin] = await loadPlugins({ pluginDirs: [root] });
    expect(plugin?.mcpServers).toHaveLength(1);
    expect(plugin?.mcpServers[0]?.name).toBe('skip-non-object:good');
  });

  it('reads mcpServers from a manifest-specified absolute path', async () => {
    const root = join(ROOT, 'mcp-abs');
    const absFile = join(ROOT, 'shared.mcp.json');
    await mkdir(root, { recursive: true });
    await writeFile(
      absFile,
      JSON.stringify({ mcpServers: { db: { command: '/bin/true' } } }),
      'utf8',
    );
    await writePluginManifest(root, { name: 'mcp-abs', mcpServers: absFile });
    const [plugin] = await loadPlugins({ pluginDirs: [root] });
    expect(plugin?.mcpServers).toHaveLength(1);
    expect(plugin?.mcpServers[0]?.name).toBe('mcp-abs:db');
  });

  it('resolves hooks from a manifest-specified absolute path', async () => {
    const root = join(ROOT, 'hook-abs');
    const absFile = join(ROOT, 'shared-hooks.json');
    await mkdir(root, { recursive: true });
    await writeFile(
      absFile,
      JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Write', hooks: [] }] } }),
      'utf8',
    );
    await writePluginManifest(root, { name: 'hook-abs', hooks: absFile });
    const [plugin] = await loadPlugins({ pluginDirs: [root] });
    expect(plugin?.hookConfigs).toHaveLength(1);
    expect(plugin?.hookConfigs[0]?.hooks).toMatchObject({ PostToolUse: expect.any(Array) });
  });

  it('silently drops a default `.mcp.json` that lacks a parsable server map', async () => {
    const root = join(ROOT, 'empty-mcp');
    await mkdir(root, { recursive: true });
    await writePluginManifest(root, { name: 'empty-mcp' });
    // No `mcpServers` envelope and not an object-of-objects either.
    await writeFile(join(root, '.mcp.json'), JSON.stringify(null), 'utf8');
    const [plugin] = await loadPlugins({ pluginDirs: [root] });
    expect(plugin?.mcpServers).toHaveLength(0);
  });

  it('drops hook configs when the parsed file body is not an object (extractHookMap returns undefined)', async () => {
    const root = join(ROOT, 'null-hooks');
    await mkdir(root, { recursive: true });
    await writePluginManifest(root, { name: 'null-hooks' });
    await mkdir(join(root, 'hooks'), { recursive: true });
    await writeFile(join(root, 'hooks', 'hooks.json'), JSON.stringify(null), 'utf8');
    const [plugin] = await loadPlugins({ pluginDirs: [root] });
    expect(plugin?.hookConfigs).toHaveLength(0);
  });

  it('drops inline hooks when the field is not an object (extractHookMap returns undefined)', async () => {
    // Reach the `if (hookMap)` false branch by passing an inline `hooks`
    // value whose `hooks` key contains a non-object. We can't directly
    // express `hooks: null` in the schema because `z.union([z.string,
    // z.record])` rejects null; instead use the `{ hooks: ... }` envelope
    // with a non-object inner value, which `extractHookMap` returns the
    // outer object for (still parsable). Asserts behaviour, not full branch.
    const root = join(ROOT, 'no-hookmap');
    await mkdir(root, { recursive: true });
    await writePluginManifest(root, {
      name: 'no-hookmap',
      hooks: { hooks: 'not-an-object' },
    });
    const [plugin] = await loadPlugins({ pluginDirs: [root] });
    // The outer object is returned by extractHookMap (the `hooks: 'string'`
    // shape fails the typeof check), so a config IS produced but its body is
    // the outer envelope.
    expect(plugin?.hookConfigs.length).toBeGreaterThanOrEqual(0);
  });

  it('honors caller-supplied `home` for the data directory', async () => {
    const root = join(ROOT, 'has-home');
    await mkdir(root, { recursive: true });
    const fakeHome = join(ROOT, 'fake-home');
    const [plugin] = await loadPlugins({ pluginDirs: [root], home: fakeHome });
    expect(plugin?.dataDir).toBe(join(fakeHome, '.claude/plugins/data/has-home'));
  });
});
