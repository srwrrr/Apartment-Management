import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `npm run test:coverage`: which lines and branches the tests run (text summary, HTML report, lcov for SonarQube).
    coverage: { provider: 'v8', include: ['src/**/*.ts'], exclude: ['src/index.ts'], reporter: ['text-summary', 'html', 'lcov'] },
  },
});
