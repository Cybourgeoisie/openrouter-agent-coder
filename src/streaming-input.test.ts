import { describe, it, expect } from 'vitest';
import type { ConversationState } from '@openrouter/agent';
import {
  StreamingInputSource,
  commitPartialResponse,
  isAsyncIterable,
  normalizeUserInput,
  setInterruptedFlag,
  userInputToCallModelItem,
  type UserInput,
} from './streaming-input.js';

describe('isAsyncIterable', () => {
  it('returns true for async generators', () => {
    async function* gen() {
      yield 1;
    }
    expect(isAsyncIterable(gen())).toBe(true);
  });
  it('returns true for hand-rolled iterables', () => {
    const v = { [Symbol.asyncIterator]: async function* () {} };
    expect(isAsyncIterable(v)).toBe(true);
  });
  it('returns false for strings, arrays, plain objects, null, undefined', () => {
    expect(isAsyncIterable('hello')).toBe(false);
    expect(isAsyncIterable([1, 2])).toBe(false);
    expect(isAsyncIterable({})).toBe(false);
    expect(isAsyncIterable(null)).toBe(false);
    expect(isAsyncIterable(undefined)).toBe(false);
  });
});

describe('normalizeUserInput', () => {
  it('wraps a string into { content: string }', () => {
    expect(normalizeUserInput('hi')).toEqual({ content: 'hi' });
  });
  it('passes a UserInput struct through unchanged', () => {
    const input: UserInput = { content: [{ type: 'input_text', text: 'x' }] };
    expect(normalizeUserInput(input)).toBe(input);
  });
});

describe('userInputToCallModelItem', () => {
  it('produces a role:user item for a string content', () => {
    expect(userInputToCallModelItem({ content: 'hi' })).toEqual({
      role: 'user',
      content: 'hi',
    });
  });
  it('passes a ContentBlock array through verbatim', () => {
    const blocks = [
      { type: 'input_text', text: 'see' },
      { type: 'input_image', image_url: 'https://x/y.png', detail: 'low' },
    ];
    expect(userInputToCallModelItem({ content: blocks })).toEqual({
      role: 'user',
      content: blocks,
    });
  });
});

describe('StreamingInputSource', () => {
  it('yields the wrapped string then ends when prompt is a string and no pushes happen', async () => {
    const s = new StreamingInputSource('hello');
    expect(await s.next()).toEqual({ value: { content: 'hello' }, done: false });
    expect(await s.next()).toEqual({ value: undefined, done: true });
    expect(s.isExhausted()).toBe(true);
  });

  it('drains the queue (FIFO) after the initial string', async () => {
    const s = new StreamingInputSource('first');
    s.push('second');
    s.push({ content: 'third' });
    const r1 = await s.next();
    const r2 = await s.next();
    const r3 = await s.next();
    const r4 = await s.next();
    expect(r1.value).toEqual({ content: 'first' });
    expect(r2.value).toEqual({ content: 'second' });
    expect(r3.value).toEqual({ content: 'third' });
    expect(r4.done).toBe(true);
  });

  it('pulls from the AsyncIterable when no pushed messages are queued', async () => {
    async function* iter(): AsyncGenerator<UserInput> {
      yield { content: 'a' };
      yield { content: 'b' };
    }
    const s = new StreamingInputSource(iter());
    expect((await s.next()).value).toEqual({ content: 'a' });
    expect((await s.next()).value).toEqual({ content: 'b' });
    expect((await s.next()).done).toBe(true);
  });

  it('drains the queue before pulling the iterable on each next()', async () => {
    async function* iter(): AsyncGenerator<UserInput> {
      yield { content: 'i1' };
      yield { content: 'i2' };
    }
    const s = new StreamingInputSource(iter());
    s.push('p1');
    s.push('p2');
    // Queue first
    expect((await s.next()).value).toEqual({ content: 'p1' });
    expect((await s.next()).value).toEqual({ content: 'p2' });
    // Then iterable
    expect((await s.next()).value).toEqual({ content: 'i1' });
    s.push('p3');
    // Queue interleaves between iter pulls
    expect((await s.next()).value).toEqual({ content: 'p3' });
    expect((await s.next()).value).toEqual({ content: 'i2' });
    expect((await s.next()).done).toBe(true);
  });

  it('returns a late-arriving queue value if a push lands while the iterable returns done', async () => {
    let pulled = 0;
    let resolveSecond: () => void = () => undefined;
    const secondReady = new Promise<void>((res) => {
      resolveSecond = res;
    });
    async function* iter(): AsyncGenerator<UserInput> {
      if (pulled === 0) {
        pulled++;
        yield { content: 'i1' };
      }
      // Block here so the test can push() before iter signals done
      await secondReady;
      // Then end.
    }
    const s = new StreamingInputSource(iter());
    expect((await s.next()).value).toEqual({ content: 'i1' });
    // Start the next() — it'll await the iterator's blocked next() call.
    const pendingNext = s.next();
    // Race: push while pendingNext is waiting on iter.
    s.push('late');
    // Now release the iterator → it returns done.
    resolveSecond();
    const r = await pendingNext;
    expect(r).toEqual({ value: { content: 'late' }, done: false });
    expect((await s.next()).done).toBe(true);
  });

  it('isExhausted reflects pending initial + queue + iter state', async () => {
    const s = new StreamingInputSource('only');
    expect(s.isExhausted()).toBe(false);
    await s.next();
    expect(s.isExhausted()).toBe(true);
    s.push('later');
    expect(s.isExhausted()).toBe(false);
    await s.next();
    expect(s.isExhausted()).toBe(true);
  });

  it('isExhausted is false while the AsyncIterable is in progress', async () => {
    async function* iter(): AsyncGenerator<UserInput> {
      yield { content: 'a' };
      yield { content: 'b' };
    }
    const s = new StreamingInputSource(iter());
    // Iter present, not yet exhausted → exhausted check returns false even
    // before next() is called.
    expect(s.isExhausted()).toBe(false);
    await s.next();
    expect(s.isExhausted()).toBe(false);
    await s.next();
    // Iter has yielded its last but not yet signalled done — still in progress
    // until the next pull reveals done. Drain once more.
    await s.next();
    expect(s.isExhausted()).toBe(true);
  });
});

