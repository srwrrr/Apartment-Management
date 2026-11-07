import { defineConfig, devices } from '@playwright/test';

// End-to-end tests run against their own database and their own ports,
// so they never touch your development data or a running dev server.
const E2E_DB = 'postgresql://apt:apt@localhost:5432/apartment_e2e';
const API_PORT = 4100;
const WEB_PORT = 5174;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    // A phone-sized screen (NFR-10).
    { name: 'phone', use: { ...devices['Pixel 5'] } },
  ],
  webServer: [
    {
      command: 'node ../e2e/prepareDb.cjs && npx tsx src/server.ts',
      cwd: './server',
      url: `http://localhost:${API_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { DATABASE_URL: E2E_DB, PORT: String(API_PORT), SESSION_SECRET: 'e2e-secret-e2e-secret-123456', NODE_ENV: 'development' },
    },
    {
      command: `npx vite --port ${WEB_PORT} --strictPort`,
      cwd: './web',
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { API_URL: `http://localhost:${API_PORT}` },
    },
  ],
});
