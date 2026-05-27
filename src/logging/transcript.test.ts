import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TRANSCRIPT_SCHEMA_VERSION,
  logTranscriptAssistant,
  logTranscriptCompact,
  logTranscriptSessionEnd,
  logTranscriptSessionStart,
  logTranscriptToolResult,
  logTranscriptUser,
  readTranscript,
  type TranscriptRecord,
} from './transcript.js';

const SESSION = 'sess_test_transcript';

describe('transcript writer', () => {
  let logsRoot: string;

  beforeEach(async () => {
    logsRoot = await mkdtemp(join(tmpdir(), 'or-transcript-'));
    return async () => {
      await rm(logsRoot, { recursive: true, force: true });
    };
  });

  it('creates the per-session directory + transcript.jsonl on first write', async () => {
    expect(existsSync(join(logsRoot, SESSION, 'transcript.jsonl'))).toBe(false);
    await logTranscriptSessionStart({ logsRoot, sessionId: SESSION, cwd: '/work' });
    expect(existsSync(join(logsRoot, SESSION, 'transcript.jsonl'))).toBe(true);
  });

  it('appends one JSONL line per record, in call order', async () => {
    await logTranscriptSessionStart({ logsRoot, sessionId: SESSION, cwd: '/work' });
    await logTranscriptUser({ logsRoot, sessionId: SESSION, text: 'hi' });
    await logTranscriptSessionEnd({
      logsRoot,
      sessionId: SESSION,
      status: 'success',
      totalCostUsd: 0,
    });
    const raw = await readFile(join(logsRoot, SESSION, 'transcript.jsonl'), 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(3);
    const kinds = lines.map((l) => (JSON.parse(l) as TranscriptRecord).kind);
    expect(kinds).toEqual(['session_start', 'user', 'session_end']);
  });

  it('serializes every record kind with the documented fields', async () => {
    await logTranscriptSessionStart({
      logsRoot,
      sessionId: SESSION,
      cwd: '/work',
      parentSessionId: 'sess_parent',
      ts: '2026-05-26T00:00:00.000Z',
    });
    await logTranscriptUser({
      logsRoot,
      sessionId: SESSION,
      text: 'do the thing',
      ts: '2026-05-26T00:00:01.000Z',
    });
    await logTranscriptAssistant({
      logsRoot,
      sessionId: SESSION,
      turnNumber: 1,
      requestId: 'req_1',
      model: 'anthropic/claude-opus-4-7',
      text: 'sure, doing it',
      reasoning: 'thinking it through',
      toolCalls: [{ callId: 'c1', name: 'read_file', input: { path: 'x.txt' } }],
      usage: { prompt: 100, completion: 50, reasoning: 200, cached: 10 },
      costUsd: 0.0012,
      ts: '2026-05-26T00:00:02.000Z',
    });
    await logTranscriptToolResult({
      logsRoot,
      sessionId: SESSION,
      callId: 'c1',
      name: 'read_file',
      isError: false,
      output: { content: 'file body' },
      ts: '2026-05-26T00:00:03.000Z',
    });
    await logTranscriptCompact({
      logsRoot,
      sessionId: SESSION,
      reason: 'auto',
      droppedMessages: 12,
      summaryText: 'condensed history',
      ts: '2026-05-26T00:00:04.000Z',
    });
    await logTranscriptSessionEnd({
      logsRoot,
      sessionId: SESSION,
      status: 'success',
      totalUsage: { prompt: 100, completion: 50 },
      totalCostUsd: 0.0012,
      ts: '2026-05-26T00:00:05.000Z',
    });

    const raw = await readFile(join(logsRoot, SESSION, 'transcript.jsonl'), 'utf8');
    const records = raw
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as TranscriptRecord);

    expect(records[0]).toEqual({
      v: TRANSCRIPT_SCHEMA_VERSION,
      sessionId: SESSION,
      ts: '2026-05-26T00:00:00.000Z',
      kind: 'session_start',
      cwd: '/work',
      parentSessionId: 'sess_parent',
    });

    expect(records[1]).toEqual({
      v: TRANSCRIPT_SCHEMA_VERSION,
      sessionId: SESSION,
      ts: '2026-05-26T00:00:01.000Z',
      kind: 'user',
      text: 'do the thing',
    });

    expect(records[2]).toEqual({
      v: TRANSCRIPT_SCHEMA_VERSION,
      sessionId: SESSION,
      ts: '2026-05-26T00:00:02.000Z',
      kind: 'assistant',
      turnNumber: 1,
      requestId: 'req_1',
      model: 'anthropic/claude-opus-4-7',
      text: 'sure, doing it',
      reasoning: 'thinking it through',
      toolCalls: [{ callId: 'c1', name: 'read_file', input: { path: 'x.txt' } }],
      usage: { prompt: 100, completion: 50, reasoning: 200, cached: 10 },
      costUsd: 0.0012,
    });

    expect(records[3]).toEqual({
      v: TRANSCRIPT_SCHEMA_VERSION,
      sessionId: SESSION,
      ts: '2026-05-26T00:00:03.000Z',
      kind: 'tool_result',
      callId: 'c1',
      name: 'read_file',
      isError: false,
      output: { content: 'file body' },
    });

    expect(records[4]).toEqual({
      v: TRANSCRIPT_SCHEMA_VERSION,
      sessionId: SESSION,
      ts: '2026-05-26T00:00:04.000Z',
      kind: 'compact',
      reason: 'auto',
      droppedMessages: 12,
      summaryText: 'condensed history',
    });

    expect(records[5]).toEqual({
      v: TRANSCRIPT_SCHEMA_VERSION,
      sessionId: SESSION,
      ts: '2026-05-26T00:00:05.000Z',
      kind: 'session_end',
      status: 'success',
      totalUsage: { prompt: 100, completion: 50 },
      totalCostUsd: 0.0012,
    });
  });

  it('omits optional fields when undefined on compact and session_end', async () => {
    await logTranscriptCompact({
      logsRoot,
      sessionId: SESSION,
      reason: 'manual',
      droppedMessages: 0,
      summaryText: '',
    });
    await logTranscriptSessionEnd({ logsRoot, sessionId: SESSION, status: 'error' });
    const raw = await readFile(join(logsRoot, SESSION, 'transcript.jsonl'), 'utf8');
    const [compact, end] = raw
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as TranscriptRecord);
    expect(compact).not.toHaveProperty('usage');
    expect(compact).not.toHaveProperty('costUsd');
    expect(end).not.toHaveProperty('reason');
    expect(end).not.toHaveProperty('totalUsage');
    expect(end).not.toHaveProperty('totalCostUsd');
  });

  it('omits optional fields when undefined (assistant w/o tool calls)', async () => {
    await logTranscriptAssistant({
      logsRoot,
      sessionId: SESSION,
      turnNumber: 0,
      requestId: 'req_min',
      model: 'm',
    });
    const raw = await readFile(join(logsRoot, SESSION, 'transcript.jsonl'), 'utf8');
    const record = JSON.parse(raw.trim()) as Extract<TranscriptRecord, { kind: 'assistant' }>;
    expect(record).not.toHaveProperty('text');
    expect(record).not.toHaveProperty('reasoning');
    expect(record).not.toHaveProperty('toolCalls');
    expect(record).not.toHaveProperty('usage');
    expect(record).not.toHaveProperty('costUsd');
  });
});