function makeMemoryAccessor(): {
  load: () => Promise<ConversationState | null>;
  save: (s: ConversationState) => Promise<void>;
  current: () => ConversationState | null;
} {
  let cache: ConversationState | null = null;
  return {
    load: async () => cache,
    save: async (s) => {
      cache = s;
    },
    current: () => cache,
  };
}

describe('commitPartialResponse', () => {
  it('is a no-op when state is null', async () => {
    const acc = makeMemoryAccessor();
    await commitPartialResponse(acc);
    expect(acc.current()).toBeNull();
  });

  it('is a no-op when there is no partialResponse field', async () => {
    const acc = makeMemoryAccessor();
    const state: ConversationState = {
      id: 'x',
      messages: [{ type: 'message', role: 'user', content: 'hi' }],
      status: 'complete',
      createdAt: 1,
      updatedAt: 2,
    } as ConversationState;
    await acc.save(state);
    await commitPartialResponse(acc);
    expect(acc.current()).toEqual(state);
  });

  it('drops a partialResponse that has only toolCalls (no text) without committing anything', async () => {
    const acc = makeMemoryAccessor();
    const baseMsgs = [{ type: 'message', role: 'user', content: 'hi' }];
    const state = {
      id: 'x',
      messages: baseMsgs,
      status: 'interrupted',
      partialResponse: { toolCalls: [{ callId: 'c1', name: 'foo', arguments: '{}' }] },
      createdAt: 1,
      updatedAt: 2,
    } as unknown as ConversationState;
    await acc.save(state);
    await commitPartialResponse(acc);
    const next = acc.current()!;
    expect((next as { partialResponse?: unknown }).partialResponse).toBeUndefined();
    expect(next.messages).toEqual(baseMsgs);
  });

  it('commits partialResponse.text as a new assistant message and clears the field', async () => {
    const acc = makeMemoryAccessor();
    const baseMsgs = [{ type: 'message', role: 'user', content: 'hello' }];
    const state = {
      id: 'x',
      messages: baseMsgs,
      status: 'interrupted',
      partialResponse: { text: 'in-progress answer' },
      createdAt: 1,
      updatedAt: 2,
    } as unknown as ConversationState;
    await acc.save(state);
    await commitPartialResponse(acc);
    const next = acc.current()!;
    expect((next as { partialResponse?: unknown }).partialResponse).toBeUndefined();
    expect(next.messages).toEqual([
      ...baseMsgs,
      { type: 'message', role: 'assistant', content: 'in-progress answer' },
    ]);
  });

  it('tolerates a non-array messages field (treats as empty history)', async () => {
    const acc = makeMemoryAccessor();
    const state = {
      id: 'x',
      messages: null,
      status: 'interrupted',
      partialResponse: { text: 'partial' },
      createdAt: 1,
      updatedAt: 2,
    } as unknown as ConversationState;
    await acc.save(state);
    await commitPartialResponse(acc);
    const next = acc.current()!;
    expect(next.messages).toEqual([{ type: 'message', role: 'assistant', content: 'partial' }]);
  });
});

describe('setInterruptedFlag', () => {
  it('writes a skeleton state with interruptedBy when no prior state exists', async () => {
    const acc = makeMemoryAccessor();
    await setInterruptedFlag(acc, 'host-interrupt');
    const next = acc.current()!;
    expect((next as { interruptedBy?: string }).interruptedBy).toBe('host-interrupt');
    expect(next.status).toBe('interrupted');
    expect(next.messages).toEqual([]);
  });

  it('preserves existing fields and adds interruptedBy when state already exists', async () => {
    const acc = makeMemoryAccessor();
    const state = {
      id: 'x',
      messages: [{ type: 'message', role: 'user', content: 'hi' }],
      status: 'in_progress',
      previousResponseId: 'resp_abc',
      createdAt: 1,
      updatedAt: 2,
    } as unknown as ConversationState;
    await acc.save(state);
    await setInterruptedFlag(acc, 'host-interrupt');
    const next = acc.current()!;
    expect((next as { interruptedBy?: string }).interruptedBy).toBe('host-interrupt');
    expect(next.messages).toEqual(state.messages);
    expect((next as { previousResponseId?: string }).previousResponseId).toBe('resp_abc');
  });

  it('is idempotent — re-writing the flag overwrites with the same value', async () => {
    const acc = makeMemoryAccessor();
    await setInterruptedFlag(acc, 'host-interrupt');
    await setInterruptedFlag(acc, 'host-interrupt');
    expect((acc.current() as { interruptedBy?: string }).interruptedBy).toBe('host-interrupt');
  });
});
