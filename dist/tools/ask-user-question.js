import { tool } from '@openrouter/agent';
import { z } from 'zod/v4';
import { randomUUID } from 'node:crypto';
import { DEFAULT_TOOL_CONTEXT } from './context.js';
const DEFAULT_TIMEOUT_MS = 300_000;
export const MAX_TIMEOUT_MS = 600_000;
const MAX_OPTIONS = 26;
export function askUserQuestionTool(ctx = DEFAULT_TOOL_CONTEXT, opts = {}) {
    return tool({
        name: 'ask_user_question',
        description: 'Ask the user a multiple-choice clarifying question and wait for their answer. Use sparingly — only when the model genuinely needs disambiguation it cannot resolve from context. Returns the selected option id and label; if `allow_free_text` is true and the host returns a free-text answer, the result also carries `freeTextAnswer`.',
        inputSchema: z.object({
            question: z.string().describe('The question text shown to the user.'),
            options: z
                .array(z.object({
                label: z.string().describe('Short label rendered as the choice (1-5 words).'),
                preview: z
                    .string()
                    .describe('Optional preview content for the host UI (code snippet, mockup, etc.).')
                    .optional(),
            }))
                .min(2)
                .max(MAX_OPTIONS)
                .describe(`Between 2 and ${MAX_OPTIONS} mutually-exclusive choices. Option ids are auto-assigned 'a','b','c',... lexicographically.`),
            allow_free_text: z
                .boolean()
                .describe('When true, the host may return a free-text answer instead of an option id.')
                .optional(),
            timeout_ms: z
                .number()
                .int()
                .positive()
                .describe('Optional override for the wait timeout in milliseconds. Default 300000 (5 minutes). Clamped at 600000 (10 minutes); a warn notification is emitted when clamping fires.')
                .optional(),
        }),
        execute: async ({ question, options, allow_free_text, timeout_ms }, execCtx) => {
            if (ctx.signal?.aborted) {
                return { error: 'aborted' };
            }
            if (!opts.onAskUserQuestion) {
                return { error: 'no host handler registered for ask_user_question' };
            }
            // Prefer the notify injected on the live SDK ToolExecuteContext (set up
            // by the agent's wrapToolWithHooks). Fall back to the factory-time
            // ctx.notify so unit tests that wire notify at factory construction time
            // continue to observe the hook calls.
            const notify = execCtx?.notify ?? ctx.notify;
            let effectiveTimeoutMs = timeout_ms ?? DEFAULT_TIMEOUT_MS;
            if (effectiveTimeoutMs > MAX_TIMEOUT_MS) {
                const requestedMs = effectiveTimeoutMs;
                effectiveTimeoutMs = MAX_TIMEOUT_MS;
                await notify?.('warn', 'ask_user_question timeout_ms exceeds MAX_TIMEOUT_MS, clamping', {
                    requestedMs,
                    effectiveMs: effectiveTimeoutMs,
                });
            }
            const questionId = randomUUID();
            const requestOptions = options.map((opt, i) => ({
                id: String.fromCharCode(97 + i),
                label: opt.label,
                ...(opt.preview !== undefined ? { preview: opt.preview } : {}),
            }));
            const request = {
                questionId,
                question,
                options: requestOptions,
                ...(allow_free_text !== undefined ? { allowFreeText: allow_free_text } : {}),
            };
            // Surface the question to subscribers via the Notification hook so logs /
            // dashboards / non-UI sinks can observe it even when no UI consumes the
            // callback. Independent of whether the host callback resolves promptly.
            await notify?.('info', 'ask_user_question', request);
            const handler = opts.onAskUserQuestion;
            return await new Promise((resolve) => {
                let settled = false;
                const settle = (result) => {
                    if (settled)
                        return;
                    settled = true;
                    if (ctx.signal)
                        ctx.signal.removeEventListener('abort', onAbort);
                    clearTimeout(timer);
                    resolve(result);
                };
                const onAbort = () => settle({ error: 'aborted' });
                if (ctx.signal)
                    ctx.signal.addEventListener('abort', onAbort, { once: true });
                const timer = setTimeout(() => settle({ error: `timed out after ${effectiveTimeoutMs}ms` }), effectiveTimeoutMs);
                handler(request).then((response) => {
                    const matched = requestOptions.find((o) => o.id === response.selectedOptionId);
                    const result = {};
                    if (response.selectedOptionId !== undefined) {
                        result.selectedOptionId = response.selectedOptionId;
                        if (matched)
                            result.label = matched.label;
                    }
                    if (response.freeTextAnswer !== undefined) {
                        result.freeTextAnswer = response.freeTextAnswer;
                    }
                    settle(result);
                }, (err) => {
                    const message = err instanceof Error ? err.message : String(err);
                    settle({ error: message });
                });
            });
        },
    });
}
//# sourceMappingURL=ask-user-question.js.map