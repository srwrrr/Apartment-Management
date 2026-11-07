# Apartment Management

A web app for running an apartment building in Bangladesh: bills and payments, maintenance requests, announcements, and reports for the committee. Residents use it on their phones in English or Bangla, and it can be installed like an app.

Built for CSE327 (Software Engineering). The requirements are in [docs/SRS.md](docs/SRS.md), and the design is in [project_spec.md](project_spec.md). Everything it uses is free.

## What it does

| For | Features |
|---|---|
| Residents | See and report payments, download receipts and statements, submit maintenance requests with photos, rate finished work, read announcements, find emergency numbers offline |
| Staff | Task list, status updates and notes, permission-based access to billing, residents and reports |
| Administrators | Units, residents and household members, bulk import, bill generation, payment checks, no-dues certificates, move-out wizard, expenses, scheduled jobs, targeted and scheduled announcements, printable notices, dashboard, CSV exports, monthly committee report, activity log |

## Run it

You need Node 22 or newer and PostgreSQL 16 or newer. Docker can provide PostgreSQL instead: `docker compose up -d`.

```bash
cp .env.example .env                                     # then set SESSION_SECRET
powershell -ExecutionPolicy Bypass -File scripts/setup-db.ps1   # creates the database user and database
npm install
npx playwright install chromium                          # used to make PDFs
npm run db:deploy
npm run seed                                             # the demo building
npm run app                                              # builds the site and serves it
```

Open <http://localhost:4000>. With `DEMO_MODE=true` in `.env`, the login page has one-click buttons for an administrator, a staff member and a resident.

For development, use `npm run dev` instead: the API runs on port 4000 and the web app on <http://localhost:5173>, and both reload when you save.

### Demo accounts

| Role | Login ID | Password |
|---|---|---|
| Administrator | `admin@demo.local` | `Admin1234` |
| Maintenance manager | `manager@demo.local` | `Manager1234` |
| Caretaker (no extra permissions) | `staff@demo.local` | `Staff1234` |
| Cashier | `billing@demo.local` | `Billing1234` |
| Office staff | `office@demo.local` | `Office1234` |
| Resident | `resident@demo.local` | `Resident1234` |
| Household member | `family@demo.local` | `Resident1234` |

`npm run demo:reset` **deletes everything in the database** and rebuilds the demo in about 10 seconds. It only runs with `DEMO_MODE=true`, and never in production.

## Project layout

```
packages/shared   validation, permissions, money formatting, English and Bangla text
server            Express API, Prisma, PostgreSQL, PDFs, background jobs
web               React app, installable
e2e, e2e-pwa      browser tests
scripts           database setup, backup, restore
docs              SRS, diagrams, demo script, test results
```

## Tests

```bash
npm test            # shared, API and web tests (the API uses its own apartment_test database)
npm run test:e2e    # browser tests at desktop and phone size, with accessibility scans
npm run test:pwa    # the built site: install, offline, security policy
```

None of these touch your development data. CI runs all three on every push ([.github/workflows/ci.yml](.github/workflows/ci.yml)).

## Operations

- [Backup and restore](docs/backup-and-restore.md), including the restore test results
- [Performance results](docs/performance-results.md)
- [Usability test kit](docs/usability-test.md)
- [Demo script](docs/demo-script.md)
- [Diagrams](docs/diagrams/README.md)

`npm run app` runs without HTTPS, which is fine on a laptop. On a real server, put it behind HTTPS and set `NODE_ENV=production` and a long random `SESSION_SECRET`: production login cookies only travel over HTTPS, and the server refuses to start with the example secret.
