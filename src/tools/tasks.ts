import { tool } from '@openrouter/agent';
import { z } from 'zod/v4';
import { randomUUID } from 'node:crypto';
import { DEFAULT_TOOL_CONTEXT, type ToolContext } from './context.js';

/**
 * Lifecycle state a task can be in. The four-state enum mirrors the host-UI
 * contract: tasks start `pending`, move to `in_progress` when the agent picks
 * them up, and end in `completed` or `cancelled`.
 */
export type TaskState = 'pending' | 'in_progress' | 'completed' | 'cancelled';

const TASK_STATES = ['pending', 'in_progress', 'completed', 'cancelled'] as const;

/** A single entry in the in-run task list. */
export interface Task {
  id: string;
  content: string;
  state: TaskState;
  activeForm?: string;
}

/** Model-supplied input to `task_create`. */
export interface CreateTaskRequest {
  content: string;
  activeForm?: string;
}

/** Model-supplied input to `task_update`. */
export interface UpdateTaskRequest {
  taskId: string;
  state: TaskState;
  content?: string;
}

/**
 * Notification payload pushed on every successful `task_create` /
 * `task_update`. Subscribers receive the full latest task list (not a diff).
 */
export interface TaskListChangedNotification {
  tasks: Task[];
}

/**
 * Convenience callback fired on every mutation with the full latest list.
 * Equivalent to filtering `Notification` hook events on
 * `message === 'tasks_changed'`.
 */
export type OnTasksChanged = (tasks: Task[]) => void;

/**
 * Shared, run-scoped container holding the task list both factories mutate.
 * The agent stashes a single instance and passes it to both factories so they
 * read/write the same array across turns.
 */
export interface TaskListRef {
  tasks: Task[];
}

export interface TaskToolOptions {
  /** Shared task list both factories mutate. Defaults to a fresh empty list. */
  taskListRef?: TaskListRef;
  /** Convenience callback fired on every mutation with the full latest list. */
  onTasksChanged?: OnTasksChanged;
}

export interface TaskCreateToolResult {
  id: string;
}

export interface TaskUpdateToolResult {
  error?: string;
}

function snapshot(ref: TaskListRef): Task[] {
  return ref.tasks.map((t) => ({ ...t }));
}

export function taskCreateTool(
  ctx: ToolContext = DEFAULT_TOOL_CONTEXT,
  opts: TaskToolOptions = {},
) {
  const taskListRef = opts.taskListRef ?? { tasks: [] };
  return tool({
    name: 'task_create',
    description:
      "Add a task to the agent's in-run task list. Use to track multi-step work the user/host should see progress on. Returns `{ id }` (UUID). The full latest list is emitted via the `Notification` hook (level=info, message=tasks_changed) and via the optional `onTasksChanged` callback.",
    inputSchema: z.object({
      content: z.string().describe('Imperative task description (e.g. "Run tests"). Required.'),
      activeForm: z
        .string()
        .describe(
          'Optional present-continuous form shown while the task is in_progress (e.g. "Running tests").',
        )
        .optional(),
    }),
    execute: async ({ content, activeForm }, execCtx): Promise<TaskCreateToolResult> => {
      // Prefer the SDK-injected ctx.notify (set up by wrapToolWithHooks); fall
      // back to factory-time ctx.notify for unit-test ergonomics. Mirrors the
      // pattern in ask-user-question.ts.
      const notify =
        (execCtx as { notify?: ToolContext['notify'] } | undefined)?.notify ?? ctx.notify;

      const id = randomUUID();
      const task: Task = {
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

export function taskUpdateTool(
  ctx: ToolContext = DEFAULT_TOOL_CONTEXT,
  opts: TaskToolOptions = {},
) {
  const taskListRef = opts.taskListRef ?? { tasks: [] };
  return tool({
    name: 'task_update',
    description:
      "Update an existing task in the agent's in-run task list. Sets its state (pending/in_progress/completed/cancelled) and optionally rewrites `content`. Returns `{}` on success or `{ error: 'unknown task id: <id>' }` when the id is not in the list. The full latest list is emitted via the `Notification` hook (level=info, message=tasks_changed) and via the optional `onTasksChanged` callback.",
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
    execute: async ({ taskId, state, content }, execCtx): Promise<TaskUpdateToolResult> => {
      const notify =
        (execCtx as { notify?: ToolContext['notify'] } | undefined)?.notify ?? ctx.notify;

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
