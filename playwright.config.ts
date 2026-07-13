import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/integration',
  timeout: 30_000,
  fullyParallel: false,
  use: {
    baseURL: 'http://127.0.0.1:41731',
    trace: 'retain-on-failure'
  },
  webServer: {
    command: 'pnpm run serve:e2e',
    url: 'http://127.0.0.1:41731',
    reuseExistingServer: false,
    timeout: 120_000
  }
});
