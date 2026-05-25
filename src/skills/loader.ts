/**
 * Phase 5.7 — skill discovery walker and {@link SkillLoader} factory.
 *
 * Walks four roots in precedence order (highest first):
 *
 * 1. **Plugin roots** — caller-supplied `{ name, root }` entries. Skill names
 *    are namespaced as `<pluginName>:<skillName>`, so plugin skills never
 *    collide with project/user skills.
 * 2. **User scope** — `<home>/.claude/skills/<name>/SKILL.md`.
 * 3. **Project scope** — walks up from `opts.cwd` until a `.git` directory
 *    is found (or {@link MAX_PROJECT_WALK_DEPTH} levels, whichever is first).
 *    Every level's `.claude/skills/` is scanned; the *deepest* match wins
 *    (closest-to-cwd > closest-to-root) per the spike's monorepo support note.
 *
 * Precedence on name collision (per the spike's "enterprise > personal >
 * project" rule with no enterprise scope in v1): user > project. Plugin
 * skills are namespaced and therefore never collide.
 *
 * Discovery is async and lazy-ish — {@link createSkillLoader} returns an
 * uninstantiated handle; the first call to {@link SkillLoader.list} drives
 * the walk and caches the result.
 *
 * Caller-decides-cwd invariant: `opts.cwd` must be provided by the host.
 * The walker NEVER reads `process.cwd()`. Similarly, the user scope honors
 * `opts.home` (defaults to {@link os.homedir}) — the loader does not read
 * `process.env.HOME`.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve, basename } from 'node:path';
import * as os from 'node:os';
import { renderSkillBody, type SubstitutionContext } from './substitution.js';
import {
  skillFrontmatterSchema,
  type SkillFrontmatter,
  type SkillInfo,
  type SkillSource,
} from './spec.js';

/** Cap on the number of directories walked when resolving the project scope. */
export const MAX_PROJECT_WALK_DEPTH = 10;

/** Options accepted by {@link createSkillLoader}. */
export interface SkillLoaderOptions {
  /** Project working directory — the walker climbs up from here. */
  cwd: string;
  /** Override for the user scope root. Defaults to `os.homedir()`. */
  home?: string;
  /** Optional plugin roots (5.8 will populate; no-op when empty / undefined). */
  pluginRoots?: ReadonlyArray<{ name: string; root: string }>;
  /** When `true`, the user scope is skipped entirely. */
  disableUserSkills?: boolean;
  /** When `true`, the project scope is skipped entirely. */
  disableProjectSkills?: boolean;
  /**
   * Optional diagnostic logger. Malformed frontmatter / IO errors are logged
   * at `'warn'` level; the discovery walk never throws. Shape-compatible
   * with `AgentLogger` from `src/agent.ts`.
   */
  logger?: (
    level: 'debug' | 'info' | 'warn' | 'error',
    msg: string,
    fields?: Record<string, unknown>,
  ) => void;
}

/**
 * Lifecycle interface returned by {@link createSkillLoader}. The agent uses
 * `list()` to build the listing block and `get()` / `render()` when the
 * `Skill` tool fires. `watch()` is a no-op stub in v1 — the live-reload
 * design lands in a follow-up.
 */
export interface SkillLoader {
  /** Return every discovered skill, sorted by qualified name. Cached. */
  list(): Promise<readonly SkillInfo[]>;
  /** Look up a single skill by its qualified name (or `undefined`). */
  get(name: string): Promise<SkillInfo | undefined>;
  /**
   * Render a skill body with the supplied substitution context, returning the
   * already-rendered string ready to feed into the model. Throws when the
   * skill is unknown — callers should call {@link get} first if they want a
   * silent miss.
   */
  render(name: string, ctx: SubstitutionContext): Promise<string>;
  /** v1 stub. Returns a no-op disposer. */
  watch(onChange: (event: { name: string; type: 'add' | 'remove' | 'update' }) => void): () => void;
}

/**
 * Build a {@link SkillLoader} bound to the supplied discovery roots. The
 * loader is created synchronously; FS reads happen on the first call to
 * {@link SkillLoader.list}.
 */
