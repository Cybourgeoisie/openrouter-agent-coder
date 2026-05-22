import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_BASE = join(__dirname, '..', '..', 'logs');

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

export async function logSessionStart(sessionId: string): Promise<void> {
  const dir = join(LOG_BASE, sessionId);
  await ensureDir(dir);
  const startedAt = new Date().toISOString();
  await writeFile(join(dir, 'session.json'), JSON.stringify({ sessionId, startedAt }, null, 2));
}

export async function logRequest(entry: RequestLog): Promise<void> {
  const dir = join(LOG_BASE, entry.sessionId, entry.requestId);
  await ensureDir(dir);
  await writeFile(join(dir, 'request.json'), JSON.stringify(entry, null, 2));
}

export async function logGeneration(entry: GenerationLog): Promise<void> {
  const dir = join(LOG_BASE, entry.sessionId, entry.requestId, entry.generationId);
  await ensureDir(dir);
  await writeFile(join(dir, 'response.json'), JSON.stringify(entry, null, 2));
}
