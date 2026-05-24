/**
 * Phase 5.5 — `tool_search` + `tool_load` dynamic MCP tool discovery.
 *
 * When an agent run is configured with many MCP servers exposing dozens or
 * hundreds of tools, sending every tool's JSON Schema to the model on every
 * turn burns prompt budget. The opt-in `enableToolSearch` flag (see
 * {@link OpenRouterAgentRunOptions}) hides the bridge's MCP tools behind two
 * built-in tools the model invokes explicitly:
 *
 * - `tool_search({ query, limit? })` returns ranked matches from the MCP
 *   tool catalog without registering anything. Each match carries the
 *   prefixed `<serverName>__<toolName>` name, a server-name field, the
 *   tool's description, and a truncated `schema_preview` so the model can
 *   judge whether the tool is the right fit.
 * - `tool_load({ names })` registers one or more MCP tools into the run's
 *   working-set so subsequent turns can call them. Already-loaded tools are
 *   reported in a separate field; unknown names are reported as `notFound`.
 *
 * The agent wires both factories with a `getCatalog()` closure over the
 * per-run {@link McpBridge}'s tool list and an `onLoad` callback that mutates
 * the live `tools` array passed into the SDK's `callModel`. Each successful
 * load fires a `Notification` hook (`info`, `tool_loaded`) so audit
 * consumers can observe the working-set growth.
 *
 * Scorer (deterministic, hand-rolled — no deps):
 *
 * - +10 if the lowercased name CONTAINS the lowercased query
 * - +5 if the lowercased description CONTAINS the lowercased query
 * - +2 per whitespace-tokenized query word found in the name
 * - +1 per whitespace-tokenized query word found in the description
 *
 * Tie-break ascending by `name`. The substring weights dominate per-token so
 * a query that matches a name verbatim ranks above a query whose individual
 * words happen to appear in a less-relevant description. Empty queries
 * return an empty `matches` array.
 */

import { tool } from '@openrouter/agent';
import { z } from 'zod/v4';
import { DEFAULT_TOOL_CONTEXT, type ToolContext } from './context.js';

/**
 * Max characters retained from the JSON-stringified `inputSchema` in a
 * {@link ToolSearchMatch}'s `schema_preview`. Schemas longer than this are
 * truncated and suffixed with {@link SCHEMA_PREVIEW_TRUNCATION_MARKER}. Picked
 * to be large enough to surface the top-level shape (a half-dozen keys with
 * short descriptions) but small enough that a 20-match search response
 * doesn't itself bloat the context the feature is trying to save.
 */
export const MAX_SCHEMA_PREVIEW_CHARS = 200;

/**
 * Single-character marker appended to a {@link ToolSearchMatch} whose
 * `schema_preview` was truncated at {@link MAX_SCHEMA_PREVIEW_CHARS}. Picked
 * as the unicode horizontal ellipsis (U+2026) rather than three dots so the
 * preview never gets misread as part of a JSON token.
 */
export const SCHEMA_PREVIEW_TRUNCATION_MARKER = '…';

/**
 * Default `limit` applied when the model omits one. Picked to fit comfortably
 * in a single tool result (typical schemas truncate around 200 chars, so 10
 * matches ≈ 2–3 KB of result text) without forcing the model to paginate for
 * the typical "find the right tool" use case.
 */
export const DEFAULT_SEARCH_LIMIT = 10;

/**
 * Hard ceiling enforced on the `limit` input. The catalog itself is bounded
 * by the host's MCP configuration, so this cap mostly guards against a model
 * passing an absurd value that would dump every tool's schema preview.
 */
export const MAX_SEARCH_LIMIT = 50;

/**
 * Catalog entry the search index reads. Mirrors the shape the
 * {@link McpBridge} exposes on `bridge.tools`, plus a synthetic `server`
 * field derived from the prefix on `name`. The factory's `getCatalog()`
 * closure builds these from the live bridge on each call so the index
 * naturally reflects whatever subset of servers handshook successfully — a
 * server that failed init never appears, and the run continues without it.
 */
