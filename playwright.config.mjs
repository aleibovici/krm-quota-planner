import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT || 4791);
const baseURL = `http://127.0.0.1:${port}/`;

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.mjs',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  timeout: 60_000,
  use: {
    baseURL,
    trace: 'on-first-retry',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'node e2e/web-server.mjs',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
