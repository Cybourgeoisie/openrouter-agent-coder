import { tool } from '@openrouter/agent';
import { z } from 'zod/v4';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DEFAULT_TOOL_CONTEXT } from './context.js';
/**
 * Caps that protect the agent from runaway reads. Mirrors Claude Code's
 * three-tier guard:
 *
 *  - {@link MAX_BYTES}: hard pre-read byte cap. Files above this size never
 *    get loaded into memory at all — `stat()` rejects them with a message
 *    pointing the model at `start_line`/`end_line` or `grep_files`.
 *  - {@link DEFAULT_LINE_LIMIT}: soft truncation. When neither `start_line`
 *    nor `end_line` is supplied, returns at most this many lines and tells
 *    the model the result was truncated so it can paginate.
 *  - {@link MAX_TOKENS_ESTIMATE}: hard post-read token cap, estimated as
 *    `content.length / CHARS_PER_TOKEN`. Catches files whose lines are
 *    short enough to slip past the line limit but dense enough to blow the
 *    model's context window (e.g. minified bundles within the byte cap).
 */
const MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_LINE_LIMIT = 2000;
const MAX_TOKENS_ESTIMATE = 25000;
const CHARS_PER_TOKEN = 4;
function formatBytes(n) {
    if (n >= 1024 * 1024)
        return `${(n / (1024 * 1024)).toFixed(1)}MB`;
    if (n >= 1024)
        return `${(n / 1024).toFixed(1)}KB`;
    return `${n}B`;
}
export function readFileTool(ctx = DEFAULT_TOOL_CONTEXT) {
    return tool({
        name: 'read_file',
        description: 'Read the contents of a file at the given path. Returns the file content as a string. ' +
            `By default, reads up to the first ${DEFAULT_LINE_LIMIT} lines — use start_line and end_line ` +
            '(1-indexed, inclusive) to read a specific range, useful for paging through large files ' +
            'after grep_files has identified the relevant area. ' +
            `Files larger than ${formatBytes(MAX_BYTES)} are rejected; use start_line/end_line or grep_files instead. ` +
            'Use this to understand existing code before making changes.',
        inputSchema: z.object({
            path: z.string().describe('Absolute or relative path to the file to read'),
            start_line: z
                .number()
                .int()
                .min(1)
                .describe('First line to return (1-indexed, inclusive). Omit to start from the beginning.')
                .optional(),
            end_line: z
                .number()
                .int()
                .min(1)
                .describe('Last line to return (1-indexed, inclusive). Omit to read to the end of the file.')
                .optional(),
        }),
        execute: async ({ path, start_line, end_line }) => {
            if (ctx.signal?.aborted)
                throw new Error('read_file cancelled');
            const resolved = resolve(ctx.cwd, path);
            // Tier 1 — pre-read byte cap. stat() before readFile so a 1GB file
            // never reaches the V8 string allocator.
            const s = await stat(resolved);
            if (s.size > MAX_BYTES) {
                throw new Error(`File content (${formatBytes(s.size)}) exceeds maximum allowed size (${formatBytes(MAX_BYTES)}). ` +
                    'Use start_line and end_line to read specific portions of the file, ' +
                    'or use grep_files to find specific content instead of reading the whole file.');
            }
            const raw = await readFile(resolved, 'utf-8');
            const lines = raw.split('\n');
            const totalLines = lines.length;
            const hasExplicitRange = start_line !== undefined || end_line !== undefined;
            // Resolve the slice bounds. Without an explicit range we cap at
            // DEFAULT_LINE_LIMIT (Tier 2 — soft default truncation).
            let from;
            let to;
            let truncatedByDefault = false;
            if (hasExplicitRange) {
                from = (start_line ?? 1) - 1;
                to = end_line !== undefined ? end_line : totalLines;
                if (from < 0 || from >= totalLines) {
                    throw new Error(`start_line ${start_line} is out of range — file has ${totalLines} lines`);
                }
                if (to < from + 1) {
                    throw new Error(`end_line ${end_line} must be >= start_line ${start_line}`);
                }
            }
            else {
                from = 0;
                to = Math.min(totalLines, DEFAULT_LINE_LIMIT);
                truncatedByDefault = totalLines > DEFAULT_LINE_LIMIT;
            }
            const content = lines.slice(from, to).join('\n');
            // Tier 3 — post-read token estimate. Cheap heuristic (1 token ≈ 4 chars)
            // catches dense files whose lines are short enough to slip past Tier 2
            // but big enough to blow the model's context window.
            const estimatedTokens = Math.ceil(content.length / CHARS_PER_TOKEN);
            if (estimatedTokens > MAX_TOKENS_ESTIMATE) {
                throw new Error(`File content (~${estimatedTokens} estimated tokens) exceeds maximum allowed tokens (${MAX_TOKENS_ESTIMATE}). ` +
                    'Use start_line and end_line to read a smaller range, ' +
                    'or use grep_files to find specific content.');
            }
            if (truncatedByDefault) {
                return {
                    content,
                    path,
                    start_line: 1,
                    end_line: to,
                    total_lines: totalLines,
                    truncated: true,
                    notice: `File was too large and has been truncated to the first ${DEFAULT_LINE_LIMIT} lines. ` +
                        `Use start_line and end_line to read further (file has ${totalLines} lines total). ` +
                        `Don't tell the user about this truncation.`,
                };
            }
            if (hasExplicitRange) {
                return {
                    content,
                    path,
                    start_line: from + 1,
                    end_line: Math.min(to, totalLines),
                    total_lines: totalLines,
                };
            }
            return { content, path };
        },
    });
}
//# sourceMappingURL=read-file.js.map