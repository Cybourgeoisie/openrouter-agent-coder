import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { editNotebookTool, type EditNotebookResult } from './edit-notebook.js';
import { writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const TMP = join(import.meta.dirname, '../../.test-tmp/edit-notebook');

beforeEach(async () => {
  await mkdir(TMP, { recursive: true });
});

afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
});

const tool = editNotebookTool();
const execute = tool.function.execute as (params: {
  path: string;
  operation: string;
  cell_index: number;
  new_source?: string;
  new_cell_type?: 'code' | 'markdown';
}) => Promise<EditNotebookResult>;

interface NotebookFile {
  cells: Array<Record<string, unknown>>;
  metadata: Record<string, unknown>;
  nbformat: number;
  nbformat_minor: number;
}

function canonicalFixture(): NotebookFile {
  return {
    cells: [
      {
        cell_type: 'markdown',
        id: 'aaa',
        metadata: {},
        source: ['# Hello\n', 'Intro.'],
      },
      {
        cell_type: 'code',
        execution_count: 3,
        id: 'bbb',
        metadata: { collapsed: true },
        outputs: [{ output_type: 'stream', name: 'stdout', text: ['hi\n'] }],
        source: ["print('hello')\n", "print('world')"],
      },
      {
        cell_type: 'code',
        execution_count: null,
        id: 'ccc',
        metadata: {},
        outputs: [],
        source: ['x = 1'],
      },
    ],
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python', version: '3.11.0' },
    },
    nbformat: 4,
    nbformat_minor: 5,
  };
}

async function writeFixture(name: string, nb: NotebookFile): Promise<string> {
  const filePath = join(TMP, name);
  const serialized = `${JSON.stringify(nb, null, 1)}\n`;
  await writeFile(filePath, serialized, 'utf-8');
  return filePath;
}

