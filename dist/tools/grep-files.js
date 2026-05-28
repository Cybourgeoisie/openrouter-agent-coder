import { tool } from '@openrouter/agent';
import { z } from 'zod/v4';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { DEFAULT_TOOL_CONTEXT } from './context.js';
import { compileGlobToRegex } from '../utils/glob.js';
const MAX_FILE_SIZE = 1024 * 1024;
const MAX_MATCHES = 200;
const MAX_CONTEXT = 20;
/**
 * Built-in file-type aliases mapping a short token to a list of basename globs.
 *
 * Combines with the user-supplied `file_glob` via UNION (a file matches if
 * either includes it). Unknown types are silently ignored.
 *
 * Obviously growable — add aliases as needed without breaking callers.
 */
const FILETYPE_GLOBS = {
    ts: ['*.ts', '*.tsx'],
    js: ['*.js', '*.jsx', '*.mjs', '*.cjs'],
    py: ['*.py'],
    rust: ['*.rs'],
    go: ['*.go'],
    java: ['*.java'],
    rb: ['*.rb'],
    php: ['*.php'],
    c: ['*.c', '*.h'],
    cpp: ['*.cpp', '*.cc', '*.cxx', '*.hpp', '*.hh', '*.hxx'],
    cs: ['*.cs'],
    sh: ['*.sh', '*.bash', '*.zsh'],
    md: ['*.md', '*.markdown'],
    json: ['*.json'],
    yaml: ['*.yaml', '*.yml'],
};
async function collectFiles(dir, globs) {
    const results = [];
    const regexes = globs.map((g) => compileGlobToRegex(g));
    async function walk(current) {
        let entries;
        try {
            entries = await readdir(current);
        }
        catch {
            return;
        }
        await Promise.all(entries.map(async (name) => {
            if (name.startsWith('.') ||
                name === 'node_modules' ||
                name === 'dist' ||
                name === 'coverage') {
                return;
            }
            const fullPath = join(current, name);
            let s;
            try {
                s = await stat(fullPath);
            }
            catch {
                return;
            }
            if (s.isDirectory()) {
                await walk(fullPath);
            }
            else if (s.isFile() && s.size <= MAX_FILE_SIZE && regexes.some((r) => r.test(name))) {
                results.push(fullPath);
            }
        }));
    }
    await walk(dir);
    return results;
}
function clampContext(value) {
    if (value === undefined)
        return 0;
    if (value < 0)
        return 0;
    if (value > MAX_CONTEXT)
        return MAX_CONTEXT;
    return value;
}
export function grepFilesTool(ctx = DEFAULT_TOOL_CONTEXT) {
    return tool({
        name: 'grep_files',
        description: 'Search for a regex pattern across files in a directory tree. Returns structured matches with file path, line number, and matched line text. Optional context lines (before_context/after_context/context), filetype filter (type), and output mode (content/files_with_matches/count). Skips node_modules, dist, coverage, hidden files, and files larger than 1 MiB.',
        inputSchema: z.object({
            pattern: z.string().describe('Regular expression to search for'),
            path: z.string().describe('Directory to search in').default('.'),
            file_glob: z
                .string()
                .describe('Glob pattern to filter filenames (e.g. "*.ts", "*.md"). Defaults to all files.')
                .default('*'),
            case_sensitive: z
                .boolean()
                .describe('Whether the pattern match is case-sensitive. Defaults to false.')
                .default(false),
            type: z
                .string()
                .describe('Built-in filetype filter (e.g. "ts", "py", "go"). Combines with file_glob via union — a file matches if either includes it. Unknown values are silently ignored.')
                .optional(),
            before_context: z
                .number()
                .int()
                .describe('Number of preceding lines to include with each match (like grep -B). Capped at 20.')
                .optional(),
            after_context: z
                .number()
                .int()
                .describe('Number of following lines to include with each match (like grep -A). Capped at 20.')
                .optional(),
            context: z
                .number()
                .int()
                .describe('Shorthand for setting both before_context and after_context (like grep -C). Explicit before/after_context take precedence per side.')
                .optional(),
            output_mode: z
                .enum(['content', 'files_with_matches', 'count'])
                .describe('How to project results: "content" (default) returns per-line matches; "files_with_matches" returns just file paths; "count" returns per-file match counts.')
                .default('content'),
        }),
        execute: async ({ pattern, path, file_glob, case_sensitive, type, before_context, after_context, context, output_mode, }) => {
            if (ctx.signal?.aborted)
                throw new Error('grep_files cancelled');
            const flags = case_sensitive ? '' : 'i';
            let regex;
            try {
                regex = new RegExp(pattern, flags);
            }
            catch (err) {
                throw new Error(`Invalid regex pattern: ${err.message}`, { cause: err });
            }
            const beforeN = clampContext(before_context ?? context);
            const afterN = clampContext(after_context ?? context);
            const globs = [file_glob];
            if (type !== undefined) {
                const extras = FILETYPE_GLOBS[type];
                if (extras !== undefined)
                    globs.push(...extras);
            }
            const resolvedRoot = resolve(ctx.cwd, path);
            const files = await collectFiles(resolvedRoot, globs);
            const matches = [];
            let truncated = false;
            outer: for (const file of files) {
                if (ctx.signal?.aborted)
                    throw new Error('grep_files cancelled');
                let text;
                try {
                    text = await readFile(file, 'utf-8');
                }
                catch {
                    continue;
                }
                const lines = text.split('\n');
                const rel = relative(resolvedRoot, file);
                // Circular buffer of the last `beforeN` lines.
                const beforeBuf = [];
                // Pending after-context emissions: each entry is a reference to a match
                // whose `after` array still needs filling, with a remaining count.
                const pending = [];
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    // Drain any after-context windows opened by earlier matches.
                    if (pending.length > 0) {
                        for (const p of pending) {
                            p.match.after.push(line);
                            p.remaining -= 1;
                        }
                        while (pending.length > 0 && pending[0].remaining <= 0) {
                            pending.shift();
                        }
                    }
                    if (regex.test(line)) {
                        if (matches.length >= MAX_MATCHES) {
                            truncated = true;
                            break outer;
                        }
                        const m = {
                            file: rel,
                            line: i + 1,
                            text: line,
                        };
                        if (beforeN > 0)
                            m.before = beforeBuf.slice();
                        if (afterN > 0) {
                            m.after = [];
                            pending.push({ match: m, remaining: afterN });
                        }
                        matches.push(m);
                    }
                    if (beforeN > 0) {
                        beforeBuf.push(line);
                        if (beforeBuf.length > beforeN)
                            beforeBuf.shift();
                    }
                }
            }
            // Mode dispatch.
            if (output_mode === 'files_with_matches') {
                const seen = new Set();
                const files = [];
                for (const m of matches) {
                    if (!seen.has(m.file)) {
                        seen.add(m.file);
                        files.push(m.file);
                    }
                }
                return {
                    pattern,
                    path,
                    mode: 'files_with_matches',
                    files,
                    matchCount: matches.length,
                    truncated,
                };
            }
            if (output_mode === 'count') {
                const counts = new Map();
                for (const m of matches) {
                    counts.set(m.file, (counts.get(m.file) ?? 0) + 1);
                }
                const perFile = Array.from(counts.entries()).map(([file, count]) => ({ file, count }));
                return {
                    pattern,
                    path,
                    mode: 'count',
                    totalMatches: matches.length,
                    perFile,
                    truncated,
                };
            }
            // 'content' (default) — current shape, plus optional `before`/`after`.
            return {
                pattern,
                path,
                matchCount: matches.length,
                truncated,
                matches,
            };
        },
    });
}
//# sourceMappingURL=grep-files.js.map