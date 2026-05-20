import { tool } from '@openrouter/agent';
import { z } from 'zod/v4';
import { readFile } from 'node:fs/promises';

export const readFileTool = tool({
  name: 'read_file',
  description:
    'Read the contents of a file at the given path. Returns the file content as a string. Use this to understand existing code before making changes.',
  inputSchema: z.object({
    path: z.string().describe('Absolute or relative path to the file to read'),
  }),
  execute: async ({ path }) => {
    const content = await readFile(path, 'utf-8');
    return { content, path };
  },
});
