import { tool } from '@openrouter/agent';
import { z } from 'zod/v4';
import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DEFAULT_TOOL_CONTEXT } from './context.js';
export function listDirectoryTool(ctx = DEFAULT_TOOL_CONTEXT) {
    return tool({
        name: 'list_directory',
        description: 'List files and directories at the given path. Returns names with a trailing / for directories.',
        inputSchema: z.object({
            path: z.string().describe('Path to the directory to list').default('.'),
        }),
        execute: async ({ path }) => {
            if (ctx.signal?.aborted)
                throw new Error('list_directory cancelled');
            const resolved = resolve(ctx.cwd, path);
            const entries = await readdir(resolved);
            const detailed = await Promise.all(entries.map(async (name) => {
                const fullPath = join(resolved, name);
                try {
                    const s = await stat(fullPath);
                    return s.isDirectory() ? `${name}/` : name;
                }
                catch {
                    return name;
                }
            }));
            return { path, entries: detailed };
        },
    });
}
//# sourceMappingURL=list-directory.js.map