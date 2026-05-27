import { appendFile, mkdir, open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
/**
 * Schema version for every {@link TranscriptRecord} written. Bumped only when a
 * backward-incompatible field change ships; readers should ignore lines whose
 * `v` they don't understand.
 */
export const TRANSCRIPT_SCHEMA_VERSION = 1;
function transcriptPath(logsRoot, sessionId) {
    return join(logsRoot, sessionId, 'transcript.jsonl');
}
async function appendRecord(logsRoot, record) {
    const path = transcriptPath(logsRoot, record.sessionId);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(record)}\n`);
}
function now(input) {
    return input.ts ?? new Date().toISOString();
}
export async function logTranscriptSessionStart(input) {
    const record = {
        v: TRANSCRIPT_SCHEMA_VERSION,
        sessionId: input.sessionId,
        ts: now(input),
        kind: 'session_start',
        cwd: input.cwd,
        ...(input.parentSessionId !== undefined && { parentSessionId: input.parentSessionId }),
    };
    await appendRecord(input.logsRoot, record);
}
export async function logTranscriptUser(input) {
    const record = {
        v: TRANSCRIPT_SCHEMA_VERSION,
        sessionId: input.sessionId,
        ts: now(input),
        kind: 'user',
        text: input.text,
    };
    await appendRecord(input.logsRoot, record);
}
export async function logTranscriptAssistant(input) {
    const record = {
        v: TRANSCRIPT_SCHEMA_VERSION,
        sessionId: input.sessionId,
        ts: now(input),
        kind: 'assistant',
        turnNumber: input.turnNumber,
        requestId: input.requestId,
        model: input.model,
        ...(input.text !== undefined && { text: input.text }),
        ...(input.reasoning !== undefined && { reasoning: input.reasoning }),
        ...(input.toolCalls !== undefined &&
            input.toolCalls.length > 0 && {
            toolCalls: input.toolCalls,
        }),
        ...(input.usage !== undefined && { usage: input.usage }),
        ...(input.costUsd !== undefined && { costUsd: input.costUsd }),
        ...(input.durationMs !== undefined && { durationMs: input.durationMs }),
    };
    await appendRecord(input.logsRoot, record);
}
export async function logTranscriptToolResult(input) {
    const record = {
        v: TRANSCRIPT_SCHEMA_VERSION,
        sessionId: input.sessionId,
        ts: now(input),
        kind: 'tool_result',
        callId: input.callId,
        name: input.name,
        isError: input.isError,
        output: input.output,
    };
    await appendRecord(input.logsRoot, record);
}
export async function logTranscriptCompact(input) {
    const record = {
        v: TRANSCRIPT_SCHEMA_VERSION,
        sessionId: input.sessionId,
        ts: now(input),
        kind: 'compact',
        reason: input.reason,
        droppedMessages: input.droppedMessages,
        summaryText: input.summaryText,
        ...(input.usage !== undefined && { usage: input.usage }),
        ...(input.costUsd !== undefined && { costUsd: input.costUsd }),
    };
    await appendRecord(input.logsRoot, record);
}
export async function logTranscriptSessionEnd(input) {
    const record = {
        v: TRANSCRIPT_SCHEMA_VERSION,
        sessionId: input.sessionId,
        ts: now(input),
        kind: 'session_end',
        status: input.status,
        ...(input.reason !== undefined && { reason: input.reason }),
        ...(input.totalUsage !== undefined && { totalUsage: input.totalUsage }),
        ...(input.totalCostUsd !== undefined && { totalCostUsd: input.totalCostUsd }),
    };
    await appendRecord(input.logsRoot, record);
}
/**
 * Stream every record from a session's transcript in append order. Missing
 * file → empty iterable (mirrors the ENOENT-tolerant shape of
 * `createFileStateAccessor.load`). Malformed lines are skipped silently —
 * older readers shouldn't crash on schema-evolution garbage.
 */
export async function* readTranscript(logsRoot, sessionId) {
    const path = transcriptPath(logsRoot, sessionId);
    let handle;
    try {
        handle = await open(path, 'r');
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return;
        throw err;
    }
    try {
        const stream = createReadStream(path, { fd: handle.fd, autoClose: false });
        const rl = createInterface({ input: stream, crlfDelay: Infinity });
        for await (const line of rl) {
            if (!line)
                continue;
            try {
                const parsed = JSON.parse(line);
                yield parsed;
            }
            catch {
                // skip malformed lines silently
            }
        }
    }
    finally {
        await handle.close();
    }
}
//# sourceMappingURL=transcript.js.map