import { defineConfig, devices } from '@playwright/test';

// The service worker only exists in a production build, so these tests build the app and run that build,
// served by the API server exactly as `npm run app` does. That also puts the site under its real security policy.
const E2E_DB = 'postgresql://apt:apt@localhost:5432/apartment_e2e';
const PORT = 4100;

export default defineConfig({
  testDir: './e2e-pwa',
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: { baseURL: `http://localhost:${PORT}`, ...devices['Pixel 5'] },
  webServer: {
    command: 'npm run build --prefix ../web && node ../e2e/prepareDb.cjs && npx tsx src/server.ts',
    cwd: './server',
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 240_000,
    env: { DATABASE_URL: E2E_DB, PORT: String(PORT), SESSION_SECRET: 'e2e-secret-e2e-secret-123456', NODE_ENV: 'development', SERVE_WEB: 'true' },
  },
});
