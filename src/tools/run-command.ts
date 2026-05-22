import { tool } from '@openrouter/agent';
import { z } from 'zod/v4';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { DEFAULT_TOOL_CONTEXT, type ToolContext } from './context.js';

const TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 250;

export interface RunCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function runCommandTool(ctx: ToolContext = DEFAULT_TOOL_CONTEXT) {
  return tool({
    name: 'run_command',
    description:
      'Execute a shell command and return stdout/stderr. Use for running tests, builds, git commands, etc. Commands time out after 30 seconds.',
    inputSchema: z.object({
      command: z.string().describe('The shell command to execute'),
      cwd: z
        .string()
        .describe(
          "Working directory for the command. Resolved against the run's cwd if relative. Omit to inherit the run's cwd.",
        )
        .optional(),
    }),
    execute: async ({ command, cwd: argCwd }): Promise<RunCommandResult> => {
      if (ctx.signal?.aborted) {
        return { exitCode: 1, stdout: '', stderr: 'run_command cancelled before start' };
      }

      const effectiveCwd = argCwd ? resolve(ctx.cwd, argCwd) : ctx.cwd;

      return new Promise<RunCommandResult>((resolveResult) => {
        const child = spawn('sh', ['-c', command], { cwd: effectiveCwd });

        let stdout = '';
        let stderr = '';
        let stdoutBytes = 0;
        let stderrBytes = 0;
        const MAX_BUFFER = 1024 * 1024;
        let cancelled = false;
        let killTimer: NodeJS.Timeout | undefined;

        const timeoutTimer = setTimeout(() => {
          try {
            child.kill('SIGTERM');
          } catch {
            /* already gone */
          }
        }, TIMEOUT_MS);

        const onAbort = () => {
          cancelled = true;
          try {
            child.kill('SIGTERM');
          } catch {
            /* already gone */
          }
          killTimer = setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {
              /* already gone */
            }
          }, KILL_GRACE_MS);
        };
        if (ctx.signal) ctx.signal.addEventListener('abort', onAbort, { once: true });

        child.stdout?.on('data', (chunk: Buffer) => {
          if (stdoutBytes >= MAX_BUFFER) return;
          const text = chunk.toString();
          stdoutBytes += chunk.byteLength;
          stdout += text;
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          if (stderrBytes >= MAX_BUFFER) return;
          const text = chunk.toString();
          stderrBytes += chunk.byteLength;
          stderr += text;
        });

        const finish = (result: RunCommandResult): void => {
          clearTimeout(timeoutTimer);
          if (killTimer) clearTimeout(killTimer);
          if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);
          resolveResult(result);
        };

        child.on('error', (err) => {
          finish({ exitCode: 1, stdout, stderr: err.message });
        });

        child.on('close', (code, killSignal) => {
          if (cancelled) {
            const suffix = stderr && !stderr.endsWith('\n') ? '\n' : '';
            finish({
              exitCode: code ?? 1,
              stdout,
              stderr: stderr + suffix + 'run_command cancelled',
            });
            return;
          }
          if (killSignal === 'SIGTERM' || killSignal === 'SIGKILL') {
            const suffix = stderr && !stderr.endsWith('\n') ? '\n' : '';
            finish({
              exitCode: code ?? 1,
              stdout,
              stderr: stderr + suffix + `terminated by ${killSignal}`,
            });
            return;
          }
          finish({ exitCode: code ?? 1, stdout, stderr });
        });
      });
    },
  });
}
