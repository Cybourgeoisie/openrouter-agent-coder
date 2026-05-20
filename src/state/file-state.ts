import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { StateAccessor, ConversationState } from '@openrouter/agent';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(__dirname, '..', '..', 'logs');

function statePath(sessionId: string): string {
  return join(STATE_DIR, sessionId, 'state.json');
}

export function createFileStateAccessor(sessionId: string): StateAccessor {
  const path = statePath(sessionId);

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
