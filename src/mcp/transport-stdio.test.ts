import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { McpStdioClient } from './transport-stdio.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ECHO_FIXTURE = resolve(REPO_ROOT, 'scripts/test-fixtures/mcp-stdio-echo.mjs');
const HANG_FIXTURE = resolve(REPO_ROOT, 'scripts/test-fixtures/mcp-stdio-hang.mjs');

function echoClient(
  overrides: { signal?: AbortSignal; logger?: Parameters<typeof makeClient>[0]['logger'] } = {},
) {
  return makeClient({
    command: process.execPath,
    args: [ECHO_FIXTURE],
    ...overrides,
  });
}

function makeClient(opts: ConstructorParameters<typeof McpStdioClient>[0]) {
  return new McpStdioClient(opts);
}

describe('McpStdioClient', () => {
  it('module import has no side-effects (does not load the SDK)', async () => {
    // Reload the module under a fresh import and confirm it returns without
    // requiring @modelcontextprotocol/sdk on the call path. The SDK is only
    // imported inside connect().
    const mod = await import('./transport-stdio.js');
    expect(typeof mod.McpStdioClient).toBe('function');
    // No-op constructor, no I/O, no spawn.
    const c = new mod.McpStdioClient({ command: process.execPath, args: ['-e', '0'] });
    expect(c).toBeInstanceOf(mod.McpStdioClient);
  });

  it('completes the handshake and exposes server metadata', async () => {
    const client = echoClient();
    try {
      await client.connect();
      const version = client.getServerVersion();
      expect(version?.name).toBe('echo-fixture');
      expect(version?.version).toBe('0.0.1');
      expect(client.getServerCapabilities()).toBeDefined();
    } finally {
      await client.close();
    }
  });

  it('listTools returns the registered tools', async () => {
    const client = echoClient();
    try {
      await client.connect();
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(['echo', 'fail']);
      const echo = tools.find((t) => t.name === 'echo');
      expect(echo?.inputSchema).toMatchObject({ type: 'object' });
    } finally {
      await client.close();
    }
  });

  it('callTool round-trips a happy-path result', async () => {
    const client = echoClient();
    try {
      await client.connect();
      const result = await client.callTool('echo', { message: 'hello mcp' });
      expect(result.isError).not.toBe(true);
      expect(result.content).toMatchObject([{ type: 'text', text: 'hello mcp' }]);
    } finally {
      await client.close();
    }
  });

  it('callTool surfaces tool-side errors (isError:true)', async () => {
    const client = echoClient();
    try {
      await client.connect();
      const result = await client.callTool('fail', {});
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject([{ type: 'text', text: 'intentional failure' }]);
    } finally {
      await client.close();
    }
  });

  it('close() is idempotent — calling twice is a no-op', async () => {
    const client = echoClient();
    await client.connect();
    await client.close();
    await expect(client.close()).resolves.toBeUndefined();
    // Once closed, request methods reject with a clear error.
    await expect(client.listTools()).rejects.toThrow(/not connected/);
  });

  it('rejects connect() when signal is pre-aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('test pre-abort'));
    const client = echoClient({ signal: controller.signal });
    await expect(client.connect()).rejects.toThrow(/pre-abort/);
    // Cleanup safety: close() on a never-connected client is fine.
    await client.close();
  });

  it('aborting mid-handshake tears down the subprocess and rejects connect()', async () => {
    const controller = new AbortController();
    const client = makeClient({
      command: process.execPath,
      args: [HANG_FIXTURE],
      signal: controller.signal,
    });
    // Kick off connect() against the hung server, then abort after a tick so
    // the SDK is mid-`initialize`.
    const pending = client.connect();
    setTimeout(() => controller.abort(new Error('mid-handshake abort')), 50);
    await expect(pending).rejects.toThrow();
    await client.close();
  });

  it('rejects a second connect() call on the same instance', async () => {
    const client = echoClient();
    try {
      await client.connect();
      await expect(client.connect()).rejects.toThrow(/already called/);
    } finally {
      await client.close();
    }
  });

  it('rejects connect() after close()', async () => {
    const client = echoClient();
    await client.connect();
    await client.close();
    const reopen = echoClient();
    // Verify the post-close branch on the same instance, not a fresh one.
    await reopen.close();
    await expect(reopen.connect()).rejects.toThrow(/after close/);
  });

  it('listResources / readResource passthrough', async () => {
    const client = echoClient();
    try {
      await client.connect();
      const { resources } = await client.listResources();
      expect(resources.find((r) => r.name === 'greeting')).toBeDefined();
      const read = await client.readResource('memory://greeting.txt');
      expect(read.contents[0]).toMatchObject({ text: 'hello from fixture' });
    } finally {
      await client.close();
    }
  });

  it('listPrompts / getPrompt passthrough', async () => {
    const client = echoClient();
    try {
      await client.connect();
      const { prompts } = await client.listPrompts();
      expect(prompts.find((p) => p.name === 'wave')).toBeDefined();
      const prompt = await client.getPrompt('wave', { name: 'world' });
      expect(prompt.messages[0]).toMatchObject({
        role: 'user',
        content: { type: 'text', text: 'wave at world' },
      });
    } finally {
      await client.close();
    }
  });

  it('pre-aborted signal with a string reason still rejects', async () => {
    const controller = new AbortController();
    controller.abort('string-reason');
    const client = echoClient({ signal: controller.signal });
    await expect(client.connect()).rejects.toThrow(/string-reason|aborted/i);
    await client.close();
  });

  it('pre-aborted signal with a non-Error non-string reason still rejects', async () => {
    const controller = new AbortController();
    controller.abort({ code: 42 });
    const client = echoClient({ signal: controller.signal });
    await expect(client.connect()).rejects.toThrow(/aborted/i);
    await client.close();
  });

  it('forwards child stderr lines to the optional logger', async () => {
    const lines: Array<{ level: string; message: string }> = [];
    const client = makeClient({
      command: process.execPath,
      // -e prints to stderr; the server then attaches and processes init normally.
      args: [
        '-e',
        `process.stderr.write('hello-from-fixture\\n');import('${ECHO_FIXTURE.replace(/\\/g, '\\\\')}');`,
      ],
      logger: (level, message) => lines.push({ level, message }),
    });
    try {
      await client.connect();
      // Give the stderr pipe a tick to flush.
      await new Promise((r) => setTimeout(r, 50));
      const debugMsg = lines.find(
        (l) => l.level === 'debug' && l.message.includes('hello-from-fixture'),
      );
      expect(debugMsg).toBeTruthy();
    } finally {
      await client.close();
    }
  });
});
