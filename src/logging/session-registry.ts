import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_BASE = join(__dirname, '..', '..', 'logs');
const REGISTRY_PATH = join(LOG_BASE, 'sessions.json');

export interface SessionEntry {
  /** The session identifier, e.g. `sess_<uuid>`. */
  sessionId: string;
  /** ISO-8601 timestamp of when the session was started. */
  startedAt: string;
  /** The first prompt sent in this session (populated after the first request). */
  firstPrompt?: string;
}

/**
 * Read the full ordered session registry from disk.
 * Returns an empty array when the file does not yet exist.
 */
export async function readSessionRegistry(): Promise<SessionEntry[]> {
  try {
    const raw = await readFile(REGISTRY_PATH, 'utf-8');
    return JSON.parse(raw) as SessionEntry[];
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Persist the registry atomically (write to .tmp then rename).
 */
async function writeSessionRegistry(entries: SessionEntry[]): Promise<void> {
  await mkdir(dirname(REGISTRY_PATH), { recursive: true });
  const tmp = `${REGISTRY_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify(entries, null, 2));
  await rename(tmp, REGISTRY_PATH);
}

/**
 * Append a new session entry to the registry.
 * If an entry with the same sessionId already exists it is left untouched.
 */
export async function appendSessionToRegistry(entry: SessionEntry): Promise<void> {
  const entries = await readSessionRegistry();
  const exists = entries.some((e) => e.sessionId === entry.sessionId);
  if (!exists) {
    entries.push(entry);
    await writeSessionRegistry(entries);
  }
}

/**
 * Persist the `firstPrompt` for an existing registry entry.
 * No-ops silently when the entry is not found.
 */
export async function setSessionFirstPrompt(
  sessionId: string,
  firstPrompt: string,
): Promise<void> {
  const entries = await readSessionRegistry();
  const entry = entries.find((e) => e.sessionId === sessionId);
  if (!entry) return;
  // Only record once — don't overwrite with later prompts.
  if (entry.firstPrompt !== undefined) return;
  entry.firstPrompt = firstPrompt;
  await writeSessionRegistry(entries);
}

/**
 * Return the most-recently-started session entry, or `null` when the
 * registry is empty.  "Most recent" is defined by insertion order (last
 * element in the array).
 */
export async function getLastSession(): Promise<SessionEntry | null> {
  const entries = await readSessionRegistry();
  if (entries.length === 0) return null;
  return entries[entries.length - 1];
}
