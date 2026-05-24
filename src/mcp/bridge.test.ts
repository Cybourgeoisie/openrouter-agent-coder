import { describe, it, expect, vi } from 'vitest';

import {
  McpBridge,
  MCP_TOOL_NAME_SEPARATOR,
  defaultClientFactory,
  mapMcpToolToTool,
  type McpBridgeClient,
  type McpClientFactory,
} from './bridge.js';
import type { McpServerConfig } from './config.js';

// ---------- stub client helpers ----------

interface StubToolDef {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  // Optional async handler; defaults to `{content: [{type:'text', text: 'ok'}]}`.
  handler?: (
    args: Record<string, unknown> | undefined,
    signal?: AbortSignal,
  ) => Promise<{ isError?: boolean; content?: unknown; [k: string]: unknown }>;
}

interface StubClientInit {
  tools: StubToolDef[];
  /** When set, `connect()` rejects with this error message. */
  connectError?: string;
  /** When set, `listTools()` rejects with this error message. */
  listError?: string;
  /** Track per-call args, signals, etc. */
  callLog?: Array<{ name: string; args: Record<string, unknown> | undefined; aborted: boolean }>;
  connectCount?: { value: number };
  closeCount?: { value: number };
}

function createStubClient(init: StubClientInit): McpBridgeClient {
  let closed = false;
  return {
    async connect(signal?: AbortSignal) {
      if (init.connectCount) init.connectCount.value += 1;
      if (signal?.aborted) throw new Error('aborted before connect');
      if (init.connectError) throw new Error(init.connectError);
    },
    async close() {
      if (init.closeCount) init.closeCount.value += 1;
      closed = true;
    },
    async listTools() {
      if (closed) throw new Error('closed');
      if (init.listError) throw new Error(init.listError);
      return {
        tools: init.tools.map((t) => ({
          name: t.name,
          ...(t.description !== undefined ? { description: t.description } : {}),
          inputSchema: t.inputSchema,
        })),
      };
    },
    async callTool(name, args, signal) {
      if (closed) throw new Error('closed');
      init.callLog?.push({ name, args, aborted: signal?.aborted ?? false });
      const tool = init.tools.find((t) => t.name === name);
      if (!tool) throw new Error(`no tool ${name}`);
      if (tool.handler) return tool.handler(args, signal);
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  };
}

function stdio(name: string): McpServerConfig {
  return {
    transport: 'stdio',
    name,
    command: 'node',
    args: ['x.js'],
    source: `/tmp/${name}.mcp.json`,
  };
}

// ---------- mapMcpToolToTool ----------

describe('mapMcpToolToTool', () => {
  it('produces a Tool whose name is the prefixed server__tool form', () => {
    const t = mapMcpToolToTool(
      'srv',
      { name: 'echo', inputSchema: { type: 'object', properties: { msg: { type: 'string' } } } },
      async () => ({ content: [{ type: 'text', text: 'k' }] }),
    );
    const fn = t.function as { name: string; description?: string };
    expect(fn.name).toBe(`srv${MCP_TOOL_NAME_SEPARATOR}echo`);
  });

  it('forwards the description verbatim when present', () => {
    const t = mapMcpToolToTool(
      'srv',
      { name: 'echo', description: 'echo back', inputSchema: { type: 'object' } },
      async () => ({ content: [] }),
    );
    const fn = t.function as { description?: string };
    expect(fn.description).toBe('echo back');
  });

  it('omits the description when MCP tool has none', () => {
    const t = mapMcpToolToTool(
      'srv',
      { name: 'echo', inputSchema: { type: 'object' } },
      async () => ({ content: [] }),
    );
    const fn = t.function as { description?: string };
    expect(fn.description).toBeUndefined();
  });

  it('passes JSON-Schema through unchanged via z.unknown().meta() (schema-passthrough)', async () => {
    const jsonSchema = {
      type: 'object',
      properties: { foo: { type: 'string', minLength: 1 }, bar: { type: 'integer' } },
      required: ['foo'],
    } as const;
    const t = mapMcpToolToTool('srv', { name: 'echo', inputSchema: jsonSchema }, async () => ({
      content: [],
    }));
    // The SDK invokes z.toJSONSchema on inputSchema to send to the model.
    const { z } = await import('zod/v4');
    const schema = (t.function as { inputSchema: unknown }).inputSchema;
    const out = z.toJSONSchema(schema as Parameters<typeof z.toJSONSchema>[0]);
    expect(out).toMatchObject(jsonSchema);
  });

  it('dispatches execute to the supplied callback with raw args and ctx.signal', async () => {
    const dispatch = vi.fn(async () => ({ content: [{ type: 'text', text: 'pong' }] }));
    const t = mapMcpToolToTool('srv', { name: 'echo', inputSchema: { type: 'object' } }, dispatch);
    const execute = (t.function as { execute: (i: unknown, c?: unknown) => Promise<unknown> })
      .execute;
    const controller = new AbortController();
    const result = await execute({ msg: 'hi' }, { signal: controller.signal });
    expect(dispatch).toHaveBeenCalledWith('echo', { msg: 'hi' }, controller.signal);
    expect(result).toMatchObject({ content: [{ type: 'text', text: 'pong' }] });
  });

  it('non-object input is forwarded as undefined args', async () => {
    const dispatch = vi.fn(async () => ({ content: [] }));
    const t = mapMcpToolToTool('srv', { name: 'echo', inputSchema: { type: 'object' } }, dispatch);
    const execute = (t.function as { execute: (i: unknown) => Promise<unknown> }).execute;
    await execute('not-an-object');
    expect(dispatch).toHaveBeenCalledWith('echo', undefined, undefined);
  });

  it('throws with {error:"mcp_tool_error"} JSON when MCP returns isError:true', async () => {
    const dispatch = vi.fn(async () => ({
      isError: true,
      content: [{ type: 'text', text: 'boom' }],
    }));
    const t = mapMcpToolToTool('srv', { name: 'echo', inputSchema: { type: 'object' } }, dispatch);
    const execute = (t.function as { execute: (i: unknown) => Promise<unknown> }).execute;
    await expect(execute({})).rejects.toThrow();
    try {
      await execute({});
    } catch (e) {
      const parsed = JSON.parse((e as Error).message);
      expect(parsed.error).toBe('mcp_tool_error');
      expect(parsed.result.isError).toBe(true);
    }
  });
});

// ---------- defaultClientFactory ----------

describe('defaultClientFactory', () => {
  it('returns an McpStdioClient instance for transport:"stdio"', () => {
    const client = defaultClientFactory({
      transport: 'stdio',
      name: 's',
      command: 'node',
      source: '/tmp/.mcp.json',
    });
    // We assert only the structural surface — no side-effects, no spawn yet.
    expect(typeof client.connect).toBe('function');
    expect(typeof client.callTool).toBe('function');
    expect(typeof client.close).toBe('function');
  });

  it('returns an McpHttpClient instance for transport:"http" (Streamable HTTP)', () => {
    const client = defaultClientFactory({
      transport: 'http',
      name: 's',
      url: 'https://example.test/mcp',
      source: '/tmp/.mcp.json',
    });
    expect(typeof client.connect).toBe('function');
    expect(typeof client.callTool).toBe('function');
  });

  it('forwards args/env onto the stdio client when present', () => {
    const client = defaultClientFactory({
      transport: 'stdio',
      name: 's',
      command: 'node',
      args: ['x.js'],
      env: { TOKEN: 'abc' },
      source: '/tmp/.mcp.json',
    });
    expect(typeof client.connect).toBe('function');
  });

  it('forwards headers onto the http client when present', () => {
    const client = defaultClientFactory({
      transport: 'http',
      name: 's',
      url: 'https://example.test/mcp',
      headers: { Authorization: 'Bearer x' },
      source: '/tmp/.mcp.json',
    });
    expect(typeof client.connect).toBe('function');
  });
});

// ---------- McpBridge ----------

describe('McpBridge', () => {
  it('init() is a no-op for an empty server list', async () => {
    const factory = vi.fn();
    const bridge = new McpBridge({ servers: [], clientFactory: factory as McpClientFactory });
    await bridge.init();
    expect(bridge.tools).toEqual([]);
    expect(factory).not.toHaveBeenCalled();
  });

  it('init() spawns each server and lists their tools (discovery)', async () => {
    const aClient = createStubClient({
      tools: [{ name: 'do_a', inputSchema: { type: 'object' } }],
    });
    const bClient = createStubClient({
      tools: [{ name: 'do_b', inputSchema: { type: 'object' } }],
    });
    const bridge = new McpBridge({
      servers: [stdio('a'), stdio('b')],
      clientFactory: (s) => (s.name === 'a' ? aClient : bClient),
    });
    await bridge.init();

    const names = bridge.tools.map((t) => (t.function as { name: string }).name).sort();
    expect(names).toEqual(['a__do_a', 'b__do_b']);
    expect([...bridge.serverNames].sort()).toEqual(['a', 'b']);
  });

  it('dispatches each Tool invocation back to the originating server', async () => {
    const aLog: Array<{
      name: string;
      args: Record<string, unknown> | undefined;
      aborted: boolean;
    }> = [];
    const bLog: typeof aLog = [];
    const aClient = createStubClient({
      tools: [{ name: 'tool', inputSchema: { type: 'object' } }],
      callLog: aLog,
    });
    const bClient = createStubClient({
      tools: [{ name: 'tool', inputSchema: { type: 'object' } }],
      callLog: bLog,
    });
    const bridge = new McpBridge({
      servers: [stdio('a'), stdio('b')],
      clientFactory: (s) => (s.name === 'a' ? aClient : bClient),
    });
    await bridge.init();

    const aTool = bridge.tools.find((t) => (t.function as { name: string }).name === 'a__tool');
    const bTool = bridge.tools.find((t) => (t.function as { name: string }).name === 'b__tool');
    expect(aTool).toBeDefined();
    expect(bTool).toBeDefined();

    const execA = (aTool!.function as { execute: (i: unknown, c?: unknown) => Promise<unknown> })
      .execute;
    const execB = (bTool!.function as { execute: (i: unknown, c?: unknown) => Promise<unknown> })
      .execute;
    await execA({ which: 'a-call' });
    await execB({ which: 'b-call' });

    expect(aLog).toEqual([{ name: 'tool', args: { which: 'a-call' }, aborted: false }]);
    expect(bLog).toEqual([{ name: 'tool', args: { which: 'b-call' }, aborted: false }]);
  });

  it('prefix-collision: two servers with the same toolName produce distinct prefixed names', async () => {
    const aClient = createStubClient({
      tools: [{ name: 'common', inputSchema: { type: 'object' } }],
    });
    const bClient = createStubClient({
      tools: [{ name: 'common', inputSchema: { type: 'object' } }],
    });
    const bridge = new McpBridge({
      servers: [stdio('alpha'), stdio('beta')],
      clientFactory: (s) => (s.name === 'alpha' ? aClient : bClient),
    });
    await bridge.init();
    const names = bridge.tools.map((t) => (t.function as { name: string }).name).sort();
    expect(names).toEqual(['alpha__common', 'beta__common']);
  });

  it('schema passthrough: MCP JSON Schema reaches the model unmodified', async () => {
    const inputSchema = {
      type: 'object',
      properties: { count: { type: 'integer', minimum: 0 }, label: { type: 'string' } },
      required: ['count'],
      additionalProperties: false,
    };
    const client = createStubClient({ tools: [{ name: 'echo', inputSchema }] });
    const bridge = new McpBridge({
      servers: [stdio('srv')],
      clientFactory: () => client,
    });
    await bridge.init();
    const wrapped = bridge.tools[0];
    expect(wrapped).toBeDefined();
    const { z } = await import('zod/v4');
    const schema = (wrapped.function as { inputSchema: unknown }).inputSchema;
    const out = z.toJSONSchema(schema as Parameters<typeof z.toJSONSchema>[0]);
    expect(out).toMatchObject(inputSchema);
  });

  it('schema passthrough: args dispatch through to the server byte-for-byte', async () => {
    const log: Array<{
      name: string;
      args: Record<string, unknown> | undefined;
      aborted: boolean;
    }> = [];
    const client = createStubClient({
      tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
      callLog: log,
    });
    const bridge = new McpBridge({
      servers: [stdio('srv')],
      clientFactory: () => client,
    });
    await bridge.init();
    const tool = bridge.tools[0];
    const execute = (tool.function as { execute: (i: unknown) => Promise<unknown> }).execute;
    const args = { nested: { a: 1, b: ['x', 'y'] }, flag: true };
    await execute(args);
    expect(log).toHaveLength(1);
    expect(log[0].args).toEqual(args);
  });

  it('per-server init failure: logs + fires notify(warn) + continues with remaining servers', async () => {
    const logger = vi.fn();
    const notify = vi.fn();
    const goodClient = createStubClient({
      tools: [{ name: 'ok', inputSchema: { type: 'object' } }],
    });
    const badClient = createStubClient({ tools: [], connectError: 'spawn ENOENT' });
    const bridge = new McpBridge({
      servers: [stdio('good'), stdio('bad')],
      clientFactory: (s) => (s.name === 'good' ? goodClient : badClient),
      logger,
      notify,
    });
    await bridge.init();

    // Bridge stays alive with the survivor's tools.
    expect(bridge.serverNames).toEqual(['good']);
    const names = bridge.tools.map((t) => (t.function as { name: string }).name);
    expect(names).toEqual(['good__ok']);

    // Notification fired for the failing server.
    expect(notify).toHaveBeenCalledWith(
      'warn',
      'mcp_server_failed',
      expect.objectContaining({ name: 'bad', error: expect.stringContaining('spawn ENOENT') }),
    );
    // Logger captured the failure at warn level.
    const warnCall = logger.mock.calls.find((c: unknown[]) => c[0] === 'warn');
    expect(warnCall).toBeDefined();
  });

  it('listTools failure on one server still allows others through', async () => {
    const okClient = createStubClient({
      tools: [{ name: 'fine', inputSchema: { type: 'object' } }],
    });
    const flakyClient = createStubClient({ tools: [], listError: 'no tools/list method' });
    const notify = vi.fn();
    const bridge = new McpBridge({
      servers: [stdio('ok'), stdio('flaky')],
      clientFactory: (s) => (s.name === 'ok' ? okClient : flakyClient),
      notify,
    });
    await bridge.init();
    expect(bridge.serverNames).toEqual(['ok']);
    expect(notify).toHaveBeenCalledWith('warn', 'mcp_server_failed', expect.any(Object));
  });

  it('notify() throw inside init failure handler does not derail the bridge', async () => {
    const notify = vi.fn(() => Promise.reject(new Error('notify boom')));
    const ok = createStubClient({ tools: [{ name: 'ok', inputSchema: { type: 'object' } }] });
    const bad = createStubClient({ tools: [], connectError: 'fail' });
    const bridge = new McpBridge({
      servers: [stdio('ok'), stdio('bad')],
      clientFactory: (s) => (s.name === 'ok' ? ok : bad),
      notify,
    });
    await expect(bridge.init()).resolves.toBeUndefined();
    expect(bridge.serverNames).toEqual(['ok']);
  });

  it('close() tears down every initialised server', async () => {
    const closeA = { value: 0 };
    const closeB = { value: 0 };
    const a = createStubClient({
      tools: [{ name: 't', inputSchema: { type: 'object' } }],
      closeCount: closeA,
    });
    const b = createStubClient({
      tools: [{ name: 't', inputSchema: { type: 'object' } }],
      closeCount: closeB,
    });
    const bridge = new McpBridge({
      servers: [stdio('a'), stdio('b')],
      clientFactory: (s) => (s.name === 'a' ? a : b),
    });
    await bridge.init();
    await bridge.close();
    expect(closeA.value).toBe(1);
    expect(closeB.value).toBe(1);
  });

  it('close() is idempotent — safe to call multiple times', async () => {
    const closeCount = { value: 0 };
    const a = createStubClient({
      tools: [{ name: 't', inputSchema: { type: 'object' } }],
      closeCount,
    });
    const bridge = new McpBridge({ servers: [stdio('a')], clientFactory: () => a });
    await bridge.init();
    await bridge.close();
    await bridge.close();
    expect(closeCount.value).toBe(1);
  });

  it('close() before init() is a safe no-op', async () => {
    const bridge = new McpBridge({
      servers: [stdio('a')],
      clientFactory: () => createStubClient({ tools: [] }),
    });
    await expect(bridge.close()).resolves.toBeUndefined();
  });

  it('close() swallows per-server teardown errors', async () => {
    const flaky: McpBridgeClient = {
      async connect() {},
      async close() {
        throw new Error('close boom');
      },
      async listTools() {
        return { tools: [{ name: 'x', inputSchema: { type: 'object' } }] };
      },
      async callTool() {
        return { content: [] };
      },
    };
    const logger = vi.fn();
    const bridge = new McpBridge({
      servers: [stdio('flaky')],
      clientFactory: () => flaky,
      logger,
    });
    await bridge.init();
    await expect(bridge.close()).resolves.toBeUndefined();
  });

  it('pre-aborted signal: init() does not spawn any servers', async () => {
    const factory = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const bridge = new McpBridge({
      servers: [stdio('a')],
      signal: controller.signal,
      clientFactory: factory as McpClientFactory,
    });
    await bridge.init();
    expect(factory).not.toHaveBeenCalled();
    expect(bridge.tools).toEqual([]);
  });

  it('per-tool-call signal: ctx.signal propagates to the underlying callTool', async () => {
    const log: Array<{
      name: string;
      args: Record<string, unknown> | undefined;
      aborted: boolean;
    }> = [];
    const client = createStubClient({
      tools: [{ name: 'go', inputSchema: { type: 'object' } }],
      callLog: log,
    });
    const bridge = new McpBridge({ servers: [stdio('srv')], clientFactory: () => client });
    await bridge.init();
    const tool = bridge.tools[0];
    const execute = (tool.function as { execute: (i: unknown, c?: unknown) => Promise<unknown> })
      .execute;
    const controller = new AbortController();
    controller.abort();
    await execute({}, { signal: controller.signal });
    expect(log[0].aborted).toBe(true);
  });

  it('init() after close() short-circuits (closed bridge stays closed)', async () => {
    const factory = vi.fn();
    const bridge = new McpBridge({
      servers: [stdio('a')],
      clientFactory: factory as McpClientFactory,
    });
    await bridge.close();
    await bridge.init();
    expect(factory).not.toHaveBeenCalled();
    expect(bridge.tools).toEqual([]);
  });

  it('close() logs swallowed errors at debug level with the error message', async () => {
    const logger = vi.fn();
    const flaky: McpBridgeClient = {
      async connect() {},
      async close() {
        throw new Error('teardown boom');
      },
      async listTools() {
        return { tools: [{ name: 'x', inputSchema: { type: 'object' } }] };
      },
      async callTool() {
        return { content: [] };
      },
    };
    const bridge = new McpBridge({
      servers: [stdio('flaky')],
      clientFactory: () => flaky,
      logger,
    });
    await bridge.init();
    await bridge.close();
    const debugCall = logger.mock.calls.find(
      (c: unknown[]) => c[0] === 'debug' && String(c[1]).includes('close() of flaky'),
    );
    expect(debugCall).toBeDefined();
    expect((debugCall as unknown[])[2]).toMatchObject({ error: 'teardown boom' });
  });

  it('close() logs swallowed non-Error throws via String(err) fallback', async () => {
    const logger = vi.fn();
    const flaky: McpBridgeClient = {
      async connect() {},
      async close() {
        throw 'bare-string-error';
      },
      async listTools() {
        return { tools: [{ name: 'x', inputSchema: { type: 'object' } }] };
      },
      async callTool() {
        return { content: [] };
      },
    };
    const bridge = new McpBridge({
      servers: [stdio('flaky')],
      clientFactory: () => flaky,
      logger,
    });
    await bridge.init();
    await bridge.close();
    const debugCall = logger.mock.calls.find(
      (c: unknown[]) => c[0] === 'debug' && String(c[1]).includes('close() of flaky'),
    );
    expect(debugCall).toBeDefined();
    expect((debugCall as unknown[])[2]).toMatchObject({ error: 'bare-string-error' });
  });

  it('init failure with a non-Error throw is logged via String(err) fallback', async () => {
    const logger = vi.fn();
    const notify = vi.fn();
    const flaky: McpBridgeClient = {
      async connect() {
        throw 42;
      },
      async close() {},
      async listTools() {
        return { tools: [] };
      },
      async callTool() {
        return { content: [] };
      },
    };
    const bridge = new McpBridge({
      servers: [stdio('flaky')],
      clientFactory: () => flaky,
      logger,
      notify,
    });
    await bridge.init();
    const warnCall = logger.mock.calls.find((c: unknown[]) => c[0] === 'warn');
    expect(warnCall).toBeDefined();
    expect(String((warnCall as unknown[])[1])).toContain('42');
    expect(notify).toHaveBeenCalledWith(
      'warn',
      'mcp_server_failed',
      expect.objectContaining({ error: '42' }),
    );
  });

  it('init failure: best-effort close() throwing does not break the loop', async () => {
    const broken: McpBridgeClient = {
      async connect() {
        throw new Error('connect fail');
      },
      async close() {
        throw new Error('cleanup fail too');
      },
      async listTools() {
        return { tools: [] };
      },
      async callTool() {
        return { content: [] };
      },
    };
    const ok = createStubClient({ tools: [{ name: 'survives', inputSchema: { type: 'object' } }] });
    const bridge = new McpBridge({
      servers: [stdio('broken'), stdio('ok')],
      clientFactory: (s) => (s.name === 'broken' ? broken : ok),
    });
    await bridge.init();
    expect(bridge.serverNames).toEqual(['ok']);
  });

  it('double init() is a no-op (second call short-circuits)', async () => {
    const connectCount = { value: 0 };
    const client = createStubClient({
      tools: [{ name: 'x', inputSchema: { type: 'object' } }],
      connectCount,
    });
    const bridge = new McpBridge({
      servers: [stdio('a')],
      clientFactory: () => client,
    });
    await bridge.init();
    await bridge.init();
    expect(connectCount.value).toBe(1);
  });
});

// ---------- Phase 5.2.5: lifecycle hooks (McpServerStart / McpServerStop) ----------

describe('McpBridge lifecycle hooks', () => {
  it('fires McpServerStart per server after successful init with capabilities counts', async () => {
    const aClient: McpBridgeClient = {
      ...createStubClient({ tools: [{ name: 't1', inputSchema: { type: 'object' } }] }),
      async listResources() {
        return { resources: [{ uri: 'mem://x' }, { uri: 'mem://y' }] };
      },
      async listPrompts() {
        return { prompts: [{ name: 'p' }] };
      },
    };
    const onLifecycle = vi.fn();
    const bridge = new McpBridge({
      servers: [stdio('a')],
      clientFactory: () => aClient,
      onLifecycle,
    });
    await bridge.init();
    expect(onLifecycle).toHaveBeenCalledTimes(1);
    expect(onLifecycle).toHaveBeenCalledWith('McpServerStart', {
      event: 'McpServerStart',
      serverName: 'a',
      transport: 'stdio',
      capabilities: { tools: 1, resources: 2, prompts: 1 },
    });
  });

  it('McpServerStart uses transport:"streamableHttp" for http config', async () => {
    const client = createStubClient({ tools: [] });
    const onLifecycle = vi.fn();
    const bridge = new McpBridge({
      servers: [
        {
          transport: 'http',
          name: 'h',
          url: 'https://example.test/mcp',
          source: '/tmp/.mcp.json',
        },
      ],
      clientFactory: () => client,
      onLifecycle,
    });
    await bridge.init();
    expect(onLifecycle).toHaveBeenCalledWith(
      'McpServerStart',
      expect.objectContaining({ transport: 'streamableHttp' }),
    );
  });

  it('McpServerStart treats missing listResources/listPrompts as 0', async () => {
    const client = createStubClient({
      tools: [{ name: 'only', inputSchema: { type: 'object' } }],
    });
    const onLifecycle = vi.fn();
    const bridge = new McpBridge({
      servers: [stdio('s')],
      clientFactory: () => client,
      onLifecycle,
    });
    await bridge.init();
    expect(onLifecycle).toHaveBeenCalledWith(
      'McpServerStart',
      expect.objectContaining({ capabilities: { tools: 1, resources: 0, prompts: 0 } }),
    );
  });

  it('McpServerStart treats list*() results with undefined arrays as 0', async () => {
    const client: McpBridgeClient = {
      ...createStubClient({ tools: [{ name: 't', inputSchema: { type: 'object' } }] }),
      // Force the `resources?.length ?? 0` / `prompts?.length ?? 0` fallback
      // branches by returning a result with the array field missing.
      async listResources() {
        return { resources: undefined as unknown as ReadonlyArray<unknown> };
      },
      async listPrompts() {
        return { prompts: undefined as unknown as ReadonlyArray<unknown> };
      },
    };
    const onLifecycle = vi.fn();
    const bridge = new McpBridge({
      servers: [stdio('s')],
      clientFactory: () => client,
      onLifecycle,
    });
    await bridge.init();
    expect(onLifecycle).toHaveBeenCalledWith(
      'McpServerStart',
      expect.objectContaining({ capabilities: { tools: 1, resources: 0, prompts: 0 } }),
    );
  });

  it('McpServerStart treats rejected listResources/listPrompts as 0 (Method not found tolerance)', async () => {
    const client: McpBridgeClient = {
      ...createStubClient({ tools: [{ name: 't', inputSchema: { type: 'object' } }] }),
      async listResources() {
        throw new Error('Method not found');
      },
      async listPrompts() {
        throw new Error('Method not found');
      },
    };
    const onLifecycle = vi.fn();
    const bridge = new McpBridge({
      servers: [stdio('s')],
      clientFactory: () => client,
      onLifecycle,
    });
    await bridge.init();
    expect(onLifecycle).toHaveBeenCalledWith(
      'McpServerStart',
      expect.objectContaining({ capabilities: { tools: 1, resources: 0, prompts: 0 } }),
    );
  });

  it('McpServerStart does NOT fire when a server fails its handshake (notify warn fires instead)', async () => {
    const onLifecycle = vi.fn();
    const notify = vi.fn();
    const bad = createStubClient({ tools: [], connectError: 'spawn ENOENT' });
    const bridge = new McpBridge({
      servers: [stdio('bad')],
      clientFactory: () => bad,
      onLifecycle,
      notify,
    });
    await bridge.init();
    expect(onLifecycle).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith('warn', 'mcp_server_failed', expect.any(Object));
  });

  it('fires McpServerStop with reason:"closed" on normal teardown + positive durationMs', async () => {
    const onLifecycle = vi.fn();
    const a = createStubClient({ tools: [{ name: 't', inputSchema: { type: 'object' } }] });
    const bridge = new McpBridge({
      servers: [stdio('a')],
      clientFactory: () => a,
      onLifecycle,
    });
    await bridge.init();
    // Force at least 1ms to pass so durationMs is >= 0 reliably.
    await new Promise((r) => setTimeout(r, 2));
    await bridge.close();
    const stopCalls = onLifecycle.mock.calls.filter((c: unknown[]) => c[0] === 'McpServerStop');
    expect(stopCalls).toHaveLength(1);
    const payload = stopCalls[0][1] as { reason: string; durationMs: number; serverName: string };
    expect(payload.serverName).toBe('a');
    expect(payload.reason).toBe('closed');
    expect(payload.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('fires McpServerStop with reason:"error" when close() throws', async () => {
    const onLifecycle = vi.fn();
    const flaky: McpBridgeClient = {
      async connect() {},
      async close() {
        throw new Error('teardown boom');
      },
      async listTools() {
        return { tools: [{ name: 'x', inputSchema: { type: 'object' } }] };
      },
      async callTool() {
        return { content: [] };
      },
    };
    const bridge = new McpBridge({
      servers: [stdio('flaky')],
      clientFactory: () => flaky,
      onLifecycle,
    });
    await bridge.init();
    await bridge.close();
    const stopCall = onLifecycle.mock.calls.find((c: unknown[]) => c[0] === 'McpServerStop');
    expect(stopCall).toBeDefined();
    expect((stopCall as unknown[])[1]).toMatchObject({ reason: 'error', serverName: 'flaky' });
  });

  it('fires McpServerStop with reason:"aborted" when the run-level signal is aborted at close time', async () => {
    const onLifecycle = vi.fn();
    const controller = new AbortController();
    const a = createStubClient({ tools: [{ name: 't', inputSchema: { type: 'object' } }] });
    const bridge = new McpBridge({
      servers: [stdio('a')],
      clientFactory: () => a,
      onLifecycle,
      signal: controller.signal,
    });
    await bridge.init();
    controller.abort();
    await bridge.close();
    const stopCall = onLifecycle.mock.calls.find((c: unknown[]) => c[0] === 'McpServerStop');
    expect(stopCall).toBeDefined();
    expect((stopCall as unknown[])[1]).toMatchObject({ reason: 'aborted', serverName: 'a' });
  });

  it('does NOT fire McpServerStop for servers that failed init (symmetric with no-start)', async () => {
    const onLifecycle = vi.fn();
    const bad = createStubClient({ tools: [], connectError: 'fail' });
    const bridge = new McpBridge({
      servers: [stdio('bad')],
      clientFactory: () => bad,
      onLifecycle,
    });
    await bridge.init();
    await bridge.close();
    const stopCalls = onLifecycle.mock.calls.filter((c: unknown[]) => c[0] === 'McpServerStop');
    expect(stopCalls).toHaveLength(0);
  });

  it('onLifecycle throw during start does not derail the bridge (init still succeeds, server still live)', async () => {
    const onLifecycle = vi.fn(() => Promise.reject(new Error('hook boom')));
    const a = createStubClient({ tools: [{ name: 't', inputSchema: { type: 'object' } }] });
    const bridge = new McpBridge({
      servers: [stdio('a')],
      clientFactory: () => a,
      onLifecycle,
    });
    await expect(bridge.init()).resolves.toBeUndefined();
    expect(bridge.serverNames).toEqual(['a']);
    // The handshake completed even though the lifecycle emitter threw.
    expect(bridge.tools).toHaveLength(1);
  });

  it('onLifecycle throw during stop does not derail close()', async () => {
    let startCount = 0;
    const onLifecycle = vi.fn(() => {
      startCount += 1;
      return Promise.reject(new Error('hook boom'));
    });
    const closeCount = { value: 0 };
    const a = createStubClient({
      tools: [{ name: 't', inputSchema: { type: 'object' } }],
      closeCount,
    });
    const bridge = new McpBridge({
      servers: [stdio('a')],
      clientFactory: () => a,
      onLifecycle,
    });
    await bridge.init();
    await expect(bridge.close()).resolves.toBeUndefined();
    expect(closeCount.value).toBe(1);
    expect(startCount).toBeGreaterThanOrEqual(2); // start + stop both invoked
  });
});

describe('McpBridge.catalog (Phase 5.5)', () => {
  it('is empty before init() and after close()', async () => {
    const client = createStubClient({
      tools: [{ name: 't', inputSchema: { type: 'object' } }],
    });
    const bridge = new McpBridge({
      servers: [stdio('a')],
      clientFactory: () => client,
    });
    expect(bridge.catalog).toEqual([]);
    await bridge.init();
    expect(bridge.catalog.length).toBe(1);
    await bridge.close();
    expect(bridge.catalog).toEqual([]);
  });

  it('projects each entry with prefixed name, server, description, inputSchema', async () => {
    const inputSchema = {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    };
    const client = createStubClient({
      tools: [
        { name: 'echo', description: 'Echo the input', inputSchema },
        { name: 'noop', inputSchema: { type: 'object' } },
      ],
    });
    const bridge = new McpBridge({
      servers: [stdio('srv')],
      clientFactory: () => client,
    });
    await bridge.init();
    const catalog = [...bridge.catalog].sort((a, b) => a.name.localeCompare(b.name));
    expect(catalog).toEqual([
      {
        name: 'srv__echo',
        server: 'srv',
        description: 'Echo the input',
        inputSchema,
      },
      {
        name: 'srv__noop',
        server: 'srv',
        inputSchema: { type: 'object' },
      },
    ]);
  });

  it('flattens across multiple servers', async () => {
    const a = createStubClient({ tools: [{ name: 't', inputSchema: { type: 'object' } }] });
    const b = createStubClient({ tools: [{ name: 't', inputSchema: { type: 'object' } }] });
    const bridge = new McpBridge({
      servers: [stdio('a'), stdio('b')],
      clientFactory: (s) => (s.name === 'a' ? a : b),
    });
    await bridge.init();
    const names = bridge.catalog.map((c) => c.name).sort();
    expect(names).toEqual(['a__t', 'b__t']);
  });

  it('uses the configured MCP_TOOL_NAME_SEPARATOR for the name prefix', async () => {
    const client = createStubClient({ tools: [{ name: 't', inputSchema: {} }] });
    const bridge = new McpBridge({
      servers: [stdio('srv')],
      clientFactory: () => client,
    });
    await bridge.init();
    expect(bridge.catalog[0]?.name).toBe(`srv${MCP_TOOL_NAME_SEPARATOR}t`);
  });

  it('skips servers whose handshake failed', async () => {
    const good = createStubClient({ tools: [{ name: 'ok', inputSchema: {} }] });
    const bad = createStubClient({ tools: [], connectError: 'no-connect' });
    const bridge = new McpBridge({
      servers: [stdio('good'), stdio('bad')],
      clientFactory: (s) => (s.name === 'good' ? good : bad),
    });
    await bridge.init();
    expect(bridge.catalog.map((c) => c.server)).toEqual(['good']);
  });
});
