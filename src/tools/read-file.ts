import { tool } from '@openrouter/agent';
import { z } from 'zod/v4';
import { readFile } from 'node:fs/promises';

export const readFileTool = tool({
  name: 'read_file',
  description:
    'Read the contents of a file at the given path. Returns the file content as a string. ' +
    'Use start_line and end_line to read a specific range (1-indexed, inclusive) instead of the whole file — ' +
    'useful for large files after grep_files has identified the relevant area. ' +
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
    const raw = await readFile(path, 'utf-8');

    if (start_line === undefined && end_line === undefined) {
      return { content: raw, path };
    }

    const lines = raw.split('\n');
    const totalLines = lines.length;

    const from = (start_line ?? 1) - 1; // convert to 0-indexed
    const to = end_line !== undefined ? end_line : totalLines; // end_line is inclusive, slice is exclusive

    if (from < 0 || from >= totalLines) {
      throw new Error(`start_line ${start_line} is out of range — file has ${totalLines} lines`);
    }
    if (to < from + 1) {
      throw new Error(`end_line ${end_line} must be >= start_line ${start_line}`);
    }

    const slice = lines.slice(from, to).join('\n');
    return {
      content: slice,
      path,
      start_line: from + 1,
      end_line: Math.min(to, totalLines),
      total_lines: totalLines,
    };
  },
});