export function createSkillLoader(opts: SkillLoaderOptions): SkillLoader {
  let cache: Map<string, SkillInfo> | null = null;

  const ensureLoaded = async (): Promise<Map<string, SkillInfo>> => {
    if (cache) return cache;
    cache = await discoverSkills(opts);
    return cache;
  };

  return {
    async list(): Promise<readonly SkillInfo[]> {
      const map = await ensureLoaded();
      return [...map.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },
    async get(name: string): Promise<SkillInfo | undefined> {
      const map = await ensureLoaded();
      return map.get(name);
    },
    async render(name: string, ctx: SubstitutionContext): Promise<string> {
      const map = await ensureLoaded();
      const skill = map.get(name);
      if (!skill) throw new Error(`skill not found: ${name}`);
      // Default skillDir to the discovered SKILL.md's containing dir when the
      // caller hasn't already pinned one. Lets the body reference assets via
      // `${CLAUDE_SKILL_DIR}/foo.txt` without the host wiring up the path.
      const effectiveCtx: SubstitutionContext =
        ctx.skillDir !== undefined ? ctx : { ...ctx, skillDir: dirname(skill.location) };
      return renderSkillBody(skill.body, effectiveCtx);
    },
    watch(_onChange): () => void {
      // v1 stub. Hosts that need hot-reload can rebuild the loader between
      // runs; the design for filesystem watching lands in a follow-on card.
      void _onChange;
      return () => undefined;
    },
  };
}

async function discoverSkills(opts: SkillLoaderOptions): Promise<Map<string, SkillInfo>> {
  const out = new Map<string, SkillInfo>();

  // Lowest precedence first (project), then user (which overrides on
  // collision), then plugins (which are namespaced so they never collide).
  if (opts.disableProjectSkills !== true) {
    for (const skill of await discoverProjectSkills(opts.cwd, opts.logger)) {
      out.set(skill.name, skill); // last-seen wins; project order is root → cwd (deepest last → overrides shallower)
    }
  }
  if (opts.disableUserSkills !== true) {
    const homeDir = opts.home ?? os.homedir();
    for (const skill of await discoverScopedSkills(
      join(homeDir, '.claude', 'skills'),
      'user',
      opts.logger,
    )) {
      out.set(skill.name, skill);
    }
  }
  if (opts.pluginRoots && opts.pluginRoots.length > 0) {
    for (const { name: pluginName, root } of opts.pluginRoots) {
      for (const skill of await discoverScopedSkills(
        join(root, 'skills'),
        'plugin',
        opts.logger,
        pluginName,
      )) {
        out.set(skill.name, skill);
      }
    }
  }
  return out;
}

/**
 * Walk up from `cwd` collecting `.claude/skills/` discoveries at each level.
 * Stops at the first `.git` or filesystem root, capped at
 * {@link MAX_PROJECT_WALK_DEPTH} levels.
 *
 * Returned in shallowest-first order so the caller's `Map.set` loop ends with
 * the deepest (closest-to-cwd) entry winning — matches the documented
 * "monorepo deepest-wins" rule from the spike.
 */
async function discoverProjectSkills(
  cwd: string,
  logger: SkillLoaderOptions['logger'],
): Promise<readonly SkillInfo[]> {
  const out: SkillInfo[] = [];
  const startDir = resolve(cwd);
  const visited: string[] = [];
  let current = startDir;
  for (let depth = 0; depth < MAX_PROJECT_WALK_DEPTH; depth++) {
    visited.push(current);
    if (await pathExists(join(current, '.git'))) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  // Walk in REVERSE — outer dirs first, cwd last — so the deepest match
  // overrides shallower ones via the caller's Map.set loop.
  for (const dir of visited.reverse()) {
    const scoped = await discoverScopedSkills(join(dir, '.claude', 'skills'), 'project', logger);
    for (const s of scoped) out.push(s);
  }
  return out;
}

/**
 * Read every direct subdirectory of `root` that contains a `SKILL.md` and
 * parse it. Missing root → empty result. Malformed frontmatter → warn log +
 * skipped. The walk is shallow by design — nested skill dirs are NOT
 * supported (the spike documents `<root>/<skill-name>/SKILL.md` as the
 * canonical shape).
 */
async function discoverScopedSkills(
  root: string,
  source: SkillSource,
  logger: SkillLoaderOptions['logger'],
  pluginName?: string,
): Promise<readonly SkillInfo[]> {
  if (!(await pathExists(root))) return [];
  let entries: string[];
  try {
    const dirents = await readdir(root, { withFileTypes: true });
    entries = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (err) {
    logger?.('warn', `skill discovery: failed to read ${root}`, { err: String(err) });
    return [];
  }
  const out: SkillInfo[] = [];
  for (const dir of entries) {
    const skillDir = join(root, dir);
    const location = join(skillDir, 'SKILL.md');
    if (!(await pathExists(location))) continue;
    let raw: string;
    try {
      raw = await readFile(location, 'utf8');
    } catch (err) {
      logger?.('warn', `skill discovery: failed to read ${location}`, { err: String(err) });
      continue;
    }
    let parsed: { frontmatter: SkillFrontmatter; body: string };
    try {
      parsed = parseSkillFile(raw, dir);
    } catch (err) {
      logger?.('warn', `skill discovery: invalid frontmatter at ${location}`, {
        err: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    const qualifiedName = pluginName
      ? `${pluginName}:${parsed.frontmatter.name}`
      : parsed.frontmatter.name;
    out.push({
      name: qualifiedName,
      source,
      ...(pluginName !== undefined && { pluginName }),
      location,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
    });
  }
  return out;
}

/**
 * Split a SKILL.md into its frontmatter object + body string, validating the
 * frontmatter against {@link skillFrontmatterSchema} and enforcing the
 * directory-name match invariant.
 *
 * Throws on:
 *
 * - Missing or malformed frontmatter block (no opening `---`, no closing
 *   `---`, malformed YAML).
 * - `name` missing / failing regex.
 * - `name` mismatching the parent dir.
 */
export function parseSkillFile(
  raw: string,
  expectedDirName: string,
): { frontmatter: SkillFrontmatter; body: string } {
  const { yaml, body } = splitFrontmatter(raw);
  if (yaml === null) {
    throw new Error('SKILL.md missing YAML frontmatter block');
  }
  const rawFm = parseYamlFrontmatter(yaml);
  const camel = normalizeFrontmatterKeys(rawFm);
  const parsed = skillFrontmatterSchema.safeParse(camel);
  if (!parsed.success) {
    throw new Error(
      `frontmatter validation failed: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
    );
  }
  const fm = parsed.data as SkillFrontmatter;
  if (fm.name !== basename(expectedDirName)) {
    throw new Error(
      `frontmatter \`name\` (${fm.name}) does not match parent directory (${expectedDirName})`,
    );
  }
  return { frontmatter: fm, body };
}

/**
 * Hand-rolled YAML-frontmatter splitter. Accepts the standard `---\n...\n---`
 * convention plus a trailing newline (or its absence). Returns `yaml=null`
 * when the file does not open with `---`.
 *
 * Exported so {@link ../commands/loader.ts} can reuse the same splitter
 * without duplicating the BOM / fence-edge handling.
 */
export function splitFrontmatter(raw: string): { yaml: string | null; body: string } {
  // Accept BOM or leading whitespace before the opening fence — common with
  // editors that auto-prepend a BOM.
  let i = 0;
  if (raw.charCodeAt(0) === 0xfeff) i = 1;
  // Require `---` followed by a newline at position i.
  if (raw.slice(i, i + 3) !== '---') return { yaml: null, body: raw };
  // Find end of the opening line.
  const openEnd = raw.indexOf('\n', i + 3);
  if (openEnd === -1) return { yaml: null, body: raw };
  // Find the closing `---` on its own line.
  const closing = findClosingFence(raw, openEnd + 1);
  if (closing === -1) {
    throw new Error('SKILL.md frontmatter is missing the closing `---` fence');
  }
  const yaml = raw.slice(openEnd + 1, closing.fenceStart);
  const body = raw.slice(closing.bodyStart);
  return { yaml, body };
}

function findClosingFence(
  raw: string,
  searchFrom: number,
): { fenceStart: number; bodyStart: number } | -1 {
  let pos = searchFrom;
  while (pos < raw.length) {
    // Find next newline; the line we want is the one whose body is exactly `---`.
    const lineEnd = raw.indexOf('\n', pos);
    const line = lineEnd === -1 ? raw.slice(pos) : raw.slice(pos, lineEnd);
    if (line.trim() === '---') {
      const bodyStart = lineEnd === -1 ? raw.length : lineEnd + 1;
      return { fenceStart: pos, bodyStart };
    }
    if (lineEnd === -1) break;
    pos = lineEnd + 1;
  }
  return -1;
}

/**
 * Tiny YAML subset parser. Supports:
 *
 * - `key: value` scalar pairs (single-line).
 * - `key: [a, b, c]` inline arrays.
 * - Multi-line block lists (`key:\n  - a\n  - b`).
 * - `key: |` and `key: >` multi-line block scalars (literal preserved as-is).
 * - Booleans (`true`/`false`/`yes`/`no`) and integer literals.
 * - `key:\n  nested: value` one-level-nested maps (used by `metadata`).
 *
 * This is intentionally minimal — SKILL.md frontmatter is a flat key/value
 * surface in practice. For richer YAML we'd bring in `yaml` (~150KB), which
 * the spike flags as acceptable but not required. Quoting is honored for both
 * single- and double-quoted scalars; backslash escapes are NOT expanded
 * (frontmatter values are file paths and short strings, not encoded blobs).
 *
 * Exported for unit tests.
 */
export function parseYamlFrontmatter(input: string): Record<string, unknown> {
  const lines = input.split('\n');
  const out: Record<string, unknown> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      i++;
      continue;
    }
    const indent = leadingSpaceCount(line);
    if (indent > 0) {
      // Stray indented line at the top level — skip; nested handling lives
      // inside the per-key branches below.
      i++;
      continue;
    }
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) {
      throw new Error(`malformed frontmatter line (no colon): ${line.trim()}`);
    }
    const key = line.slice(0, colonIdx).trim();
    const after = line.slice(colonIdx + 1).trim();
    if (after === '|' || after === '>') {
      // Block scalar — collect indented continuation lines verbatim.
      const collected: string[] = [];
      i++;
      while (i < lines.length) {
        const next = lines[i]!;
        if (next.trim() === '') {
          collected.push('');
          i++;
          continue;
        }
        const ind = leadingSpaceCount(next);
        if (ind === 0) break;
        collected.push(next.slice(ind));
        i++;
      }
      const joiner = after === '|' ? '\n' : ' ';
      out[key] = collected.join(joiner);
      continue;
    }
    if (after === '') {
      // Either a block list or a nested map. Peek the next non-empty line.
      let j = i + 1;
      while (j < lines.length && lines[j]!.trim() === '') j++;
      if (j < lines.length && /^[ \t]+- /.test(lines[j]!)) {
        // Block list.
        const items: unknown[] = [];
        i = j;
        while (i < lines.length) {
          const next = lines[i]!;
          const ind = leadingSpaceCount(next);
          if (ind === 0) break;
          const m = next.trimStart();
          if (!m.startsWith('- ')) break;
          items.push(parseScalar(m.slice(2).trim()));
          i++;
        }
        out[key] = items;
        continue;
      }
      if (j < lines.length && leadingSpaceCount(lines[j]!) > 0) {
        // Nested map (one level).
        const sub: Record<string, unknown> = {};
        i = j;
        while (i < lines.length) {
          const next = lines[i]!;
          if (next.trim() === '') {
            i++;
            continue;
          }
          const ind = leadingSpaceCount(next);
          if (ind === 0) break;
          const c = next.indexOf(':');
          if (c === -1) {
            throw new Error(`malformed nested key: ${next.trim()}`);
          }
          const k2 = next.slice(0, c).trim();
          const v2 = next.slice(c + 1).trim();
          sub[k2] = parseScalar(v2);
          i++;
        }
        out[key] = sub;
        continue;
      }
      // Truly empty value.
      out[key] = '';
      i++;
      continue;
    }
    out[key] = parseScalar(after);
    i++;
  }
  return out;
}

function leadingSpaceCount(s: string): number {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  return i;
}

function parseScalar(raw: string): unknown {
  if (raw.length === 0) return '';
  // Inline array.
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    if (inner.length === 0) return [];
    return splitInlineList(inner).map((s) => parseScalar(s.trim()));
  }
  // Strip surrounding quotes.
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  if (raw === 'true' || raw === 'yes') return true;
  if (raw === 'false' || raw === 'no') return false;
  if (raw === 'null' || raw === '~') return null;
  if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return Number.parseFloat(raw);
  return raw;
}

function splitInlineList(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      out.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  out.push(inner.slice(start));
  return out;
}

/**
 * Normalize raw YAML keys (kebab-case, snake_case) into the camelCase shape
 * {@link skillFrontmatterSchema} validates. Also widens dual-shape fields:
 *
 * - `arguments` accepts both a YAML list (`[a, b]`) and a space-separated
 *   string (`a b`).
 * - `paths` accepts both a YAML list and a comma-separated string.
 * - `allowed-tools` accepts both a YAML list and a space-separated string
 *   (the schema keeps it as a string for downstream rule-compile).
 *
 * Exported for tests.
 */
export function normalizeFrontmatterKeys(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const ckey = kebabToCamel(key);
    if (ckey === 'arguments') {
      if (typeof value === 'string') {
        out.arguments = value.trim().length === 0 ? [] : value.trim().split(/\s+/);
      } else if (Array.isArray(value)) {
        out.arguments = value.map(String);
      }
      continue;
    }
    if (ckey === 'paths') {
      if (typeof value === 'string') {
        out.paths = value
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
      } else if (Array.isArray(value)) {
        out.paths = value.map(String);
      }
      continue;
    }
    if (ckey === 'allowedTools') {
      if (Array.isArray(value)) {
        out.allowedTools = value.map(String).join(' ');
      } else if (typeof value === 'string') {
        out.allowedTools = value;
      }
      continue;
    }
    out[ckey] = value;
  }
  return out;
}

function kebabToCamel(s: string): string {
  return s.replace(/[-_]([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Convenience wrapper around {@link createSkillLoader} that immediately
 * resolves to the discovered skills. Equivalent to `createSkillLoader(opts).list()`.
 * Exported for hosts that just want a one-shot list at startup.
 */
export async function loadSkills(opts: SkillLoaderOptions): Promise<readonly SkillInfo[]> {
  const loader = createSkillLoader(opts);
  return loader.list();
}

/**
 * Quote-aware shell-style splitter used by host code to turn a raw `/skill foo
 * "bar baz"` input line into the positional arguments array the substitution
 * helper expects. Exported here so commands (5.6) can reuse it.
 *
 * Behaviour:
 *
 * - Splits on whitespace OUTSIDE quotes.
 * - Recognises both `'` and `"` quotes; the surrounding quotes are stripped.
 * - Backslash escapes `\\"` and `\\'` inside the matching quote style.
 * - Unterminated quotes are treated as terminating at end-of-input (no throw).
 */
export function splitShellArgs(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let i = 0;
  let hadAny = false;
  while (i < input.length) {
    const c = input[i]!;
    if (quote) {
      if (c === '\\' && input[i + 1] === quote) {
        cur += quote;
        i += 2;
        continue;
      }
      if (c === quote) {
        quote = null;
        i++;
        continue;
      }
      cur += c;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      hadAny = true;
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      if (hadAny) {
        out.push(cur);
        cur = '';
        hadAny = false;
      }
      i++;
      continue;
    }
    cur += c;
    hadAny = true;
    i++;
  }
  if (hadAny) out.push(cur);
  return out;
}
