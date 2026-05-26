import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
export function createFileStateAccessor(logsRoot, sessionId) {
    const path = join(logsRoot, sessionId, 'state.json');
    return {
        load: async () => {
            try {
                const raw = await readFile(path, 'utf-8');
                return JSON.parse(raw);
            }
            catch (err) {
                if (err.code === 'ENOENT')
                    return null;
                throw err;
            }
        },
        save: async (state) => {
            await mkdir(dirname(path), { recursive: true });
            const tmp = `${path}.tmp`;
            await writeFile(tmp, JSON.stringify(state, null, 2));
            await rename(tmp, path);
        },
    };
}
//# sourceMappingURL=file-state.js.map