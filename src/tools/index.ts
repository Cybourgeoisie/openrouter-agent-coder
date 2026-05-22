import type { Tool } from '@openrouter/agent';
import { readFileTool } from './read-file.js';
import { writeFileTool } from './write-file.js';
import { editFileTool } from './edit-file.js';
import { listDirectoryTool } from './list-directory.js';
import { runCommandTool } from './run-command.js';
import { grepFilesTool } from './grep-files.js';

export { readFileTool } from './read-file.js';
export { writeFileTool } from './write-file.js';
export { editFileTool } from './edit-file.js';
export { listDirectoryTool } from './list-directory.js';
export { runCommandTool } from './run-command.js';
export { grepFilesTool } from './grep-files.js';
export { SERVER_TOOLS, createServerToolsHooks } from './server-tools.js';

/**
 * Build the default set of client tools wired to a single AbortSignal.
 * Each tool factory checks the signal on entry; `run_command` additionally
 * propagates SIGTERM (with a 250ms SIGKILL grace) to its child process.
 */
export function allTools(signal?: AbortSignal): readonly Tool[] {
  return [
    readFileTool(signal),
    writeFileTool(signal),
    editFileTool(signal),
    listDirectoryTool(signal),
    runCommandTool(signal),
    grepFilesTool(signal),
  ];
}