export interface SearchableTool {
  /** Prefixed name (`<serverName>__<toolName>`) as registered by the bridge. */
  name: string;
  /** Originating MCP server name (the prefix before `__`). */
  server: string;
  /** Tool description as reported by the server's `tools/list` response. */
  description?: string;
  /** Raw `inputSchema` (JSON Schema object) used to build `schema_preview`. */
  inputSchema?: unknown;
}

/**
 * A single search hit emitted from `tool_search`. The `schema_preview` is a
 * char-capped JSON stringification of the tool's `inputSchema` (see
 * {@link MAX_SCHEMA_PREVIEW_CHARS}); when the input schema was missing the
 * field is omitted entirely so the model can tell "no schema" apart from
 * "empty object schema". `score` is included so the model has signal on how
 * confident the index is in each hit — useful when two matches are tied or
 * the query is ambiguous.
 */
export interface ToolSearchMatch {
  name: string;
  server: string;
  description?: string;
  schema_preview?: string;
  score: number;
}

/**
 * Result envelope returned by `tool_search`. `note` is populated only on
 * "empty catalog" or "empty query" — non-error explanatory text the model
 * may use to recover (e.g. ask the user a clarifying question, or move on
 * without searching). Errors throw and surface as `tool_result.isError`.
 */
export interface ToolSearchToolResult {
  matches: ToolSearchMatch[];
  note?: string;
}

/**
 * Result envelope returned by `tool_load`. Each input name lands in exactly
 * one of the three buckets, so a caller can detect partial-success by
 * checking `notFound.length > 0` or `alreadyLoaded.length > 0`. The order
 * within each bucket mirrors the input array's order (de-duplicated).
 */
export interface ToolLoadToolResult {
  loaded: string[];
  alreadyLoaded: string[];
  notFound: string[];
}

/**
 * Tokenize a query string by whitespace. Lowercases, splits on `\s+`, drops
 * empty fragments. Exported so the test suite can assert tokenization
 * matches the scorer's view.
 */
export function tokenize(input: string): string[] {
  const lower = input.toLowerCase();
  const tokens = lower.split(/\s+/);
  const out: string[] = [];
  for (const t of tokens) {
    if (t.length > 0) out.push(t);
  }
  return out;
}

/**
 * Score a single catalog entry against a query string per the weighting
 * documented in this module's header. Exported for the unit suite — the
 * factory itself goes through {@link searchCatalog}.
 */
export function scoreMatch(
  query: string,
  candidate: Pick<SearchableTool, 'name' | 'description'>,
): number {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return 0;
  const nameLower = candidate.name.toLowerCase();
  const descLower = (candidate.description ?? '').toLowerCase();
  let score = 0;
  if (nameLower.includes(q)) score += 10;
  if (descLower.length > 0 && descLower.includes(q)) score += 5;
  const tokens = tokenize(q);
  for (const tok of tokens) {
    if (nameLower.includes(tok)) score += 2;
    if (descLower.length > 0 && descLower.includes(tok)) score += 1;
  }
  return score;
}

/**
 * Build a JSON-stringified preview of an `inputSchema`, capped at
 * {@link MAX_SCHEMA_PREVIEW_CHARS}. Returns `undefined` for a missing input
 * schema (so the match envelope can omit the field entirely instead of
 * advertising an empty preview). A schema that cannot be JSON-serialized
 * (e.g. cyclic) falls back to its `toString()` representation rather than
 * throwing — the preview is best-effort.
 */
export function buildSchemaPreview(inputSchema: unknown): string | undefined {
  if (inputSchema === undefined || inputSchema === null) return undefined;
  let json: string;
  try {
    json = JSON.stringify(inputSchema);
  } catch {
    json = String(inputSchema);
  }
  if (json === undefined) return undefined;
  if (json.length <= MAX_SCHEMA_PREVIEW_CHARS) return json;
  return json.slice(0, MAX_SCHEMA_PREVIEW_CHARS) + SCHEMA_PREVIEW_TRUNCATION_MARKER;
}

