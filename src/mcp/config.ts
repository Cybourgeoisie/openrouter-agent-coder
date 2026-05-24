/**
 * Phase 5.2.3 — MCP `.mcp.json` discovery.
 *
 * Pure async loader that finds, parses, and validates `.mcp.json` config
 * files in two scopes — `'user'` (`os.homedir()/.mcp.json`) and `'project'`
 * (walk up from `cwd` to the first `.git` ancestor, depth-capped). Returns a
 * deterministically-sorted flat list of validated server entries with the
 * originating file path stamped on each for debuggability.
 *
 * No side effects beyond `readFile` — does NOT spawn servers, mutate
 * `process.env`, or call `process.cwd()`. The 5.2.4 tool-bridge owns spawn
 * and lifecycle; this module is the read-only config layer.
 *
 * Walker mirrors `src/context-discovery.ts` (Phase 3.4): same depth cap,
 * same `.git` boundary semantics, same silent treatment of missing files.
 * Composition order (`user → project`) and override-by-name semantics mirror
 * Phase 3.4's specific-wins layering.
 */

import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import * as os from 'node:os';
import { z } from 'zod/v4';

/** Cap on the number of directories walked when resolving the project scope. */
export const MAX_PROJECT_WALK_DEPTH = 10;

/** Recognized scopes. Default order applied by {@link loadMcpConfig}. */
export type McpConfigScope = 'user' | 'project';

/**
 * stdio MCP server entry. Validated and normalized — `transport: 'stdio'` is
 * always set on the output, even when the input file omitted the field (the
 * loader infers from `command` presence).
 */
export interface McpStdioServerConfig {
  /** Discriminator. Always `'stdio'` on the output. */
  transport: 'stdio';
  /** Server name (object key under `mcpServers`). */
  name: string;
  /** Executable to spawn. */
  command: string;
  /** Argv passed to the executable. Omitted when absent in the source file. */
  args?: string[];
  /** Environment forwarded to the child. Omitted when absent in the source file. */
  env?: Record<string, string>;
  /** Absolute path to the `.mcp.json` this entry was loaded from. */
  source: string;
}

/**
 * HTTP MCP server entry. The 5.2.4 tool-bridge maps this to one of the SDK
 * transports in `src/mcp/spec.ts` (defaults to `'streamableHttp'`; SSE
 * fallback is a bridge-layer concern, not a config-layer one).
 */
export interface McpHttpServerConfig {
  /** Discriminator. Always `'http'` on the output. */
  transport: 'http';
  /** Server name (object key under `mcpServers`). */
  name: string;
  /** Endpoint URL (URL-validated at parse time). */
  url: string;
  /** Extra headers sent on every request. Omitted when absent in the source file. */
  headers?: Record<string, string>;
  /** Absolute path to the `.mcp.json` this entry was loaded from. */
  source: string;
}

/** Discriminated union of validated server entries. */
export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export interface LoadMcpConfigOptions {
  /**
   * Working directory the project walker starts from. When omitted the
   * project scope is silently skipped — the user scope (if requested) still
   * loads. This preserves the single-`process.cwd()`-call invariant: the
   * caller decides what `cwd` means.
   */
  cwd?: string;
  /**
   * Scopes to load and the order they apply in. Later entries override
   * earlier entries by SERVER NAME (full replacement, not deep merge).
   * Defaults to `['user', 'project']` so project entries win over user
   * entries.
   */
  scopes?: readonly McpConfigScope[];
}

const DEFAULT_SCOPES: readonly McpConfigScope[] = ['user', 'project'];

/**
 * Permissive Zod schema for a single server entry. We accept any combination
 * of fields here and then run a `superRefine` pass to enforce the XOR shape
 * — this produces clearer error messages than `z.union` (which reports both
 * union arms' errors when neither matches).
 */
