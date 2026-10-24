import { defineConfig, devices } from '@playwright/test';

/**
 * Deployment tests for the embedded demo (Vercel with no database attached).
 * tests/demo/serve.ts builds the snapshot and serves two instances behind a
 * proxy. "multi-instance" alternates every request between the instances;
 * "single-instance" pins requests to one, like a warm serverless instance.
 */
const PORT = Number(process.env.DEMO_PORT ?? 3300);

export default defineConfig({
  testDir: 'tests/demo',
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-demo' }]],
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure', screenshot: 'only-on-failure', locale: 'en-US' },
  projects: [
    { name: 'multi-instance', testMatch: /multi-instance\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
    { name: 'single-instance', testMatch: /single-instance\.spec\.ts/, use: { ...devices['Desktop Chrome'], extraHTTPHeaders: { 'x-demo-route': 'sticky' } } },
    { name: 'mobile', testMatch: /mobile\.spec\.ts/, use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'pnpm exec tsx tests/demo/serve.ts',
    url: `http://localhost:${PORT}/api/v1/health`,
    timeout: 900_000,
    reuseExistingServer: false,
    env: { DEMO_PORT: String(PORT) },
  },
});
