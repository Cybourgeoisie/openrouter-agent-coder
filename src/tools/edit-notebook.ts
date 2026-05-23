import { tool } from '@openrouter/agent';
import { z } from 'zod/v4';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DEFAULT_TOOL_CONTEXT, type ToolContext } from './context.js';

type CellType = 'code' | 'markdown';
type Operation = 'replace_source' | 'insert' | 'delete' | 'change_type';

interface NotebookCell {
  cell_type: string;
  source: string | string[];
  metadata?: Record<string, unknown>;
  outputs?: unknown[];
  execution_count?: number | null;
  [extra: string]: unknown;
}

interface Notebook {
  cells: NotebookCell[];
  [extra: string]: unknown;
}

export interface EditNotebookSuccess {
  ok: true;
  cells: number;
}

export interface EditNotebookError {
  error: string;
}

export type EditNotebookResult = EditNotebookSuccess | EditNotebookError;

function sourceToString(source: string | string[]): string {
  return Array.isArray(source) ? source.join('') : source;
}

function stringToSourceArray(source: string): string[] {
  if (source === '') return [];
  const lines = source.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    out.push(`${lines[i]}\n`);
  }
  const last = lines[lines.length - 1];
  if (last !== '') out.push(last);
  return out;
}

export function editNotebookTool(ctx: ToolContext = DEFAULT_TOOL_CONTEXT) {
  return tool({
    name: 'edit_notebook',
    description:
      "Edit a Jupyter notebook (.ipynb) by manipulating cells. Operations: `replace_source` (rewrite a cell's source), `insert` (add a new cell), `delete` (remove a cell), `change_type` (toggle code/markdown). Untouched cells and notebook metadata are preserved. Returns `{ ok: true, cells: <count> }` on success or `{ error: ... }` on a validation / IO failure.",
    inputSchema: z.object({
      path: z.string().describe('Path to the .ipynb file, relative to the agent cwd.'),
      operation: z
        .enum(['replace_source', 'insert', 'delete', 'change_type'])
        .describe('Mutation to perform.'),
      cell_index: z
        .number()
        .int()
        .nonnegative()
        .describe(
          '0-based cell index. For `insert`, the position where the new cell lands (0 = prepend, cells.length = append).',
        ),
      new_source: z
        .string()
        .optional()
        .describe('New cell source. Required for `replace_source` and `insert`.'),
      new_cell_type: z
        .enum(['code', 'markdown'])
        .optional()
        .describe('Cell type for the new/modified cell. Required for `insert` and `change_type`.'),
    }),
    execute: async ({
      path,
      operation,
      cell_index,
      new_source,
      new_cell_type,
    }): Promise<EditNotebookResult> => {
      const resolved = resolve(ctx.cwd, path);

      let raw: string;
      try {
        raw = await readFile(resolved, 'utf-8');
      } catch (err) {
        return { error: `failed to read notebook: ${(err as Error).message}` };
      }

      let notebook: Notebook;
      try {
        notebook = JSON.parse(raw) as Notebook;
      } catch (err) {
        return { error: `failed to parse notebook: ${(err as Error).message}` };
      }

      const cells = notebook.cells;
      const op = operation as Operation;

      if (op === 'replace_source') {
        if (new_source === undefined) {
          return { error: 'replace_source requires new_source' };
        }
        if (cell_index >= cells.length) {
          return {
            error: `cell_index ${cell_index} out of range (notebook has ${cells.length} cells)`,
          };
        }
        const target = cells[cell_index];
        cells[cell_index] = { ...target, source: stringToSourceArray(new_source) };
      } else if (op === 'insert') {
        if (new_source === undefined) {
          return { error: 'insert requires new_source' };
        }
        if (new_cell_type === undefined) {
          return { error: 'insert requires new_cell_type' };
        }
        if (cell_index > cells.length) {
          return {
            error: `cell_index ${cell_index} out of range (notebook has ${cells.length} cells)`,
          };
        }
        const newCell: NotebookCell = {
          cell_type: new_cell_type,
          source: stringToSourceArray(new_source),
          metadata: {},
        };
        if (new_cell_type === 'code') {
          newCell.outputs = [];
          newCell.execution_count = null;
        }
        cells.splice(cell_index, 0, newCell);
      } else if (op === 'delete') {
        if (cell_index >= cells.length) {
          return {
            error: `cell_index ${cell_index} out of range (notebook has ${cells.length} cells)`,
          };
        }
        cells.splice(cell_index, 1);
      } else {
        // change_type
        if (new_cell_type === undefined) {
          return { error: 'change_type requires new_cell_type' };
        }
        if (cell_index >= cells.length) {
          return {
            error: `cell_index ${cell_index} out of range (notebook has ${cells.length} cells)`,
          };
        }
        const target = cells[cell_index];
        const currentType = target.cell_type as CellType;
        const preservedSource = stringToSourceArray(sourceToString(target.source));
        if (currentType === 'code' && new_cell_type === 'markdown') {
          const rest = { ...target };
          delete rest.outputs;
          delete rest.execution_count;
          cells[cell_index] = { ...rest, cell_type: 'markdown', source: preservedSource };
        } else if (currentType === 'markdown' && new_cell_type === 'code') {
          cells[cell_index] = {
            ...target,
            cell_type: 'code',
            source: preservedSource,
            outputs: [],
            execution_count: null,
          };
        } else {
          cells[cell_index] = { ...target, cell_type: new_cell_type, source: preservedSource };
        }
      }

      const serialized = `${JSON.stringify(notebook, null, 1)}\n`;
      try {
        await writeFile(resolved, serialized, 'utf-8');
      } catch (err) {
        return { error: `failed to write notebook: ${(err as Error).message}` };
      }

      return { ok: true, cells: cells.length };
    },
  });
}
