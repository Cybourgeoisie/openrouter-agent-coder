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
  'glob',
] as const;

interface ModeCase {
  mode: PermissionMode;
  allowed: readonly string[];
  denied: readonly string[];
  denyReason: string;
}

const PLAN_DENY_REASON = 'plan mode: read-only — propose edits in your reply';

const CASES: readonly ModeCase[] = [
  {
    mode: 'default',
    allowed: ['read_file', 'list_directory', 'grep_files', 'glob'],
    denied: ['write_file', 'edit_file', 'run_command'],
    denyReason: 'requires approval',
  },
  {
    mode: 'acceptEdits',
    allowed: ['read_file', 'list_directory', 'grep_files', 'glob', 'write_file', 'edit_file'],
    denied: ['run_command'],
    denyReason: 'requires approval',
  },
  {
    mode: 'plan',
    allowed: ['read_file', 'list_directory', 'grep_files', 'glob'],
    denied: ['write_file', 'edit_file', 'run_command'],
    denyReason: PLAN_DENY_REASON,
  },
  {
    mode: 'bypassPermissions',
    allowed: [...ALL_TOOLS],
    denied: [],
    // bypassPermissions never denies — the reason is unused. Kept for type uniformity.
    denyReason: '',
  },
];

describe('permissionModeToCanUseTool', () => {
  for (const { mode, allowed, denied, denyReason } of CASES) {
    describe(`mode: ${mode}`, () => {
      const gate = permissionModeToCanUseTool(mode);

      for (const tool of allowed) {
        it(`allows ${tool}`, async () => {
          const result = await gate(tool, {});
          expect(result.behavior).toBe('allow');
        });
      }

      for (const tool of denied) {
        it(`denies ${tool} with reason "${denyReason}"`, async () => {
          const result = await gate(tool, {});
          expect(result).toEqual<CanUseToolResult>({
            behavior: 'deny',
            reason: denyReason,
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

  it('plan mode surfaces the plan-specific deny reason rather than the generic one', async () => {
    const planGate = permissionModeToCanUseTool('plan');
    const result = await planGate('write_file', {});
    expect(result).toEqual<CanUseToolResult>({
      behavior: 'deny',
      reason: PLAN_DENY_REASON,
    });
  });

  it('plan mode permits the glob tool (Phase 3.11 — pure read operation)', async () => {
    const planGate = permissionModeToCanUseTool('plan');
    const result = await planGate('glob', {});
    expect(result).toEqual<CanUseToolResult>({ behavior: 'allow' });
  });

  it('default mode denies unknown / custom tool names', async () => {
    const gate = permissionModeToCanUseTool('default');
    const result = await gate('custom_tool_not_in_set', {});
    expect(result).toEqual<CanUseToolResult>({
      behavior: 'deny',
      reason: 'requires approval',
    });
  });

  it('plan mode denies unknown / custom tool names with the plan-specific reason', async () => {
    const gate = permissionModeToCanUseTool('plan');
    const result = await gate('custom_tool_not_in_set', {});
    expect(result).toEqual<CanUseToolResult>({
      behavior: 'deny',
      reason: PLAN_DENY_REASON,
    });
  });

  it('bypassPermissions mode allows unknown / custom tool names', async () => {
    const gate = permissionModeToCanUseTool('bypassPermissions');
    const result = await gate('custom_tool_not_in_set', {});
    expect(result.behavior).toBe('allow');
  });
});
