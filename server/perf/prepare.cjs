// Creates an empty apartment_perf database and runs the load test against it. Your development data is not touched.
const { execSync } = require('node:child_process');
const path = require('node:path');
const { Client } = require('pg');

const DB = 'postgresql://apt:apt@localhost:5432/apartment_perf';
const server = path.resolve(__dirname, '..');

(async () => {
  const admin = new Client({ connectionString: 'postgresql://apt:apt@localhost:5432/apartment' });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS apartment_perf');
  await admin.query('CREATE DATABASE apartment_perf');
  await admin.end();
  const env = { ...process.env, DATABASE_URL: DB, SESSION_SECRET: 'perf-secret-perf-secret-123456', NODE_ENV: 'test', UPLOAD_DIR: './.perf-uploads' };
  execSync('npx prisma migrate deploy', { cwd: server, env, stdio: 'pipe' });
  execSync('npx tsx perf/run.ts', { cwd: server, env, stdio: 'inherit' });
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
