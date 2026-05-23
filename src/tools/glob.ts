import { tool } from '@openrouter/agent';
import { z } from 'zod/v4';
import { readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { DEFAULT_TOOL_CONTEXT, type ToolContext } from './context.js';
import { compileGlobToRegex } from '../utils/glob.js';

const MAX_MATCHES = 1000;

const SKIP_NAMES = new Set(['node_modules', 'dist', 'coverage']);

export interface GlobResult {
  pattern: string;
  path: string;
  matches: string[];
  matchCount: number;
  truncated: boolean;
}

export function globTool(ctx: ToolContext = DEFAULT_TOOL_CONTEXT) {
  return tool({
    name: 'glob',
    description:
      'Find files by glob pattern across a directory tree. Patterns: `**/*.ts` (recursive), `src/**/*.test.ts` (scoped), `*.md` (flat). `*` matches anything except `/`; `?` matches a single non-`/` character; `[a-z]` character classes are supported. Returns relative paths sorted lexicographically, capped at 1000 matches. Skips node_modules, dist, coverage, and hidden files/dirs.',
    inputSchema: z.object({
      pattern: z
        .string()
        .describe(
          'Glob pattern to match against relative paths from `path` (e.g. "**/*.ts", "src/**/*.test.ts", "*.md").',
        ),
      path: z
        .string()
        .describe('Directory to search in. Relative paths resolve against the agent cwd.')
        .default('.'),
      case_sensitive: z
        .boolean()
        .describe('Whether pattern matching is case-sensitive. Defaults to true.')
        .default(true),
    }),
    execute: async ({ pattern, path, case_sensitive }): Promise<GlobResult> => {
      if (ctx.signal?.aborted) throw new Error('glob cancelled');

      const baseRegex = compileGlobToRegex(pattern);
      const regex = case_sensitive ? baseRegex : new RegExp(baseRegex.source, 'i');

      const root = resolve(ctx.cwd, path);
      const matches: string[] = [];
      let truncated = false;

      // BFS: queue of absolute directory paths to drain one level at a time.
      let frontier: string[] = [root];
      while (frontier.length > 0 && !truncated) {
        if (ctx.signal?.aborted) throw new Error('glob cancelled');

        const nextFrontier: string[] = [];
        for (const dir of frontier) {
          let entries: import('node:fs').Dirent[];
          try {
            entries = await readdir(dir, { withFileTypes: true });
          } catch {
            continue;
          }

          for (const entry of entries) {
            const name = entry.name;
            if (name.startsWith('.') || SKIP_NAMES.has(name)) continue;
            const fullPath = resolve(dir, name);

            if (entry.isDirectory()) {
              nextFrontier.push(fullPath);
            } else if (entry.isFile()) {
              const rel = relative(root, fullPath);
              if (regex.test(rel)) {
                if (matches.length >= MAX_MATCHES) {
                  truncated = true;
                  break;
                }
                matches.push(rel);
              }
            }
          }
          if (truncated) break;
        }
        frontier = nextFrontier;
      }

      matches.sort();

      return {
        pattern,
        path,
        matches,
        matchCount: matches.length,
        truncated,
      };
    },
  });
}
