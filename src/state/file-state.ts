import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { StateAccessor, ConversationState } from '@openrouter/agent';

export function createFileStateAccessor(logsRoot: string, sessionId: string): StateAccessor {
  const path = join(logsRoot, sessionId, 'state.json');

  return {
    load: async () => {
      try {
        const raw = await readFile(path, 'utf-8');
        return JSON.parse(raw) as ConversationState;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },
    save: async (state: ConversationState) => {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      await writeFile(tmp, JSON.stringify(state, null, 2));
      await rename(tmp, path);
    },
  };
}
