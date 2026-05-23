import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 10_000,
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/__tests__/**'],
      thresholds: {
        statements: 98.2,
        branches: 95.8,
        functions: 96.5,
        lines: 99.2,
      },
    },
  },
});
