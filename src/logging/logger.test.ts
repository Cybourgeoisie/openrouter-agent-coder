import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  createSessionId,
  createRequestId,
  createGenerationId,
  logSessionStart,
  logRequest,
  logGeneration,
  readSessionLog,
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
  it('creates session.json under logsRoot with cwd captured', async () => {
    await logSessionStart(LOGS_ROOT, 'test-session', '/tmp/cwd-fixture');

    const raw = await readFile(join(LOGS_ROOT, 'test-session', 'session.json'), 'utf-8');
    const data = JSON.parse(raw);
    expect(data.sessionId).toBe('test-session');
    expect(data.startedAt).toBeDefined();
    expect(() => new Date(data.startedAt)).not.toThrow();
    expect(data.cwd).toBe('/tmp/cwd-fixture');
  });
});

describe('readSessionLog', () => {
  it('round-trips a session.json written by logSessionStart', async () => {
    await logSessionStart(LOGS_ROOT, 'rt-session', '/some/where');
    const data = await readSessionLog(LOGS_ROOT, 'rt-session');
    expect(data.sessionId).toBe('rt-session');
    expect(data.cwd).toBe('/some/where');
  });

  it('round-trips parentSessionId when provided', async () => {
    await logSessionStart(LOGS_ROOT, 'forked-session', '/tmp/forked-cwd', 'parent-id-xyz');
    const data = await readSessionLog(LOGS_ROOT, 'forked-session');
    expect(data.sessionId).toBe('forked-session');
    expect(data.parentSessionId).toBe('parent-id-xyz');
  });

  it('omits parentSessionId on disk when not supplied', async () => {
    await logSessionStart(LOGS_ROOT, 'root-session', '/tmp/root-cwd');
    const raw = await readFile(join(LOGS_ROOT, 'root-session', 'session.json'), 'utf-8');
    const data = JSON.parse(raw);
    expect(Object.prototype.hasOwnProperty.call(data, 'parentSessionId')).toBe(false);
  });

  // Backward compatibility: session.json files written before Phase 1.6
  // contained only { sessionId, startedAt }. They must still parse without
  // throwing — cwd is optional on the SessionLog type.
  it('parses a legacy session.json that lacks cwd', async () => {
    const dir = join(LOGS_ROOT, 'legacy-session');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'session.json'),
      JSON.stringify({ sessionId: 'legacy-session', startedAt: '2024-01-01T00:00:00.000Z' }),
    );
    const data = await readSessionLog(LOGS_ROOT, 'legacy-session');
    expect(data.sessionId).toBe('legacy-session');
    expect(data.startedAt).toBe('2024-01-01T00:00:00.000Z');
    expect(data.cwd).toBeUndefined();
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
