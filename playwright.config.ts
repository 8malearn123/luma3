import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end journeys against a dedicated, disposable database whose name must
 * end in `_e2e` (rebuilt and seeded by tests/e2e/global-setup.ts).
 */
const E2E_DB = process.env.E2E_DATABASE ?? 'luma_e2e';
const PORT = Number(process.env.E2E_PORT ?? 3110);
export const e2eEnv = {
  APP_ENV: 'development',
  APP_URL: `http://localhost:${PORT}`,
  DATABASE_URL: `postgres://luma_app:luma_app_dev@localhost:5432/${E2E_DB}`,
  DATABASE_OWNER_URL: `postgres://luma_owner:luma_owner_dev@localhost:5432/${E2E_DB}`,
  DB_APP_ROLE: 'luma_app',
  AUTH_SECRET: 'e2e-secret-e2e-secret-e2e-secret-0123456789',
  DEMO_MODE: 'false',
  DEV_OTP_ECHO: 'true',
  STORAGE_DRIVER: 'local',
  STORAGE_LOCAL_DIR: './.e2e/storage',
  PAYMENT_SANDBOX_WEBHOOK_SECRET: 'e2e-webhook-secret',
  OPENAI_API_KEY: '',
  OPENAI_MODEL: '',
  PLATFORM_MFA_REQUIRED: 'true',
  SEED_CREDENTIALS_JSON: './.e2e/credentials.json',
};

export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure', screenshot: 'only-on-failure', locale: 'ar-SA' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /responsive\.spec\.ts/ },
  ],
  webServer: {
    command: `pnpm exec next dev -p ${PORT}`,
    url: `http://localhost:${PORT}/api/v1/health`,
    timeout: 180_000,
    reuseExistingServer: false,
    env: { ...e2eEnv, NEXT_DIST_DIR: '.next-e2e' },
  },
});
