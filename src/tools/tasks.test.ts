import { describe, it, expect, vi } from 'vitest';
import {
  taskCreateTool,
  taskUpdateTool,
  type Task,
  type TaskListRef,
  type TaskCreateToolResult,
  type TaskUpdateToolResult,
} from './tasks.js';

interface CreateParams {
  content: string;
  activeForm?: string;
}
interface UpdateParams {
  taskId: string;
  state: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  content?: string;
}

function makeCreate(
  ctx: Parameters<typeof taskCreateTool>[0] = { cwd: '.' },
  opts: Parameters<typeof taskCreateTool>[1] = {},
): (p: CreateParams) => Promise<TaskCreateToolResult> {
  const t = taskCreateTool(ctx, opts);
  return t.function.execute as (p: CreateParams) => Promise<TaskCreateToolResult>;
}
function makeUpdate(
  ctx: Parameters<typeof taskUpdateTool>[0] = { cwd: '.' },
  opts: Parameters<typeof taskUpdateTool>[1] = {},
): (p: UpdateParams) => Promise<TaskUpdateToolResult> {
  const t = taskUpdateTool(ctx, opts);
  return t.function.execute as (p: UpdateParams) => Promise<TaskUpdateToolResult>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type NotifyFn = (
  level: 'info' | 'warn' | 'error',
  message: string,
  context?: unknown,
) => Promise<void>;
function makeNotify(): ReturnType<typeof vi.fn<NotifyFn>> {
  return vi.fn<NotifyFn>(async () => undefined);
}

describe('task_create tool', () => {
  it('has correct name and description', () => {
    const t = taskCreateTool();
    expect(t.function.name).toBe('task_create');
    expect(t.function.description).toMatch(/task/i);
  });

  it('appends a task to the shared list, returns a UUID id, and fires Notification with the full list', async () => {
    const ref: TaskListRef = { tasks: [] };
    const notify = makeNotify();
    const create = makeCreate({ cwd: '.', notify }, { taskListRef: ref });

    const result = await create({ content: 'Implement feature X', activeForm: 'Implementing X' });

    expect(result.id).toMatch(UUID_RE);
    expect(ref.tasks).toHaveLength(1);
    expect(ref.tasks[0]).toEqual({
      id: result.id,
      content: 'Implement feature X',
      state: 'pending',
      activeForm: 'Implementing X',
    });

    expect(notify).toHaveBeenCalledTimes(1);
    const [level, message, context] = notify.mock.calls[0];
    expect(level).toBe('info');
    expect(message).toBe('tasks_changed');
    expect(context).toEqual({
      tasks: [
        {
          id: result.id,
          content: 'Implement feature X',
          state: 'pending',
          activeForm: 'Implementing X',
        },
      ],
    });
  });

  it('omits activeForm when the input did not supply one', async () => {
    const ref: TaskListRef = { tasks: [] };
    const create = makeCreate({ cwd: '.' }, { taskListRef: ref });

    await create({ content: 'no active form' });

    expect(ref.tasks[0]).not.toHaveProperty('activeForm');
    expect(ref.tasks[0].state).toBe('pending');
  });

  it('fires onTasksChanged with a defensive snapshot (mutating it does not affect the ref)', async () => {
    const ref: TaskListRef = { tasks: [] };
    let received: Task[] | null = null;
    const create = makeCreate(
      { cwd: '.' },
      {
        taskListRef: ref,
        onTasksChanged: (tasks) => {
          received = tasks;
        },
      },
    );

    await create({ content: 'task 1' });

    expect(received).not.toBeNull();
    expect(received!).toHaveLength(1);
    // The snapshot must be a new array — mutating it must not corrupt the ref.
    received!.push({
      id: 'fake',
      content: 'injected',
      state: 'pending',
    });
    expect(ref.tasks).toHaveLength(1);
    // And the entries themselves are shallow copies.
    received![0].content = 'mutated';
    expect(ref.tasks[0].content).toBe('task 1');
  });

  it('prefers the SDK-injected execCtx.notify over the factory-time ctx.notify', async () => {
    const ref: TaskListRef = { tasks: [] };
    const factoryNotify = makeNotify();
    const sdkNotify = makeNotify();
    const t = taskCreateTool({ cwd: '.', notify: factoryNotify }, { taskListRef: ref });
    const exec = t.function.execute as unknown as (
      input: CreateParams,
      ctx: { notify: typeof sdkNotify },
    ) => Promise<TaskCreateToolResult>;

    await exec({ content: 'pick sdk notify' }, { notify: sdkNotify });

    expect(sdkNotify).toHaveBeenCalledTimes(1);
    expect(factoryNotify).not.toHaveBeenCalled();
  });

  it('still resolves cleanly when no notify and no onTasksChanged are wired', async () => {
    const ref: TaskListRef = { tasks: [] };
    const create = makeCreate({ cwd: '.' }, { taskListRef: ref });
    const result = await create({ content: 'silent' });
    expect(result.id).toMatch(UUID_RE);
    expect(ref.tasks).toHaveLength(1);
  });

  it('defaults to a fresh empty TaskListRef when one is not supplied', async () => {
    const create = makeCreate();
    const result = await create({ content: 'standalone' });
    expect(result.id).toMatch(UUID_RE);
  });

  it('rejects a non-string content at the schema level', () => {
    const t = taskCreateTool();
    const inputSchema = (
      t.function as unknown as { inputSchema: { safeParse: (i: unknown) => { success: boolean } } }
    ).inputSchema;
    expect(inputSchema.safeParse({ content: 123 }).success).toBe(false);
  });
});

describe('task_update tool', () => {
  it('has correct name and description', () => {
    const t = taskUpdateTool();
    expect(t.function.name).toBe('task_update');
    expect(t.function.description).toMatch(/update/i);
  });

  it('updates state on an existing task and emits Notification with the full latest list', async () => {
    const ref: TaskListRef = { tasks: [] };
    const notify = makeNotify();
    const create = makeCreate({ cwd: '.', notify }, { taskListRef: ref });
    const update = makeUpdate({ cwd: '.', notify }, { taskListRef: ref });

    const { id } = await create({ content: 'task A' });
    notify.mockClear();

    const result = await update({ taskId: id, state: 'in_progress' });

    expect(result).toEqual({});
    expect(ref.tasks[0]).toEqual({ id, content: 'task A', state: 'in_progress' });

    expect(notify).toHaveBeenCalledTimes(1);
    const [level, message, context] = notify.mock.calls[0];
    expect(level).toBe('info');
    expect(message).toBe('tasks_changed');
    expect(context).toEqual({ tasks: [{ id, content: 'task A', state: 'in_progress' }] });
  });

  it('updates content only when provided', async () => {
    const ref: TaskListRef = { tasks: [] };
    const create = makeCreate({ cwd: '.' }, { taskListRef: ref });
    const update = makeUpdate({ cwd: '.' }, { taskListRef: ref });
    const { id } = await create({ content: 'original' });

    // No content key → unchanged.
    await update({ taskId: id, state: 'in_progress' });
    expect(ref.tasks[0].content).toBe('original');

    // content provided → overwrites.
    await update({ taskId: id, state: 'completed', content: 'replaced' });
    expect(ref.tasks[0]).toMatchObject({ content: 'replaced', state: 'completed' });
  });

  it('returns { error: "unknown task id: <id>" } for an unknown id and does not emit Notification', async () => {
    const ref: TaskListRef = { tasks: [] };
    const notify = makeNotify();
    const update = makeUpdate({ cwd: '.', notify }, { taskListRef: ref });

    const result = await update({ taskId: 'no-such-id', state: 'completed' });

    expect(result).toEqual({ error: 'unknown task id: no-such-id' });
    expect(notify).not.toHaveBeenCalled();
    expect(ref.tasks).toHaveLength(0);
  });

  it('rejects an invalid state at the schema level', () => {
    const t = taskUpdateTool();
    const inputSchema = (
      t.function as unknown as { inputSchema: { safeParse: (i: unknown) => { success: boolean } } }
    ).inputSchema;
    expect(inputSchema.safeParse({ taskId: 'abc', state: 'archived' }).success).toBe(false);
    expect(inputSchema.safeParse({ taskId: 'abc', state: 'completed' }).success).toBe(true);
  });

  it('rejects a missing state at the schema level', () => {
    const t = taskUpdateTool();
    const inputSchema = (
      t.function as unknown as { inputSchema: { safeParse: (i: unknown) => { success: boolean } } }
    ).inputSchema;
    expect(inputSchema.safeParse({ taskId: 'abc' }).success).toBe(false);
  });

  it('preserves activeForm across an update that does not touch it', async () => {
    const ref: TaskListRef = { tasks: [] };
    const create = makeCreate({ cwd: '.' }, { taskListRef: ref });
    const update = makeUpdate({ cwd: '.' }, { taskListRef: ref });
    const { id } = await create({ content: 'C', activeForm: 'Cing' });

    await update({ taskId: id, state: 'in_progress' });
    expect(ref.tasks[0]).toEqual({ id, content: 'C', state: 'in_progress', activeForm: 'Cing' });
  });

  it('fires onTasksChanged once per successful update', async () => {
    const ref: TaskListRef = { tasks: [] };
    const onTasksChanged = vi.fn();
    const create = makeCreate({ cwd: '.' }, { taskListRef: ref, onTasksChanged });
    const update = makeUpdate({ cwd: '.' }, { taskListRef: ref, onTasksChanged });
    const { id } = await create({ content: 'C' });
    expect(onTasksChanged).toHaveBeenCalledTimes(1);

    await update({ taskId: id, state: 'completed' });
    expect(onTasksChanged).toHaveBeenCalledTimes(2);

    await update({ taskId: 'bogus', state: 'cancelled' });
    expect(onTasksChanged).toHaveBeenCalledTimes(2);
  });

  it('prefers the SDK-injected execCtx.notify over the factory-time ctx.notify', async () => {
    const ref: TaskListRef = { tasks: [{ id: 'k', content: 'x', state: 'pending' }] };
    const factoryNotify = makeNotify();
    const sdkNotify = makeNotify();
    const t = taskUpdateTool({ cwd: '.', notify: factoryNotify }, { taskListRef: ref });
    const exec = t.function.execute as unknown as (
      input: UpdateParams,
      ctx: { notify: typeof sdkNotify },
    ) => Promise<TaskUpdateToolResult>;
    await exec({ taskId: 'k', state: 'completed' }, { notify: sdkNotify });
    expect(sdkNotify).toHaveBeenCalledTimes(1);
    expect(factoryNotify).not.toHaveBeenCalled();
  });
});

describe('task_create + task_update — shared list', () => {
  it('final Notification snapshot after create+create+update reflects all entries with correct states', async () => {
    const ref: TaskListRef = { tasks: [] };
    const notify = makeNotify();
    const create = makeCreate({ cwd: '.', notify }, { taskListRef: ref });
    const update = makeUpdate({ cwd: '.', notify }, { taskListRef: ref });

    const a = await create({ content: 'A' });
    const b = await create({ content: 'B', activeForm: 'Bing' });
    const c = await create({ content: 'C' });
    await update({ taskId: b.id, state: 'in_progress' });

    // Four notifications: 3 creates + 1 update.
    expect(notify).toHaveBeenCalledTimes(4);
    const last = notify.mock.calls.at(-1)!;
    expect(last[1]).toBe('tasks_changed');
    expect(last[2]).toEqual({
      tasks: [
        { id: a.id, content: 'A', state: 'pending' },
        { id: b.id, content: 'B', state: 'in_progress', activeForm: 'Bing' },
        { id: c.id, content: 'C', state: 'pending' },
      ],
    });
  });

  it('honors all four TaskStates on update', async () => {
    const ref: TaskListRef = { tasks: [] };
    const create = makeCreate({ cwd: '.' }, { taskListRef: ref });
    const update = makeUpdate({ cwd: '.' }, { taskListRef: ref });
    const { id } = await create({ content: 'cycle me' });

    for (const state of ['in_progress', 'completed', 'cancelled', 'pending'] as const) {
      const r = await update({ taskId: id, state });
      expect(r).toEqual({});
      expect(ref.tasks[0].state).toBe(state);
    }
  });
});
