import { OpenRouter, stepCountIs, maxCost } from '@openrouter/agent';
import type { ConversationState } from '@openrouter/agent';
import { allTools } from './tools/index.js';
import { createFileStateAccessor } from './state/file-state.js';
import {
  createRequestId,
  createGenerationId,
  logRequest,
  logGeneration,
} from './logging/logger.js';

const DEFAULT_MODEL = process.env.OR_MODEL ?? 'anthropic/claude-sonnet-4';
const MAX_STEPS = parseInt(process.env.OR_MAX_STEPS ?? '25', 10);
const MAX_COST = parseFloat(process.env.OR_MAX_COST ?? '1.00');

export interface AgentSession {
  sessionId: string;
  client: OpenRouter;
}

export function createAgent(sessionId: string): AgentSession {
  const client = new OpenRouter({
    apiKey: process.env.OPENROUTER_API_KEY,
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

  for await (const delta of result.getTextStream()) {
    onTextDelta(delta);
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
