import type { Tool } from '@openrouter/agent';
import { readFileTool } from './read-file.js';
import { writeFileTool } from './write-file.js';
import { editFileTool } from './edit-file.js';
import { listDirectoryTool } from './list-directory.js';
import { runCommandTool } from './run-command.js';
import { grepFilesTool } from './grep-files.js';
import { globTool } from './glob.js';
import { askUserQuestionTool, type AskUserQuestionToolOptions } from './ask-user-question.js';
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
export { SERVER_TOOLS, createServerToolsHooks } from './server-tools.js';
export { DEFAULT_TOOL_CONTEXT } from './context.js';
export type { ToolContext } from './context.js';

/**
 * Options accepted by {@link allTools} when constructing the bundled tool set.
 * Currently only carries the `onAskUserQuestion` host callback used by the
 * `ask_user_question` tool.
 */
export interface AllToolsOptions {
  /** Host callback for the `ask_user_question` tool; see {@link AskUserQuestionToolOptions}. */
  onAskUserQuestion?: AskUserQuestionToolOptions['onAskUserQuestion'];
}

/**
 * Build the default set of client tools bound to a {@link ToolContext}. Each
 * tool factory checks `ctx.signal` on entry and resolves relative path inputs
 * against `ctx.cwd`. `run_command` additionally propagates SIGTERM (with a
 * 250ms SIGKILL grace) to its child process. `ask_user_question` requires
 * `opts.onAskUserQuestion` — without it the tool surfaces a
 * `no host handler registered` error from its result.
 */
export function allTools(
  ctx: ToolContext = DEFAULT_TOOL_CONTEXT,
  opts: AllToolsOptions = {},
): readonly Tool[] {
  return [
    readFileTool(ctx),
    writeFileTool(ctx),
    editFileTool(ctx),
    listDirectoryTool(ctx),
    runCommandTool(ctx),
    grepFilesTool(ctx),
    globTool(ctx),
    askUserQuestionTool(ctx, { onAskUserQuestion: opts.onAskUserQuestion }),
  ];
}
