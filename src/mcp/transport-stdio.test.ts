// NOTE: A cosmetic `close timed out after 10000ms` message can appear AFTER
// `Tests closed successfully` when this file runs in vitest. Exit code is 0
// and 100% of tests pass — root cause is the SDK's `StdioClientTransport`
// cleanup outliving vitest's pool-close gate. Background in PR #115; do not
// chase this.

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
    // What this DOES cover: re-importing the module + constructing a client
    // does not throw, does not perform I/O, and does not spawn a subprocess.
    // What this does NOT cover: a static SDK import would still pass this
    // test — the lazy-load contract is verified at build time (the top of
    // `transport-stdio.ts` uses `import type` only) and by reading the
    // compiled `dist/mcp/transport-stdio.js` for absence of `import` /
    // `require` of the SDK. TODO(PR #115): consider strengthening to a child
    // `node -e` that asserts `require.cache` / `process.moduleLoadList` has
    // no `modelcontextprotocol` entries before connect().
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
      expect(names).toEqual(['echo', 'fail', 'hang']);
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

  it('rejects connect() after close() on the same instance', async () => {
    // Exercise the post-close branch on the SAME instance: connect, close,
    // then attempt to re-connect — should reject with /after close/.
    const client = echoClient();
    await client.connect();
    await client.close();
    await expect(client.connect()).rejects.toThrow(/after close/);
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

  it('connect(signal) rejects when the per-call signal is pre-aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('per-call pre-abort'));
    const client = echoClient();
    await expect(client.connect(controller.signal)).rejects.toThrow(/per-call pre-abort/);
    await client.close();
  });

  it('per-method signal pre-aborted on listTools rejects without affecting the client', async () => {
    const client = echoClient();
    try {
      await client.connect();
      const controller = new AbortController();
      controller.abort(new Error('per-call listTools'));
      await expect(client.listTools(controller.signal)).rejects.toThrow();
      // Client is still healthy — a follow-up call without a signal succeeds.
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  it('mid-call abort on callTool rejects that call and leaves the client connected', async () => {
    const client = echoClient();
    try {
      await client.connect();
      const controller = new AbortController();
      const pending = client.callTool('hang', {}, controller.signal);
      setTimeout(() => controller.abort(new Error('mid-call abort')), 50);
      await expect(pending).rejects.toThrow();
      // Follow-up call on the same client succeeds — the abort did not tear
      // down the transport.
      const ok = await client.callTool('echo', { message: 'after abort' });
      expect(ok.content).toMatchObject([{ type: 'text', text: 'after abort' }]);
    } finally {
      await client.close();
    }
  });

  it('per-method signal on readResource / getPrompt is honored', async () => {
    const client = echoClient();
    try {
      await client.connect();
      const c1 = new AbortController();
      c1.abort(new Error('rr-abort'));
      await expect(client.readResource('memory://greeting.txt', c1.signal)).rejects.toThrow();
      const c2 = new AbortController();
      c2.abort(new Error('gp-abort'));
      await expect(client.getPrompt('wave', { name: 'x' }, c2.signal)).rejects.toThrow();
      // Client still healthy.
      const read = await client.readResource('memory://greeting.txt');
      expect(read.contents[0]).toMatchObject({ text: 'hello from fixture' });
    } finally {
      await client.close();
    }
  });

  it('lifecycle signal aborted AFTER connect causes subsequent calls to reject', async () => {
    const controller = new AbortController();
    const client = echoClient({ signal: controller.signal });
    try {
      await client.connect();
      // Sanity: client is usable before abort.
      await client.listTools();
      controller.abort(new Error('post-handshake lifecycle abort'));
      await expect(client.listTools()).rejects.toThrow(/not connected/);
    } finally {
      // close() after a lifecycle-driven close must still be a no-op.
      await client.close();
      await expect(client.close()).resolves.toBeUndefined();
    }
  });

  it('handshake failure without a lifecycle signal still cleans up', async () => {
    // Covers the catch path of connect() without a lifecycle listener to
    // remove. Child exits immediately so the SDK's initialize rejects.
    const client = makeClient({
      command: process.execPath,
      args: ['-e', 'process.exit(1)'],
    });
    await expect(client.connect()).rejects.toThrow();
    await client.close();
  });

  it('lifecycle signal composes with per-call signal — per-call rejects without closing client', async () => {
    const lifecycle = new AbortController();
    const client = echoClient({ signal: lifecycle.signal });
    try {
      await client.connect();
      const perCall = new AbortController();
      perCall.abort(new Error('per-call wins'));
      await expect(client.listTools(perCall.signal)).rejects.toThrow();
      // Lifecycle signal never fired, so the client is still connected.
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });
});
