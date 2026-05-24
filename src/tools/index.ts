import type { Tool } from '@openrouter/agent';
import { readFileTool } from './read-file.js';
import { writeFileTool } from './write-file.js';
import { editFileTool } from './edit-file.js';
import { listDirectoryTool } from './list-directory.js';
import { runCommandTool } from './run-command.js';
import { grepFilesTool } from './grep-files.js';
import { globTool } from './glob.js';
import { askUserQuestionTool, type AskUserQuestionToolOptions } from './ask-user-question.js';
import { taskCreateTool, taskUpdateTool, type OnTasksChanged, type TaskListRef } from './tasks.js';
import { editNotebookTool } from './edit-notebook.js';
import { monitorTool } from './monitor.js';
import { spawnSubagentTool, type SpawnSubagentToolOptions } from './spawn-subagent.js';
import { DEFAULT_TOOL_CONTEXT, type ToolContext } from './context.js';

export { readFileTool } from './read-file.js';
export { writeFileTool } from './write-file.js';
export { editFileTool } from './edit-file.js';
export { listDirectoryTool } from './list-directory.js';
export { runCommandTool } from './run-command.js';
export { grepFilesTool } from './grep-files.js';
export { globTool } from './glob.js';
export { askUserQuestionTool } from './ask-user-question.js';
export type {
  AskUserQuestionToolOptions,
  AskUserQuestionToolResult,
  OnAskUserQuestion,
  UserQuestionRequest,
  UserQuestionResponse,
} from './ask-user-question.js';
export { taskCreateTool, taskUpdateTool } from './tasks.js';
export { editNotebookTool } from './edit-notebook.js';
export type {
  EditNotebookResult,
  EditNotebookSuccess,
  EditNotebookError,
} from './edit-notebook.js';
export { monitorTool } from './monitor.js';
export type { MonitorResult, MonitorLine, MonitorError } from './monitor.js';
export { spawnSubagentTool, DEFAULT_MAX_SUBAGENT_DEPTH } from './spawn-subagent.js';
export type {
  SpawnSubagentToolOptions,
  SpawnSubagentToolResult,
  SubagentRunConfig,
  SubagentRunResult,
  SubagentRunner,
  SubagentLifecycleEmitter,
} from './spawn-subagent.js';
export type {
  TaskState,
  Task,
  CreateTaskRequest,
  UpdateTaskRequest,
  TaskListChangedNotification,
  OnTasksChanged,
  TaskListRef,
  TaskToolOptions,
  TaskCreateToolResult,
  TaskUpdateToolResult,
} from './tasks.js';
export { SERVER_TOOLS, createServerToolsHooks } from './server-tools.js';
export { DEFAULT_TOOL_CONTEXT } from './context.js';
export type { ToolContext } from './context.js';

/**
 * Options accepted by {@link allTools} when constructing the bundled tool set.
 * Carries host callbacks for the interactive tools (`ask_user_question`,
 * `task_create` / `task_update`) plus the shared in-run task list ref so both
 * task factories mutate the same array.
 */
export interface AllToolsOptions {
  /** Host callback for the `ask_user_question` tool; see {@link AskUserQuestionToolOptions}. */
  onAskUserQuestion?: AskUserQuestionToolOptions['onAskUserQuestion'];
  /**
   * Convenience callback fired after every `task_create` / `task_update`
   * mutation with the full latest task list. Filtering the `Notification`
   * hook on `message === 'tasks_changed'` is equivalent.
   */
  onTasksChanged?: OnTasksChanged;
  /**
   * Shared task list both task factories mutate. Pass the same ref across
   * runs of {@link allTools} if you want a persistent list; omit to get a
   * fresh empty list per call.
   */
  taskListRef?: TaskListRef;
  /**
   * Opt-in {@link spawnSubagentTool} configuration. When omitted, the
   * `spawn_subagent` tool is **NOT** included in the default bundle —
   * subagent spawning stays an explicit, host-wired feature (mirrors
   * `OpenRouterAgentRun({ enableSubagents: true })`, which threads the
   * options struct in for the caller). Supply this to add the tool;
   * the factory needs the parent's `runSubagent` closure to drive a
   * child `OpenRouterAgentRun`. See {@link SpawnSubagentToolOptions}.
   */
  spawnSubagent?: SpawnSubagentToolOptions;
}

/**
 * Build the default set of client tools bound to a {@link ToolContext}. Each
 * tool factory checks `ctx.signal` on entry and resolves relative path inputs
 * against `ctx.cwd`. `run_command` additionally propagates SIGTERM (with a
 * 250ms SIGKILL grace) to its child process. `ask_user_question` requires
 * `opts.onAskUserQuestion` — without it the tool surfaces a
 * `no host handler registered` error from its result. `task_create` /
 * `task_update` share a single `taskListRef` (auto-created here when the
 * caller omits one).
 */
export function allTools(
  ctx: ToolContext = DEFAULT_TOOL_CONTEXT,
  opts: AllToolsOptions = {},
): readonly Tool[] {
  const taskListRef = opts.taskListRef ?? { tasks: [] };
  const tools: Tool[] = [
    readFileTool(ctx),
    writeFileTool(ctx),
    editFileTool(ctx),
    listDirectoryTool(ctx),
    runCommandTool(ctx),
    grepFilesTool(ctx),
    globTool(ctx),
    askUserQuestionTool(ctx, { onAskUserQuestion: opts.onAskUserQuestion }),
    taskCreateTool(ctx, { taskListRef, onTasksChanged: opts.onTasksChanged }),
    taskUpdateTool(ctx, { taskListRef, onTasksChanged: opts.onTasksChanged }),
    editNotebookTool(ctx),
    monitorTool(ctx),
  ];
  if (opts.spawnSubagent !== undefined) {
    tools.push(spawnSubagentTool(opts.spawnSubagent, ctx));
  }
  return tools;
}
