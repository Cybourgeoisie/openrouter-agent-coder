/**
 * Phase 5.1: context-compaction primitives. Pure functions — no SDK / FS
 * coupling, so they can be unit-tested in isolation from
 * {@link OpenRouterAgentRun}. The wiring into the run loop lives in
 * `src/agent.ts`.
 */
/**
 * System prompt sent to the summarizer model during compaction. v1 is a fixed
 * string constant (not configurable) — exported here so tests and external
 * code can reason about the exact instructions the summarizer receives. The
 * partition prefix is sent verbatim as the model's `input`; this prompt is
 * passed via the `instructions` field.
 */
export const COMPACTION_PROMPT = 'You are a context-compaction assistant. The user message is the JSON-encoded prefix of an ongoing conversation between a user and an AI coding agent (including tool calls and tool outputs) that has grown too long to keep in full. Summarize this prefix into a concise narrative that preserves: (1) the user goals and constraints, (2) decisions made and their rationale, (3) files, paths, and identifiers referenced, (4) any unresolved tasks. Omit verbose tool outputs that no longer matter. Return only the summary text — do not preface it with commentary, do not wrap it in markdown, do not include a heading.';
/**
 * Approximate average character → token ratio used by the v1 char-length
 * heuristic. The ~4-chars-per-token figure is the conservative end of the
 * range used by OpenAI / Anthropic tokenizers for English text; non-English
 * prose, code, or JSON-encoded tool calls tend to fall in the 3.5–4.5 band.
 * v1 ships without a real tokenizer dep ({@link getModelContextWindow}
 * already biases the threshold via {@link DEFAULT_THRESHOLD_RATIO}).
 */
export const CHARS_PER_TOKEN = 4;
/**
 * Fraction of the model's context window that triggers an auto-compaction
 * when no explicit `compactionThreshold` is supplied to the run. 0.8 leaves
 * ~20% headroom for the next turn's input + response.
 */
export const DEFAULT_THRESHOLD_RATIO = 0.8;
/**
 * Conservative fallback context-window size (in tokens) used when the active
 * model is not present in {@link MODEL_CONTEXT_WINDOWS}. 128k matches the
 * smaller end of the modern frontier-model band and avoids overestimating
 * for unknown deployments.
 */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
/**
 * Hard-coded table of well-known OpenRouter / Anthropic / OpenAI / Google
 * model context-window sizes (in tokens). Lookups are exact-match first, then
 * with the `~` alias prefix stripped (e.g. `~anthropic/claude-sonnet-latest`
 * → `anthropic/claude-sonnet-latest`). v1 deliberately ships a static table
 * rather than fetching `/api/v1/models` so that compaction has no network
 * dependency. Add new entries here as they ship.
 */
export const MODEL_CONTEXT_WINDOWS = Object.freeze({
    // Anthropic Claude — 200k standard, 1M for the "[1m]" variants
    'anthropic/claude-sonnet-latest': 200_000,
    'anthropic/claude-opus-latest': 200_000,
    'anthropic/claude-haiku-latest': 200_000,
    'anthropic/claude-sonnet-4.6': 200_000,
    'anthropic/claude-opus-4.7': 200_000,
    'anthropic/claude-opus-4-7': 200_000,
    'anthropic/claude-haiku-4.5': 200_000,
    'anthropic/claude-3-5-sonnet': 200_000,
    'anthropic/claude-3-5-haiku': 200_000,
    // OpenAI
    'openai/gpt-5': 400_000,
    'openai/gpt-5.1': 400_000,
    'openai/gpt-4.1': 1_000_000,
    'openai/gpt-4o': 128_000,
    'openai/gpt-4o-mini': 128_000,
    'openai/o1': 200_000,
    'openai/o3': 200_000,
    // Google Gemini
    'google/gemini-2.5-pro': 1_000_000,
    'google/gemini-2.5-flash': 1_000_000,
    'google/gemini-2.0-flash': 1_000_000,
    // xAI Grok
    'xai/grok-4': 256_000,
    'xai/grok-3': 131_072,
    // Qwen
    'qwen/qwen3-coder': 256_000,
});
/**
 * Resolve the context-window size (in tokens) for a given model id. Tries the
 * id verbatim, then with a leading `~` (OR alias marker) stripped. Falls back
 * to {@link DEFAULT_CONTEXT_WINDOW_TOKENS} for unknown models.
 *
 * Exported so consumers can pre-compute a sensible `compactionThreshold` for
 * a model whose default they want to override, without re-deriving the table.
 */
export function getModelContextWindow(model) {
    const exact = MODEL_CONTEXT_WINDOWS[model];
    if (exact !== undefined)
        return exact;
    if (model.startsWith('~')) {
        const stripped = model.slice(1);
        const aliased = MODEL_CONTEXT_WINDOWS[stripped];
        if (aliased !== undefined)
            return aliased;
    }
    return DEFAULT_CONTEXT_WINDOW_TOKENS;
}
/**
 * Resolve the threshold (in **characters**, not tokens) that triggers
 * auto-compaction. Caller-supplied `configured` wins outright — it is
 * interpreted as a raw character count so consumers can opt out of the
 * char-per-token translation entirely. When omitted, the threshold is
 * `getModelContextWindow(model) * CHARS_PER_TOKEN * DEFAULT_THRESHOLD_RATIO`.
 */
export function resolveCompactionThresholdChars(configured, model) {
    if (configured !== undefined)
        return configured;
    return Math.floor(getModelContextWindow(model) * CHARS_PER_TOKEN * DEFAULT_THRESHOLD_RATIO);
}
/**
 * Char-length heuristic for the SDK's `ConversationState.messages` field
 * (`InputsUnion`). Accepts either the raw string form or the array form;
 * arrays are JSON-serialized per-item (cheap enough at compaction scale —
 * runs once per turn boundary at most). Non-message inputs (`null`,
 * `undefined`, anything else) return `0`.
 */
export function estimateMessagesCharLength(messages) {
    if (typeof messages === 'string')
        return messages.length;
    if (!Array.isArray(messages))
        return 0;
    let total = 0;
    for (const msg of messages) {
        try {
            total += JSON.stringify(msg).length;
        }
        catch {
            // Cyclic or unserializable items contribute nothing to the heuristic —
            // they can't have come from the SDK's own message store, so this is a
            // defensive guard for hand-crafted state in tests.
        }
    }
    return total;
}
/**
 * Split a message array into a `summarize` prefix and a `keep` tail. The tail
 * length is `min(messages.length, keepRecentTurns)`. When the array is
 * shorter than the keep window, the prefix is empty and no compaction is
 * needed.
 *
 * Note: `keepRecentTurns` is interpreted at **message** granularity, not
 * strict conversational-turn granularity. The SDK's `InputsUnion` mixes user
 * messages, assistant output items, reasoning items, tool calls, and tool
 * results — a robust turn-boundary detector is deferred to a future card
 * (the v1 heuristic keeps the implementation predictable and dependency-free).
 */
export function partitionMessages(messages, keepRecentTurns) {
    const keepCount = Math.max(0, Math.floor(keepRecentTurns));
    if (messages.length <= keepCount) {
        return { summarize: [], keep: messages };
    }
    const cut = messages.length - keepCount;
    return {
        summarize: messages.slice(0, cut),
        keep: messages.slice(cut),
    };
}
/** Default number of trailing messages preserved verbatim during compaction. */
export const DEFAULT_KEEP_RECENT_TURNS = 5;
//# sourceMappingURL=compaction.js.map