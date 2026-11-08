// ESLint: the team's automated code review. Run `npm run lint`.
// Rule sets: ESLint's recommended rules, typescript-eslint's type-aware rules (they read the
// TypeScript types, so they catch bugs such as promises nobody waits for), and React's hooks rules.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'docs/**', 'server/perf/**', 'test-results/**', 'playwright-report/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['packages/shared/src/**/*.ts', 'server/src/**/*.ts', 'server/prisma/**/*.ts', 'server/test/**/*.ts', 'web/src/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Unused names are mistakes, except a leading underscore, which marks "deliberately unused".
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      // Express handlers may be async; Express 4 does not await them, and our wrapper catches errors.
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false, attributes: false } }],
      // Prefer === everywhere. `x != null` is the one exception: it deliberately means "not null and not undefined".
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    files: ['server/**/*.ts', 'packages/shared/**/*.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['web/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: globals.browser },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // Tests read untyped HTTP response bodies (res.body) on purpose; the assertions are the type check there.
    files: ['**/*.test.ts', '**/*.test.tsx', 'server/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // Fakes of async APIs (fetch, response.json) are async to match them, even with nothing to await.
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    // Plain JavaScript files (configs, scripts) are not type-checked.
    files: ['**/*.{js,cjs,mjs}'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { globals: globals.node },
  },
);
