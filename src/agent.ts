import {
  OpenRouter,
  stepCountIs,
  maxCost,
  isTurnStartEvent,
  isTurnEndEvent,
  isToolResultEvent,
  isToolCallOutputEvent,
} from '@openrouter/agent';
import type { ConversationState } from '@openrouter/agent';
import { allTools } from './tools/index.js';
import { createServerToolsHooks } from './tools/server-tools.js';
import { createFileStateAccessor } from './state/file-state.js';
import {
  createRequestId,
  createGenerationId,
  logRequest,
  logGeneration,
} from './logging/logger.js';

const DEFAULT_MODEL = process.env.OR_MODEL ?? '~anthropic/claude-sonnet-latest';
const MAX_STEPS = parseInt(process.env.OR_MAX_STEPS ?? '25', 10);
const MAX_COST = parseFloat(process.env.OR_MAX_COST ?? '1.00');

if (process.env.DEBUG) {
  const key = process.env.OPENROUTER_API_KEY;
  const maskedKey = key ? `${key.slice(0, 10)}...${key.slice(-4)}` : '(not set)';
  console.log('Config:', {
    model: DEFAULT_MODEL,
    maxSteps: MAX_STEPS,
    maxCost: MAX_COST,
    apiKey: maskedKey,
    baseUrl: process.env.OPENROUTER_BASE_URL ?? '(default)',
  });
}

export interface AgentSession {
  sessionId: string;
  client: OpenRouter;
  /** Running cost total across all prompts in this session (USD). */
  totalCost: number;
  /** Total number of inner-loop turns executed across all prompts. */
  totalTurns: number;
}

/** Metrics returned by a single runPrompt call. */
export interface PromptResult {
  text: string;
  /** The model that actually served this prompt (resolved from alias). */
  model: string;
  /** Number of inner-loop turns (tool-call round-trips) in this prompt. */
  turnCount: number;
  /** Cost incurred by this prompt (USD). */
  promptCost: number;
  /** Cumulative session cost including this prompt (USD). */
  totalCost: number;
}

export function createAgent(sessionId: string): AgentSession {
  const client = new OpenRouter({
    apiKey: process.env.OPENROUTER_API_KEY,
    ...(process.env.OPENROUTER_BASE_URL && { serverURL: process.env.OPENROUTER_BASE_URL }),
    appTitle: 'OR/Agent Coder',
    hooks: createServerToolsHooks(),
  } as ConstructorParameters<typeof OpenRouter>[0]);
  return { sessionId, client, totalCost: 0, totalTurns: 0 };
}

