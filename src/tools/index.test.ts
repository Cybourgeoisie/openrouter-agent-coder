import { describe, it, expect } from 'vitest';
import {
  allTools,
  readFileTool,
  writeFileTool,
  editFileTool,
  listDirectoryTool,
  runCommandTool,
  grepFilesTool,
  globTool,
  askUserQuestionTool,
} from './index.js';

describe('tools barrel', () => {
  it('exports all eight tools', () => {
    expect(allTools()).toHaveLength(8);
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
      'glob',
      'ask_user_question',
    ]);
  });

  it('re-exports individual tool factories', () => {
    expect(readFileTool().function.name).toBe('read_file');
    expect(writeFileTool().function.name).toBe('write_file');
    expect(editFileTool().function.name).toBe('edit_file');
    expect(listDirectoryTool().function.name).toBe('list_directory');
    expect(runCommandTool().function.name).toBe('run_command');
    expect(grepFilesTool().function.name).toBe('grep_files');
    expect(globTool().function.name).toBe('glob');
    expect(askUserQuestionTool().function.name).toBe('ask_user_question');
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
    // Every client tool's execute should reject (or resolve to a cancellation
    // payload for the well-behaved ones) once the signal aborts.
    for (const t of tools) {
      const exec = (
        t.function as { execute: (params: Record<string, unknown>) => Promise<unknown> | unknown }
      ).execute;
      // Provide a benign-enough input; the abort check runs before any IO.
      const candidate = exec(
        t.function.name === 'run_command'
          ? { command: 'true' }
          : t.function.name === 'ask_user_question'
            ? { question: 'q?', options: [{ label: 'A' }, { label: 'B' }] }
            : t.function.name === 'list_directory' ||
                t.function.name === 'grep_files' ||
                t.function.name === 'glob'
              ? { path: '.', pattern: 'x', file_glob: '*', case_sensitive: true }
              : { path: 'nonexistent', old_string: 'a', new_string: 'b', content: '' },
      );
      if (t.function.name === 'run_command') {
        // run_command resolves with an error result rather than throwing.
        await expect(candidate).resolves.toMatchObject({ exitCode: 1 });
      } else if (t.function.name === 'ask_user_question') {
        await expect(candidate).resolves.toEqual({ error: 'aborted' });
      } else {
        await expect(candidate).rejects.toThrow(/cancelled/);
      }
    }
  });

  it('allTools forwards onAskUserQuestion into the ask_user_question factory', async () => {
    let received: unknown;
    const tools = allTools(
      { cwd: '.' },
      {
        onAskUserQuestion: async (req) => {
          received = req;
          return { questionId: req.questionId, selectedOptionId: 'a' };
        },
      },
    );
    const ask = tools.find((t) => t.function.name === 'ask_user_question')!;
    const exec = (
      ask.function as { execute: (params: Record<string, unknown>) => Promise<unknown> }
    ).execute;
    const result = await exec({
      question: 'pick',
      options: [{ label: 'X' }, { label: 'Y' }],
    });
    expect(received).toMatchObject({ question: 'pick' });
    expect(result).toEqual({ selectedOptionId: 'a', label: 'X' });
  });
});
