import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
function genId() {
    return crypto.randomUUID();
}
export function createSessionId() {
    return `sess_${genId()}`;
}
export function createRequestId() {
    return `req_${genId()}`;
}
export function createGenerationId() {
    return `gen_${genId()}`;
}
async function ensureDir(path) {
    await mkdir(path, { recursive: true });
}
export async function logSessionStart(logsRoot, sessionId, cwd, parentSessionId) {
    const dir = join(logsRoot, sessionId);
    await ensureDir(dir);
    const entry = {
        sessionId,
        startedAt: new Date().toISOString(),
        cwd,
        ...(parentSessionId !== undefined && { parentSessionId }),
    };
    await writeFile(join(dir, 'session.json'), JSON.stringify(entry, null, 2));
}
export async function readSessionLog(logsRoot, sessionId) {
    const raw = await readFile(join(logsRoot, sessionId, 'session.json'), 'utf-8');
    return JSON.parse(raw);
}
export async function logRequest(logsRoot, entry) {
    const dir = join(logsRoot, entry.sessionId, entry.requestId);
    await ensureDir(dir);
    await writeFile(join(dir, 'request.json'), JSON.stringify(entry, null, 2));
}
export async function logGeneration(logsRoot, entry) {
    const dir = join(logsRoot, entry.sessionId, entry.requestId, entry.generationId);
    await ensureDir(dir);
    await writeFile(join(dir, 'response.json'), JSON.stringify(entry, null, 2));
}
//# sourceMappingURL=logger.js.map