export async function runPrompt(
  session: AgentSession,
  prompt: string,
  onTextDelta: (delta: string) => void,
): Promise<PromptResult> {
  const { sessionId, client } = session;
  const requestId = createRequestId();
  const state = createFileStateAccessor(sessionId);

  await logRequest({
    sessionId,
    requestId,
    prompt,
    timestamp: new Date().toISOString(),
  });

  // Per-turn cost accumulator updated by onTurnEnd callbacks.
  let promptCost = 0;

  const result = client.callModel({
    model: DEFAULT_MODEL,
    sessionId,
    input: [{ role: 'user' as const, content: prompt }],
    instructions:
      'You are a code editing agent. You can read, write, and edit files, list directories, and run shell commands. Work step by step: read files to understand the codebase, then make changes. Always verify your changes.',
    tools: allTools,
    state,
    stopWhen: [stepCountIs(MAX_STEPS), maxCost(MAX_COST)],
    onTurnEnd: async (_ctx, response) => {
      const generationId = createGenerationId();
      await logGeneration({
        sessionId,
        requestId,
        generationId,
        response,
        timestamp: new Date().toISOString(),
      });
      // Accumulate cost reported by this turn's API response.
      const turnCost = response.usage?.cost ?? 0;
      promptCost += turnCost;
    },
  });

  // ── Tool-display helpers ────────────────────────────────────────────────

  /** Truncate a string to 100 chars, appending '...' when cut. */
  function truncate(s: string, max = 100): string {
    const flat = s.replace(/\s+/g, ' ').trim();
    return flat.length <= max ? flat : `${flat.slice(0, max)}...`;
  }

  /**
   * Derive the extra context to show on the ⚙ call line, alongside the
   * tool name. For file tools this is the filename; for run_command it is
   * the command string (both truncated to 100 chars).
   */
  function callSnippet(toolName: string, args: Record<string, unknown>): string {
    switch (toolName) {
      case 'read_file': {
        const range =
          args.start_line !== undefined
            ? `:${args.start_line}${args.end_line !== undefined ? `-${args.end_line}` : '+'}`
            : '';
        return truncate(`${args.path ?? ''}${range}`);
      }
      case 'write_file':
      case 'edit_file':
        return truncate(String(args.path ?? ''));
      case 'list_directory':
        return truncate(String(args.path ?? '.'));
      case 'run_command':
        return truncate(String(args.command ?? ''));
      case 'grep_files':
        return truncate(`/${args.pattern ?? ''}/  ${args.path ?? '.'}`);
      default:
        return '';
    }
  }

  /**
   * Derive the extra context to show on the ↳ result line — the first 100
   * chars of the most informative field in the result payload.
   */
  function resultSnippet(toolName: string, resultStr: string): string {
    try {
      const parsed = JSON.parse(resultStr) as Record<string, unknown>;
      switch (toolName) {
        case 'read_file':
          return truncate(String(parsed.content ?? resultStr));
        case 'write_file':
          return `${parsed.bytesWritten ?? '?'} bytes written`;
        case 'edit_file':
          return parsed.replaced ? 'replaced' : 'not replaced';
        case 'list_directory': {
          const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
          return truncate(entries.join(', '));
        }
        case 'run_command': {
          const out = String(parsed.stdout ?? '');
          const err = String(parsed.stderr ?? '');
          const code = parsed.exitCode ?? 0;
          const body = (out || err || '(no output)').trim();
          const prefix = code !== 0 ? `exit ${code} · ` : '';
          return prefix + truncate(body);
        }
        case 'grep_files': {
          const count = parsed.matchCount ?? 0;
          const trunc = parsed.truncated ? '+' : '';
          return `${count}${trunc} match${count === 1 ? '' : 'es'}`;
        }
        default:
          return truncate(resultStr);
      }
    } catch {
      return truncate(resultStr);
    }
  }

  // ── Stream state ────────────────────────────────────────────────────────

  // Track state across turns so we can emit a blank line between whole
  // message turns (e.g. turn 0 text → tool calls → turn 1 text) while
  // letting the content itself supply newlines within a single turn.
  let turnHadText = false;
  let lastCharInTurn = '';
  // turnNumber is the value from TurnStartEvent — 0 is the initial request,
  // 1+ are follow-up tool-execution turns.
  let currentTurnNumber = 0;
  // Highest turn number seen (used to report turn count after streaming ends).
  let maxTurnNumber = 0;
  // Map from callId → tool name, populated from the output_item.done event
  // so the result line can label itself with the originating tool name.
  const toolCallNames = new Map<string, string>();

  for await (const event of result.getFullResponsesStream()) {
    if (isTurnStartEvent(event)) {
      currentTurnNumber = event.turnNumber;
      if (currentTurnNumber > maxTurnNumber) maxTurnNumber = currentTurnNumber;

      // Reset per-turn tracking at the start of each new message turn.
      turnHadText = false;
      lastCharInTurn = '';

      // Emit a visible turn-separator banner for every turn after the first
      // so the user can see agentic round-trips happening in real time.
      if (currentTurnNumber > 0) {
        onTextDelta(`\n── Turn ${currentTurnNumber} ──\n`);
      }
    } else if (isTurnEndEvent(event)) {
      // After a turn that produced visible text, emit a blank separator so
      // the next turn (if any) is visually separated. Within a turn, newlines
      // come naturally from the streamed content — we never inject extras.
      if (turnHadText) {
        if (lastCharInTurn !== '\n') {
          onTextDelta('\n');
        }
        onTextDelta('\n');
      }
    } else if ('type' in event && event.type === 'response.output_text.delta') {
      const delta = (event as { type: string; delta: string }).delta;
      if (delta) {
        onTextDelta(delta);
        lastCharInTurn = delta[delta.length - 1];
        turnHadText = true;
      }
    } else if ('type' in event && event.type === 'response.output_item.done') {
      // A response output item is complete. If it's a function_call, render a
      // one-liner with the tool name plus a context snippet from its arguments.
      const doneEvent = event as {
        type: string;
        item: { type: string; name?: string; arguments?: string; callId?: string; id?: string };
      };
      const item = doneEvent.item;
      if (item.type === 'function_call' && item.name) {
        // Record callId → name/args so we can label the result when it arrives.
        const callId = item.callId ?? item.id ?? '';
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(item.arguments ?? '{}') as Record<string, unknown>; } catch { /* ignore */ }
        if (callId) toolCallNames.set(callId, item.name);
        const snippet = callSnippet(item.name, args);
        const detail = snippet ? ` ${snippet}` : ` ${Buffer.byteLength(item.arguments ?? '', 'utf8')} bytes`;
        onTextDelta(`\n⚙ ${item.name}${detail}\n`);
        turnHadText = true;
        lastCharInTurn = '\n';
      }
    } else if (isToolCallOutputEvent(event)) {
      // A tool result — look up the tool name via the callId and show a snippet.
      const { output } = event;
      const toolName = toolCallNames.get(output.callId) ?? output.callId;
      const resultStr = typeof output.output === 'string'
        ? output.output
        : JSON.stringify(output.output);
      const snippet = resultSnippet(toolName, resultStr);
      onTextDelta(`  ↳ ${toolName}: ${snippet}\n`);
      turnHadText = true;
      lastCharInTurn = '\n';
    }
  }

  const text = await result.getText();
  const response = await result.getResponse();

  // The final getResponse() call may carry usage for the last turn when
  // onTurnEnd hasn't fired yet (e.g. single-turn responses with no tools).
  // Add any cost not yet captured by onTurnEnd callbacks.
  const finalCost = response.usage?.cost ?? 0;
  // Guard against double-counting: if promptCost is still 0 (no onTurnEnd
  // fired), use the final response cost directly.
  if (promptCost === 0 && finalCost > 0) {
    promptCost = finalCost;
  }

  const finalGenId = createGenerationId();
  await logGeneration({
    sessionId,
    requestId,
    generationId: finalGenId,
    response,
    timestamp: new Date().toISOString(),
  });

  // Update session-level accumulators.
  session.totalCost += promptCost;
  // turnCount = number of inner-loop turns (0 means a single shot with no
  // tool round-trips; 1+ means tool calls were made).
  const turnCount = maxTurnNumber;
  session.totalTurns += turnCount;

  return { text, model: response.model, turnCount, promptCost, totalCost: session.totalCost };
}
