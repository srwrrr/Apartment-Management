// Creates the e2e database if needed, migrates it, empties it, and loads the demo accounts.
// Runs as part of the API server's start command, so the database is ready before the first health check.
const { execSync } = require('node:child_process');
const path = require('node:path');

const E2E_DB = 'postgresql://apt:apt@localhost:5432/apartment_e2e';
const server = path.resolve(__dirname, '../server');
const { Client } = require(require.resolve('pg', { paths: [server] }));

(async () => {
  const admin = new Client({ connectionString: 'postgresql://apt:apt@localhost:5432/apartment' });
  await admin.connect();
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'apartment_e2e'");
  if (exists.rowCount === 0) await admin.query('CREATE DATABASE apartment_e2e');
  await admin.end();

  const env = { ...process.env, DATABASE_URL: E2E_DB };
  execSync('npx prisma migrate deploy', { cwd: server, env, stdio: 'pipe' });

  const db = new Client({ connectionString: E2E_DB });
  await db.connect();
  await db.query('TRUNCATE users, units, settings, "session" RESTART IDENTITY CASCADE');
  await db.end();

  execSync('npx tsx prisma/seed.ts', { cwd: server, env, stdio: 'pipe' });
  console.log('e2e database ready');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
