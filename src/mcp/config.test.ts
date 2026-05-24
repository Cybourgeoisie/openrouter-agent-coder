import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMcpConfig, MAX_PROJECT_WALK_DEPTH } from './config.js';

let ROOT: string;
let ORIGINAL_HOME: string | undefined;

beforeEach(async () => {
  ROOT = await mkdtemp(join(tmpdir(), 'mcp-config-test-'));
  ORIGINAL_HOME = process.env.HOME;
  // Redirect os.homedir() at a sandbox dir so the test never reaches the
  // real user's ~/.mcp.json. os.homedir() honours $HOME on POSIX.
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

async function writeJson(path: string, content: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(content, null, 2), 'utf8');
}

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content, 'utf8');
}

describe('loadMcpConfig', () => {
  it('returns [] when no .mcp.json exists in any scope', async () => {
    const out = await loadMcpConfig({ cwd: ROOT });
    expect(out).toEqual([]);
  });

  it('returns [] when scopes is empty', async () => {
    const fakeHome = join(ROOT, 'fake-home');
    await writeJson(join(fakeHome, '.mcp.json'), {
      mcpServers: { foo: { command: 'node', args: ['s.js'] } },
    });
    process.env.HOME = fakeHome;
    const out = await loadMcpConfig({ cwd: ROOT, scopes: [] });
    expect(out).toEqual([]);
  });

  it('loads a user-only config from ~/.mcp.json', async () => {
    const fakeHome = join(ROOT, 'fake-home');
    await writeJson(join(fakeHome, '.mcp.json'), {
      mcpServers: {
        'my-server': { command: 'node', args: ['server.js'], env: { FOO: 'bar' } },
      },
    });
    process.env.HOME = fakeHome;

    const out = await loadMcpConfig({ cwd: ROOT });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      transport: 'stdio',
      name: 'my-server',
      command: 'node',
      args: ['server.js'],
      env: { FOO: 'bar' },
      source: join(fakeHome, '.mcp.json'),
    });
  });

  it('loads a project-only config from cwd/.mcp.json', async () => {
    await writeJson(join(ROOT, '.mcp.json'), {
      mcpServers: {
        'http-svc': { url: 'https://example.com/mcp', headers: { 'X-Auth': 'k' } },
      },
    });
    await writeText(join(ROOT, '.git', 'HEAD'), 'ref: refs/heads/main\n');

    const out = await loadMcpConfig({ cwd: ROOT });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      transport: 'http',
      name: 'http-svc',
      url: 'https://example.com/mcp',
      headers: { 'X-Auth': 'k' },
      source: join(ROOT, '.mcp.json'),
    });
  });

  it('project entry overrides user entry by name (full replacement, not merge)', async () => {
    const fakeHome = join(ROOT, 'fake-home');
    const workdir = join(ROOT, 'work');
    await writeJson(join(fakeHome, '.mcp.json'), {
      mcpServers: {
        shared: {
          command: 'user-cmd',
          args: ['from-user'],
          env: { ONLY_USER: '1' },
        },
        userOnly: { command: 'u' },
      },
    });
    await writeJson(join(workdir, '.mcp.json'), {
      mcpServers: {
        shared: { url: 'https://project.example/mcp' },
        projectOnly: { command: 'p' },
      },
    });
    await writeText(join(workdir, '.git', 'HEAD'), 'x');
    process.env.HOME = fakeHome;

    const out = await loadMcpConfig({ cwd: workdir });
    expect(out.map((s) => s.name)).toEqual(['projectOnly', 'shared', 'userOnly']);

    const shared = out.find((s) => s.name === 'shared')!;
    // Project (http) fully replaces user (stdio). No leftover `args`/`env`/`command`.
    expect(shared).toMatchObject({
      transport: 'http',
      name: 'shared',
      url: 'https://project.example/mcp',
      source: join(workdir, '.mcp.json'),
    });
    expect((shared as unknown as Record<string, unknown>).command).toBeUndefined();
    expect((shared as unknown as Record<string, unknown>).args).toBeUndefined();
    expect((shared as unknown as Record<string, unknown>).env).toBeUndefined();
  });

  it('walker finds .mcp.json at nested depth and at root with deeper overriding shallower', async () => {
    const repoRoot = join(ROOT, 'repo');
    const childDir = join(repoRoot, 'a', 'b');
    await writeText(join(repoRoot, '.git', 'HEAD'), 'x');
    await writeJson(join(repoRoot, '.mcp.json'), {
      mcpServers: {
        rootOnly: { command: 'r' },
        shared: { command: 'root-cmd' },
      },
    });
    await writeJson(join(childDir, '.mcp.json'), {
      mcpServers: {
        childOnly: { url: 'https://child.example/mcp' },
        shared: { command: 'child-cmd' },
      },
    });

    const out = await loadMcpConfig({ cwd: childDir, scopes: ['project'] });
    expect(out.map((s) => s.name)).toEqual(['childOnly', 'rootOnly', 'shared']);

    const shared = out.find((s) => s.name === 'shared')!;
    expect(shared).toMatchObject({ transport: 'stdio', command: 'child-cmd' });
    expect(shared.source).toBe(join(childDir, '.mcp.json'));

    const rootOnly = out.find((s) => s.name === 'rootOnly')!;
    expect(rootOnly.source).toBe(join(repoRoot, '.mcp.json'));
  });

  it('walker stops at the .git boundary (config beyond .git not picked up)', async () => {
    const repoRoot = join(ROOT, 'repo');
    const childDir = join(repoRoot, 'sub');
    await writeText(join(repoRoot, '.git', 'HEAD'), 'x');
    await writeJson(join(repoRoot, '.mcp.json'), {
      mcpServers: { inside: { command: 'i' } },
    });
    // OUTSIDE the .git boundary — must NOT be picked up.
    await writeJson(join(ROOT, '.mcp.json'), {
      mcpServers: { outside: { command: 'o' } },
    });

    const out = await loadMcpConfig({ cwd: childDir, scopes: ['project'] });
    expect(out.map((s) => s.name)).toEqual(['inside']);
  });

  it(`walker stops at depth cap (${MAX_PROJECT_WALK_DEPTH})`, async () => {
    // Build a chain deeper than the cap with no .git anywhere, place a
    // .mcp.json beyond the cap that must NOT be picked up, and one within.
    const segments = Array.from({ length: MAX_PROJECT_WALK_DEPTH + 2 }, (_, i) => `d${i}`);
    const deep = join(ROOT, ...segments);
    await mkdir(deep, { recursive: true });

    const beyondCap = join(ROOT, 'd0');
    await writeJson(join(beyondCap, '.mcp.json'), {
      mcpServers: { beyond: { command: 'b' } },
    });
    const withinCap = join(ROOT, 'd0', 'd1', 'd2');
    await writeJson(join(withinCap, '.mcp.json'), {
      mcpServers: { within: { command: 'w' } },
    });

    const out = await loadMcpConfig({ cwd: deep, scopes: ['project'] });
    const names = out.map((s) => s.name);
    expect(names).toContain('within');
    expect(names).not.toContain('beyond');
  });

  it('throws with the file path in the message when JSON is malformed', async () => {
    const filePath = join(ROOT, '.mcp.json');
    await writeText(filePath, '{not valid json');
    await writeText(join(ROOT, '.git', 'HEAD'), 'x');

    await expect(loadMcpConfig({ cwd: ROOT, scopes: ['project'] })).rejects.toThrow(filePath);
  });

  it('throws when a server entry has BOTH `command` and `url`', async () => {
    const filePath = join(ROOT, '.mcp.json');
    await writeJson(filePath, {
      mcpServers: {
        bad: { command: 'node', url: 'https://example.com/mcp' },
      },
    });
    await writeText(join(ROOT, '.git', 'HEAD'), 'x');

    await expect(loadMcpConfig({ cwd: ROOT, scopes: ['project'] })).rejects.toThrow(
      /cannot have both/,
    );
  });

  it('throws when a server entry has NEITHER `command` nor `url`', async () => {
    const filePath = join(ROOT, '.mcp.json');
    await writeJson(filePath, {
      mcpServers: {
        bad: { args: ['x'] },
      },
    });
    await writeText(join(ROOT, '.git', 'HEAD'), 'x');

    await expect(loadMcpConfig({ cwd: ROOT, scopes: ['project'] })).rejects.toThrow(
      /must have either/,
    );
  });

  it('throws when explicit transport "stdio" is set without `command`', async () => {
    await writeJson(join(ROOT, '.mcp.json'), {
      mcpServers: {
        bad: { transport: 'stdio', url: 'https://example.com/mcp' },
      },
    });
    await writeText(join(ROOT, '.git', 'HEAD'), 'x');

    await expect(loadMcpConfig({ cwd: ROOT, scopes: ['project'] })).rejects.toThrow(
      /transport \\"stdio\\" requires/,
    );
  });

  it('throws when explicit transport "http" is set without `url`', async () => {
    await writeJson(join(ROOT, '.mcp.json'), {
      mcpServers: {
        bad: { transport: 'http', command: 'node' },
      },
    });
    await writeText(join(ROOT, '.git', 'HEAD'), 'x');

    await expect(loadMcpConfig({ cwd: ROOT, scopes: ['project'] })).rejects.toThrow(
      /transport \\"http\\" requires/,
    );
  });

  it('throws when `url` is not a valid URL', async () => {
    await writeJson(join(ROOT, '.mcp.json'), {
      mcpServers: {
        bad: { url: 'not a url' },
      },
    });
    await writeText(join(ROOT, '.git', 'HEAD'), 'x');

    await expect(loadMcpConfig({ cwd: ROOT, scopes: ['project'] })).rejects.toThrow(/Invalid/);
  });

  it('scopes parameter filters which scopes load (project-only skips ~/.mcp.json)', async () => {
    const fakeHome = join(ROOT, 'fake-home');
    await writeJson(join(fakeHome, '.mcp.json'), {
      mcpServers: { userServer: { command: 'u' } },
    });
    await writeJson(join(ROOT, '.mcp.json'), {
      mcpServers: { projectServer: { command: 'p' } },
    });
    await writeText(join(ROOT, '.git', 'HEAD'), 'x');
    process.env.HOME = fakeHome;

    const out = await loadMcpConfig({ cwd: ROOT, scopes: ['project'] });
    expect(out.map((s) => s.name)).toEqual(['projectServer']);
  });

  it('scopes parameter filters which scopes load (user-only ignores project file)', async () => {
    const fakeHome = join(ROOT, 'fake-home');
    await writeJson(join(fakeHome, '.mcp.json'), {
      mcpServers: { userServer: { command: 'u' } },
    });
    await writeJson(join(ROOT, '.mcp.json'), {
      mcpServers: { projectServer: { command: 'p' } },
    });
    await writeText(join(ROOT, '.git', 'HEAD'), 'x');
    process.env.HOME = fakeHome;

    const out = await loadMcpConfig({ cwd: ROOT, scopes: ['user'] });
    expect(out.map((s) => s.name)).toEqual(['userServer']);
  });

  it('output is sorted by name deterministically', async () => {
    await writeJson(join(ROOT, '.mcp.json'), {
      mcpServers: {
        zebra: { command: 'z' },
        alpha: { command: 'a' },
        middle: { command: 'm' },
      },
    });
    await writeText(join(ROOT, '.git', 'HEAD'), 'x');

    const out = await loadMcpConfig({ cwd: ROOT, scopes: ['project'] });
    expect(out.map((s) => s.name)).toEqual(['alpha', 'middle', 'zebra']);
  });

  it('skips project scope when cwd is undefined (user scope still loads)', async () => {
    const fakeHome = join(ROOT, 'fake-home');
    await writeJson(join(fakeHome, '.mcp.json'), {
      mcpServers: { userOnly: { command: 'u' } },
    });
    process.env.HOME = fakeHome;

    const out = await loadMcpConfig(); // no cwd, default scopes
    expect(out.map((s) => s.name)).toEqual(['userOnly']);
  });

  it('skips project scope when cwd is undefined even with project in scopes', async () => {
    const out = await loadMcpConfig({ scopes: ['project'] });
    expect(out).toEqual([]);
  });

  it('infers transport when not explicitly set (stdio from command, http from url)', async () => {
    await writeJson(join(ROOT, '.mcp.json'), {
      mcpServers: {
        s: { command: 'node' },
        h: { url: 'https://example.com/mcp' },
      },
    });
    await writeText(join(ROOT, '.git', 'HEAD'), 'x');

    const out = await loadMcpConfig({ cwd: ROOT, scopes: ['project'] });
    expect(out.find((s) => s.name === 's')!.transport).toBe('stdio');
    expect(out.find((s) => s.name === 'h')!.transport).toBe('http');
  });

  it('accepts explicit transport that matches the field shape', async () => {
    await writeJson(join(ROOT, '.mcp.json'), {
      mcpServers: {
        s: { transport: 'stdio', command: 'node' },
        h: { transport: 'http', url: 'https://example.com/mcp' },
      },
    });
    await writeText(join(ROOT, '.git', 'HEAD'), 'x');

    const out = await loadMcpConfig({ cwd: ROOT, scopes: ['project'] });
    expect(out).toHaveLength(2);
  });

  it('omits optional args/env/headers from the output when absent in the source', async () => {
    await writeJson(join(ROOT, '.mcp.json'), {
      mcpServers: {
        bare: { command: 'node' },
        bareHttp: { url: 'https://example.com/mcp' },
      },
    });
    await writeText(join(ROOT, '.git', 'HEAD'), 'x');

    const out = await loadMcpConfig({ cwd: ROOT, scopes: ['project'] });
    const bare = out.find((s) => s.name === 'bare')!;
    expect('args' in bare).toBe(false);
    expect('env' in bare).toBe(false);
    const bareHttp = out.find((s) => s.name === 'bareHttp')!;
    expect('headers' in bareHttp).toBe(false);
  });

  it('handles a .mcp.json file with no `mcpServers` key (returns no entries from that file)', async () => {
    await writeJson(join(ROOT, '.mcp.json'), {});
    await writeText(join(ROOT, '.git', 'HEAD'), 'x');

    const out = await loadMcpConfig({ cwd: ROOT, scopes: ['project'] });
    expect(out).toEqual([]);
  });

  it('handles a .mcp.json with empty mcpServers object', async () => {
    await writeJson(join(ROOT, '.mcp.json'), { mcpServers: {} });
    await writeText(join(ROOT, '.git', 'HEAD'), 'x');

    const out = await loadMcpConfig({ cwd: ROOT, scopes: ['project'] });
    expect(out).toEqual([]);
  });

  it('dedupes repeated scope entries while preserving caller order', async () => {
    const fakeHome = join(ROOT, 'fake-home');
    await writeJson(join(fakeHome, '.mcp.json'), {
      mcpServers: { shared: { command: 'u' } },
    });
    await writeJson(join(ROOT, '.mcp.json'), {
      mcpServers: { shared: { command: 'p' } },
    });
    await writeText(join(ROOT, '.git', 'HEAD'), 'x');
    process.env.HOME = fakeHome;

    // Repeated scopes should not change the result.
    const out = await loadMcpConfig({
      cwd: ROOT,
      scopes: ['user', 'project', 'user', 'project'],
    });
    expect(out).toHaveLength(1);
    // 'project' still wins because the first-seen ordering is preserved
    // (user then project), and the later-applied scope overrides.
    expect((out[0] as { command?: string }).command).toBe('p');
  });

  it('reverses user/project order when scopes is explicitly ["project","user"]', async () => {
    const fakeHome = join(ROOT, 'fake-home');
    await writeJson(join(fakeHome, '.mcp.json'), {
      mcpServers: { shared: { command: 'u' } },
    });
    await writeJson(join(ROOT, '.mcp.json'), {
      mcpServers: { shared: { command: 'p' } },
    });
    await writeText(join(ROOT, '.git', 'HEAD'), 'x');
    process.env.HOME = fakeHome;

    const out = await loadMcpConfig({ cwd: ROOT, scopes: ['project', 'user'] });
    // user is now later — wins over project.
    expect((out[0] as { command?: string }).command).toBe('u');
  });

  it('stamps each entry with the absolute source path it was loaded from', async () => {
    const fakeHome = join(ROOT, 'fake-home');
    await writeJson(join(fakeHome, '.mcp.json'), {
      mcpServers: { userServer: { command: 'u' } },
    });
    await writeJson(join(ROOT, '.mcp.json'), {
      mcpServers: { projectServer: { command: 'p' } },
    });
    await writeText(join(ROOT, '.git', 'HEAD'), 'x');
    process.env.HOME = fakeHome;

    const out = await loadMcpConfig({ cwd: ROOT });
    expect(out.find((s) => s.name === 'userServer')!.source).toBe(join(fakeHome, '.mcp.json'));
    expect(out.find((s) => s.name === 'projectServer')!.source).toBe(join(ROOT, '.mcp.json'));
  });

  it('stops the walker at the filesystem root when no .git is found within the cap', async () => {
    // tmpdir resolves to a real path; create a chain shorter than cap but
    // with no .git so the walker must terminate at the parent === current
    // boundary (filesystem root). This exercises the `parent === current`
    // break branch.
    const out = await loadMcpConfig({ cwd: ROOT, scopes: ['project'] });
    expect(out).toEqual([]);
  });
});
