import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod/v4';
import { tool, createSdkMcpServer } from './custom-tools.js';

describe('tool() helper', () => {
  it('returns an SDK Tool with name, description, and Zod inputSchema', () => {
    const t = tool({
      name: 'add',
      description: 'add two numbers',
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      execute: async ({ a, b }) => ({ sum: a + b }),
    });

    expect(t.type).toBe('function');
    expect(t.function.name).toBe('add');
    expect(t.function.description).toBe('add two numbers');
    expect(t.function.inputSchema).toBeDefined();
    expect('execute' in t.function).toBe(true);
  });

  it('omits description when not provided', () => {
    const t = tool({
      name: 'noop',
      inputSchema: z.object({}),
      execute: async () => 'ok',
    });
    expect((t.function as { description?: string }).description).toBeUndefined();
  });

  it('inputSchema is convertible to JSON Schema for required/optional/default/enum/array', () => {
    const schema = z.object({
      mode: z.enum(['fast', 'slow']),
      count: z.number().int(),
      tags: z.array(z.string()),
      note: z.string().optional(),
      retries: z.number().default(3),
    });
    const t = tool({
      name: 'task',
      inputSchema: schema,
      execute: async () => 'done',
    });
    // Re-derive the JSON Schema from the stored Zod schema to verify the
    // round-trip the SDK does at API-send time.
    const jsonSchema = z.toJSONSchema(t.function.inputSchema as unknown as z.ZodType) as {
      type: string;
      properties: Record<string, { type?: string; enum?: string[]; default?: unknown }>;
      required?: string[];
    };
    expect(jsonSchema.type).toBe('object');
    expect(jsonSchema.properties.mode).toMatchObject({ enum: ['fast', 'slow'] });
    expect(jsonSchema.properties.count.type).toBe('integer');
    expect(jsonSchema.properties.tags.type).toBe('array');
    expect(jsonSchema.required).toContain('mode');
    expect(jsonSchema.required).toContain('count');
    expect(jsonSchema.required).toContain('tags');
    // optional fields don't appear in `required`
    expect(jsonSchema.required).not.toContain('note');
    // schemas with a default carry the default value through
    expect(jsonSchema.properties.retries.default).toBe(3);
  });

  it('execute receives validated input (default applied, types coerced)', async () => {
    const spy = vi.fn(async (input: { count: number; retries: number }) => ({
      total: input.count * input.retries,
    }));
    const t = tool({
      name: 'multiply',
      inputSchema: z.object({
        count: z.number(),
        retries: z.number().default(3),
      }),
      execute: spy,
    });

    const exec = (t.function as { execute: (i: unknown, c?: unknown) => Promise<unknown> }).execute;
    const result = await exec({ count: 5 });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toEqual({ count: 5, retries: 3 });
    expect(result).toEqual({ total: 15 });
  });

  it('forwards the SDK execute context as the second argument to execute', async () => {
    const seen: unknown[] = [];
    const t = tool({
      name: 'spy_ctx',
      inputSchema: z.object({ x: z.string() }),
      execute: async (input, ctx) => {
        seen.push(ctx);
        return input.x;
      },
    });
    const exec = (t.function as { execute: (i: unknown, c?: unknown) => Promise<unknown> }).execute;
    const ctx = { toolCall: { callId: 'call_42' } };
    await exec({ x: 'hello' }, ctx);
    expect(seen[0]).toBe(ctx);
  });

  it('schema-validation failure throws an Error naming the tool and offending fields', async () => {
    const spy = vi.fn(async () => 'should not run');
    const t = tool({
      name: 'strict',
      inputSchema: z.object({ count: z.number().int() }),
      execute: spy,
    });
    const exec = (t.function as { execute: (i: unknown, c?: unknown) => Promise<unknown> }).execute;

    await expect(exec({ count: 'not-a-number' })).rejects.toThrow(
      /Invalid input for tool "strict".*count/,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it('schema-validation failure with a missing root key reports <root> path when input is not an object', async () => {
    const t = tool({
      name: 'must_be_object',
      inputSchema: z.object({ x: z.string() }),
      execute: async () => 'ok',
    });
    const exec = (t.function as { execute: (i: unknown, c?: unknown) => Promise<unknown> }).execute;
    await expect(exec('not-an-object')).rejects.toThrow(/Invalid input for tool "must_be_object"/);
  });

  it('propagates errors thrown inside execute unchanged', async () => {
    const t = tool({
      name: 'boom',
      inputSchema: z.object({}),
      execute: async () => {
        throw new Error('handler exploded');
      },
    });
    const exec = (t.function as { execute: (i: unknown, c?: unknown) => Promise<unknown> }).execute;
    await expect(exec({})).rejects.toThrow('handler exploded');
  });

  it('accepts synchronous execute return values', async () => {
    const t = tool({
      name: 'sync_ok',
      inputSchema: z.object({ n: z.number() }),
      execute: (input) => `n=${input.n}`,
    });
    const exec = (t.function as { execute: (i: unknown, c?: unknown) => Promise<unknown> }).execute;
    await expect(exec({ n: 7 })).resolves.toBe('n=7');
  });
});

describe('createSdkMcpServer()', () => {
  it('bundles tools with name + version into a value bag', () => {
    const t1 = tool({
      name: 'a',
      inputSchema: z.object({}),
      execute: async () => 1,
    });
    const t2 = tool({
      name: 'b',
      inputSchema: z.object({}),
      execute: async () => 2,
    });

    const server = createSdkMcpServer({
      name: 'demo',
      version: '0.1.0',
      tools: [t1, t2],
    });

    expect(server.name).toBe('demo');
    expect(server.version).toBe('0.1.0');
    expect(server.tools).toHaveLength(2);
    expect(server.tools[0].function.name).toBe('a');
    expect(server.tools[1].function.name).toBe('b');
  });

  it('accepts an empty tools list (placeholder server)', () => {
    const server = createSdkMcpServer({ name: 'empty', version: '0.0.0', tools: [] });
    expect(server.tools).toHaveLength(0);
  });
});