/**
 * Run the scorer against every catalog entry, drop zero-score entries,
 * sort by descending score with a name-ascending tie-break, slice to
 * `limit`, and project to {@link ToolSearchMatch}. Pure — exported so the
 * test suite can exercise the ranking deterministically without spinning
 * up an agent.
 */
export function searchCatalog(
  catalog: readonly SearchableTool[],
  query: string,
  limit: number,
): ToolSearchMatch[] {
  if (catalog.length === 0) return [];
  const scored: Array<{ entry: SearchableTool; score: number }> = [];
  for (const entry of catalog) {
    const score = scoreMatch(query, entry);
    if (score > 0) scored.push({ entry, score });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.entry.name < b.entry.name) return -1;
    if (a.entry.name > b.entry.name) return 1;
    return 0;
  });
  const sliced = scored.slice(0, limit);
  return sliced.map(({ entry, score }) => {
    const preview = buildSchemaPreview(entry.inputSchema);
    const match: ToolSearchMatch = {
      name: entry.name,
      server: entry.server,
      score,
    };
    if (entry.description !== undefined) match.description = entry.description;
    if (preview !== undefined) match.schema_preview = preview;
    return match;
  });
}

/**
 * Factory inputs for {@link toolSearchTool}.
 *
 * - `getCatalog` is invoked on every search call and must return the current
 *   MCP tool catalog. The agent supplies a closure over the per-run
 *   {@link McpBridge}'s `tools` getter so server-init failures naturally
 *   shrink the catalog without further bookkeeping.
 */
export interface ToolSearchToolOptions {
  getCatalog: () => readonly SearchableTool[];
}

/**
 * Build the `tool_search` built-in tool. The factory takes a `getCatalog()`
 * closure (not a snapshot) so the catalog is read fresh on every call — the
 * agent's bridge tool set is fixed for the life of a single run, but reading
 * lazily keeps the factory honest about that contract (and lets the
 * integration test stub the catalog mid-run).
 */
export function toolSearchTool(
  opts: ToolSearchToolOptions,
  _ctx: ToolContext = DEFAULT_TOOL_CONTEXT,
) {
  // ctx is accepted for factory-signature symmetry with the other built-in
  // tools (see e.g. `taskCreateTool` / `askUserQuestionTool`); the search
  // tool is pure and has no per-execute resource needs of its own.
  void _ctx;
  return tool({
    name: 'tool_search',
    description:
      'Search the catalog of MCP tools loaded from configured servers. Returns ranked matches by name and description; each match carries the prefixed `serverName__toolName`, the originating `server`, the tool `description`, a truncated `schema_preview` of the tool input schema, and a numeric `score`. Use this when you suspect an MCP tool exists for a task but its specific name is unknown — then call `tool_load` with the chosen `serverName__toolName` to register it for use. Returns `{ matches: [...], note? }`; `note` is populated when the catalog is empty or the query is empty.',
    inputSchema: z.object({
      query: z
        .string()
        .describe(
          'Search query. Matched (case-insensitive) against the prefixed tool name and description. Substring matches on the full query score higher than per-word token matches.',
        ),
      limit: z
        .number()
        .int()
        .positive()
        .max(MAX_SEARCH_LIMIT)
        .optional()
        .describe(
          `Maximum number of matches to return. Defaults to ${DEFAULT_SEARCH_LIMIT}; capped at ${MAX_SEARCH_LIMIT}.`,
        ),
    }),
    execute: async ({ query, limit }): Promise<ToolSearchToolResult> => {
      const catalog = opts.getCatalog();
      if (catalog.length === 0) {
        return {
          matches: [],
          note: 'No MCP tools are available in this run. Configure MCP servers via `mcpServers` or `autoDiscoverMcp: true` to populate the catalog.',
        };
      }
      const trimmed = query.trim();
      if (trimmed.length === 0) {
        return {
          matches: [],
          note: 'Query was empty — provide a non-empty search string.',
        };
      }
      const effectiveLimit = limit ?? DEFAULT_SEARCH_LIMIT;
      const matches = searchCatalog(catalog, trimmed, effectiveLimit);
      return { matches };
    },
  });
}

