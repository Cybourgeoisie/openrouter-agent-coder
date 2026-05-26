import { tool } from '@openrouter/agent';
import { z } from 'zod/v4';
import { randomUUID } from 'node:crypto';
import { DEFAULT_TOOL_CONTEXT } from './context.js';
const TASK_STATES = ['pending', 'in_progress', 'completed', 'cancelled'];
function snapshot(ref) {
    return ref.tasks.map((t) => ({ ...t }));
}
export function taskCreateTool(ctx = DEFAULT_TOOL_CONTEXT, opts = {}) {
    const taskListRef = opts.taskListRef ?? { tasks: [] };
    return tool({
        name: 'task_create',
        description: "Add a task to the agent's in-run task list. Use to track multi-step work the user/host should see progress on. Returns `{ id }` (UUID). The full latest list is emitted via the `Notification` hook (level=info, message=tasks_changed) and via the optional `onTasksChanged` callback.",
        inputSchema: z.object({
            content: z.string().describe('Imperative task description (e.g. "Run tests"). Required.'),
            activeForm: z
                .string()
                .describe('Optional present-continuous form shown while the task is in_progress (e.g. "Running tests").')
                .optional(),
        }),
        execute: async ({ content, activeForm }, execCtx) => {
            // Prefer the SDK-injected ctx.notify (set up by wrapToolWithHooks); fall
            // back to factory-time ctx.notify for unit-test ergonomics. Mirrors the
            // pattern in ask-user-question.ts.
            const notify = execCtx?.notify ?? ctx.notify;
            const id = randomUUID();
            const task = {
                id,
                content,
                state: 'pending',
                ...(activeForm !== undefined ? { activeForm } : {}),
            };
            taskListRef.tasks.push(task);
            const tasks = snapshot(taskListRef);
            await notify?.('info', 'tasks_changed', { tasks });
            opts.onTasksChanged?.(tasks);
            return { id };
        },
    });
}
export function taskUpdateTool(ctx = DEFAULT_TOOL_CONTEXT, opts = {}) {
    const taskListRef = opts.taskListRef ?? { tasks: [] };
    return tool({
        name: 'task_update',
        description: "Update an existing task in the agent's in-run task list. Sets its state (pending/in_progress/completed/cancelled) and optionally rewrites `content`. Returns `{}` on success or `{ error: 'unknown task id: <id>' }` when the id is not in the list. The full latest list is emitted via the `Notification` hook (level=info, message=tasks_changed) and via the optional `onTasksChanged` callback.",
        inputSchema: z.object({
            taskId: z.string().describe('Id returned by a previous task_create call.'),
            state: z
                .enum(TASK_STATES)
                .describe('New task state: pending / in_progress / completed / cancelled.'),
            content: z
                .string()
                .describe('Optional new content for the task. Only applied when provided.')
                .optional(),
        }),
        execute: async ({ taskId, state, content }, execCtx) => {
            const notify = execCtx?.notify ?? ctx.notify;
            const idx = taskListRef.tasks.findIndex((t) => t.id === taskId);
            if (idx === -1) {
                return { error: `unknown task id: ${taskId}` };
            }
            const existing = taskListRef.tasks[idx];
            taskListRef.tasks[idx] = {
                ...existing,
                state,
                ...(content !== undefined ? { content } : {}),
            };
            const tasks = snapshot(taskListRef);
            await notify?.('info', 'tasks_changed', { tasks });
            opts.onTasksChanged?.(tasks);
            return {};
        },
    });
}
//# sourceMappingURL=tasks.js.map