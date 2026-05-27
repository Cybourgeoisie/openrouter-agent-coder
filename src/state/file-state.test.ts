import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createFileStateAccessor } from './file-state.js';
import { mkdtemp, rm, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConversationState } from '@openrouter/agent';

const SESSION_ID = 'test-state-session';
let LOGS_ROOT: string;

beforeEach(async () => {
  LOGS_ROOT = await mkdtemp(join(tmpdir(), 'file-state-test-'));
});

afterEach(async () => {
  await rm(LOGS_ROOT, { recursive: true, force: true });
});

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

describe('FileStateAccessor', () => {
  it('load returns null when no state file exists', async () => {
    const accessor = createFileStateAccessor(LOGS_ROOT, SESSION_ID);
    const state = await accessor.load();
    expect(state).toBeNull();
  });

  it('save then load round-trips state', async () => {
    const accessor = createFileStateAccessor(LOGS_ROOT, SESSION_ID);
    const state = makeState({ id: 'conv_roundtrip' });

    await accessor.save(state);
    const loaded = await accessor.load();

    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe('conv_roundtrip');
    expect(loaded!.status).toBe('in_progress');
  });

  it('save overwrites previous state', async () => {
    const accessor = createFileStateAccessor(LOGS_ROOT, SESSION_ID);

    await accessor.save(makeState({ id: 'first' }));
    await accessor.save(makeState({ id: 'second' }));

    const loaded = await accessor.load();
    expect(loaded!.id).toBe('second');
  });

  it('persists previousResponseId', async () => {
    const accessor = createFileStateAccessor(LOGS_ROOT, SESSION_ID);
    const state = makeState({ previousResponseId: 'gen-abc-123' });

    await accessor.save(state);
    const loaded = await accessor.load();

    expect(loaded!.previousResponseId).toBe('gen-abc-123');
  });

  it('writes state.json under the provided logsRoot', async () => {
    const accessor = createFileStateAccessor(LOGS_ROOT, SESSION_ID);
    await accessor.save(makeState());

    const statePath = join(LOGS_ROOT, SESSION_ID, 'state.json');
    const raw = await readFile(statePath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.id).toBe('conv_test');
  });

  it('rethrows non-ENOENT errors from readFile (e.g. EACCES)', async () => {
    const accessor = createFileStateAccessor(LOGS_ROOT, SESSION_ID);
    await accessor.save(makeState());
    const statePath = join(LOGS_ROOT, SESSION_ID, 'state.json');

    await chmod(statePath, 0o000);
    try {
      await expect(accessor.load()).rejects.toMatchObject({
        code: expect.stringMatching(/^(?!ENOENT$).+/),
      });
    } finally {
      await chmod(statePath, 0o600);
    }
  });

  it('serializes concurrent saves so neither rejects with ENOENT on rename', async () => {
    // Regression: two concurrent save() calls used to share `${path}.tmp`.
    // The first rename succeeded and consumed the tmp; the second rename
    // then hit ENOENT. The accessor now serializes saves per-instance.
    const accessor = createFileStateAccessor(LOGS_ROOT, SESSION_ID);

    const results = await Promise.allSettled([
      accessor.save(makeState({ id: 'concurrent-a' })),
      accessor.save(makeState({ id: 'concurrent-b' })),
      accessor.save(makeState({ id: 'concurrent-c' })),
    ]);

    for (const r of results) {
      expect(r.status).toBe('fulfilled');
    }
    // Last writer wins — serialization preserves call order.
    const loaded = await accessor.load();
    expect(loaded!.id).toBe('concurrent-c');
  });

  it('one failed save does not poison subsequent saves on the same accessor', async () => {
    const accessor = createFileStateAccessor(LOGS_ROOT, SESSION_ID);

    // Force a JSON.stringify failure (circular reference) on the first save.
    // The chain must recover so a subsequent save still goes through.
    const bad = makeState({ id: 'bad' }) as ConversationState & { self?: unknown };
    bad.self = bad;

    const first = accessor.save(bad);
    const second = accessor.save(makeState({ id: 'good' }));

    await expect(first).rejects.toBeDefined();
    await expect(second).resolves.toBeUndefined();

    const loaded = await accessor.load();
    expect(loaded!.id).toBe('good');
  });

  it('preserves message history', async () => {
    const accessor = createFileStateAccessor(LOGS_ROOT, SESSION_ID);
    const messages = [
      { role: 'user' as const, content: 'hello' },
      { role: 'assistant' as const, content: 'hi there' },
    ];
    await accessor.save(makeState({ messages }));

    const loaded = await accessor.load();
    expect(loaded!.messages).toEqual(messages);
  });
});
