import { tool } from '@openrouter/agent';
import { z } from 'zod/v4';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DEFAULT_TOOL_CONTEXT, type ToolContext } from './context.js';
import { createCheckpoint } from '../checkpoints.js';

export function editFileTool(ctx: ToolContext = DEFAULT_TOOL_CONTEXT) {
  return tool({
    name: 'edit_file',
    description:
      'Edit a file by replacing an exact string match with new content. The old_string must appear exactly once in the file. Use read_file first to see the current content.',
    inputSchema: z.object({
      path: z.string().describe('Path to the file to edit'),
      old_string: z
        .string()
        .describe('The exact string to find and replace (must be unique in file)'),
      new_string: z.string().describe('The replacement string'),
      checkpoint: z
        .boolean()
        .optional()
        .describe(
          'When true, snapshot the file under the session checkpoints directory before editing. Overrides the run-level default.',
        ),
    }),
    execute: async ({ path, old_string, new_string, checkpoint }) => {
      if (ctx.signal?.aborted) throw new Error('edit_file cancelled');
      const resolved = resolve(ctx.cwd, path);
      const content = await readFile(resolved, 'utf-8');
      const occurrences = content.split(old_string).length - 1;

      if (occurrences === 0) {
        throw new Error(`old_string not found in ${path}`);
      }
      if (occurrences > 1) {
        throw new Error(
          `old_string found ${occurrences} times in ${path} — it must be unique. Provide more surrounding context.`,
        );
      }

      const wantCheckpoint = checkpoint ?? ctx.checkpoint ?? false;
      if (wantCheckpoint) {
        if (ctx.persistSession === false) {
          ctx.logger?.('warn', 'checkpoint requested but persistSession is false', {
            tool: 'edit_file',
            path: resolved,
          });
        } else if (ctx.sessionId && ctx.logsRoot) {
          await createCheckpoint(ctx.sessionId, ctx.logsRoot, [resolved], { logger: ctx.logger });
        }
      }

      const updated = content.replace(old_string, new_string);
      await writeFile(resolved, updated, 'utf-8');
      return { path, replaced: true };
    },
  });
}
