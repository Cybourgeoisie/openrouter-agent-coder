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
        statements: 99.5,
        branches: 98.28,
        functions: 98.7,
        lines: 99.9,
      },
    },
  },
});
