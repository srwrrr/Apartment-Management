import { execSync } from 'node:child_process';

// Applies all migrations to the throw-away test database before tests run.
export default function setup() {
  execSync('npx prisma migrate deploy', {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, DATABASE_URL: 'postgresql://apt:apt@localhost:5432/apartment_test' },
    stdio: 'pipe',
  });
}
