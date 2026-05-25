// Scenario authoring helper (Phase 6.5a). TypeScript module used during
// scenario authoring to:
//
//   1. Compute the canonical `promptHash` for a request body without making
//      authors hand-SHA the canonicalized JSON.
//   2. Assemble `ScriptEntry`-shaped objects with the wire / turn / response
//      fields wired up, ready to JSON.stringify into a scenario file.
//   3. Surface the prefixed Anthropic tool name (`mcp__harness__echo`) so
//      scripts can stay aligned with what the SDK actually emits on
//      `tool_use.name`.
//
// **The output of this helper is JSON.** Resolved Q2 in the plan doc is
// "JSON for canonical set, TS for authoring." Don't ship `.ts` scenarios
// from this directory — the loader is JSON-only and the comparative driver
// iterates `*.json` files. Authoring scripts in TS that emit JSON are fine
// to keep alongside (gitignored if one-off; checked in if reusable).
//
// === Workflow (manual, until 6.10's recorder lands) ===
//
//   1. Sketch the scenario in TS using `scriptEntry()` with placeholder
//      hashes ('sha256:capture-me'); ship the JSON.
//   2. Run the comparative suite. Both adapters log a 4xx/5xx with the
//      real `promptHash` in the diagnostic body when a script misses.
//   3. Paste the real hashes into the JSON (or regenerate via this helper
//      passing the exact body the SDK sent).
//   4. Re-run; iterate per turn until clean.
//
// Why the helper exists at all (vs. just `computePromptHash`): the canonical
// hash function operates on the SDK's full request body, which authors don't
// hand-craft. The helper bundles the wire format + turn index + response
// shape into one place so a scenario file's structure stays mechanical and
// reviewer-friendly.

import {
  computePromptHash,
  type AnthropicResponse,
  type AnthropicScriptEntry,
  type OpenAIResponse,
  type OpenAIScriptEntry,
  type OpenResponsesResponse,
  type OpenResponsesScriptEntry,
  type StreamControl,
  type WireFormat,
} from '../emulator/index.js';
import { MCP_SERVER_NAME, anthropicToolName } from './_tools.js';

export { MCP_SERVER_NAME, anthropicToolName, computePromptHash };

/**
 * Placeholder hash recognized by `scriptEntry()` as "I haven't captured the
 * real one yet — emit a sentinel that will deliberately fail script-lookup
 * so the diagnostic dumps the actual body." Authors paste the real hash
 * back in once they've seen the capture.
 */
export const CAPTURE_ME = 'sha256:capture-me';

interface ScriptEntryArgsBase {
  /** 0-indexed turn number for this entry within the scenario. */
  turn: number;
  /**
   * The canonical `promptHash` for this turn's request. Use `CAPTURE_ME` to
   * leave it pending; the script will fail-and-diagnose on first run so the
   * author can paste the real hash from the emulator's miss diagnostic.
   */
  promptHash: string;
  /** Optional streaming control (chunk size, inter-chunk delay). */
  stream?: StreamControl;
}

export interface AnthropicScriptEntryArgs extends ScriptEntryArgsBase {
  wire: 'anthropic';
  response: AnthropicResponse;
}

export interface OpenAIScriptEntryArgs extends ScriptEntryArgsBase {
  wire: 'openai';
  response: OpenAIResponse;
}

export interface OpenResponsesScriptEntryArgs extends ScriptEntryArgsBase {
  wire: 'openresponses';
  response: OpenResponsesResponse;
}

export type ScriptEntryArgs =
  | AnthropicScriptEntryArgs
  | OpenAIScriptEntryArgs
  | OpenResponsesScriptEntryArgs;

/**
 * Factory for one script entry. Picked over a builder pattern per ambiguity
 * call #1 — the surface is small (wire + turn + hash + response + optional
 * stream) and a single positional argument keeps the JSON layout readable.
 * The output is plain data; JSON.stringify it into the scenario's `script`
 * array verbatim.
 *
 * `kind` is hard-coded to `'success'` because failure-injection on the
 * canonical set is 6.6's job; 6.5a's #1–#4 are happy-path only.
 */
export function scriptEntry(args: AnthropicScriptEntryArgs): AnthropicScriptEntry;
export function scriptEntry(args: OpenAIScriptEntryArgs): OpenAIScriptEntry;
export function scriptEntry(args: OpenResponsesScriptEntryArgs): OpenResponsesScriptEntry;
export function scriptEntry(
  args: ScriptEntryArgs,
): AnthropicScriptEntry | OpenAIScriptEntry | OpenResponsesScriptEntry {
  const base = {
    wire: args.wire,
    promptHash: args.promptHash,
    turn: args.turn,
    kind: 'success' as const,
    ...(args.stream && { stream: args.stream }),
  };
  if (args.wire === 'anthropic') {
    return { ...base, wire: 'anthropic', response: args.response } as AnthropicScriptEntry;
  }
  if (args.wire === 'openai') {
    return { ...base, wire: 'openai', response: args.response } as OpenAIScriptEntry;
  }
  return {
    ...base,
    wire: 'openresponses',
    response: args.response,
  } as OpenResponsesScriptEntry;
}

/**
 * Compute the canonical `promptHash` for a request body, given the wire
 * format. Re-exported here so authoring scripts that capture the SDK's
 * actual request body (e.g. by intercepting the emulator's diagnostic dump)
 * can produce the matching hash without importing from the emulator
 * internals directly.
 */
export function promptHashFor(body: unknown, wire: WireFormat): string {
  return computePromptHash(body, wire);
}
