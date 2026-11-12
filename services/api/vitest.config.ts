import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests that use TEST_DATABASE_URL empty the same tables, so with a database they run one file at a time.
    fileParallelism: !process.env.TEST_DATABASE_URL,
  },
});
