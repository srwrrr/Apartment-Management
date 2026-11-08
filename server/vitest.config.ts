import { defineConfig } from 'vitest/config';

const TEST_DB = 'postgresql://apt:apt@localhost:5432/apartment_test';

export default defineConfig({
  test: {
    globalSetup: ['./test/globalSetup.ts'],
    fileParallelism: false, // tests share one database
    testTimeout: 20000,
    hookTimeout: 120000,
    env: {
      DATABASE_URL: TEST_DB,
      SESSION_SECRET: 'test-secret-test-secret-123456',
      NODE_ENV: 'test',
      UPLOAD_DIR: './.test-uploads', // photos written by tests; removed afterwards
    },
    // `npm run test:coverage`: which lines and branches the tests run (text summary, HTML report, lcov for SonarQube).
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/server.ts', 'src/types.d.ts'],
      reporter: ['text-summary', 'html', 'lcov'],
    },
  },
});
