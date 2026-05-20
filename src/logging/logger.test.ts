import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { readFile, rm, stat } from 'node:fs/promises';
import {
  createSessionId,
  createRequestId,
  createGenerationId,
  logSessionStart,
  logRequest,
  logGeneration,
} from './logger.js';

const LOG_BASE = join(process.cwd(), 'logs');

afterEach(async () => {
  await rm(join(LOG_BASE, 'test-session'), { recursive: true, force: true });
  // Remove the test session entry from the registry so tests stay isolated.
  // We do a best-effort rewrite rather than deleting the whole file so that
  // real session entries recorded by the developer are not lost.
  try {
    const registryPath = join(LOG_BASE, 'sessions.json');
    const raw = await readFile(registryPath, 'utf-8').catch(() => '[]');
    const entries = (JSON.parse(raw) as Array<{ sessionId: string }>).filter(
      (e) => e.sessionId !== 'test-session',
    );
    const { writeFile } = await import('node:fs/promises');
    await writeFile(registryPath, JSON.stringify(entries, null, 2));
  } catch {
    // Non-fatal — registry may not exist yet in a fresh checkout.
  }
});

describe('ID generation', () => {
  it('createSessionId returns prefixed UUID', () => {
    const id = createSessionId();
    expect(id).toMatch(/^sess_[0-9a-f-]{36}$/);
  });

  it('createRequestId returns prefixed UUID', () => {
    const id = createRequestId();
    expect(id).toMatch(/^req_[0-9a-f-]{36}$/);
  });

  it('createGenerationId returns prefixed UUID', () => {
    const id = createGenerationId();
    expect(id).toMatch(/^gen_[0-9a-f-]{36}$/);
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => createSessionId()));
    expect(ids.size).toBe(100);
  });
});

describe('logSessionStart', () => {
  it('creates session.json with correct structure', async () => {
    await logSessionStart('test-session');

    const raw = await readFile(join(LOG_BASE, 'test-session', 'session.json'), 'utf-8');
    const data = JSON.parse(raw);
    expect(data.sessionId).toBe('test-session');
    expect(data.startedAt).toBeDefined();
    expect(() => new Date(data.startedAt)).not.toThrow();
  });

  it('registers the session in sessions.json', async () => {
    await logSessionStart('test-session');

    const raw = await readFile(join(LOG_BASE, 'sessions.json'), 'utf-8');
    const entries = JSON.parse(raw) as Array<{ sessionId: string }>;
    expect(entries.some((e) => e.sessionId === 'test-session')).toBe(true);
  });
});

describe('logRequest', () => {
  it('writes request.json with all fields', async () => {
    const entry = {
      sessionId: 'test-session',
      requestId: 'req-1',
      prompt: 'hello',
      timestamp: '2024-01-01T00:00:00Z',
    };
    await logRequest(entry);

    const raw = await readFile(
      join(LOG_BASE, 'test-session', 'req-1', 'request.json'),
      'utf-8',
    );
    const data = JSON.parse(raw);
    expect(data).toEqual(entry);
  });

  it('captures the first prompt in the registry when the session is pre-registered', async () => {
    // First register the session so setSessionFirstPrompt can find the entry.
    await logSessionStart('test-session');

    await logRequest({
      sessionId: 'test-session',
      requestId: 'req-2',
      prompt: 'my first prompt',
      timestamp: '2024-01-01T00:00:00Z',
    });

    const raw = await readFile(join(LOG_BASE, 'sessions.json'), 'utf-8');
    const entries = JSON.parse(raw) as Array<{ sessionId: string; firstPrompt?: string }>;
    const entry = entries.find((e) => e.sessionId === 'test-session');
    expect(entry?.firstPrompt).toBe('my first prompt');
  });
});

describe('logGeneration', () => {
  it('writes response.json at correct path', async () => {
    const entry = {
      sessionId: 'test-session',
      requestId: 'req-1',
      generationId: 'gen-1',
      response: { id: 'resp-123', model: 'test-model', output: [] },
      timestamp: '2024-01-01T00:00:00Z',
    };
    await logGeneration(entry);

    const path = join(LOG_BASE, 'test-session', 'req-1', 'gen-1', 'response.json');
    const raw = await readFile(path, 'utf-8');
    const data = JSON.parse(raw);
    expect(data.generationId).toBe('gen-1');
    expect(data.response.model).toBe('test-model');
  });

  it('creates nested directory structure', async () => {
    await logGeneration({
      sessionId: 'test-session',
      requestId: 'req-deep',
      generationId: 'gen-deep',
      response: {},
      timestamp: '2024-01-01T00:00:00Z',
    });

    const dir = join(LOG_BASE, 'test-session', 'req-deep', 'gen-deep');
    const s = await stat(dir);
    expect(s.isDirectory()).toBe(true);
  });
});
