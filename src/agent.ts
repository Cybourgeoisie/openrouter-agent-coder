import {
  OpenRouter,
  stepCountIs,
  maxCost,
  isTurnStartEvent,
  isTurnEndEvent,
} from '@openrouter/agent';
import type { ConversationState } from '@openrouter/agent';
import { allTools } from './tools/index.js';
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

export interface AgentSession {
  sessionId: string;
  client: OpenRouter;
}

export function createAgent(sessionId: string): AgentSession {
  const client = new OpenRouter({
    apiKey: process.env.OPENROUTER_API_KEY,
    ...(process.env.OPENROUTER_BASE_URL && { serverURL: process.env.OPENROUTER_BASE_URL }),
    appTitle: 'OR/Agent Coder',
  });
  return { sessionId, client };
}

export async function runPrompt(
  session: AgentSession,
  prompt: string,
  onTextDelta: (delta: string) => void,
): Promise<string> {
  const { sessionId, client } = session;
  const requestId = createRequestId();
  const state = createFileStateAccessor(sessionId);

  await logRequest({
    sessionId,
    requestId,
    prompt,
    timestamp: new Date().toISOString(),
  });

  const result = client.callModel({
    model: DEFAULT_MODEL,
    sessionId,
    input: prompt,
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
    },
  });

  // Track state across turns so we can emit a blank line between whole
  // message turns (e.g. turn 0 text → tool calls → turn 1 text) while
  // letting the content itself supply newlines within a single turn.
  let turnHadText = false;
  let lastCharInTurn = '';

  for await (const event of result.getFullResponsesStream()) {
    if (isTurnStartEvent(event)) {
      // Reset per-turn tracking at the start of each new message turn.
      turnHadText = false;
      lastCharInTurn = '';
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
    }
  }

  const text = await result.getText();
  const response = await result.getResponse();

  const finalGenId = createGenerationId();
  await logGeneration({
    sessionId,
    requestId,
    generationId: finalGenId,
    response,
    timestamp: new Date().toISOString(),
  });

  return text;
}
