# Deploying on Render (free) with a Neon database

The whole app runs as one Docker container on Render: the API, the built web app, and the
headless Chromium that makes PDFs. The database is PostgreSQL on Neon's free plan, which does
not expire (Render's own free PostgreSQL is deleted after 30 days).

## 1. Create the database on Neon

1. Sign up at <https://neon.com> and create a project (any name; pick the region closest to
   Bangladesh, for example Singapore).
2. On the project dashboard, press **Connect**. Turn **Connection pooling off** (migrations need
   a direct connection) and copy the connection string. It looks like
   `postgresql://user:password@ep-xxxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`.

Keep it private: it is the database password.

## 2. Create the web service on Render

1. Sign in at <https://render.com> with GitHub and allow access to the `Apartment-Management`
   repository.
2. **New > Blueprint**, choose the repository. Render reads `render.yaml` (branch `srwr`,
   free plan, Docker).
3. When asked for `DATABASE_URL`, paste the Neon connection string. `SESSION_SECRET` is
   generated for you.
4. **Apply**. The first build takes several minutes (it downloads the Chromium image).

On every start the container applies any new database migrations, makes sure the demo accounts
and demo building exist (it never adds the building to a database that already has units), and
then serves the app on the address Render gives you, for example
`https://apartment-management.onrender.com`.

## Logging in

The one-click demo buttons are hidden in production. Type the accounts instead:

| Role | Login | Password |
| --- | --- | --- |
| Administrator | admin@demo.local | Admin1234 |
| Maintenance manager | manager@demo.local | Manager1234 |
| Cashier | billing@demo.local | Billing1234 |
| Caretaker | staff@demo.local | Staff1234 |
| Resident | resident@demo.local | Resident1234 |

Every start resets these demo passwords to the ones above.

## What the free plan means

- After 15 minutes with no visitors the service sleeps; the next visit takes about a minute to
  wake it. Open the site a minute before a demo.
- Uploaded photos are kept on the container's own disk, which is wiped on every restart or
  redeploy. Bills, payments, requests and everything else are in Neon and are kept.
- Reminders and other timed jobs only run while the service is awake.
- 512 MB of memory: enough for normal use and PDFs (about 380 MB measured in testing).

## Updating

Push to the `srwr` branch; Render rebuilds and redeploys automatically.
