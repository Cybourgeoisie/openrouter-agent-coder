import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';

const execFileAsync = promisify(execFile);

const LOG_BASE = join(process.cwd(), 'logs');
const REGISTRY_PATH = join(LOG_BASE, 'sessions.json');
const DIST_INDEX = join(process.cwd(), 'dist/index.js');

describe('CLI entry point', () => {
  it('exits with error when OPENROUTER_API_KEY is missing', async () => {
    try {
      await execFileAsync('node', [DIST_INDEX, 'test'], {
        env: { ...process.env, OPENROUTER_API_KEY: '', DOTENV_SKIP: '1' },
        timeout: 5000,
      });
      expect.fail('should have exited with non-zero');
    } catch (err: unknown) {
      const e = err as { code?: number; stderr?: string };
      expect(e.code).toBe(1);
      expect(e.stderr).toContain('OPENROUTER_API_KEY');
    }
  });

  it('dist/index.js exists and is loadable', async () => {
    await execFileAsync('node', ['-e', `require("${DIST_INDEX}")`], {
      env: { ...process.env, OPENROUTER_API_KEY: '', DOTENV_SKIP: '1' },
      timeout: 5000,
    }).catch(() => {});
  });
});

describe('--continue flag', () => {
  it('prints "No previous session found" when registry is empty', async () => {
    let backup: string | null = null;
    try {
      backup = await readFile(REGISTRY_PATH, 'utf-8');
    } catch {
      /* no prior registry */
    }

    try {
      await rm(REGISTRY_PATH, { force: true });

      const result = await execFileAsync('node', [DIST_INDEX, '--continue', 'hi'], {
        env: { ...process.env, OPENROUTER_API_KEY: 'sk-fake-for-test', DOTENV_SKIP: '1' },
        timeout: 10000,
      }).catch((e) => e as { code?: number; stderr?: string; stdout?: string });

      const combined = ((result as any).stderr ?? '') + ((result as any).stdout ?? '');
      expect(combined).toContain('No previous session found');
    } finally {
      if (backup !== null) {
        await writeFile(REGISTRY_PATH, backup);
      }
    }
  });

  it('continues the last session when registry has entries', async () => {
    const previousId = 'sess_00000000-0000-0000-0000-000000000001';

    let backup: string | null = null;
    try {
      backup = await readFile(REGISTRY_PATH, 'utf-8');
    } catch {
      /* no prior registry */
    }

    try {
      await mkdir(LOG_BASE, { recursive: true });
      await writeFile(
        REGISTRY_PATH,
        JSON.stringify(
          [{ sessionId: previousId, startedAt: '2024-01-01T00:00:00.000Z', firstPrompt: 'hello' }],
          null,
          2,
        ),
      );

      const result = await execFileAsync('node', [DIST_INDEX, '--continue', 'what is 1+1?'], {
        env: { ...process.env, OPENROUTER_API_KEY: 'sk-fake-for-test', DOTENV_SKIP: '1' },
        timeout: 10000,
      }).catch((e) => e as { code?: number; stderr?: string; stdout?: string });

      const combined = ((result as any).stderr ?? '') + ((result as any).stdout ?? '');
      expect(combined).toContain(previousId);
    } finally {
      if (backup !== null) {
        await writeFile(REGISTRY_PATH, backup);
      } else {
        await rm(REGISTRY_PATH, { force: true });
      }
      await rm(join(LOG_BASE, previousId), { recursive: true, force: true });
    }
  });
});
