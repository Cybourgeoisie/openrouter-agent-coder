import { describe, it, expect } from 'vitest';
import { SERVER_TOOLS, createServerToolsHooks } from './server-tools.js';

describe('SERVER_TOOLS', () => {
  it('includes datetime tool', () => {
    expect(SERVER_TOOLS).toContainEqual({ type: 'openrouter:datetime' });
  });

  it('includes web search tool', () => {
    expect(SERVER_TOOLS).toContainEqual({ type: 'openrouter:web_search' });
  });

  it('includes web fetch tool', () => {
    expect(SERVER_TOOLS).toContainEqual({ type: 'openrouter:web_fetch' });
  });
});

describe('createServerToolsHooks', () => {
  it('returns an SDKHooks instance', () => {
    const hooks = createServerToolsHooks();
    expect(hooks).toBeDefined();
    expect(hooks.beforeCreateRequestHooks).toHaveLength(1);
  });

  it('appends server tools to request body', () => {
    const hooks = createServerToolsHooks();
    const body = JSON.stringify({ model: 'test', tools: [{ type: 'function', name: 'f1' }] });
    const input = { url: new URL('https://example.com'), options: { body } };

    const result = hooks.beforeCreateRequest(
      {} as Parameters<typeof hooks.beforeCreateRequest>[0],
      input,
    );

    const parsed = JSON.parse((result as { options: { body: string } }).options.body);
    expect(parsed.tools).toHaveLength(1 + SERVER_TOOLS.length);
    expect(parsed.tools[0].name).toBe('f1');
    expect(parsed.tools.map((t: { type: string }) => t.type)).toContain('openrouter:datetime');
    expect(parsed.tools.map((t: { type: string }) => t.type)).toContain('openrouter:web_search');
    expect(parsed.tools.map((t: { type: string }) => t.type)).toContain('openrouter:web_fetch');
  });

  it('creates tools array when none exists', () => {
    const hooks = createServerToolsHooks();
    const body = JSON.stringify({ model: 'test' });
    const input = { url: new URL('https://example.com'), options: { body } };

    const result = hooks.beforeCreateRequest(
      {} as Parameters<typeof hooks.beforeCreateRequest>[0],
      input,
    );

    const parsed = JSON.parse((result as { options: { body: string } }).options.body);
    expect(parsed.tools).toHaveLength(SERVER_TOOLS.length);
  });

  it('passes through when body is not a string', () => {
    const hooks = createServerToolsHooks();
    const input = { url: new URL('https://example.com'), options: {} };

    const result = hooks.beforeCreateRequest(
      {} as Parameters<typeof hooks.beforeCreateRequest>[0],
      input,
    );

    expect(result).toEqual(input);
  });
});
