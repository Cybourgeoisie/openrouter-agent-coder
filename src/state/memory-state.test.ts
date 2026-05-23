import { describe, it, expect } from 'vitest';
import { createMemoryStateAccessor } from './memory-state.js';
import type { ConversationState } from '@openrouter/agent';

function makeState(overrides: Partial<ConversationState> = {}): ConversationState {
  return {
    id: 'conv_test',
    messages: [],
    status: 'in_progress',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('MemoryStateAccessor', () => {
  it('load returns null on a fresh accessor (mirrors file-state ENOENT → null)', async () => {
    const accessor = createMemoryStateAccessor();
    expect(await accessor.load()).toBeNull();
  });

  it('save then load round-trips the same object', async () => {
    const accessor = createMemoryStateAccessor();
    const state = makeState({ id: 'conv_roundtrip', previousResponseId: 'gen-abc-123' });

    await accessor.save(state);
    const loaded = await accessor.load();

    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe('conv_roundtrip');
    expect(loaded!.previousResponseId).toBe('gen-abc-123');
  });

  it('multiple saves overwrite cleanly', async () => {
    const accessor = createMemoryStateAccessor();
    await accessor.save(makeState({ id: 'first' }));
    await accessor.save(makeState({ id: 'second' }));
    const loaded = await accessor.load();
    expect(loaded!.id).toBe('second');
  });

  it('preserves message history across the cache', async () => {
    const accessor = createMemoryStateAccessor();
    const messages = [
      { role: 'user' as const, content: 'hello' },
      { role: 'assistant' as const, content: 'hi there' },
    ];
    await accessor.save(makeState({ messages }));
    const loaded = await accessor.load();
    expect(loaded!.messages).toEqual(messages);
  });

  it('two accessors do not share state (each constructs an isolated cache)', async () => {
    const a = createMemoryStateAccessor();
    const b = createMemoryStateAccessor();
    await a.save(makeState({ id: 'only-in-a' }));
    expect((await a.load())!.id).toBe('only-in-a');
    expect(await b.load()).toBeNull();
  });
});
