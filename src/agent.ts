import { OpenRouter, stepCountIs, maxCost, isTurnStartEvent } from '@openrouter/agent';
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

  // Highest turn number seen across TurnStartEvents (used to report the turn
  // count after streaming ends). 0 means a single shot with no tool round-trips.
  let maxTurnNumber = 0;

  for await (const event of result.getFullResponsesStream()) {
    if (isTurnStartEvent(event)) {
      const currentTurnNumber = event.turnNumber;
      if (currentTurnNumber > maxTurnNumber) maxTurnNumber = currentTurnNumber;
    } else if ('type' in event && event.type === 'response.output_text.delta') {
      const delta = (event as { type: string; delta: string }).delta;
      if (delta) {
        onTextDelta(delta);
      }
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