const serverEntrySchema = z
  .object({
    transport: z.enum(['stdio', 'http']).optional(),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    url: z.url().optional(),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .superRefine((data, ctx) => {
    const hasCommand = data.command !== undefined;
    const hasUrl = data.url !== undefined;
    if (hasCommand && hasUrl) {
      ctx.addIssue({
        code: 'custom',
        message: 'server entry cannot have both `command` and `url`',
      });
      return;
    }
    if (!hasCommand && !hasUrl) {
      ctx.addIssue({
        code: 'custom',
        message: 'server entry must have either `command` (stdio) or `url` (http)',
      });
      return;
    }
    if (data.transport === 'stdio' && !hasCommand) {
      ctx.addIssue({
        code: 'custom',
        message: 'transport "stdio" requires `command`',
      });
    }
    if (data.transport === 'http' && !hasUrl) {
      ctx.addIssue({
        code: 'custom',
        message: 'transport "http" requires `url`',
      });
    }
  });

const fileSchema = z.object({
  mcpServers: z.record(z.string().min(1), serverEntrySchema).optional(),
});

/**
 * Load and merge `.mcp.json` config from the requested scopes. Pure async —
 * the only side effects are filesystem reads.
 *
 * Behavior:
 *
 * - **Missing files** are silent (return empty for that scope).
 * - **Malformed JSON** throws with the offending file path in the message.
 * - **Schema violations** throw a `ZodError` whose path includes the
 *   offending server name (caller-facing surface — the 5.2.4 bridge will
 *   wrap this in a user-friendly notification).
 * - **Override-by-name** is full replacement, not deep merge. A `'project'`
 *   entry named `foo` completely supplants a `'user'` entry named `foo`.
 * - **Walker order**: walk from `cwd` upward, reading `.mcp.json` at each
 *   level, stopping at the first `.git` ancestor (read the boundary dir
 *   then stop) or at depth {@link MAX_PROJECT_WALK_DEPTH}. Deeper-dir
 *   entries override shallower-dir entries by name (specific wins, matches
 *   Phase 3.4 `composeInstructions`).
 *
 * Output is sorted by `name` for deterministic ordering, so callers can
 * snapshot-test or hash the result without sort instability.
 */
export async function loadMcpConfig(opts: LoadMcpConfigOptions = {}): Promise<McpServerConfig[]> {
  const scopes = opts.scopes ?? DEFAULT_SCOPES;
  if (scopes.length === 0) return [];

  // Deduplicate while preserving caller order. Later scope in the list wins
  // by-name over earlier ones.
  const seen = new Set<McpConfigScope>();
  const ordered: McpConfigScope[] = [];
  for (const s of scopes) {
    if (seen.has(s)) continue;
    seen.add(s);
    ordered.push(s);
  }

  const merged = new Map<string, McpServerConfig>();
  for (const scope of ordered) {
    const entries = scope === 'user' ? await loadUserScope() : await loadProjectScope(opts.cwd);
    for (const entry of entries) {
      // Later wins. Map.set overwrites by key (server name).
      merged.set(entry.name, entry);
    }
  }

  // Server names are unique within `merged` (Map keyed by name), so the
  // comparator never hits the equal branch — direct `<` ordering is enough.
  return [...merged.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
}

async function loadUserScope(): Promise<McpServerConfig[]> {
  const path = join(os.homedir(), '.mcp.json');
  const raw = await readFileSafe(path);
  if (raw === null) return [];
  return parseFile(path, raw);
}

async function loadProjectScope(cwd: string | undefined): Promise<McpServerConfig[]> {
  if (cwd === undefined) return [];
  const startDir = resolve(cwd);

  // Walk up collecting files, then apply outermost-first so deeper-dir
  // entries override shallower-dir entries by name (specific wins). Matches
  // `composeInstructions`' layering convention.
  const found: Array<{ path: string; raw: string }> = [];
  let current = startDir;
  for (let depth = 0; depth < MAX_PROJECT_WALK_DEPTH; depth++) {
    const filePath = join(current, '.mcp.json');
    const raw = await readFileSafe(filePath);
    if (raw !== null) found.push({ path: filePath, raw });

    if (await pathExists(join(current, '.git'))) break;

    const parent = dirname(current);
    if (parent === current) break; // filesystem root
    current = parent;
  }

  const merged = new Map<string, McpServerConfig>();
  // Reverse so the outermost directory (repo root / walk terminus) applies
  // first and the deepest dir applies last — last-write-wins on the Map.
  for (const { path, raw } of [...found].reverse()) {
    for (const entry of parseFile(path, raw)) {
      merged.set(entry.name, entry);
    }
  }
  return [...merged.values()];
}

function parseFile(path: string, raw: string): McpServerConfig[] {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    // JSON.parse only ever throws SyntaxError (an Error subclass).
    throw new Error(`Failed to parse MCP config at ${path}: ${(err as Error).message}`, {
      cause: err,
    });
  }
  const result = fileSchema.safeParse(json);
  if (!result.success) {
    throw new Error(`Invalid MCP config at ${path}: ${result.error.message}`);
  }
  const parsed = result.data;
  if (parsed.mcpServers === undefined) return [];
  return Object.entries(parsed.mcpServers).map(([name, entry]) =>
    normalizeEntry(name, entry, path),
  );
}

function normalizeEntry(
  name: string,
  entry: z.infer<typeof serverEntrySchema>,
  source: string,
): McpServerConfig {
  // `superRefine` guarantees exactly one of command/url is present. Branch on
  // command first (transport: 'stdio') then fall through to url.
  if (entry.command !== undefined) {
    const out: McpStdioServerConfig = {
      transport: 'stdio',
      name,
      command: entry.command,
      source,
    };
    if (entry.args !== undefined) out.args = entry.args;
    if (entry.env !== undefined) out.env = entry.env;
    return out;
  }
  // entry.url is guaranteed non-undefined here by the schema.
  const out: McpHttpServerConfig = {
    transport: 'http',
    name,
    url: entry.url!,
    source,
  };
  if (entry.headers !== undefined) out.headers = entry.headers;
  return out;
}

async function readFileSafe(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
