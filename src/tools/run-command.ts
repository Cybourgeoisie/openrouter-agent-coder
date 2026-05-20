import { tool } from '@openrouter/agent';
import { z } from 'zod/v4';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const TIMEOUT_MS = 30_000;

export const runCommandTool = tool({
  name: 'run_command',
  description:
    'Execute a shell command and return stdout/stderr. Use for running tests, builds, git commands, etc. Commands time out after 30 seconds.',
  inputSchema: z.object({
    command: z.string().describe('The shell command to execute'),
    cwd: z
      .string()
      .describe('Working directory for the command')
      .optional(),
  }),
  execute: async ({ command, cwd }) => {
    try {
      const { stdout, stderr } = await execFileAsync('sh', ['-c', command], {
        cwd: cwd ?? process.cwd(),
        timeout: TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
      return { exitCode: 0, stdout, stderr };
    } catch (err: unknown) {
      const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
      return {
        exitCode: e.code ?? 1,
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? e.message ?? 'Unknown error',
      };
    }
  },
});