/**
 * Factory inputs for {@link toolLoadTool}. The agent wires:
 *
 * - `getCatalog` — same closure as {@link toolSearchTool}, so the load check
 *   sees the same set of names the search exposed.
 * - `isLoaded(name)` — runtime predicate returning whether the given prefixed
 *   name is already in the run's working set. The agent backs this with a
 *   shared `Set<string>`.
 * - `onLoad(name, server)` — invoked once per successfully-loaded name (NOT
 *   for `alreadyLoaded` or `notFound` entries). The agent's wiring mutates
 *   the live `toolsForRun` array so the SDK's next-turn tool-list build
 *   picks the new entry up, and fires the audit `Notification`.
 */
export interface ToolLoadToolOptions {
  getCatalog: () => readonly SearchableTool[];
  isLoaded: (name: string) => boolean;
  onLoad: (name: string, server: string) => void | Promise<void>;
}

/**
 * Build the `tool_load` built-in tool. Loading is the only side effect: the
 * tool itself returns the bucketed result (`loaded` / `alreadyLoaded` /
 * `notFound`) and otherwise leaves the agent's state untouched. Duplicate
 * names within a single call are coalesced — the second occurrence lands in
 * `alreadyLoaded` rather than triggering a second `onLoad` call.
 */
export function toolLoadTool(opts: ToolLoadToolOptions, _ctx: ToolContext = DEFAULT_TOOL_CONTEXT) {
  void _ctx;
  return tool({
    name: 'tool_load',
    description:
      "Register one or more MCP tools (by prefixed `serverName__toolName`, as returned from `tool_search`) into this run's working set so subsequent turns can call them. Returns `{ loaded, alreadyLoaded, notFound }` — partial successes are not an error. Each successful load also fires a `Notification` hook (`info`, `tool_loaded`) so audit consumers can observe working-set growth.",
    inputSchema: z.object({
      names: z
        .array(z.string().min(1))
        .min(1)
        .describe(
          'Prefixed tool names to register (e.g. `["mcp__filesystem__read_file"]`). Pulled from a prior `tool_search` call. Duplicates are coalesced. Names not present in the current MCP catalog land in `notFound` without throwing.',
        ),
    }),
    execute: async ({ names }): Promise<ToolLoadToolResult> => {
      const catalog = opts.getCatalog();
      const byName = new Map<string, SearchableTool>();
      for (const entry of catalog) byName.set(entry.name, entry);

      const loaded: string[] = [];
      const alreadyLoaded: string[] = [];
      const notFound: string[] = [];
      const seen = new Set<string>();

      for (const raw of names) {
        const name = raw.trim();
        if (name.length === 0) continue;
        if (seen.has(name)) {
          // Duplicate within this call. The first occurrence already landed
          // in one of the three buckets; the second-and-later land in
          // `alreadyLoaded` unconditionally so the model sees consistent
          // accounting regardless of input order.
          if (!alreadyLoaded.includes(name) && !notFound.includes(name)) {
            alreadyLoaded.push(name);
          }
          continue;
        }
        seen.add(name);
        const entry = byName.get(name);
        if (!entry) {
          notFound.push(name);
          continue;
        }
        if (opts.isLoaded(name)) {
          alreadyLoaded.push(name);
          continue;
        }
        await opts.onLoad(name, entry.server);
        loaded.push(name);
      }

      return { loaded, alreadyLoaded, notFound };
    },
  });
}
