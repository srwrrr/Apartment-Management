import { defineConfig, devices } from '@playwright/test';

// The service worker only exists in a production build, so these tests build the app and run that build.
const E2E_DB = 'postgresql://apt:apt@localhost:5432/apartment_e2e';
const API_PORT = 4100;
const WEB_PORT = 5175;

export default defineConfig({
  testDir: './e2e-pwa',
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: { baseURL: `http://localhost:${WEB_PORT}`, ...devices['Pixel 5'] },
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
      command: `npx vite build && npx vite preview --port ${WEB_PORT} --strictPort`,
      cwd: './web',
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: { API_URL: `http://localhost:${API_PORT}` },
    },
  ],
});
