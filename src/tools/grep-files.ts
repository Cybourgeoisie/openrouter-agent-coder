import { tool } from '@openrouter/agent';
import { z } from 'zod/v4';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

export interface GrepMatch {
  file: string;
  line: number;
  text: string;
}

const MAX_FILE_SIZE = 1024 * 1024; // 1 MiB — skip binary / huge files
const MAX_MATCHES = 200;

/**
 * Recursively collect all files under `dir` whose names match `fileGlob`
 * (a simple glob: `*` matches any sequence of non-separator chars, `**`
 * matches any path segment including separators).  We implement matching
 * ourselves to avoid a runtime dependency.
 */
async function collectFiles(dir: string, globPattern: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(current: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(current);
    } catch {
      return;
    }

    await Promise.all(
      entries.map(async (name) => {
        // Skip hidden files/directories (dot-prefixed) and common noise dirs.
        if (
          name.startsWith('.') ||
          name === 'node_modules' ||
          name === 'dist' ||
          name === 'coverage'
        ) {
          return;
        }
        const fullPath = join(current, name);
        let s;
        try {
          s = await stat(fullPath);
        } catch {
          return;
        }
        if (s.isDirectory()) {
          await walk(fullPath);
        } else if (s.isFile() && s.size <= MAX_FILE_SIZE && matchesGlob(name, globPattern)) {
          results.push(fullPath);
        }
      }),
    );
  }

  await walk(dir);
  return results;
}

/**
 * Minimal glob matching for a single filename (not a path).
 * Supports `*` (any chars except `/`) and `**` (any chars including `/`).
 * The pattern is anchored to the full filename.
 */
function matchesGlob(filename: string, pattern: string): boolean {
  // Convert glob to a regex.
  const re = new RegExp(
    '^' +
      pattern
        .split('**')
        .map((part) =>
          part
            .split('*')
            .map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
            .join('[^/]*'),
        )
        .join('.*') +
      '$',
  );
  return re.test(filename);
}

export const grepFilesTool = tool({
  name: 'grep_files',
  description:
    'Search for a regex pattern across files in a directory tree. Returns structured matches with file path, line number, and matched line text. Skips node_modules, dist, coverage, hidden files, and files larger than 1 MiB.',
  inputSchema: z.object({
    pattern: z.string().describe('Regular expression to search for'),
    path: z.string().describe('Directory to search in').default('.'),
    file_glob: z
      .string()
      .describe('Glob pattern to filter filenames (e.g. "*.ts", "*.md"). Defaults to all files.')
      .default('*'),
    case_sensitive: z
      .boolean()
      .describe('Whether the pattern match is case-sensitive. Defaults to true.')
      .default(true),
  }),
  execute: async ({ pattern, path, file_glob, case_sensitive }) => {
    const flags = case_sensitive ? '' : 'i';
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, flags);
    } catch (err) {
      throw new Error(`Invalid regex pattern: ${(err as Error).message}`, { cause: err });
    }

    const files = await collectFiles(path, file_glob);
    const matches: GrepMatch[] = [];

    for (const file of files) {
      if (matches.length >= MAX_MATCHES) break;

      let text: string;
      try {
        text = await readFile(file, 'utf-8');
      } catch {
        continue; // skip unreadable files (binary, permission errors, etc.)
      }

      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (matches.length >= MAX_MATCHES) break;
        if (regex.test(lines[i])) {
          matches.push({
            file: relative(path, file),
            line: i + 1,
            text: lines[i],
          });
        }
      }
    }

    return {
      pattern,
      path,
      matchCount: matches.length,
      truncated: matches.length >= MAX_MATCHES,
      matches,
    };
  },
});
