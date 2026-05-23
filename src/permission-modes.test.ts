import { describe, it, expect } from 'vitest';
import { permissionModeToCanUseTool, type PermissionMode } from './permission-modes.js';
import type { CanUseToolResult } from './agent.js';

const ALL_TOOLS = [
  'read_file',
  'write_file',
  'edit_file',
  'list_directory',
  'run_command',
  'grep_files',
] as const;

interface ModeCase {
  mode: PermissionMode;
  allowed: readonly string[];
  denied: readonly string[];
}

const CASES: readonly ModeCase[] = [
  {
    mode: 'default',
    allowed: ['read_file', 'list_directory', 'grep_files'],
    denied: ['write_file', 'edit_file', 'run_command'],
  },
  {
    mode: 'acceptEdits',
    allowed: ['read_file', 'list_directory', 'grep_files', 'write_file', 'edit_file'],
    denied: ['run_command'],
  },
  {
    mode: 'plan',
    allowed: ['read_file', 'list_directory', 'grep_files'],
    denied: ['write_file', 'edit_file', 'run_command'],
  },
  {
    mode: 'bypassPermissions',
    allowed: [...ALL_TOOLS],
    denied: [],
  },
];

describe('permissionModeToCanUseTool', () => {
  for (const { mode, allowed, denied } of CASES) {
    describe(`mode: ${mode}`, () => {
      const gate = permissionModeToCanUseTool(mode);

      for (const tool of allowed) {
        it(`allows ${tool}`, async () => {
          const result = await gate(tool, {});
          expect(result.behavior).toBe('allow');
        });
      }

      for (const tool of denied) {
        it(`denies ${tool} with reason "requires approval"`, async () => {
          const result = await gate(tool, {});
          expect(result).toEqual<CanUseToolResult>({
            behavior: 'deny',
            reason: 'requires approval',
          });
        });
      }
    });
  }

  it('plan mode denies the same edit-style tools that acceptEdits would allow', async () => {
    const planGate = permissionModeToCanUseTool('plan');
    for (const tool of ['write_file', 'edit_file']) {
      const result = await planGate(tool, {});
      expect(result.behavior).toBe('deny');
    }
  });

  it('default mode denies unknown / custom tool names', async () => {
    const gate = permissionModeToCanUseTool('default');
    const result = await gate('custom_tool_not_in_set', {});
    expect(result).toEqual<CanUseToolResult>({
      behavior: 'deny',
      reason: 'requires approval',
    });
  });

  it('bypassPermissions mode allows unknown / custom tool names', async () => {
    const gate = permissionModeToCanUseTool('bypassPermissions');
    const result = await gate('custom_tool_not_in_set', {});
    expect(result.behavior).toBe('allow');
  });
});
