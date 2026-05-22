import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  createSessionId,
  createRequestId,
  createGenerationId,
  logSessionStart,
  logRequest,
  logGeneration,
} from './logger.js';

let LOGS_ROOT: string;

beforeEach(async () => {
  LOGS_ROOT = await mkdtemp(join(tmpdir(), 'logger-test-'));
});

afterEach(async () => {
  await rm(LOGS_ROOT, { recursive: true, force: true });
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
  it('creates session.json under logsRoot', async () => {
    await logSessionStart(LOGS_ROOT, 'test-session');

    const raw = await readFile(join(LOGS_ROOT, 'test-session', 'session.json'), 'utf-8');
    const data = JSON.parse(raw);
    expect(data.sessionId).toBe('test-session');
    expect(data.startedAt).toBeDefined();
    expect(() => new Date(data.startedAt)).not.toThrow();
  });
});

describe('logRequest', () => {
  it('writes request.json with all fields under logsRoot', async () => {
    const entry = {
      sessionId: 'test-session',
      requestId: 'req-1',
      prompt: 'hello',
      timestamp: '2024-01-01T00:00:00Z',
    };
    await logRequest(LOGS_ROOT, entry);

    const raw = await readFile(join(LOGS_ROOT, 'test-session', 'req-1', 'request.json'), 'utf-8');
    const data = JSON.parse(raw);
    expect(data).toEqual(entry);
  });
});

describe('logGeneration', () => {
  it('writes response.json at correct path under logsRoot', async () => {
    const entry = {
      sessionId: 'test-session',
      requestId: 'req-1',
      generationId: 'gen-1',
      response: { id: 'resp-123', model: 'test-model', output: [] },
      timestamp: '2024-01-01T00:00:00Z',
    };
    await logGeneration(LOGS_ROOT, entry);

    const path = join(LOGS_ROOT, 'test-session', 'req-1', 'gen-1', 'response.json');
    const raw = await readFile(path, 'utf-8');
    const data = JSON.parse(raw);
    expect(data.generationId).toBe('gen-1');
    expect(data.response.model).toBe('test-model');
  });

  it('creates nested directory structure', async () => {
    await logGeneration(LOGS_ROOT, {
      sessionId: 'test-session',
      requestId: 'req-deep',
      generationId: 'gen-deep',
      response: {},
      timestamp: '2024-01-01T00:00:00Z',
    });

    const dir = join(LOGS_ROOT, 'test-session', 'req-deep', 'gen-deep');
    const s = await stat(dir);
    expect(s.isDirectory()).toBe(true);
  });

  it('honours an explicit logsRoot for the on-disk layout', async () => {
    await logGeneration(LOGS_ROOT, {
      sessionId: 'isolated-session',
      requestId: 'r',
      generationId: 'g',
      response: {},
      timestamp: '2024-01-01T00:00:00Z',
    });
    const s = await stat(join(LOGS_ROOT, 'isolated-session', 'r', 'g', 'response.json'));
    expect(s.isFile()).toBe(true);
  });
});
