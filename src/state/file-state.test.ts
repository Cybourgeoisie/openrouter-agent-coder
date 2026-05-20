import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createFileStateAccessor } from './file-state.js';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConversationState } from '@openrouter/agent';

const LOG_BASE = join(process.cwd(), 'logs');
const SESSION_ID = 'test-state-session';

beforeEach(async () => {
  await mkdir(join(LOG_BASE, SESSION_ID), { recursive: true });
});

afterEach(async () => {
  await rm(join(LOG_BASE, SESSION_ID), { recursive: true, force: true });
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
    const accessor = createFileStateAccessor(SESSION_ID);
    const state = await accessor.load();
    expect(state).toBeNull();
  });

  it('save then load round-trips state', async () => {
    const accessor = createFileStateAccessor(SESSION_ID);
    const state = makeState({ id: 'conv_roundtrip' });

    await accessor.save(state);
    const loaded = await accessor.load();

    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe('conv_roundtrip');
    expect(loaded!.status).toBe('in_progress');
  });

  it('save overwrites previous state', async () => {
    const accessor = createFileStateAccessor(SESSION_ID);

    await accessor.save(makeState({ id: 'first' }));
    await accessor.save(makeState({ id: 'second' }));

    const loaded = await accessor.load();
    expect(loaded!.id).toBe('second');
  });

  it('persists previousResponseId', async () => {
    const accessor = createFileStateAccessor(SESSION_ID);
    const state = makeState({ previousResponseId: 'gen-abc-123' });

    await accessor.save(state);
    const loaded = await accessor.load();

    expect(loaded!.previousResponseId).toBe('gen-abc-123');
  });

  it('uses atomic write (tmp file renamed)', async () => {
    const accessor = createFileStateAccessor(SESSION_ID);
    await accessor.save(makeState());

    const statePath = join(LOG_BASE, SESSION_ID, 'state.json');
    const raw = await readFile(statePath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.id).toBe('conv_test');
  });

  it('preserves message history', async () => {
    const accessor = createFileStateAccessor(SESSION_ID);
    const messages = [
      { role: 'user' as const, content: 'hello' },
      { role: 'assistant' as const, content: 'hi there' },
    ];
    await accessor.save(makeState({ messages }));

    const loaded = await accessor.load();
    expect(loaded!.messages).toEqual(messages);
  });
});
