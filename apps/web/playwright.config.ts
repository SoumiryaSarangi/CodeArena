import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: { baseURL: 'http://localhost:3123' },
  webServer: {
    command: 'pnpm exec next dev -p 3123',
    url: 'http://localhost:3123/dev/ui',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
