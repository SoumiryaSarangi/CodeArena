import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testIgnore: ['live/**'], // the live spec has its own config (e2e/live.config.ts)
  timeout: 30_000,
  use: { baseURL: 'http://localhost:3123' },
  webServer: {
    command: 'node scripts/copy-monaco.mjs && pnpm exec next dev -p 3123',
    url: 'http://localhost:3123/dev/ui',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // The pad spec (e2e/pad.spec.ts) runs a real collab server on this port.
    env: { NEXT_PUBLIC_COLLAB_URL: `ws://127.0.0.1:${process.env.COLLAB_E2E_PORT ?? 1299}` },
  },
});
