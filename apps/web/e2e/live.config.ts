import { defineConfig } from '@playwright/test';

/**
 * The live spec: the real web app, API, queue and judge (no stubs). Not part of the default run;
 * see e2e/live/README.md. `pnpm --filter @codearena/web e2e:live`.
 */
export default defineConfig({
  testDir: './live',
  timeout: 120_000,
  workers: 1,
  use: { baseURL: 'http://localhost:3123' },
  webServer: {
    command: 'node scripts/copy-monaco.mjs && pnpm exec next dev -p 3123',
    url: 'http://localhost:3123/signin',
    cwd: '..', // the config lives in e2e/, the app one level up
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
