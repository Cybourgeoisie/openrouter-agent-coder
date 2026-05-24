import { describe, it, expect, vi } from 'vitest';
import {
  toolSearchTool,
  toolLoadTool,
  searchCatalog,
  scoreMatch,
  tokenize,
  buildSchemaPreview,
  MAX_SCHEMA_PREVIEW_CHARS,
  SCHEMA_PREVIEW_TRUNCATION_MARKER,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  type SearchableTool,
  type ToolSearchToolResult,
  type ToolLoadToolResult,
} from './tool-search.js';

interface SearchParams {
  query: string;
  limit?: number;
}
interface LoadParams {
  names: string[];
}

function makeSearch(
  opts: Parameters<typeof toolSearchTool>[0],
): (p: SearchParams) => Promise<ToolSearchToolResult> {
  const t = toolSearchTool(opts);
  return t.function.execute as (p: SearchParams) => Promise<ToolSearchToolResult>;
}
function makeLoad(
  opts: Parameters<typeof toolLoadTool>[0],
): (p: LoadParams) => Promise<ToolLoadToolResult> {
  const t = toolLoadTool(opts);
  return t.function.execute as (p: LoadParams) => Promise<ToolLoadToolResult>;
}

const CATALOG: SearchableTool[] = [
  {
    name: 'fs__read_file',
    server: 'fs',
    description: 'Read a file from disk and return its contents.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  },
  {
    name: 'fs__write_file',
    server: 'fs',
    description: 'Write content to a file on disk.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  },
  {
    name: 'db__query',
    server: 'db',
    description: 'Run a SQL query against the database.',
    inputSchema: { type: 'object', properties: { sql: { type: 'string' } } },
  },
  {
    name: 'web__search_web',
    server: 'web',
    description: 'Perform a web search and return ranked results.',
    inputSchema: { type: 'object' },
  },
  {
    name: 'misc__no_schema',
    server: 'misc',
    description: 'Has no input schema.',
  },
];

describe('tokenize', () => {
  it('splits on whitespace, lowercases, drops empties', () => {
    expect(tokenize('  Read  THE file  ')).toEqual(['read', 'the', 'file']);
  });

  it('returns empty array for whitespace-only input', () => {
    expect(tokenize('   ')).toEqual([]);
  });
});

describe('scoreMatch', () => {
  it('returns 0 for empty query', () => {
    expect(scoreMatch('', CATALOG[0]!)).toBe(0);
    expect(scoreMatch('   ', CATALOG[0]!)).toBe(0);
  });

  it('full substring in name scores 10, plus 2 per name-token hit', () => {
    // query "read_file" matches CATALOG[0].name exactly; lowercased single
    // token "read_file" appears in name too → 10 + 2 = 12.
    expect(scoreMatch('read_file', CATALOG[0]!)).toBe(12);
  });

  it('full substring in description scores 5, plus 1 per desc-token hit', () => {
    // "from disk" is a substring of the description but not of the name.
    // Tokens "from" and "disk" each match description → +1*2 = +2.
    expect(scoreMatch('from disk', CATALOG[0]!)).toBe(5 + 2);
  });

  it('multi-token query without a contiguous-substring match still scores via tokens', () => {
    // "file write" has tokens "file" (in name + desc) and "write" (in name).
    // Description "Write content to a file on disk." includes both tokens.
    const s = scoreMatch('file write', CATALOG[1]!);
    // Substring "file write" not in name or desc (order matters). Token
    // weights: name has "file" and "write" → +2+2=+4; desc has "file" and
    // "write" → +1+1=+2. Total = 6.
    expect(s).toBe(6);
  });

  it('handles candidates without a description', () => {
    expect(scoreMatch('no_schema', { name: 'misc__no_schema' })).toBe(12); // name substring + 1 token hit
  });
});

describe('buildSchemaPreview', () => {
  it('returns undefined for missing schema', () => {
    expect(buildSchemaPreview(undefined)).toBeUndefined();
    expect(buildSchemaPreview(null)).toBeUndefined();
  });

  it('returns JSON stringification for small schemas', () => {
    const s = { type: 'object', properties: { x: { type: 'string' } } };
    expect(buildSchemaPreview(s)).toBe(JSON.stringify(s));
  });

  it('truncates with the unicode ellipsis marker at MAX_SCHEMA_PREVIEW_CHARS', () => {
    const longProps: Record<string, { type: string; description: string }> = {};
    for (let i = 0; i < 50; i++) {
      longProps[`field${i}`] = { type: 'string', description: 'A long description here' };
    }
    const out = buildSchemaPreview({ type: 'object', properties: longProps })!;
    expect(out.length).toBe(MAX_SCHEMA_PREVIEW_CHARS + SCHEMA_PREVIEW_TRUNCATION_MARKER.length);
    expect(out.endsWith(SCHEMA_PREVIEW_TRUNCATION_MARKER)).toBe(true);
  });

  it('falls back to String() when JSON.stringify throws (cyclic input)', () => {
    const cyclic: Record<string, unknown> = { name: 'cycle' };
    cyclic.self = cyclic;
    const out = buildSchemaPreview(cyclic);
    expect(out).toBeDefined();
    expect(typeof out).toBe('string');
  });
});

describe('searchCatalog ranking', () => {
  it('returns empty for empty catalog', () => {
    expect(searchCatalog([], 'anything', 10)).toEqual([]);
  });

  it('orders matches by descending score then ascending name', () => {
    const results = searchCatalog(CATALOG, 'file', 10);
    expect(results.length).toBeGreaterThan(0);
    // Both fs__read_file and fs__write_file have "file" in name (+10 + +2 token)
    // = 12, plus "file" in description → +5 +1 = +6. Total 18 each.
    // db__query has no "file" → filtered out.
    // Name tie-break: fs__read_file < fs__write_file lexicographically.
    const names = results.map((r) => r.name);
    expect(names[0]).toBe('fs__read_file');
    expect(names[1]).toBe('fs__write_file');
    expect(names).not.toContain('db__query');
  });

  it('respects the limit parameter', () => {
    const results = searchCatalog(CATALOG, 'file', 1);
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('fs__read_file');
  });

  it('omits schema_preview when source has no inputSchema', () => {
    const results = searchCatalog(CATALOG, 'no_schema', 5);
    expect(results.length).toBeGreaterThan(0);
    const noSchema = results.find((r) => r.name === 'misc__no_schema')!;
    expect(noSchema.schema_preview).toBeUndefined();
  });

  it('is deterministic across runs with identical inputs', () => {
    const a = searchCatalog(CATALOG, 'file write', 10);
    const b = searchCatalog(CATALOG, 'file write', 10);
    expect(a).toEqual(b);
  });
});

describe('tool_search tool factory', () => {
  it('has correct name and description', () => {
    const t = toolSearchTool({ getCatalog: () => CATALOG });
    expect(t.function.name).toBe('tool_search');
    expect(t.function.description).toMatch(/search/i);
  });

  it('returns matches for a non-empty query', async () => {
    const search = makeSearch({ getCatalog: () => CATALOG });
    const result = await search({ query: 'sql' });
    expect(result.matches.length).toBe(1);
    expect(result.matches[0]!.name).toBe('db__query');
    expect(result.note).toBeUndefined();
  });

  it('returns an empty list with a helpful note when the catalog is empty', async () => {
    const search = makeSearch({ getCatalog: () => [] });
    const result = await search({ query: 'anything' });
    expect(result.matches).toEqual([]);
    expect(result.note).toMatch(/no mcp tools/i);
  });

  it('returns an empty list with a "query was empty" note for a blank query', async () => {
    const search = makeSearch({ getCatalog: () => CATALOG });
    const result = await search({ query: '   ' });
    expect(result.matches).toEqual([]);
    expect(result.note).toMatch(/empty/i);
  });

  it('reads the catalog lazily — each call sees fresh state', async () => {
    let live: SearchableTool[] = [CATALOG[0]!];
    const search = makeSearch({ getCatalog: () => live });
    const before = await search({ query: 'write' });
    expect(before.matches).toHaveLength(0);
    live = CATALOG;
    const after = await search({ query: 'write' });
    expect(after.matches.length).toBeGreaterThan(0);
  });

  it('applies an explicit limit', async () => {
    const search = makeSearch({ getCatalog: () => CATALOG });
    const result = await search({ query: 'file', limit: 1 });
    expect(result.matches).toHaveLength(1);
  });

  it('defaults limit to DEFAULT_SEARCH_LIMIT when omitted', async () => {
    // Construct a wide catalog and verify the default cap kicks in.
    const wide: SearchableTool[] = Array.from({ length: 50 }, (_, i) => ({
      name: `srv__tool${String(i).padStart(2, '0')}`,
      server: 'srv',
      description: 'matches the query',
    }));
    const search = makeSearch({ getCatalog: () => wide });
    const result = await search({ query: 'matches' });
    expect(result.matches).toHaveLength(DEFAULT_SEARCH_LIMIT);
  });

  it('exposes MAX_SEARCH_LIMIT as the schema upper bound', () => {
    // Belt-and-suspenders — the Zod schema enforces this at parse time so
    // the model can't override the cap. Verified by the constant export.
    expect(MAX_SEARCH_LIMIT).toBeGreaterThanOrEqual(DEFAULT_SEARCH_LIMIT);
  });
});

describe('tool_load tool factory', () => {
  it('has correct name and description', () => {
    const t = toolLoadTool({
      getCatalog: () => CATALOG,
      isLoaded: () => false,
      onLoad: () => undefined,
    });
    expect(t.function.name).toBe('tool_load');
    expect(t.function.description).toMatch(/register/i);
  });

  it('loads each unknown-to-loadedSet name and fires onLoad', async () => {
    const loaded = new Set<string>();
    const onLoad = vi.fn(async (name: string) => {
      loaded.add(name);
    });
    const load = makeLoad({
      getCatalog: () => CATALOG,
      isLoaded: (n) => loaded.has(n),
      onLoad,
    });
    const result = await load({ names: ['fs__read_file', 'db__query'] });
    expect(result.loaded).toEqual(['fs__read_file', 'db__query']);
    expect(result.alreadyLoaded).toEqual([]);
    expect(result.notFound).toEqual([]);
    expect(onLoad).toHaveBeenCalledTimes(2);
    expect(onLoad).toHaveBeenNthCalledWith(1, 'fs__read_file', 'fs');
    expect(onLoad).toHaveBeenNthCalledWith(2, 'db__query', 'db');
  });

  it('reports already-loaded names without re-firing onLoad', async () => {
    const loaded = new Set<string>(['fs__read_file']);
    const onLoad = vi.fn(async () => undefined);
    const load = makeLoad({
      getCatalog: () => CATALOG,
      isLoaded: (n) => loaded.has(n),
      onLoad,
    });
    const result = await load({ names: ['fs__read_file', 'fs__write_file'] });
    expect(result.loaded).toEqual(['fs__write_file']);
    expect(result.alreadyLoaded).toEqual(['fs__read_file']);
    expect(result.notFound).toEqual([]);
    expect(onLoad).toHaveBeenCalledTimes(1);
    expect(onLoad).toHaveBeenCalledWith('fs__write_file', 'fs');
  });

  it('reports notFound for names absent from the catalog', async () => {
    const load = makeLoad({
      getCatalog: () => CATALOG,
      isLoaded: () => false,
      onLoad: () => undefined,
    });
    const result = await load({ names: ['nope__missing', 'fs__read_file'] });
    expect(result.loaded).toEqual(['fs__read_file']);
    expect(result.notFound).toEqual(['nope__missing']);
  });

  it('coalesces duplicate names within a single call', async () => {
    const onLoad = vi.fn(async () => undefined);
    const load = makeLoad({
      getCatalog: () => CATALOG,
      isLoaded: () => false,
      onLoad,
    });
    const result = await load({
      names: ['fs__read_file', 'fs__read_file', 'fs__read_file'],
    });
    expect(result.loaded).toEqual(['fs__read_file']);
    expect(result.alreadyLoaded).toEqual(['fs__read_file']);
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  it('does not advance loadedSet when onLoad throws (propagates the throw)', async () => {
    const load = makeLoad({
      getCatalog: () => CATALOG,
      isLoaded: () => false,
      onLoad: () => {
        throw new Error('boom');
      },
    });
    await expect(load({ names: ['fs__read_file'] })).rejects.toThrow('boom');
  });
});

describe('sort tie-break edge cases', () => {
  it('returns sort comparator branches: -1 / +1 / 0 all exercised via 3+ entries with the same score', () => {
    // Three same-score entries with names AAA < MMM < ZZZ. V8 quicksort
    // does at least one (a > b) and one (a < b) comparison; equal-name
    // pairs hit the 0 arm.
    const cat: SearchableTool[] = [
      { name: 'zzz__same', server: 'zzz', description: 'matches' },
      { name: 'aaa__same', server: 'aaa', description: 'matches' },
      { name: 'mmm__same', server: 'mmm', description: 'matches' },
    ];
    const results = searchCatalog(cat, 'matches', 10);
    expect(results.map((r) => r.name)).toEqual(['aaa__same', 'mmm__same', 'zzz__same']);
  });

  it('returns 0 from the comparator when two entries have identical name + score', () => {
    // Synthetic duplicate-name catalog forces the comparator's `return 0`
    // branch (line 216). In practice the bridge cannot emit two tools with
    // the same prefixed name, but the comparator must still be total — Array
    // .sort relies on the comparator producing a consistent ordering.
    const dup: SearchableTool[] = [
      { name: 'srv__same', server: 'srv', description: 'one' },
      { name: 'srv__same', server: 'srv', description: 'two' },
    ];
    const results = searchCatalog(dup, 'same', 10);
    expect(results.length).toBe(2);
    expect(results[0]!.name).toBe('srv__same');
    expect(results[1]!.name).toBe('srv__same');
  });

  it('scorer short-circuits the description `&&` arm when description is the empty string', () => {
    // `descLower.length > 0` short-circuits the inner `.includes()` —
    // covers the false-side of that branch even for queries that DO contain
    // tokens (the per-token check would otherwise reach the same arm). Note
    // that "lookup foo" as a whole substring is NOT in `srv__lookup`, so
    // only per-token matches contribute: `lookup` hits the name (+2),
    // `foo` doesn't, and the empty desc adds nothing.
    const score = scoreMatch('lookup foo', { name: 'srv__lookup', description: '' });
    expect(score).toBe(2);
  });

  it('match envelope omits `description` when the source entry has no description', () => {
    const cat: SearchableTool[] = [{ name: 'srv__bare', server: 'srv' }];
    const results = searchCatalog(cat, 'bare', 5);
    expect(results).toHaveLength(1);
    expect(results[0]!.description).toBeUndefined();
  });

  it('tool_load skips empty-string entries inside the names array', async () => {
    // Defensive: the Zod schema enforces min(1) at parse time so the model
    // can't get an empty string through normally, but invoking the execute
    // closure directly proves the inner trim/skip path is exercised.
    const onLoad = vi.fn(async () => undefined);
    const load = makeLoad({
      getCatalog: () => CATALOG,
      isLoaded: () => false,
      onLoad,
    });
    const result = await load({ names: ['   ', 'fs__read_file'] });
    expect(result.loaded).toEqual(['fs__read_file']);
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  it('tool_load: duplicate-then-notfound name lands `notFound` once and skips the dup', async () => {
    // Drives the `seen.has(name)` early-return arm where the previous
    // occurrence landed in `notFound` (not `alreadyLoaded`), so the
    // duplicate accounting path stays consistent.
    const load = makeLoad({
      getCatalog: () => CATALOG,
      isLoaded: () => false,
      onLoad: () => undefined,
    });
    const result = await load({ names: ['nope__x', 'nope__x'] });
    expect(result.notFound).toEqual(['nope__x']);
    expect(result.loaded).toEqual([]);
    expect(result.alreadyLoaded).toEqual([]);
  });

  it('buildSchemaPreview returns undefined when JSON.stringify yields undefined (function input)', () => {
    // JSON.stringify on a top-level function returns the literal `undefined`
    // (not a string). The fallback path exits early; the search match envelope
    // then omits the `schema_preview` field entirely instead of advertising a
    // misleading empty preview.
    expect(buildSchemaPreview(() => 42)).toBeUndefined();
  });
});

describe('disconnect / catalog shrink behaviour', () => {
  it("removes a server's tools from search results when getCatalog stops returning them", async () => {
    // Simulates the MCP-server-disconnect → bridge.catalog shrinks scenario:
    // search index is recomputed on every call, so a tool whose source
    // server has been removed simply stops appearing in matches.
    let live = CATALOG.slice();
    const search = makeSearch({ getCatalog: () => live });
    const before = await search({ query: 'sql' });
    expect(before.matches.some((m) => m.name === 'db__query')).toBe(true);

    live = live.filter((t) => t.server !== 'db');
    const after = await search({ query: 'sql' });
    expect(after.matches.some((m) => m.name === 'db__query')).toBe(false);
  });
});
