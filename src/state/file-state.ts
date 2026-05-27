import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { StateAccessor, ConversationState } from '@openrouter/agent';

export function createFileStateAccessor(logsRoot: string, sessionId: string): StateAccessor {
  const path = join(logsRoot, sessionId, 'state.json');
  // Per-accessor save chain. Concurrent save() calls serialize through this
  // promise so two writers never race on the shared `${path}.tmp` file
  // (which would cause one of them to ENOENT on rename).
  let saveChain: Promise<void> = Promise.resolve();

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
    save: (state: ConversationState) => {
      const next = saveChain.then(async () => {
        await mkdir(dirname(path), { recursive: true });
        const tmp = `${path}.tmp`;
        await writeFile(tmp, JSON.stringify(state, null, 2));
        await rename(tmp, path);
      });
      // Swallow rejections on the chain itself so one failed save doesn't
      // poison every subsequent save. The caller awaiting `next` still sees
      // the rejection.
      saveChain = next.catch(() => {});
      return next;
    },
  };
}
