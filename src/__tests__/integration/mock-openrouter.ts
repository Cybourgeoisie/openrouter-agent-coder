import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

export interface FixtureResponse {
  id?: string;
  model?: string;
  usage?: { cost?: number; inputTokens?: number; outputTokens?: number; totalTokens?: number };
  output?: unknown[];
}

export type FixtureStep =
  | { type: 'yield'; event: Record<string, unknown> }
  | { type: 'tool_execute'; toolName: string; input: unknown; callId: string }
  | { type: 'wait_until'; signal: 'paused' | 'aborted' }
  | { type: 'invoke_turn_end'; turnNumber?: number }
  | { type: 'throw'; message: string };

export interface Fixture {
  name: string;
  steps: FixtureStep[];
  response?: FixtureResponse;
}

export interface MockState {
  fixture: Fixture | null;
  ctorArgs: unknown[];
  callModelArgs: unknown[];
  /** Resolves on test-controlled signal — set before iterating the fixture. */
  pausedGate: { promise: Promise<void>; resolve: () => void } | null;
  /** When set, the OpenRouter constructor throws an Error with this message. */
  constructorThrows: string | null;
}

export function createMockState(): MockState {
  return {
    fixture: null,
    ctorArgs: [],
    callModelArgs: [],
    pausedGate: null,
    constructorThrows: null,
  };
}

export function loadFixture(name: string): Fixture {
  const path = join(FIXTURES_DIR, `${name}.json`);
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw) as Fixture;
}

export function createGate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Build a stand-in for the `@openrouter/agent` module that plays back a
 * recorded fixture. The shape mirrors only what `src/agent.ts` consumes:
 * `OpenRouter` constructor + `callModel(...).{ cancel, getFullResponsesStream,
 * getResponse }` plus the type-guard helpers. Anything else is unused and
 * intentionally omitted.
 */
export function createOpenRouterMockModule(state: MockState): Record<string, unknown> {
  const stepCountIs = (n: number): { kind: string; n: number } => ({ kind: 'stepCountIs', n });
  const maxCost = (n: number): { kind: string; n: number } => ({ kind: 'maxCost', n });
  const isTurnStartEvent = (e: unknown): boolean =>
    !!e && typeof e === 'object' && (e as { type?: string }).type === 'turn.start';
  const isTurnEndEvent = (e: unknown): boolean =>
    !!e && typeof e === 'object' && (e as { type?: string }).type === 'turn.end';
  const isToolCallOutputEvent = (e: unknown): boolean =>
    !!e && typeof e === 'object' && (e as { type?: string }).type === 'tool.call_output';

  class OpenRouter {
    constructor(args: unknown) {
      state.ctorArgs.push(args);
      if (state.constructorThrows) {
        throw new Error(state.constructorThrows);
      }
    }
    callModel(args: {
      tools?: Array<{
        function: { name: string; execute?: (i: unknown, c?: unknown) => unknown };
      }>;
      onTurnEnd?: (ctx: unknown, resp: FixtureResponse) => Promise<void> | void;
    }): {
      cancel: () => Promise<void>;
      getFullResponsesStream: () => AsyncGenerator<unknown>;
      getResponse: () => Promise<FixtureResponse>;
    } {
      state.callModelArgs.push(args);
      const fixture = state.fixture;
      if (!fixture) throw new Error('mock-openrouter: no fixture loaded');
      const tools = args.tools ?? [];
      const findTool = (
        name: string,
      ): { function: { execute?: (i: unknown, c?: unknown) => unknown } } | undefined =>
        tools.find((t) => t.function.name === name);
      const response: FixtureResponse = fixture.response ?? {
        id: 'mock-resp',
        model: 'mock-model',
        usage: { cost: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        output: [],
      };

      let cancelled = false;
      const pausedGate = state.pausedGate;

      async function* stream(): AsyncGenerator<unknown> {
        for (const step of fixture!.steps) {
          // `throw`, `wait_until`, and plain `yield` run regardless of the
          // cancel flag — the agent has its own post-abort filters and an
          // outer catch, and we want those exercised. Heavy / side-effect
          // steps (invoke_turn_end, tool_execute) still short-circuit so the
          // mock does not double-bill costs or re-run tools after cancel.
          if (step.type === 'throw') {
            throw new Error(step.message);
          }
          if (step.type === 'wait_until') {
            if (step.signal === 'paused' && pausedGate) await pausedGate.promise;
            continue;
          }
          if (step.type === 'yield') {
            yield step.event;
            continue;
          }
          if (cancelled) return;
          if (step.type === 'invoke_turn_end') {
            if (args.onTurnEnd) await args.onTurnEnd({}, response);
            continue;
          }
          if (step.type === 'tool_execute') {
            const tool = findTool(step.toolName);
            const execute = tool?.function.execute;
            let output: unknown;
            let status: 'completed' | 'incomplete' = 'completed';
            if (typeof execute !== 'function') {
              status = 'incomplete';
              output = `tool ${step.toolName} not found`;
            } else {
              try {
                output = await execute(step.input, { toolCall: { callId: step.callId } });
              } catch (err) {
                status = 'incomplete';
                output = err instanceof Error ? err.message : String(err);
              }
            }
            yield {
              type: 'tool.call_output',
              timestamp: 0,
              output: {
                callId: step.callId,
                type: 'function_call_output',
                output,
                status,
              },
            };
            continue;
          }
        }
      }

      return {
        cancel: async () => {
          cancelled = true;
        },
        getFullResponsesStream: () => stream(),
        getResponse: async () => response,
      };
    }
  }

  return {
    OpenRouter,
    stepCountIs,
    maxCost,
    isTurnStartEvent,
    isTurnEndEvent,
    isToolCallOutputEvent,
  };
}
