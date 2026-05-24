// NOTE: The deprecated `SSEClientTransport` does NOT auto-reconnect on a
// transient drop — that's a Streamable HTTP-only feature. We exercise the
// happy path + abort matrix against both transports here; the
// reconnect-on-transient-drop path on Streamable HTTP is internal to the SDK
// (driven by `Last-Event-ID` replay and a backoff knob) and is not unit-
// tested here. See PR body for the design rationale.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { McpHttpClient } from './transport-http.js';
import type { McpHttpClientOptions } from './spec.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ECHO_FIXTURE = resolve(REPO_ROOT, 'scripts/test-fixtures/mcp-http-echo.mjs');
const HANG_FIXTURE = resolve(REPO_ROOT, 'scripts/test-fixtures/mcp-http-hang.mjs');

type Transport = 'streamableHttp' | 'sse';

interface SpawnedFixture {
  proc: ChildProcess;
  baseUrl: string;
  kill: () => Promise<void>;
}

function spawnFixture(script: string): Promise<SpawnedFixture> {
  return new Promise((res, rej) => {
    const proc = spawn(process.execPath, [script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderrBuf = '';
    proc.stderr!.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
    });
    let stdoutBuf = '';
    const onData = (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
      const newlineIdx = stdoutBuf.indexOf('\n');
      if (newlineIdx >= 0) {
        const baseUrl = stdoutBuf.slice(0, newlineIdx).trim();
        proc.stdout!.off('data', onData);
        res({
          proc,
          baseUrl,
          kill: () =>
            new Promise<void>((r) => {
              if (proc.exitCode !== null) {
                r();
                return;
              }
              proc.once('exit', () => r());
              proc.kill('SIGTERM');
              setTimeout(() => {
                if (proc.exitCode === null) proc.kill('SIGKILL');
              }, 500).unref();
            }),
        });
      }
    };
    proc.stdout!.on('data', onData);
    proc.once('error', rej);
    proc.once('exit', (code) => {
      if (code !== 0 && stdoutBuf.indexOf('\n') < 0) {
        rej(new Error(`fixture exited with code ${code}: ${stderrBuf}`));
      }
    });
  });
}

function urlFor(baseUrl: string, transport: Transport): string {
  return transport === 'streamableHttp' ? `${baseUrl}/mcp` : `${baseUrl}/sse`;
}

let echo: SpawnedFixture | undefined;

beforeAll(async () => {
  echo = await spawnFixture(ECHO_FIXTURE);
});

afterAll(async () => {
  if (echo) await echo.kill();
  echo = undefined;
});

function echoClient(
  transport: Transport,
  overrides: Partial<Extract<McpHttpClientOptions, { transport: typeof transport }>> = {},
): McpHttpClient {
  if (!echo) throw new Error('echo fixture not initialized');
  return new McpHttpClient({
    transport,
    url: urlFor(echo.baseUrl, transport),
    ...overrides,
  } as McpHttpClientOptions);
}

describe('McpHttpClient', () => {
  it('module import has no side-effects (does not load the SDK)', async () => {
    // Same lazy-load contract assertion as the stdio suite: re-importing the
    // module + constructing a client must not throw, perform I/O, or open
    // any sockets. Build-time the contract is verified by `import type`
    // only at the top of `transport-http.ts`. TODO(PR #100): consider
    // strengthening to a child `node -e` that asserts `require.cache`
    // is free of `modelcontextprotocol` before connect().
    const mod = await import('./transport-http.js');
    expect(typeof mod.McpHttpClient).toBe('function');
    const c = new mod.McpHttpClient({
      transport: 'streamableHttp',
      url: 'http://127.0.0.1:1/mcp',
    });
    expect(c).toBeInstanceOf(mod.McpHttpClient);
  });

  it('rejects an invalid url at connect()', async () => {
    const client = new McpHttpClient({
      transport: 'streamableHttp',
      url: 'not a url at all',
    });
    await expect(client.connect()).rejects.toThrow(/invalid url/);
    await client.close();
  });

  it('handshake failure without a lifecycle signal still cleans up', async () => {
    // Bad port that no one is listening on — handshake POST will reject.
    const client = new McpHttpClient({
      transport: 'streamableHttp',
      url: 'http://127.0.0.1:1/mcp',
    });
    await expect(client.connect()).rejects.toThrow();
    await client.close();
  });
});

