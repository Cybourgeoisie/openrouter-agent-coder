import { describe, it, expect } from 'vitest';
import {
  allTools,
  readFileTool,
  writeFileTool,
  editFileTool,
  listDirectoryTool,
  runCommandTool,
  grepFilesTool,
} from './index.js';

describe('tools barrel', () => {
  it('exports all six tools', () => {
    expect(allTools()).toHaveLength(6);
  });

  it('includes every tool by name', () => {
    const names = allTools().map((t) => t.function.name);
    expect(names).toEqual([
      'read_file',
      'write_file',
      'edit_file',
      'list_directory',
      'run_command',
      'grep_files',
    ]);
  });

  it('re-exports individual tool factories', () => {
    expect(readFileTool().function.name).toBe('read_file');
    expect(writeFileTool().function.name).toBe('write_file');
    expect(editFileTool().function.name).toBe('edit_file');
    expect(listDirectoryTool().function.name).toBe('list_directory');
    expect(runCommandTool().function.name).toBe('run_command');
    expect(grepFilesTool().function.name).toBe('grep_files');
  });

  it('all tools have execute functions', () => {
    for (const t of allTools()) {
      const fn = (t.function as { execute?: unknown }).execute;
      expect(typeof fn).toBe('function');
    }
  });

  it('all tools have descriptions', () => {
    for (const t of allTools()) {
      expect(t.function.description).toBeTruthy();
    }
  });

  it('passes the same signal to every tool factory in the bundle', async () => {
    const ctrl = new AbortController();
    const tools = allTools({ cwd: '.', signal: ctrl.signal });
    ctrl.abort();
    // Every client tool's execute should reject promptly once the signal aborts.
    for (const t of tools) {
      const exec = (
        t.function as { execute: (params: Record<string, unknown>) => Promise<unknown> | unknown }
      ).execute;
      // Provide a benign-enough input; the abort check runs before any IO.
      const candidate = exec(
        t.function.name === 'run_command'
          ? { command: 'true' }
          : t.function.name === 'list_directory' || t.function.name === 'grep_files'
            ? { path: '.', pattern: 'x', file_glob: '*', case_sensitive: true }
            : { path: 'nonexistent', old_string: 'a', new_string: 'b', content: '' },
      );
      if (t.function.name === 'run_command') {
        // run_command resolves with an error result rather than throwing.
        await expect(candidate).resolves.toMatchObject({ exitCode: 1 });
      } else {
        await expect(candidate).rejects.toThrow(/cancelled/);
      }
    }
  });
});
