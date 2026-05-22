import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface SessionLog {
  sessionId: string;
  startedAt: string;
  /**
   * Working directory captured at session-creation time. Optional so older
   * session.json files (written before Phase 1.6) still parse cleanly.
   */
  cwd?: string;
}

export interface RequestLog {
  sessionId: string;
  requestId: string;
  prompt: string;
  timestamp: string;
}

export interface GenerationLog {
  sessionId: string;
  requestId: string;
  generationId: string;
  response: unknown;
  timestamp: string;
}

function genId(): string {
  return crypto.randomUUID();
}

export function createSessionId(): string {
  return `sess_${genId()}`;
}

export function createRequestId(): string {
  return `req_${genId()}`;
}

export function createGenerationId(): string {
  return `gen_${genId()}`;
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function logSessionStart(
  logsRoot: string,
  sessionId: string,
  cwd: string,
): Promise<void> {
  const dir = join(logsRoot, sessionId);
  await ensureDir(dir);
  const entry: SessionLog = {
    sessionId,
    startedAt: new Date().toISOString(),
    cwd,
  };
  await writeFile(join(dir, 'session.json'), JSON.stringify(entry, null, 2));
}

export async function readSessionLog(logsRoot: string, sessionId: string): Promise<SessionLog> {
  const raw = await readFile(join(logsRoot, sessionId, 'session.json'), 'utf-8');
  return JSON.parse(raw) as SessionLog;
}

export async function logRequest(logsRoot: string, entry: RequestLog): Promise<void> {
  const dir = join(logsRoot, entry.sessionId, entry.requestId);
  await ensureDir(dir);
  await writeFile(join(dir, 'request.json'), JSON.stringify(entry, null, 2));
}

export async function logGeneration(logsRoot: string, entry: GenerationLog): Promise<void> {
  const dir = join(logsRoot, entry.sessionId, entry.requestId, entry.generationId);
  await ensureDir(dir);
  await writeFile(join(dir, 'response.json'), JSON.stringify(entry, null, 2));
}
