import { describe, it, expect, vi } from 'vitest';
import {
  askUserQuestionTool,
  MAX_TIMEOUT_MS,
  type AskUserQuestionToolResult,
  type UserQuestionRequest,
  type UserQuestionResponse,
} from './ask-user-question.js';

interface ExecuteParams {
  question: string;
  options: Array<{ label: string; preview?: string }>;
  allow_free_text?: boolean;
  timeout_ms?: number;
}

function makeExecute(
  ctx: Parameters<typeof askUserQuestionTool>[0] = { cwd: '.' },
  opts: Parameters<typeof askUserQuestionTool>[1] = {},
): (params: ExecuteParams) => Promise<AskUserQuestionToolResult> {
  const t = askUserQuestionTool(ctx, opts);
  return t.function.execute as (params: ExecuteParams) => Promise<AskUserQuestionToolResult>;
}

describe('ask_user_question tool', () => {
  it('has correct name and description', () => {
    const t = askUserQuestionTool();
    expect(t.function.name).toBe('ask_user_question');
    expect(t.function.description).toMatch(/multiple-choice/i);
  });

  it('resolves with the chosen option id + label when the host picks one', async () => {
    let captured: UserQuestionRequest | null = null;
    const execute = makeExecute(
      { cwd: '.' },
      {
        onAskUserQuestion: async (req): Promise<UserQuestionResponse> => {
          captured = req;
          return { questionId: req.questionId, selectedOptionId: 'b' };
        },
      },
    );

    const result = await execute({
      question: 'Which option?',
      options: [{ label: 'Option A' }, { label: 'Option B' }, { label: 'Option C' }],
    });

    expect(result).toEqual({ selectedOptionId: 'b', label: 'Option B' });
    expect(captured).not.toBeNull();
    expect(captured!.questionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(captured!.options).toEqual([
      { id: 'a', label: 'Option A' },
      { id: 'b', label: 'Option B' },
      { id: 'c', label: 'Option C' },
    ]);
  });

  it('preserves the option preview when supplied', async () => {
    let captured: UserQuestionRequest | null = null;
    const execute = makeExecute(
      { cwd: '.' },
      {
        onAskUserQuestion: async (req): Promise<UserQuestionResponse> => {
          captured = req;
          return { questionId: req.questionId, selectedOptionId: 'a' };
        },
      },
    );

    await execute({
      question: 'Preview?',
      options: [{ label: 'A', preview: '```ts\nfoo()\n```' }, { label: 'B' }],
    });

    expect(captured!.options[0]).toEqual({ id: 'a', label: 'A', preview: '```ts\nfoo()\n```' });
    expect(captured!.options[1]).toEqual({ id: 'b', label: 'B' });
  });

  it('surfaces a free-text answer when the host returns only freeTextAnswer', async () => {
    const execute = makeExecute(
      { cwd: '.' },
      {
        onAskUserQuestion: async (req): Promise<UserQuestionResponse> => ({
          questionId: req.questionId,
          freeTextAnswer: 'custom',
        }),
      },
    );

    const result = await execute({
      question: 'Any thoughts?',
      options: [{ label: 'A' }, { label: 'B' }],
      allow_free_text: true,
    });

    expect(result).toEqual({ freeTextAnswer: 'custom' });
    expect(result.selectedOptionId).toBeUndefined();
    expect(result.label).toBeUndefined();
  });

  it('includes both selectedOptionId+label and freeTextAnswer when the host returns both', async () => {
    const execute = makeExecute(
      { cwd: '.' },
      {
        onAskUserQuestion: async (req): Promise<UserQuestionResponse> => ({
          questionId: req.questionId,
          selectedOptionId: 'a',
          freeTextAnswer: 'extra context',
        }),
      },
    );

    const result = await execute({
      question: 'Pick + add a note',
      options: [{ label: 'Yes' }, { label: 'No' }],
      allow_free_text: true,
    });

    expect(result).toEqual({
      selectedOptionId: 'a',
      label: 'Yes',
      freeTextAnswer: 'extra context',
    });
  });

  it('omits label when selectedOptionId does not match any option', async () => {
    const execute = makeExecute(
      { cwd: '.' },
      {
        onAskUserQuestion: async (req): Promise<UserQuestionResponse> => ({
          questionId: req.questionId,
          selectedOptionId: 'z',
        }),
      },
    );

    const result = await execute({
      question: 'Q',
      options: [{ label: 'A' }, { label: 'B' }],
    });

    expect(result).toEqual({ selectedOptionId: 'z' });
  });

  it('returns a no-handler error when onAskUserQuestion is not wired', async () => {
    const execute = makeExecute({ cwd: '.' });
    const result = await execute({
      question: 'pick',
      options: [{ label: 'A' }, { label: 'B' }],
    });
    expect(result).toEqual({ error: 'no host handler registered for ask_user_question' });
  });

  it('returns aborted when ctx.signal is already aborted before execute', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const execute = makeExecute(
      { cwd: '.', signal: ctrl.signal },
      { onAskUserQuestion: async () => ({ questionId: 'x', selectedOptionId: 'a' }) },
    );
    const result = await execute({
      question: 'q',
      options: [{ label: 'A' }, { label: 'B' }],
    });
    expect(result).toEqual({ error: 'aborted' });
  });

  it('resolves promptly with aborted when ctx.signal aborts mid-await', async () => {
    const ctrl = new AbortController();
    // Host never resolves on its own.
    const execute = makeExecute(
      { cwd: '.', signal: ctrl.signal },
      { onAskUserQuestion: () => new Promise<UserQuestionResponse>(() => undefined) },
    );
    setTimeout(() => ctrl.abort(), 25);
    const result = await execute({
      question: 'q',
      options: [{ label: 'A' }, { label: 'B' }],
    });
    expect(result).toEqual({ error: 'aborted' });
  });

  it('returns a timed-out error when the configured timeout elapses', async () => {
    const execute = makeExecute(
      { cwd: '.' },
      { onAskUserQuestion: () => new Promise<UserQuestionResponse>(() => undefined) },
    );
    const result = await execute({
      question: 'q',
      options: [{ label: 'A' }, { label: 'B' }],
      timeout_ms: 50,
    });
    expect(result).toEqual({ error: 'timed out after 50ms' });
  });

  it('clamps timeout_ms over MAX_TIMEOUT_MS and emits a warn notification', async () => {
    const notify = vi.fn(async () => undefined);
    const execute = makeExecute(
      { cwd: '.', notify },
      {
        onAskUserQuestion: async (req): Promise<UserQuestionResponse> => ({
          questionId: req.questionId,
          selectedOptionId: 'a',
        }),
      },
    );

    await execute({
      question: 'q',
      options: [{ label: 'A' }, { label: 'B' }],
      timeout_ms: 700_000,
    });

    const warnCall = notify.mock.calls.find(
      (c) => (c as unknown as [string])[0] === 'warn',
    ) as unknown as [string, string, unknown] | undefined;
    expect(warnCall).toBeDefined();
    expect(warnCall![1]).toMatch(/clamping/i);
    expect(warnCall![2]).toEqual({ requestedMs: 700_000, effectiveMs: MAX_TIMEOUT_MS });
  });

  it('fires the Notification hook with the request payload', async () => {
    const notify = vi.fn(async () => undefined);
    const execute = makeExecute(
      { cwd: '.', notify },
      {
        onAskUserQuestion: async (req): Promise<UserQuestionResponse> => ({
          questionId: req.questionId,
          selectedOptionId: 'a',
        }),
      },
    );

    await execute({
      question: 'Pick one',
      options: [{ label: 'A' }, { label: 'B' }],
      allow_free_text: true,
    });

    const infoCall = notify.mock.calls.find(
      (c) => (c as unknown as [string])[0] === 'info',
    ) as unknown as [string, string, UserQuestionRequest];
    expect(infoCall).toBeDefined();
    expect(infoCall[1]).toBe('ask_user_question');
    expect(infoCall[2].question).toBe('Pick one');
    expect(infoCall[2].allowFreeText).toBe(true);
    expect(infoCall[2].options).toEqual([
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ]);
  });

  it('surfaces a handler-thrown error as the error field', async () => {
    const execute = makeExecute(
      { cwd: '.' },
      {
        onAskUserQuestion: async () => {
          throw new Error('host UI offline');
        },
      },
    );
    const result = await execute({
      question: 'q',
      options: [{ label: 'A' }, { label: 'B' }],
    });
    expect(result).toEqual({ error: 'host UI offline' });
  });

  it('coerces a non-Error rejection into a string error', async () => {
    const execute = makeExecute(
      { cwd: '.' },
      // Async function that rejects with a non-Error value; cast via unknown
      // because the declared callback contract is Promise<UserQuestionResponse>.
      {
        onAskUserQuestion: (() =>
          Promise.reject('plain string')) as unknown as NonNullable<
          Parameters<typeof askUserQuestionTool>[1]
        >['onAskUserQuestion'],
      },
    );
    const result = await execute({
      question: 'q',
      options: [{ label: 'A' }, { label: 'B' }],
    });
    expect(result).toEqual({ error: 'plain string' });
  });

  it('rejects fewer than 2 options at the schema level', () => {
    const t = askUserQuestionTool();
    const inputSchema = (
      t.function as unknown as { inputSchema: { safeParse: (i: unknown) => { success: boolean } } }
    ).inputSchema;
    const parsed = inputSchema.safeParse({
      question: 'q',
      options: [{ label: 'only one' }],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects more than 26 options at the schema level', () => {
    const t = askUserQuestionTool();
    const inputSchema = (
      t.function as unknown as { inputSchema: { safeParse: (i: unknown) => { success: boolean } } }
    ).inputSchema;
    const tooMany = Array.from({ length: 27 }, (_, i) => ({ label: `Option ${i}` }));
    const parsed = inputSchema.safeParse({ question: 'q', options: tooMany });
    expect(parsed.success).toBe(false);
  });

  it('accepts up to 26 options and assigns ids a..z', async () => {
    let captured: UserQuestionRequest | null = null;
    const execute = makeExecute(
      { cwd: '.' },
      {
        onAskUserQuestion: async (req): Promise<UserQuestionResponse> => {
          captured = req;
          return { questionId: req.questionId, selectedOptionId: 'z' };
        },
      },
    );
    const opts = Array.from({ length: 26 }, (_, i) => ({ label: `Option ${i}` }));
    const result = await execute({ question: 'q', options: opts });

    expect(captured!.options).toHaveLength(26);
    expect(captured!.options[0].id).toBe('a');
    expect(captured!.options[25].id).toBe('z');
    expect(result.selectedOptionId).toBe('z');
    expect(result.label).toBe('Option 25');
  });

  it('exports MAX_TIMEOUT_MS = 600_000 (10 minutes)', () => {
    expect(MAX_TIMEOUT_MS).toBe(600_000);
  });

  it('ignores a late host response after the timeout already settled', async () => {
    let resolveLate: (r: UserQuestionResponse) => void = () => undefined;
    const execute = makeExecute(
      { cwd: '.' },
      {
        onAskUserQuestion: () =>
          new Promise<UserQuestionResponse>((r) => {
            resolveLate = r;
          }),
      },
    );
    const result = await execute({
      question: 'q',
      options: [{ label: 'A' }, { label: 'B' }],
      timeout_ms: 25,
    });
    expect(result).toEqual({ error: 'timed out after 25ms' });
    // Fire the late host resolution; the guard inside settle() must swallow it.
    resolveLate({ questionId: 'late', selectedOptionId: 'a' });
    // Give the event loop a tick to process the late resolution.
    await new Promise((r) => setTimeout(r, 5));
    // The result was already returned above — the late call is a no-op (no throw, no second resolve).
  });
});
