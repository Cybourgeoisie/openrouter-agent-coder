import { describe, it, expect } from 'vitest';
import {
  allTools,
  readFileTool,
  writeFileTool,
  editFileTool,
  listDirectoryTool,
  runCommandTool,
} from './index.js';

describe('tools barrel', () => {
  it('exports all five tools', () => {
    expect(allTools).toHaveLength(5);
  });

  it('includes every tool by name', () => {
    const names = allTools.map((t) => t.function.name);
    expect(names).toEqual([
      'read_file',
      'write_file',
      'edit_file',
      'list_directory',
      'run_command',
    ]);
  });

  it('re-exports individual tools', () => {
    expect(readFileTool.function.name).toBe('read_file');
    expect(writeFileTool.function.name).toBe('write_file');
    expect(editFileTool.function.name).toBe('edit_file');
    expect(listDirectoryTool.function.name).toBe('list_directory');
    expect(runCommandTool.function.name).toBe('run_command');
  });

  it('all tools have execute functions', () => {
    for (const tool of allTools) {
      expect(typeof tool.function.execute).toBe('function');
    }
  });

  it('all tools have descriptions', () => {
    for (const tool of allTools) {
      expect(tool.function.description).toBeTruthy();
    }
  });
});
