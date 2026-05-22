import { tool } from '@openrouter/agent';
import { z } from 'zod/v4';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export function listDirectoryTool(signal?: AbortSignal) {
  return tool({
    name: 'list_directory',
    description:
      'List files and directories at the given path. Returns names with a trailing / for directories.',
    inputSchema: z.object({
      path: z.string().describe('Path to the directory to list').default('.'),
    }),
    execute: async ({ path }) => {
      if (signal?.aborted) throw new Error('list_directory cancelled');
      const entries = await readdir(path);
      const detailed = await Promise.all(
        entries.map(async (name) => {
          const fullPath = join(path, name);
          try {
            const s = await stat(fullPath);
            return s.isDirectory() ? `${name}/` : name;
          } catch {
            return name;
          }
        }),
      );
      return { path, entries: detailed };
    },
  });
}
