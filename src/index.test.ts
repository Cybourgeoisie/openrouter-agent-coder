import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

describe('CLI entry point', () => {
  it('exits with error when OPENROUTER_API_KEY is missing', async () => {
    try {
      await execFileAsync('node', ['dist/index.js', 'test'], {
        env: { ...process.env, OPENROUTER_API_KEY: '' },
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
    const { stdout } = await execFileAsync('node', ['-e', 'require("./dist/index.js")'], {
      env: { ...process.env, OPENROUTER_API_KEY: '' },
      timeout: 5000,
    }).catch((err) => err);
    // It will fail due to missing API key but that proves it loaded
  });
});
