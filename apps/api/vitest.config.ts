import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Integration suites create and migrate a throwaway database; DDL on WSL2 can take ~10 s.
  test: { hookTimeout: 60_000, testTimeout: 30_000 },
});
