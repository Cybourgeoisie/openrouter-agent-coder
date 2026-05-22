import { describe, it, expect } from 'vitest';
import { runCommandTool } from './run-command.js';

const tool = runCommandTool();
const execute = tool.function.execute as (params: {
  command: string;
  cwd?: string;
}) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

describe('run_command tool', () => {
  it('has correct name', () => {
    expect(tool.function.name).toBe('run_command');
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

  it('appends "run_command cancelled" when aborted mid-execution', async () => {
    const controller = new AbortController();
    const cancelTool = runCommandTool({ cwd: '.', signal: controller.signal });
    const cancelExecute = cancelTool.function.execute as (params: {
      command: string;
    }) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

    setTimeout(() => controller.abort(), 50);
    const result = await cancelExecute({ command: "printf 'oops' >&2; sleep 5" });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('run_command cancelled');
    expect(result.stderr).toMatch(/oops\nrun_command cancelled$/);
  });

  it('appends "terminated by SIGTERM" when the child is killed by a signal', async () => {
    const result = await execute({ command: "printf 'before' >&2; kill -TERM $$" });
    expect(result.stderr).toContain('terminated by SIGTERM');
    expect(result.stderr).toMatch(/before\nterminated by SIGTERM$/);
  });

  it('appends "terminated by SIGKILL" when the child is killed by SIGKILL', async () => {
    const result = await execute({ command: 'kill -KILL $$' });
    expect(result.stderr).toContain('terminated by SIGKILL');
  });

  it('emits stderr from the error handler when spawn fails', async () => {
    const errTool = runCommandTool({ cwd: '/nonexistent-xyz-9999-claude-test' });
    const errExecute = errTool.function.execute as (params: {
      command: string;
    }) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
    const result = await errExecute({ command: 'echo hi' });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBeTruthy();
  });

  it('cancels with empty stderr (no suffix prepended)', async () => {
    const controller = new AbortController();
    const cancelTool = runCommandTool({ cwd: '.', signal: controller.signal });
    const cancelExecute = cancelTool.function.execute as (params: {
      command: string;
    }) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

    setTimeout(() => controller.abort(), 50);
    const result = await cancelExecute({ command: 'sleep 5' });

    expect(result.stderr).toBe('run_command cancelled');
  });

  it('appends signal marker without extra newline when stderr already ends with one', async () => {
    const result = await execute({ command: "printf 'line\\n' >&2; kill -TERM $$" });
    expect(result.stderr).toMatch(/line\nterminated by SIGTERM$/);
    expect(result.stderr).not.toMatch(/line\n\nterminated/);
  });

  it('caps stdout and stderr at 1MB each', async () => {
    const result = await execute({
      command:
        'node -e "for(let i=0;i<150;i++){process.stdout.write(\\"x\\".repeat(10000));process.stderr.write(\\"y\\".repeat(10000));}"',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeLessThanOrEqual(1024 * 1024 + 65536);
    expect(result.stderr.length).toBeLessThanOrEqual(1024 * 1024 + 65536);
  });

  it('handles signals other than SIGTERM/SIGKILL via the default close path', async () => {
    const result = await execute({ command: 'kill -HUP $$' });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain('terminated by');
    expect(result.stderr).not.toContain('run_command cancelled');
  });

  it('returns early when signal is already aborted before spawn', async () => {
    const controller = new AbortController();
    controller.abort();
    const abortedTool = runCommandTool({ cwd: '.', signal: controller.signal });
    const abortedExecute = abortedTool.function.execute as (params: {
      command: string;
    }) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
    const result = await abortedExecute({ command: 'echo hi' });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('run_command cancelled before start');
  });
});