describe.each<Transport>(['streamableHttp', 'sse'])('McpHttpClient (%s)', (transport) => {
  it('completes the handshake and exposes server metadata', async () => {
    const client = echoClient(transport);
    try {
      await client.connect();
      const version = client.getServerVersion();
      expect(version?.name).toBe('echo-http-fixture');
      expect(version?.version).toBe('0.0.1');
      expect(client.getServerCapabilities()).toBeDefined();
      if (transport === 'streamableHttp') {
        expect(typeof client.getSessionId()).toBe('string');
      } else {
        expect(client.getSessionId()).toBeUndefined();
      }
    } finally {
      await client.close();
    }
  });

  it('listTools returns the registered tools', async () => {
    const client = echoClient(transport);
    try {
      await client.connect();
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(['echo', 'fail', 'hang']);
      const echoTool = tools.find((t) => t.name === 'echo');
      expect(echoTool?.inputSchema).toMatchObject({ type: 'object' });
    } finally {
      await client.close();
    }
  });

  it('callTool round-trips a happy-path result', async () => {
    const client = echoClient(transport);
    try {
      await client.connect();
      const result = await client.callTool('echo', { message: 'hello mcp http' });
      expect(result.isError).not.toBe(true);
      expect(result.content).toMatchObject([{ type: 'text', text: 'hello mcp http' }]);
    } finally {
      await client.close();
    }
  });

  it('callTool surfaces tool-side errors (isError:true)', async () => {
    const client = echoClient(transport);
    try {
      await client.connect();
      const result = await client.callTool('fail', {});
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject([{ type: 'text', text: 'intentional failure' }]);
    } finally {
      await client.close();
    }
  });

  it('listResources / readResource passthrough', async () => {
    const client = echoClient(transport);
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
    const client = echoClient(transport);
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

  it('close() is idempotent — calling twice is a no-op', async () => {
    const client = echoClient(transport);
    await client.connect();
    await client.close();
    await expect(client.close()).resolves.toBeUndefined();
    await expect(client.listTools()).rejects.toThrow(/not connected/);
  });

  it('rejects connect() when lifecycle signal is pre-aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('test pre-abort'));
    const client = echoClient(transport, { signal: controller.signal });
    await expect(client.connect()).rejects.toThrow(/pre-abort/);
    await client.close();
  });

  it('rejects connect() when per-call signal is pre-aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('per-call pre-abort'));
    const client = echoClient(transport);
    await expect(client.connect(controller.signal)).rejects.toThrow(/per-call pre-abort/);
    await client.close();
  });

  it('pre-aborted signal with a string reason still rejects', async () => {
    const controller = new AbortController();
    controller.abort('string-reason');
    const client = echoClient(transport, { signal: controller.signal });
    await expect(client.connect()).rejects.toThrow(/string-reason|aborted/i);
    await client.close();
  });

  it('pre-aborted signal with a non-Error non-string reason still rejects', async () => {
    const controller = new AbortController();
    controller.abort({ code: 42 });
    const client = echoClient(transport, { signal: controller.signal });
    await expect(client.connect()).rejects.toThrow(/aborted/i);
    await client.close();
  });

  it('rejects a second connect() call on the same instance', async () => {
    const client = echoClient(transport);
    try {
      await client.connect();
      await expect(client.connect()).rejects.toThrow(/already called/);
    } finally {
      await client.close();
    }
  });

  it('rejects connect() after close() on the same instance', async () => {
    const client = echoClient(transport);
    await client.connect();
    await client.close();
    await expect(client.connect()).rejects.toThrow(/after close/);
  });

  it('per-method signal pre-aborted on listTools rejects without affecting the client', async () => {
    const client = echoClient(transport);
    try {
      await client.connect();
      const controller = new AbortController();
      controller.abort(new Error('per-call listTools'));
      await expect(client.listTools(controller.signal)).rejects.toThrow();
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  it('mid-call abort on callTool rejects that call and leaves the client connected', async () => {
    const client = echoClient(transport);
    try {
      await client.connect();
      const controller = new AbortController();
      const pending = client.callTool('hang', {}, controller.signal);
      setTimeout(() => controller.abort(new Error('mid-call abort')), 50);
      await expect(pending).rejects.toThrow();
      const ok = await client.callTool('echo', { message: 'after abort' });
      expect(ok.content).toMatchObject([{ type: 'text', text: 'after abort' }]);
    } finally {
      await client.close();
    }
  });

  it('per-method signal on readResource / getPrompt is honored', async () => {
    const client = echoClient(transport);
    try {
      await client.connect();
      const c1 = new AbortController();
      c1.abort(new Error('rr-abort'));
      await expect(client.readResource('memory://greeting.txt', c1.signal)).rejects.toThrow();
      const c2 = new AbortController();
      c2.abort(new Error('gp-abort'));
      await expect(client.getPrompt('wave', { name: 'x' }, c2.signal)).rejects.toThrow();
      const read = await client.readResource('memory://greeting.txt');
      expect(read.contents[0]).toMatchObject({ text: 'hello from fixture' });
    } finally {
      await client.close();
    }
  });

  it('lifecycle signal aborted AFTER connect causes subsequent calls to reject', async () => {
    const controller = new AbortController();
    const client = echoClient(transport, { signal: controller.signal });
    try {
      await client.connect();
      await client.listTools();
      controller.abort(new Error('post-handshake lifecycle abort'));
      await expect(client.listTools()).rejects.toThrow(/not connected/);
    } finally {
      await client.close();
      await expect(client.close()).resolves.toBeUndefined();
    }
  });

  it('lifecycle + per-call composition — per-call rejects without closing client', async () => {
    const lifecycle = new AbortController();
    const client = echoClient(transport, { signal: lifecycle.signal });
    try {
      await client.connect();
      const perCall = new AbortController();
      perCall.abort(new Error('per-call wins'));
      await expect(client.listTools(perCall.signal)).rejects.toThrow();
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  it('forwards transport errors via the optional logger', async () => {
    const lines: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
    const client = echoClient(transport, {
      logger: (level, message, fields) => lines.push({ level, message, fields }),
    });
    try {
      await client.connect();
      // Synthetically invoke the SDK transport's `onerror` to verify the
      // logger wiring. Reproducing an actual transport-level error
      // deterministically across both transports is fixture-heavy; the
      // logger path is what this test exists to cover.
      const inner = (client as unknown as { transport?: { onerror?: (err: Error) => void } })
        .transport;
      inner?.onerror?.(new Error('synthetic transport error'));
      const warn = lines.find(
        (l) => l.level === 'warn' && l.message.includes('synthetic transport error'),
      );
      expect(warn).toBeDefined();
      expect(warn?.fields).toMatchObject({ url: expect.stringContaining('127.0.0.1') });
    } finally {
      await client.close();
    }
  });

  it('aborting mid-handshake rejects connect() against a hung server', async () => {
    const hang = await spawnFixture(HANG_FIXTURE);
    try {
      const controller = new AbortController();
      const client = new McpHttpClient({
        transport,
        url: urlFor(hang.baseUrl, transport),
        signal: controller.signal,
      });
      const pending = client.connect();
      setTimeout(() => controller.abort(new Error('mid-handshake abort')), 50);
      await expect(pending).rejects.toThrow();
      await client.close();
    } finally {
      await hang.kill();
    }
  });
});

describe('McpHttpClient (streamableHttp specifics)', () => {
  it('passes a custom header through requestInit', async () => {
    // No fixture-side echo for headers — we just confirm passing the option
    // doesn't break the handshake. Coverage target: the `requestInit`
    // branch in `buildTransport`.
    const client = echoClient('streamableHttp', {
      headers: { 'X-Test-Header': 'phase-5.2.2' },
    } as Partial<Extract<McpHttpClientOptions, { transport: 'streamableHttp' }>>);
    try {
      await client.connect();
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  it('accepts a partial reconnection options object', async () => {
    // Covers the reconnection-options forwarding branch (and SDK-default
    // backfilling for any missing keys).
    const client = echoClient('streamableHttp', {
      reconnection: { maxRetries: 0 },
    } as Partial<Extract<McpHttpClientOptions, { transport: 'streamableHttp' }>>);
    try {
      await client.connect();
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });
});

describe('McpHttpClient (sse specifics)', () => {
  it('passes a custom header through requestInit', async () => {
    const client = echoClient('sse', {
      headers: { 'X-Test-Header': 'phase-5.2.2-sse' },
    } as Partial<Extract<McpHttpClientOptions, { transport: 'sse' }>>);
    try {
      await client.connect();
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });
});