describe('readTranscript', () => {
  let logsRoot: string;

  beforeEach(async () => {
    logsRoot = await mkdtemp(join(tmpdir(), 'or-transcript-read-'));
    return async () => {
      await rm(logsRoot, { recursive: true, force: true });
    };
  });

  it('returns an empty iterable when the file does not exist (ENOENT-tolerant)', async () => {
    const collected: TranscriptRecord[] = [];
    for await (const r of readTranscript(logsRoot, 'sess_does_not_exist')) {
      collected.push(r);
    }
    expect(collected).toEqual([]);
  });

  it('round-trips every written record in order', async () => {
    await logTranscriptSessionStart({ logsRoot, sessionId: SESSION, cwd: '/w' });
    await logTranscriptUser({ logsRoot, sessionId: SESSION, text: 'a' });
    await logTranscriptUser({ logsRoot, sessionId: SESSION, text: 'b' });

    const collected: TranscriptRecord[] = [];
    for await (const r of readTranscript(logsRoot, SESSION)) {
      collected.push(r);
    }
    expect(collected).toHaveLength(3);
    expect(collected[0].kind).toBe('session_start');
    expect(collected.slice(1).map((r) => (r as { text: string }).text)).toEqual(['a', 'b']);
  });

  it('rethrows non-ENOENT errors when opening the transcript', async () => {
    // Plant an unreadable transcript file (mode 000) so `open(..., 'r')`
    // rejects with EACCES, exercising the rethrow arm (vs. the
    // swallow-on-ENOENT path).
    const { mkdir, writeFile, chmod } = await import('node:fs/promises');
    const dir = join(logsRoot, SESSION);
    const path = join(dir, 'transcript.jsonl');
    await mkdir(dir, { recursive: true });
    await writeFile(path, '{"v":1}\n');
    await chmod(path, 0o000);
    try {
      await expect(async () => {
        for await (const _r of readTranscript(logsRoot, SESSION)) {
          void _r;
        }
      }).rejects.toThrow();
    } finally {
      // Restore so the temp-dir cleanup teardown can delete it.
      await chmod(path, 0o644);
    }
  });

  it('skips blank lines in the transcript', async () => {
    const { appendFile } = await import('node:fs/promises');
    await logTranscriptSessionStart({ logsRoot, sessionId: SESSION, cwd: '/w' });
    // Inject a trailing blank line.
    await appendFile(join(logsRoot, SESSION, 'transcript.jsonl'), '\n');
    await logTranscriptUser({ logsRoot, sessionId: SESSION, text: 'after blank' });
    const collected: TranscriptRecord[] = [];
    for await (const r of readTranscript(logsRoot, SESSION)) collected.push(r);
    expect(collected.map((r) => r.kind)).toEqual(['session_start', 'user']);
  });

  it('skips malformed lines silently', async () => {
    await logTranscriptSessionStart({ logsRoot, sessionId: SESSION, cwd: '/w' });
    // Inject a malformed line.
    const { appendFile } = await import('node:fs/promises');
    await appendFile(join(logsRoot, SESSION, 'transcript.jsonl'), '{this-is-not-json\n');
    await logTranscriptUser({ logsRoot, sessionId: SESSION, text: 'survived' });

    const collected: TranscriptRecord[] = [];
    for await (const r of readTranscript(logsRoot, SESSION)) {
      collected.push(r);
    }
    expect(collected).toHaveLength(2);
    expect(collected[1].kind).toBe('user');
  });
});
