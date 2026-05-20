import { describe, it, expect } from 'vitest';
import { runCommandTool } from './run-command.js';

const execute = runCommandTool.function.execute as (params: {
  command: string;
  cwd?: string;
}) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

describe('run_command tool', () => {
  it('has correct name', () => {
    expect(runCommandTool.function.name).toBe('run_command');
  });

  it('runs a command and returns stdout', async () => {
    const result = await execute({ command: 'echo hello' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
  });

  it('captures stderr', async () => {
    const result = await execute({ command: 'echo err >&2' });
    expect(result.stderr.trim()).toBe('err');
  });

  it('returns non-zero exit code on failure', async () => {
    const result = await execute({ command: 'exit 42' });
    expect(result.exitCode).not.toBe(0);
  });

  it('respects cwd parameter', async () => {
    const result = await execute({ command: 'pwd', cwd: '/tmp' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/\/tmp|\/private\/tmp/);
  });

  it('handles commands with pipes', async () => {
    const result = await execute({ command: 'echo "a b c" | wc -w' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('3');
  });
});
