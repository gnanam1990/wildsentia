import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 60_000,
    // The server tests share one Postgres database and truncate it between cases, so they
    // cannot run concurrently with each other. The whole suite is fast enough that running
    // files in sequence costs little and removes an entire class of flakiness.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
