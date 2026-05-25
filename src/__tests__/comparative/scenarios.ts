// Scenario file loader + schema for the comparative-parity harness.
//
// v1 is intentionally minimal: a scenario is a name + prompt + an array of
// script entries that match the existing emulator ScriptEntry shape. The
// loader copies entries into BOTH adapters' registries (Anthropic + OpenAI),
// and the emulator's wire dispatch (router in `emulator/index.ts`) decides
// which wire each entry serves on the wire.
//
// 6.5a will expand this schema with comparator config, per-scenario
// tolerances, failure-injection metadata, and the cost-budget knob for live
// mode. This file is scoped strictly to what the 6.3 smoke needs to compile.
//
// TODO(6.5): expand schema — comparator config, tolerances, budgets.

import { readFile } from 'node:fs/promises';
import { z } from 'zod';

import type { ScriptEntry } from './emulator/index.js';

const anthropicContentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
  }),
]);

const anthropicResponseSchema = z.object({
  id: z.string().optional(),
  model: z.string(),
  stopReason: z.enum(['end_turn', 'tool_use', 'max_tokens', 'stop_sequence', 'pause_turn']),
  stopSequence: z.string().nullable().optional(),
  content: z.array(anthropicContentBlockSchema),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
});

const openaiResponseSchema = z.object({
  id: z.string().optional(),
  model: z.string(),
  finishReason: z.enum(['stop', 'tool_calls', 'length', 'content_filter']),
  content: z.string().optional(),
  toolCalls: z
    .array(z.object({ id: z.string(), name: z.string(), arguments: z.string() }))
    .optional(),
  reasoning: z.string().optional(),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative(),
  }),
});

const streamControlSchema = z
  .object({
    chunkSize: z.union([z.literal('natural'), z.number().int().positive()]).optional(),
    interChunkDelayMs: z.number().int().nonnegative().optional(),
  })
  .optional();

const anthropicEntrySchema = z.object({
  wire: z.literal('anthropic').optional(),
  promptHash: z.string(),
  turn: z.number().int().nonnegative(),
  kind: z.literal('success'),
  response: anthropicResponseSchema,
  stream: streamControlSchema,
});

const openaiEntrySchema = z.object({
  wire: z.literal('openai'),
  promptHash: z.string(),
  turn: z.number().int().nonnegative(),
  kind: z.literal('success'),
  response: openaiResponseSchema,
  stream: streamControlSchema,
});

const scriptEntrySchema = z.union([anthropicEntrySchema, openaiEntrySchema]);

export const scenarioSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  prompt: z.string().min(1),
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
  script: z.array(scriptEntrySchema).min(1),
});

export type Scenario = z.infer<typeof scenarioSchema>;

/** Load + validate a scenario JSON file from disk. */
export async function loadScenario(scenarioPath: string): Promise<Scenario> {
  const raw = await readFile(scenarioPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Scenario file ${scenarioPath} is not valid JSON: ${(err as Error).message}`, {
      cause: err,
    });
  }
  const result = scenarioSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Scenario file ${scenarioPath} failed schema validation:\n${JSON.stringify(result.error.issues, null, 2)}`,
    );
  }
  return result.data;
}

/**
 * Extract the script entries for a given wire format. Entries without `wire`
 * default to `anthropic` — same default as the emulator's script-engine.
 */
export function entriesForWire(scenario: Scenario, wire: 'anthropic' | 'openai'): ScriptEntry[] {
  const out: ScriptEntry[] = [];
  for (const entry of scenario.script) {
    const entryWire = entry.wire ?? 'anthropic';
    if (entryWire !== wire) continue;
    out.push(entry as ScriptEntry);
  }
  return out;
}
