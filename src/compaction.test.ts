import { describe, it, expect } from 'vitest';
import {
  CHARS_PER_TOKEN,
  COMPACTION_PROMPT,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_KEEP_RECENT_TURNS,
  DEFAULT_THRESHOLD_RATIO,
  MODEL_CONTEXT_WINDOWS,
  estimateMessagesCharLength,
  getModelContextWindow,
  partitionMessages,
  resolveCompactionThresholdChars,
} from './compaction.js';

describe('COMPACTION_PROMPT', () => {
  it('is a non-empty stable string constant', () => {
    expect(typeof COMPACTION_PROMPT).toBe('string');
    expect(COMPACTION_PROMPT.length).toBeGreaterThan(50);
  });

  it('instructs the model to return only the summary text', () => {
    // Hard contract — downstream consumers (and the auto-compact integration
    // test) rely on the summary being un-prefaced so it can be embedded
    // verbatim into the rewritten developer-role message.
    expect(COMPACTION_PROMPT).toMatch(/Return only the summary/);
  });
});

describe('getModelContextWindow', () => {
  it('returns the exact-match window for a known model id', () => {
    expect(getModelContextWindow('anthropic/claude-sonnet-4.6')).toBe(200_000);
    expect(getModelContextWindow('openai/gpt-4.1')).toBe(1_000_000);
    expect(getModelContextWindow('google/gemini-2.5-pro')).toBe(1_000_000);
  });

  it("strips the leading '~' alias marker and re-tries", () => {
    expect(getModelContextWindow('~anthropic/claude-sonnet-latest')).toBe(
      MODEL_CONTEXT_WINDOWS['anthropic/claude-sonnet-latest'],
    );
  });

  it('falls back to DEFAULT_CONTEXT_WINDOW_TOKENS for unknown models', () => {
    expect(getModelContextWindow('some-vendor/unknown-model-2099')).toBe(
      DEFAULT_CONTEXT_WINDOW_TOKENS,
    );
  });

  it("does not strip '~' twice for unknown stripped names", () => {
    // '~unknown/model' → 'unknown/model' is also unknown → fallback
    expect(getModelContextWindow('~unknown/model')).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
  });
});

describe('resolveCompactionThresholdChars', () => {
  it('returns the caller-supplied value verbatim when provided (raw chars)', () => {
    expect(resolveCompactionThresholdChars(12_345, 'anthropic/claude-sonnet-4.6')).toBe(12_345);
  });

  it('uses zero verbatim — does not treat 0 as "unset"', () => {
    // 0 is a legitimate override (force-trigger every turn). The function
    // distinguishes undefined from 0.
    expect(resolveCompactionThresholdChars(0, 'anthropic/claude-sonnet-4.6')).toBe(0);
  });

  it('derives the default threshold from the model context window when omitted', () => {
    const tokens = getModelContextWindow('anthropic/claude-sonnet-4.6');
    const expected = Math.floor(tokens * CHARS_PER_TOKEN * DEFAULT_THRESHOLD_RATIO);
    expect(resolveCompactionThresholdChars(undefined, 'anthropic/claude-sonnet-4.6')).toBe(
      expected,
    );
  });

  it('falls back to the default window for unknown models', () => {
    const expected = Math.floor(
      DEFAULT_CONTEXT_WINDOW_TOKENS * CHARS_PER_TOKEN * DEFAULT_THRESHOLD_RATIO,
    );
    expect(resolveCompactionThresholdChars(undefined, 'unknown/whatever')).toBe(expected);
  });
});

describe('estimateMessagesCharLength', () => {
  it('returns the string length for a string input', () => {
    expect(estimateMessagesCharLength('hello world')).toBe(11);
  });

  it('returns 0 for null / undefined / non-array / non-string', () => {
    expect(estimateMessagesCharLength(null)).toBe(0);
    expect(estimateMessagesCharLength(undefined)).toBe(0);
    expect(estimateMessagesCharLength(42)).toBe(0);
    expect(estimateMessagesCharLength({ not: 'an array' })).toBe(0);
  });

  it('JSON-serializes each array item and sums the lengths', () => {
    const items = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'bb' },
    ];
    const expected = items.reduce((acc, item) => acc + JSON.stringify(item).length, 0);
    expect(estimateMessagesCharLength(items)).toBe(expected);
  });

  it('exercises the boundary: empty array returns exactly 0', () => {
    expect(estimateMessagesCharLength([])).toBe(0);
  });

  it('skips cyclic items rather than throwing', () => {
    const cyclic: Record<string, unknown> = { role: 'user' };
    cyclic.self = cyclic;
    const items = [{ role: 'user', content: 'ok' }, cyclic];
    // The cyclic item contributes 0; the leading item still counts.
    const expected = JSON.stringify(items[0]).length;
    expect(estimateMessagesCharLength(items)).toBe(expected);
  });
});

describe('partitionMessages', () => {
  it('returns empty summarize when the array is at or below keepRecentTurns', () => {
    const msgs = [{ id: 1 }, { id: 2 }];
    const { summarize, keep } = partitionMessages(msgs, 5);
    expect(summarize).toEqual([]);
    expect(keep).toEqual(msgs);
  });

  it('splits the array at messages.length - keepRecentTurns', () => {
    const msgs = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }];
    const { summarize, keep } = partitionMessages(msgs, 2);
    expect(summarize).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(keep).toEqual([{ id: 4 }, { id: 5 }]);
  });

  it('treats keepRecentTurns=0 as "keep nothing"', () => {
    const msgs = [{ id: 1 }, { id: 2 }];
    const { summarize, keep } = partitionMessages(msgs, 0);
    expect(summarize).toEqual(msgs);
    expect(keep).toEqual([]);
  });

  it('clamps negative keepRecentTurns to 0', () => {
    const msgs = [{ id: 1 }, { id: 2 }];
    const { summarize, keep } = partitionMessages(msgs, -3);
    expect(summarize).toEqual(msgs);
    expect(keep).toEqual([]);
  });

  it('uses the documented default when wired through', () => {
    // Spot-check that the default constant lines up with the issue spec.
    expect(DEFAULT_KEEP_RECENT_TURNS).toBe(5);
  });
});
