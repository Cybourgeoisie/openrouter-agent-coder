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

// ----- /responses (OpenResponses) wire — Phase 6.5a -----
//
// Mirrors the in-memory `OpenResponsesResponse` shape from `script-engine.ts`.
// Tool-use args land as a JSON string so the wire-level "args streamed as
// incremental string concat" property is preserved verbatim from script to
// emulator output.

const openResponsesContentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('tool_use'),
    callId: z.string(),
    name: z.string(),
    arguments: z.string(),
  }),
]);

const openResponsesResponseSchema = z.object({
  id: z.string().optional(),
  model: z.string(),
  status: z.enum(['completed', 'incomplete', 'failed']),
  content: z.array(openResponsesContentBlockSchema),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative().optional(),
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

const openResponsesEntrySchema = z.object({
  wire: z.literal('openresponses'),
  promptHash: z.string(),
  turn: z.number().int().nonnegative(),
  kind: z.literal('success'),
  response: openResponsesResponseSchema,
  stream: streamControlSchema,
});

const scriptEntrySchema = z.union([
  anthropicEntrySchema,
  openaiEntrySchema,
  openResponsesEntrySchema,
]);

// ----- Comparator config (Phase 6.4) -----
//
// Carried on the scenario; consumed by `comparator.ts`. `mode` picks
// exact (deterministic emulator runs) vs tolerant (live runs). Token /
// final-text / per-arg tolerance bands apply ONLY in tolerant mode — the
// load-bearing parity claim ("event-shape + hook firing order exact in both
// modes") cannot be widened from here. See `plans/comparative-parity-harness.md`
// § "The comparator" for rationale.
//
// `ignore` extends the hard-coded mask set in `transcript.ts` with scenario-
// local additions; it does NOT subtract from the base set. Keys are matched
// the same way `maskNondeterminism` matches its built-in set — by exact key
// name anywhere in the projected event tree.
//
// `argTolerances` is keyed by `<toolName>.<dot.path.into.args>` — dot-path
// syntax, no JSONPath, no array indexing. v1 keeps this simple; richer
// matching is a follow-up if a real scenario needs it.

const finalTextAssertionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('substring'), value: z.string() }),
  z.object({ type: z.literal('regex'), value: z.string() }),
  z.object({
    type: z.literal('lengthRange'),
    min: z.number().int().nonnegative().optional(),
    max: z.number().int().nonnegative().optional(),
  }),
]);

const argToleranceSchema = z.discriminatedUnion('type', [
  // Substring containment on a string-valued arg.
  z.object({ type: z.literal('substring'), value: z.string() }),
  // Numeric proximity within ±delta on a number-valued arg.
  z.object({ type: z.literal('numericDelta'), delta: z.number().nonnegative() }),
  // "Any value, just must be present" — for fields the model varies freely.
  z.object({ type: z.literal('anyString') }),
]);

const comparatorConfigSchema = z
  .object({
    mode: z.enum(['exact', 'tolerant']),
    ignore: z.array(z.string()).optional(),
    tokenTolerancePct: z.number().nonnegative().optional(),
    finalTextAssertion: finalTextAssertionSchema.nullable().optional(),
    argTolerances: z.record(z.string(), argToleranceSchema).nullable().optional(),
  })
  .optional();

export type ComparatorConfig = z.infer<typeof comparatorConfigSchema>;
export type FinalTextAssertion = z.infer<typeof finalTextAssertionSchema>;
export type ArgTolerance = z.infer<typeof argToleranceSchema>;

// ----- Tool + permission wiring (Phase 6.5a) -----
//
// Scenarios with tool calls declare the fixture names from `_tools.ts` and an
// optional `canUseToolPolicy` (used by scenario #4's permission-denial case).
// The harness reads these and wires both SDKs symmetrically:
//   - OR: `tools` option (filtered to scenario's set), `canUseTool` closure
//         that fires the policy.
//   - Anthropic: `mcpServers: { harness: ... }`, `allowedTools` filter,
//         `canUseTool` closure that mirrors the OR policy.

const harnessToolNameSchema = z.enum(['echo', 'counter', 'rm']);

const canUseToolPolicySchema = z.array(
  z.discriminatedUnion('action', [
    z.object({ tool: harnessToolNameSchema, action: z.literal('allow') }),
    z.object({
      tool: harnessToolNameSchema,
      action: z.literal('deny'),
      // Deny message is canon per ambiguity call #4 — exact-text comparison
      // is the point of the parity assertion. Both SDKs receive the same
      // string back from canUseTool; the model's adaptation text is asserted
      // by the comparator's per-event positional equality.
      message: z.string().min(1),
    }),
  ]),
);

export const scenarioSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  prompt: z.string().min(1),
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
  /**
   * Fixture tool names to register from `scenarios/_tools.ts`. Empty/omitted
   * means no tools (scenario #1's no-tool happy path). The harness builds
   * BOTH SDK-side bindings from this single declaration.
   */
  tools: z.array(harnessToolNameSchema).optional(),
  /** Policy applied by both SDKs' `canUseTool` closure. Per-tool allow/deny. */
  canUseToolPolicy: canUseToolPolicySchema.optional(),
  script: z.array(scriptEntrySchema).min(1),
  comparator: comparatorConfigSchema,
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
export function entriesForWire(
  scenario: Scenario,
  wire: 'anthropic' | 'openai' | 'openresponses',
): ScriptEntry[] {
  const out: ScriptEntry[] = [];
  for (const entry of scenario.script) {
    const entryWire = entry.wire ?? 'anthropic';
    if (entryWire !== wire) continue;
    out.push(entry as ScriptEntry);
  }
  return out;
}
