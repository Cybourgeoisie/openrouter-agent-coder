import { tool } from '@openrouter/agent';
import { z } from 'zod/v4';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DEFAULT_TOOL_CONTEXT, type ToolContext } from './context.js';

export function writeFileTool(ctx: ToolContext = DEFAULT_TOOL_CONTEXT) {
  return tool({
    name: 'write_file',
    description:
      'Write content to a file, creating it if it does not exist or overwriting if it does. Parent directories are created automatically.',
    inputSchema: z.object({
      path: z.string().describe('Absolute or relative path to the file to write'),
      content: z.string().describe('The full content to write to the file'),
    }),
    execute: async ({ path, content }) => {
      if (ctx.signal?.aborted) throw new Error('write_file cancelled');
      const resolved = resolve(ctx.cwd, path);
      await mkdir(dirname(resolved), { recursive: true });
      await writeFile(resolved, content, 'utf-8');
      return { path, bytesWritten: Buffer.byteLength(content, 'utf-8') };
    },
  });
}
