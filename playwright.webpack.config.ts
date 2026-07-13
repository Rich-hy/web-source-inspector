import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/integration-webpack',
  timeout: 30_000,
  fullyParallel: false,
  outputDir: 'test-results/webpack',
  use: {
    baseURL: 'http://127.0.0.1:41732',
    trace: 'retain-on-failure',
  },
  webServer: {
    command:
      'pnpm run build:package && pnpm --filter @web-source-inspector/fixture-webpack-basic dev',
    url: 'http://127.0.0.1:41732',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
