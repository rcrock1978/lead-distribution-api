import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { target: 'es2022' },
  resolve: {
    // '@' -> backend root; lets tests import '@/src/...' without extension pain
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
  test: {
    environment: 'node',
    globals: false,
    // All DB-touching suites share one scratch database — serialize files
    // process-wide (per-project fileParallelism proved unreliable).
    fileParallelism: false,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          fileParallelism: false,
          hookTimeout: 60_000,
          testTimeout: 60_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'concurrency',
          include: ['tests/concurrency/**/*.test.ts'],
          fileParallelism: false,
          hookTimeout: 60_000,
          testTimeout: 120_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'budgets',
          include: ['tests/budgets/**/*.test.ts'],
          fileParallelism: false,
          hookTimeout: 60_000,
          testTimeout: 120_000,
        },
      },
    ],
  },
});