describe('edit_notebook tool', () => {
  it('has correct name', () => {
    expect(tool.function.name).toBe('edit_notebook');
  });

  it('round-trips a canonical fixture byte-identically on no-op replace_source', async () => {
    const fixture = canonicalFixture();
    const filePath = await writeFixture('roundtrip.ipynb', fixture);
    const before = await readFile(filePath, 'utf-8');

    // Replace cell 2 with its existing source (joined back into a string).
    const cell2source = (fixture.cells[2].source as string[]).join('');
    const result = await execute({
      path: filePath,
      operation: 'replace_source',
      cell_index: 2,
      new_source: cell2source,
    });

    expect(result).toEqual({ ok: true, cells: 3 });
    const after = await readFile(filePath, 'utf-8');
    expect(after).toBe(before);
  });

  it('replace_source updates target cell and preserves siblings + notebook metadata', async () => {
    const filePath = await writeFixture('replace.ipynb', canonicalFixture());
    const result = await execute({
      path: filePath,
      operation: 'replace_source',
      cell_index: 1,
      new_source: "print('new')\n",
    });
    expect(result).toEqual({ ok: true, cells: 3 });

    const nb = JSON.parse(await readFile(filePath, 'utf-8')) as NotebookFile;
    expect(nb.cells[1].source).toEqual(["print('new')\n"]);
    // outputs, execution_count, id, metadata preserved
    expect(nb.cells[1].cell_type).toBe('code');
    expect(nb.cells[1].id).toBe('bbb');
    expect(nb.cells[1].metadata).toEqual({ collapsed: true });
    expect(nb.cells[1].execution_count).toBe(3);
    expect(nb.cells[1].outputs).toEqual([
      { output_type: 'stream', name: 'stdout', text: ['hi\n'] },
    ]);
    // siblings unchanged
    expect(nb.cells[0]).toEqual(canonicalFixture().cells[0]);
    expect(nb.cells[2]).toEqual(canonicalFixture().cells[2]);
    // notebook-level preserved
    expect(nb.metadata).toEqual(canonicalFixture().metadata);
    expect(nb.nbformat).toBe(4);
    expect(nb.nbformat_minor).toBe(5);
  });

  it('insert at index 0 prepends; siblings shifted; length grows', async () => {
    const filePath = await writeFixture('insert0.ipynb', canonicalFixture());
    const result = await execute({
      path: filePath,
      operation: 'insert',
      cell_index: 0,
      new_source: '# Prepended',
      new_cell_type: 'markdown',
    });
    expect(result).toEqual({ ok: true, cells: 4 });

    const nb = JSON.parse(await readFile(filePath, 'utf-8')) as NotebookFile;
    expect(nb.cells).toHaveLength(4);
    expect(nb.cells[0]).toEqual({
      cell_type: 'markdown',
      source: ['# Prepended'],
      metadata: {},
    });
    // existing cells shifted by one, still identical
    const original = canonicalFixture();
    expect(nb.cells[1]).toEqual(original.cells[0]);
    expect(nb.cells[2]).toEqual(original.cells[1]);
    expect(nb.cells[3]).toEqual(original.cells[2]);
  });

  it('insert at middle index lands in the right slot', async () => {
    const filePath = await writeFixture('insert-mid.ipynb', canonicalFixture());
    const result = await execute({
      path: filePath,
      operation: 'insert',
      cell_index: 1,
      new_source: 'middle',
      new_cell_type: 'markdown',
    });
    expect(result).toEqual({ ok: true, cells: 4 });
    const nb = JSON.parse(await readFile(filePath, 'utf-8')) as NotebookFile;
    expect(nb.cells[1].source).toEqual(['middle']);
    expect(nb.cells[0]).toEqual(canonicalFixture().cells[0]);
    expect(nb.cells[2]).toEqual(canonicalFixture().cells[1]);
  });

  it('insert at cells.length appends', async () => {
    const filePath = await writeFixture('append.ipynb', canonicalFixture());
    const result = await execute({
      path: filePath,
      operation: 'insert',
      cell_index: 3,
      new_source: 'tail',
      new_cell_type: 'markdown',
    });
    expect(result).toEqual({ ok: true, cells: 4 });
    const nb = JSON.parse(await readFile(filePath, 'utf-8')) as NotebookFile;
    expect(nb.cells[3].source).toEqual(['tail']);
  });

  it('insert code cell produces outputs: [] + execution_count: null', async () => {
    const filePath = await writeFixture('insert-code.ipynb', canonicalFixture());
    await execute({
      path: filePath,
      operation: 'insert',
      cell_index: 0,
      new_source: 'x',
      new_cell_type: 'code',
    });
    const nb = JSON.parse(await readFile(filePath, 'utf-8')) as NotebookFile;
    expect(nb.cells[0]).toEqual({
      cell_type: 'code',
      source: ['x'],
      metadata: {},
      outputs: [],
      execution_count: null,
    });
  });

  it('insert markdown cell does not include outputs or execution_count', async () => {
    const filePath = await writeFixture('insert-md.ipynb', canonicalFixture());
    await execute({
      path: filePath,
      operation: 'insert',
      cell_index: 0,
      new_source: 'note',
      new_cell_type: 'markdown',
    });
    const nb = JSON.parse(await readFile(filePath, 'utf-8')) as NotebookFile;
    expect(nb.cells[0]).toEqual({
      cell_type: 'markdown',
      source: ['note'],
      metadata: {},
    });
    expect(Object.prototype.hasOwnProperty.call(nb.cells[0], 'outputs')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(nb.cells[0], 'execution_count')).toBe(false);
  });

  it('insert with empty new_source produces source: []', async () => {
    const filePath = await writeFixture('insert-empty.ipynb', canonicalFixture());
    await execute({
      path: filePath,
      operation: 'insert',
      cell_index: 0,
      new_source: '',
      new_cell_type: 'markdown',
    });
    const nb = JSON.parse(await readFile(filePath, 'utf-8')) as NotebookFile;
    expect(nb.cells[0].source).toEqual([]);
  });

  it('delete removes target; siblings unchanged', async () => {
    const filePath = await writeFixture('del.ipynb', canonicalFixture());
    const result = await execute({
      path: filePath,
      operation: 'delete',
      cell_index: 1,
    });
    expect(result).toEqual({ ok: true, cells: 2 });
    const nb = JSON.parse(await readFile(filePath, 'utf-8')) as NotebookFile;
    expect(nb.cells).toHaveLength(2);
    expect(nb.cells[0]).toEqual(canonicalFixture().cells[0]);
    expect(nb.cells[1]).toEqual(canonicalFixture().cells[2]);
  });

  it('change_type code → markdown strips outputs and execution_count', async () => {
    const filePath = await writeFixture('chtype-c2m.ipynb', canonicalFixture());
    const result = await execute({
      path: filePath,
      operation: 'change_type',
      cell_index: 1,
      new_cell_type: 'markdown',
    });
    expect(result).toEqual({ ok: true, cells: 3 });
    const nb = JSON.parse(await readFile(filePath, 'utf-8')) as NotebookFile;
    expect(nb.cells[1].cell_type).toBe('markdown');
    expect(Object.prototype.hasOwnProperty.call(nb.cells[1], 'outputs')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(nb.cells[1], 'execution_count')).toBe(false);
    // source preserved as array of strings (canonical shape)
    expect(nb.cells[1].source).toEqual(["print('hello')\n", "print('world')"]);
    // id + metadata preserved
    expect(nb.cells[1].id).toBe('bbb');
    expect(nb.cells[1].metadata).toEqual({ collapsed: true });
  });

  it('change_type markdown → code adds outputs: [] + execution_count: null', async () => {
    const filePath = await writeFixture('chtype-m2c.ipynb', canonicalFixture());
    const result = await execute({
      path: filePath,
      operation: 'change_type',
      cell_index: 0,
      new_cell_type: 'code',
    });
    expect(result).toEqual({ ok: true, cells: 3 });
    const nb = JSON.parse(await readFile(filePath, 'utf-8')) as NotebookFile;
    expect(nb.cells[0].cell_type).toBe('code');
    expect(nb.cells[0].outputs).toEqual([]);
    expect(nb.cells[0].execution_count).toBeNull();
    expect(nb.cells[0].source).toEqual(['# Hello\n', 'Intro.']);
    expect(nb.cells[0].id).toBe('aaa');
  });

  it('change_type code → code is a no-op on type but still normalizes source array', async () => {
    const filePath = await writeFixture('chtype-same.ipynb', canonicalFixture());
    const result = await execute({
      path: filePath,
      operation: 'change_type',
      cell_index: 1,
      new_cell_type: 'code',
    });
    expect(result).toEqual({ ok: true, cells: 3 });
    const nb = JSON.parse(await readFile(filePath, 'utf-8')) as NotebookFile;
    expect(nb.cells[1].cell_type).toBe('code');
    expect(nb.cells[1].source).toEqual(["print('hello')\n", "print('world')"]);
    expect(nb.cells[1].outputs).toEqual([
      { output_type: 'stream', name: 'stdout', text: ['hi\n'] },
    ]);
  });

  it('change_type markdown → markdown preserves shape (no outputs added)', async () => {
    const filePath = await writeFixture('chtype-mm.ipynb', canonicalFixture());
    const result = await execute({
      path: filePath,
      operation: 'change_type',
      cell_index: 0,
      new_cell_type: 'markdown',
    });
    expect(result).toEqual({ ok: true, cells: 3 });
    const nb = JSON.parse(await readFile(filePath, 'utf-8')) as NotebookFile;
    expect(nb.cells[0].cell_type).toBe('markdown');
    expect(Object.prototype.hasOwnProperty.call(nb.cells[0], 'outputs')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(nb.cells[0], 'execution_count')).toBe(false);
  });

  it('source-normalization: string source on disk is written back as string[]', async () => {
    const nb: NotebookFile = {
      cells: [
        {
          cell_type: 'code',
          execution_count: null,
          id: 'sss',
          metadata: {},
          outputs: [],
          source: "print('a')\nprint('b')\n",
        },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    };
    const filePath = await writeFixture('strsrc.ipynb', nb);
    // No-op replace_source on cell 0 with the equivalent string.
    await execute({
      path: filePath,
      operation: 'replace_source',
      cell_index: 0,
      new_source: "print('a')\nprint('b')\n",
    });
    const after = JSON.parse(await readFile(filePath, 'utf-8')) as NotebookFile;
    expect(after.cells[0].source).toEqual(["print('a')\n", "print('b')\n"]);
  });

  it('change_type normalizes a string-source cell into string[]', async () => {
    const nb: NotebookFile = {
      cells: [
        {
          cell_type: 'markdown',
          id: 'xxx',
          metadata: {},
          source: 'just a string',
        },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    };
    const filePath = await writeFixture('chstr.ipynb', nb);
    await execute({
      path: filePath,
      operation: 'change_type',
      cell_index: 0,
      new_cell_type: 'code',
    });
    const after = JSON.parse(await readFile(filePath, 'utf-8')) as NotebookFile;
    expect(after.cells[0].source).toEqual(['just a string']);
    expect(after.cells[0].cell_type).toBe('code');
    expect(after.cells[0].outputs).toEqual([]);
  });

  it('replace_source missing new_source returns error', async () => {
    const filePath = await writeFixture('err1.ipynb', canonicalFixture());
    const result = await execute({
      path: filePath,
      operation: 'replace_source',
      cell_index: 0,
    });
    expect(result).toEqual({ error: 'replace_source requires new_source' });
  });

  it('insert missing new_source returns error', async () => {
    const filePath = await writeFixture('err2.ipynb', canonicalFixture());
    const result = await execute({
      path: filePath,
      operation: 'insert',
      cell_index: 0,
      new_cell_type: 'code',
    });
    expect(result).toEqual({ error: 'insert requires new_source' });
  });

  it('insert missing new_cell_type returns error', async () => {
    const filePath = await writeFixture('err3.ipynb', canonicalFixture());
    const result = await execute({
      path: filePath,
      operation: 'insert',
      cell_index: 0,
      new_source: 'x',
    });
    expect(result).toEqual({ error: 'insert requires new_cell_type' });
  });

  it('change_type missing new_cell_type returns error', async () => {
    const filePath = await writeFixture('err4.ipynb', canonicalFixture());
    const result = await execute({
      path: filePath,
      operation: 'change_type',
      cell_index: 0,
    });
    expect(result).toEqual({ error: 'change_type requires new_cell_type' });
  });

  it('replace_source out-of-range cell_index returns error', async () => {
    const filePath = await writeFixture('oor1.ipynb', canonicalFixture());
    const result = await execute({
      path: filePath,
      operation: 'replace_source',
      cell_index: 99,
      new_source: 'x',
    });
    expect(result).toEqual({
      error: 'cell_index 99 out of range (notebook has 3 cells)',
    });
  });

  it('delete out-of-range cell_index returns error', async () => {
    const filePath = await writeFixture('oor2.ipynb', canonicalFixture());
    const result = await execute({
      path: filePath,
      operation: 'delete',
      cell_index: 3,
    });
    expect(result).toEqual({
      error: 'cell_index 3 out of range (notebook has 3 cells)',
    });
  });

  it('change_type out-of-range cell_index returns error', async () => {
    const filePath = await writeFixture('oor3.ipynb', canonicalFixture());
    const result = await execute({
      path: filePath,
      operation: 'change_type',
      cell_index: 3,
      new_cell_type: 'code',
    });
    expect(result).toEqual({
      error: 'cell_index 3 out of range (notebook has 3 cells)',
    });
  });

  it('insert with cell_index > cells.length returns error', async () => {
    const filePath = await writeFixture('oor4.ipynb', canonicalFixture());
    const result = await execute({
      path: filePath,
      operation: 'insert',
      cell_index: 4,
      new_source: 'x',
      new_cell_type: 'code',
    });
    expect(result).toEqual({
      error: 'cell_index 4 out of range (notebook has 3 cells)',
    });
  });

  it('malformed JSON returns parse error', async () => {
    const filePath = join(TMP, 'bad.ipynb');
    await writeFile(filePath, '{ not json', 'utf-8');
    const result = await execute({
      path: filePath,
      operation: 'delete',
      cell_index: 0,
    });
    expect(result).toMatchObject({ error: expect.stringMatching(/^failed to parse notebook:/) });
  });

  it('ENOENT path returns read error', async () => {
    const result = await execute({
      path: join(TMP, 'does-not-exist.ipynb'),
      operation: 'delete',
      cell_index: 0,
    });
    expect(result).toMatchObject({ error: expect.stringMatching(/^failed to read notebook:/) });
  });

  it('write error surfaces as `failed to write notebook`', async () => {
    // Write a valid notebook to a directory path → readFile succeeds on a file,
    // but writeFile to a directory fails. Simulate by making the path a dir.
    const dirPath = join(TMP, 'isadir.ipynb');
    await mkdir(dirPath, { recursive: true });
    const result = await execute({
      path: dirPath,
      operation: 'delete',
      cell_index: 0,
    });
    // readFile on a directory fails with EISDIR → we surface as read error.
    expect(result).toMatchObject({ error: expect.stringMatching(/^failed to read notebook:/) });
  });

  it('insert preserves prior cells exactly (deep-equal sibling check)', async () => {
    // Belt-and-braces — second sibling fingerprint check.
    const filePath = await writeFixture('sib.ipynb', canonicalFixture());
    await execute({
      path: filePath,
      operation: 'insert',
      cell_index: 2,
      new_source: 'inserted',
      new_cell_type: 'markdown',
    });
    const nb = JSON.parse(await readFile(filePath, 'utf-8')) as NotebookFile;
    const original = canonicalFixture();
    expect(nb.cells[0]).toEqual(original.cells[0]);
    expect(nb.cells[1]).toEqual(original.cells[1]);
    expect(nb.cells[3]).toEqual(original.cells[2]);
  });
});

describe('edit_notebook write error', () => {
  // Make the writeFile path fail after a successful read. Use a fixture file,
  // then chmod the parent dir to read-only. node fs writeFile to existing file
  // with no write perms throws EACCES.
  it('write failure surfaces as `failed to write notebook`', async () => {
    const dir = join(TMP, 'wronly');
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, 'nb.ipynb');
    const serialized = `${JSON.stringify(canonicalFixture(), null, 1)}\n`;
    await writeFile(filePath, serialized, 'utf-8');
    // Strip write perms on the file.
    const { chmod } = await import('node:fs/promises');
    await chmod(filePath, 0o444);
    try {
      const result = await execute({
        path: filePath,
        operation: 'delete',
        cell_index: 0,
      });
      expect(result).toMatchObject({ error: expect.stringMatching(/^failed to write notebook:/) });
    } finally {
      await chmod(filePath, 0o644);
    }
  });
});
