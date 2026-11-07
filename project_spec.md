# Project Spec — Apartment Management

This is the **build specification**: how we will implement the requirements in [`docs/SRS.md`](docs/SRS.md) (v1.2). The SRS says *what* the system must do. This file says *how*: stack, architecture, data model, API, background jobs, and delivery plan.

If this file and the SRS disagree, the SRS wins. Fix this file, or raise a change to the SRS.

- **Status:** Draft v0.3, November 2026 (updated for SRS v1.3)
- **Requirement IDs:** `FR-xx`, `NFR-xx`, `BR-xx` refer to the SRS.
- **Budget:** ৳0. Every tool and service in this spec is free.

---

## 1. Summary

A web app for one apartment building with three roles (Resident, Staff, Admin), in English and Bangla, installable on phones. Six backend modules:

| Module | Covers |
|---|---|
| `users` | Auth, accounts, roles, staff permissions, residents, household members, units, occupancy, move-out, bulk import, directory, preferences, activity log (FR-01–08, 31, 34, 37, 42, 47, 54, 55, 56) |
| `billing` | Fees, opening balances, bill generation, charges, payments, voids, payment reports, receipts, statements, no-dues certificates, finance reports (FR-09–15, 32, 33, 38, 39–41, 45, 46) |
| `expenses` | Building expenses, income vs expense report (FR-43, 44) |
| `maintenance` | Requests, attachments, review, assignment, updates, SLA, ratings, scheduled tasks, reports (FR-16–22, 35, 49, 50) |
| `announcements` | Announcements, audiences, scheduling, groups, notices, emergency contacts, notifications, read tracking (FR-23–26, 36, 51–53) |
| `dashboard` | Overview cards, collection-rate trend, recent activity, global search, committee report (FR-27–30, 57, 58) |

Shared services used by several modules: `pdf` (receipts, statements, certificates, notices, committee report), `i18n`, `files` (uploads), `jobs`.

**Requirement counts:** 29 *Must*, 19 *Should*, 10 *Could* (58 total).

**Non-goals for v1:** online payment gateway, SMS/email, chat, polls, visitor and amenity management, IoT, native apps, multiple buildings, advance payments/credit.

---

## 2. Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Language | **TypeScript** everywhere | One language for the whole team; types catch bugs early. |
| Runtime | **Node.js 22 LTS** | Current long-term-support release. |
| Frontend | **React 18 + Vite**, React Router, TanStack Query, React Hook Form + Zod | Standard, well documented, fast dev server. |
| UI | **Tailwind CSS** + shadcn/ui components | Responsive by default (NFR-10); accessible components (NFR-12). All sizes in `rem`, so the larger-text setting scales everything (FR-55). |
| Charts | **Recharts** (MIT) on screen; inline SVG in PDFs | Collection-rate trend (FR-58) and committee report (FR-57). |
| i18n | **i18next** (`react-i18next` on web, plain `i18next` on server) | One set of translation files for screens, notifications, PDFs, and errors (FR-47). |
| Bangla font | **Noto Sans Bengali** + **Noto Sans** (SIL Open Font License), self-hosted | Correct conjuncts (NFR-28); works offline at the demo. |
| PWA | **vite-plugin-pwa** (Workbox) | Install on home screen, offline page (FR-48). |
| Backend | **Express** | Simple, widely taught. |
| Validation | **Zod**, schemas shared via `packages/shared` | One definition of each rule for both sides (NFR-04, NFR-11). |
| Database | **PostgreSQL 16+** (developed on 18) + `pg_trgm`, `btree_gist` extensions | Transactions, constraints, partial indexes, fast partial-text search (NFR-14, NFR-18). |
| ORM | **Prisma** (+ raw SQL migrations for partial indexes, CHECKs, views) | Typed queries, migrations, `$transaction`. |
| Auth | `express-session` + `connect-pg-simple`; **bcryptjs** (cost 12; same algorithm as bcrypt, no native build on Windows) | Easy logout, inactivity timeout, "end other sessions" (NFR-03, FR-31). |
| Security | `helmet`, CSRF double-submit token, `express-rate-limit` | NFR-05, NFR-07. |
| Uploads | `multer` + `file-type` (checks real content) | BR-19, BR-21, NFR-06. |
| PDF | **HTML templates → PDF with headless Chromium** (`playwright-core`) | Browsers shape Bangla text correctly; pdfkit does not reliably render Bangla conjuncts. One HTML/CSS skill set for screens and documents. |
| CSV | `papaparse` (import), hand-written writer with UTF-8 BOM (export) | FR-38, FR-42. The BOM makes Excel open Bangla correctly. |
| Jobs | `node-cron` inside the backend process | §6.8. |
| API docs | OpenAPI 3 from Zod (`zod-to-openapi`) + Swagger UI at `/api/docs` | NFR-21. |
| Testing | **Vitest**, **Supertest**, **Playwright** | NFR-22. |
| Dev DB | PostgreSQL 16+ Windows/macOS installer *or* Docker Desktop (free for personal/educational use) | NFR-27. |
| Collaboration | GitHub (repo, Issues, Projects board, Actions CI) | Free for this use. |

---

## 3. Architecture

```mermaid
flowchart LR
    B[Browser / installed PWA<br/>React SPA · EN/BN] -- HTTPS JSON /api --> API[Express API]
    API --> MW[Middleware<br/>session · CSRF · rate limit · authz · language]
    MW --> M1[users]
    MW --> M2[billing]
    MW --> M3[expenses]
    MW --> M4[maintenance]
    MW --> M5[announcements]
    MW --> M6[dashboard]
    M1 & M2 & M3 & M4 & M5 & M6 --> DB[(PostgreSQL)]
    M2 & M3 & M4 --> FS[(uploads/)]
    M2 & M5 --> PDF[pdf service<br/>HTML → Chromium → PDF]
    JOBS[node-cron jobs] --> M2 & M4 & M5
```

### 3.1 Layering inside each module

```
routes.ts      → HTTP: parse/validate input (Zod), call service, shape response
service.ts     → business rules (BR-xx), transactions, data-scoped permission checks
repository.ts  → Prisma / SQL queries only
schemas.ts     → Zod schemas (re-exported from packages/shared where the web uses them)
*.test.ts      → tests next to the code
```

**Rules**
- Routes never call Prisma directly. Services never read `req`/`res`.
- A module may call another module's **service**, never its repository.
- Every multi-record write runs inside `prisma.$transaction` (NFR-14), including the notification and activity-log rows it creates.
- Access to a unit's records goes through **one** SQL view, `unit_access` (§6.1). No module re-implements BR-08 / BR-22 / BR-27.

### 3.2 Repository layout

```
apartment-management/
├── docs/
│   ├── SRS.md
│   └── diagrams/                 # use-case, class, sequence diagrams for the course
├── project_spec.md
├── README.md
├── docker-compose.yml            # optional (Docker users)
├── package.json                  # npm workspaces
├── .github/
│   ├── workflows/ci.yml
│   └── pull_request_template.md
├── packages/
│   └── shared/
│       ├── schemas/              # Zod schemas
│       ├── permissions.ts
│       ├── enums.ts
│       ├── money.ts              # poisha ↔ taka, formatBDT (lakh grouping)
│       └── locales/{en,bn}/*.json
├── server/
│   ├── prisma/
│   │   ├── schema.prisma
│   │   ├── migrations/           # includes raw SQL for views, partial indexes, CHECKs
│   │   └── seed.ts
│   ├── assets/fonts/             # Noto Sans, Noto Sans Bengali
│   ├── src/
│   │   ├── app.ts · server.ts · config.ts
│   │   ├── middleware/           # auth, requirePermission, csrf, language, errorHandler
│   │   ├── lib/                  # prisma, dates (Asia/Dhaka), counters, csv, files
│   │   ├── pdf/                  # browser pool + templates/{receipt,statement,certificate,notice}.ts
│   │   ├── jobs/                 # daily.ts, frequent.ts
│   │   └── modules/{users,billing,expenses,maintenance,announcements,dashboard}/
│   └── uploads/                  # git-ignored
├── web/
│   ├── public/                   # PWA icons, offline.html
│   └── src/
│       ├── app/                  # router, layout, auth + language context
│       ├── components/
│       ├── features/             # mirrors server modules
│       └── lib/                  # api client, formatters
└── scripts/
    ├── backup.ps1 / backup.sh
    └── restore.ps1 / restore.sh
```

---

## 4. Roles and Permissions

Roles: `RESIDENT`, `STAFF`, `ADMIN`. Admins implicitly have every permission. Staff have only the rows in `StaffPermission`. Residents (and household members, who are also `RESIDENT` users) have no permissions, only access derived from `unit_access`.

Grantable staff permissions (`packages/shared/permissions.ts`), matching SRS Appendix B:

```
residents.manage      units.manage           directory.view
billing.manage        billing.view           payments.record
expenses.manage       reports.view
maintenance.view_all  maintenance.review     maintenance.assign
announcements.manage
```

**Reading units** (list and detail) is allowed with `units.manage` *or* `residents.manage`, because assigning residents needs a unit lookup; **changing** units needs `units.manage`.

**Admin-only, never grantable:** manage staff, void payments, opening balances, bulk import, issue no-dues certificates, activity log, settings, password resets.

### 4.1 Enforcement

```ts
router.post('/payment-reports/:id/verify', requireAuth, requirePermission('payments.record'), handler)
```

- `requireAuth` — 401 if no session; 403 `PASSWORD_CHANGE_REQUIRED` if `mustChangePassword` is set (except change-password and logout).
- `requirePermission(p)` — 403 unless admin or staff with `p`.
- **Ownership checks are in the service layer**, by joining `unit_access` in the `WHERE` clause. No match → **404**, never 403, so IDs cannot be probed (NFR-24).
- Permissions are read from the DB on every request, so changes apply immediately (FR-06).

---

## 5. Data Model

**Conventions**
- Money is **integer poisha** (`Int`; 1 BDT = 100 poisha) (BR-15).
- Timestamps are `timestamptz` in UTC, displayed in Asia/Dhaka. "Today" always means today in Asia/Dhaka (`lib/dates.ts`).
- Billing months are `date` set to the 1st (e.g. `2026-11-01`).
- IDs are UUIDs, except human-facing numbers (request `#1024`, `RCPT-…`, `NDC-…`).
- Constraints marked *(SQL)* are written as raw SQL in migrations because Prisma cannot express them.

```mermaid
erDiagram
    User ||--o| ResidentProfile : has
    User ||--o{ StaffPermission : has
    User ||--o{ Occupancy : "resident in"
    Occupancy ||--o{ HouseholdMember : includes
    User ||--o{ HouseholdMember : "is member"
    Unit ||--o{ Occupancy : has
    Unit ||--o{ UnitFee : has
    Unit ||--o{ Bill : has
    Bill ||--o{ Charge : contains
    Bill ||--o{ Payment : "paid by"
    Bill ||--o{ PaymentReport : "reported on"
    PaymentReport |o--o| Payment : "becomes"
    Unit ||--o{ NoDuesCertificate : has
    Unit ||--o{ MaintenanceRequest : "located in"
    User ||--o{ MaintenanceRequest : submits
    ScheduledTask ||--o{ MaintenanceRequest : creates
    MaintenanceRequest ||--o{ RequestUpdate : has
    MaintenanceRequest ||--o| RequestRating : has
    Attachment }o--|| MaintenanceRequest : "on"
    Attachment }o--|| PaymentReport : "on"
    Attachment }o--|| Expense : "on"
    Announcement ||--o{ AnnouncementAudience : targets
    Announcement ||--o{ AnnouncementRecipient : "sent to"
    ResidentGroup ||--o{ ResidentGroupMember : has
    User ||--o{ Notification : receives
    User ||--o{ ActivityLog : performs
```

### 5.1 People and places

**User**
| Field | Type | Notes |
|---|---|---|
| id | uuid PK | |
| loginId | text unique | Email (lower-cased) or `+8801XXXXXXXXX` (BR-01). |
| passwordHash | text | bcrypt cost 12. |
| role | enum `RESIDENT \| STAFF \| ADMIN` | |
| fullName | text | Unicode. |
| phone | text | |
| language | enum `EN \| BN`, default `EN` | BR-28. |
| textSize | enum `NORMAL \| LARGE`, default `NORMAL` | FR-55. |
| isActive | bool | BR-03. |
| mustChangePassword | bool | FR-31. |
| failedLoginCount | int | BR-02. |
| lockedUntil | timestamptz null | BR-02. |
| createdAt, updatedAt | timestamptz | |

**ResidentProfile** — `userId PK/FK, altPhone, emergencyContactName, emergencyContactPhone`. *No national ID* (NFR-25).

**StaffPermission** — `(userId, permission)` composite PK.

**Unit** — `id, unitNumber, floor, sizeSqft, bedrooms, isAvailable`. Unique index on `upper(unitNumber)` *(SQL)* (BR-04). Occupied/Vacant is derived (BR-05).

**Occupancy**
| Field | Type | Notes |
|---|---|---|
| id | uuid PK | |
| unitId, residentId | FK | |
| type | enum `OWNER \| TENANT` | |
| startDate | date | |
| endDate | date null | null = active. `CHECK (endDate >= startDate)`. |
| isBillingContact | bool | Partial unique `(unitId) WHERE isBillingContact AND endDate IS NULL` *(SQL)* (BR-06). |

No-overlap rule for the same resident + unit is enforced with an exclusion constraint on `daterange(startDate, endDate, '[]')` using `btree_gist` *(SQL)*.

**HouseholdMember** (FR-54, BR-27)
| Field | Type | Notes |
|---|---|---|
| id | uuid PK | |
| occupancyId | FK → Occupancy | |
| userId | FK → User | A `RESIDENT` user with no occupancy of their own. |
| relation | text | e.g. Spouse, Son. |
| addedAt | date | |
| removedAt | date null | |

### 5.2 Access view (the single source of BR-08 / BR-22 / BR-27)

```sql
CREATE VIEW unit_access AS
  SELECT residentId AS userId, unitId, startDate, endDate, id AS occupancyId, 'OCCUPANT' AS kind
  FROM occupancy
UNION ALL
  SELECT hm.userId, o.unitId,
         GREATEST(o.startDate, hm.addedAt)                       AS startDate,
         LEAST(COALESCE(o.endDate, 'infinity'), COALESCE(hm.removedAt, 'infinity')) AS endDate,
         o.id, 'HOUSEHOLD'
  FROM householdMember hm JOIN occupancy o ON o.id = hm.occupancyId;
```

A user can see a bill when:
```
REGULAR bill:          access overlaps [billingMonth, end of billingMonth]          (BR-08)
OPENING_BALANCE bill:  access covers setting.goLiveDate                             (BR-22)
```
Requests: user is the submitter, or the submitter shares the same `occupancyId` household (BR-27).

### 5.3 Billing

**UnitFee** (FR-32) — `id, unitId null (null = building default), chargeType, amount (CHECK > 0), description`. Unit row overrides the default for the same type.

**Bill**
| Field | Type | Notes |
|---|---|---|
| id | uuid PK | |
| unitId | FK | |
| kind | enum `REGULAR \| OPENING_BALANCE` | |
| billingMonth | date | Unique `(unitId, billingMonth)` (BR-07). For opening balances: month before go-live. |
| dueDate | date | BR-10 / BR-22. |
| billingContactId | FK → User | Snapshot at creation; printed on receipts. |
| note | text null | |
| createdById, createdAt | | |

Partial unique `(unitId) WHERE kind = 'OPENING_BALANCE'` *(SQL)*. `total / paid / balance / status` are **computed** (§6.2), never stored.

**Charge** — `id, billId, type, amount (CHECK > 0), description`.
`type`: `SERVICE | RENT | WATER | GAS | ELECTRICITY | OPENING_BALANCE | OTHER`. Partial unique `(billId, type) WHERE type <> 'OTHER'` *(SQL)*.

**Payment**
| Field | Type | Notes |
|---|---|---|
| id | uuid PK | |
| billId | FK | |
| amount | int | `CHECK > 0`. |
| paidOn | date | ≤ today. |
| method | enum `CASH \| BANK \| BKASH \| NAGAD \| ROCKET \| OTHER` | |
| reference | text null | Duplicate warning on `(method, upper(reference))`. |
| receiptNo | text unique | `RCPT-YYYY-NNNNN` from `Counter` (BR-14). |
| paymentReportId | FK null, unique | Set when created by verifying a report. |
| recordedById | FK | |
| voidedAt, voidedById, voidReason | | `CHECK ((voidedAt IS NULL) = (voidReason IS NULL))` (BR-13). |
| createdAt | | |

**PaymentReport** (FR-39, FR-40, BR-21)
| Field | Type | Notes |
|---|---|---|
| id | uuid PK | |
| billId | FK | |
| reportedById | FK → User | Resident or household member. |
| amount, paidOn, method, reference | | Same rules as Payment; `reference` required. |
| status | enum `PENDING \| VERIFIED \| REJECTED` | |
| reviewedById, reviewedAt | null | |
| rejectReason | text null | Required when REJECTED (`CHECK`). |
| createdAt | | |

Screenshot is an `Attachment` row. Index `(status, createdAt)` for the queue.

**NoDuesCertificate** (FR-46, BR-24) — `id, number unique (NDC-YYYY-NNNNN), unitId, issuedToId, coversThroughMonth, issuedById, issuedAt`.

**Counter** — `(kind 'RCPT' | 'NDC', year, value)`, PK `(kind, year)`. Incremented with `SELECT … FOR UPDATE` inside the creating transaction so numbers never repeat or skip.

### 5.4 Expenses

**Expense** (FR-43, BR-23)
| Field | Type | Notes |
|---|---|---|
| id | uuid PK | |
| spentOn | date | ≤ today. |
| category | enum `STAFF_SALARY \| GENERATOR_FUEL \| COMMON_ELECTRICITY \| WATER \| CLEANING \| LIFT \| SECURITY \| REPAIRS \| OTHER` | |
| amount | int | `CHECK > 0`. |
| payee | text | |
| description | text null | |
| recordedById, createdAt, updatedAt | | |
| voidedAt, voidedById, voidReason | | Same pattern as Payment. |

### 5.5 Maintenance

**MaintenanceRequest**
| Field | Type | Notes |
|---|---|---|
| id | uuid PK | |
| number | serial unique | `#1024`. |
| source | enum `RESIDENT \| SCHEDULED` | |
| submittedById | FK null | Server sets from session (FR-17). Null for SCHEDULED. |
| scheduledTaskId | FK null | |
| unitId | FK null | Submitter's unit (also for common-area reports, to know who reported). Null for SCHEDULED. |
| location | enum `UNIT \| COMMON_AREA` | |
| category | enum | Plumbing, Electrical, Lift, Generator, Water supply, Gas, Cleaning, Security, Common area, Other. |
| title, description | text | |
| priority | enum `LOW \| MEDIUM \| HIGH` null | |
| status | enum | BR-16. |
| assignedToId | FK null | |
| dueAt | timestamptz | BR-17; for SCHEDULED = task due date (BR-25). |
| resolvedAt, closedAt | null | |
| createdAt, updatedAt | | |

`CHECK ((source='RESIDENT' AND submittedById IS NOT NULL AND unitId IS NOT NULL) OR (source='SCHEDULED' AND scheduledTaskId IS NOT NULL))`.

Overdue = open status and `now() > dueAt`.

**RequestUpdate** — append-only: `id, seq, requestId, authorId null (null = System), kind (NOTE | STATUS_CHANGE | PRIORITY_CHANGE | ASSIGNMENT), fromValue, toValue, note, isInternal, createdAt`. `seq` is an insertion counter: rows written in one transaction share a timestamp, so the timeline is ordered by `seq`, not `createdAt`. For an assignment, `fromValue`/`toValue` hold the staff members' names at that time.

**Built in Sprint 7** (differences from the plan): all ten *Could* items are in. Scheduled requests have no submitter and no unit, so `submittedById` and `unitId` on `maintenance_requests` are optional, and a `scheduledTaskId` links them to their task. `publishAt` is stored in the existing `publishedAt` column, which can now be in the future; `recipientsResolvedAt` is what marks an announcement as sent. A rating is read-only by database trigger as well as by the API. Group audiences keep the group's name, so a deleted group still reads correctly. A household member with no other home is deactivated when removed or when their stay ends today or earlier; a stay ending on a future date leaves the login active. The FR-58 chart is plain HTML bars rather than Recharts, which keeps a large library out of what a phone stores, and the committee report's chart is inline SVG. Jobs run hourly rather than daily, with announcements every 5 minutes: the result is the same because each job does nothing the second time, and a laptop that sleeps still catches up. `npm run app` builds the web app and serves it from Express (`SERVE_WEB=true`) instead of `npm start`. `seed:large` is `npm run perf -w server`. Offline, the emergency numbers appear on `offline.html`, because navigation stays network-only (FR-48).

**Built in Sprint 6** (differences from the plan): the activity log table is `activity_logs` with `details` (json) in place of `summary` and `diff`, so the sentence is written in the reader's language. Immutability is a database trigger rather than a separate role with INSERT and SELECT only, because the app's role owns its tables; the trigger also survives a restore. Who did something comes from a per-request context, and every entry is written in the action's own transaction; only logging in, which has no transaction, writes outside one. For an unknown account a failed login stores no typed text, because people sometimes type their password there. Search (`GET /api/search`) is for staff and administrators, and each group appears only for those who may open it. PWA: no `/api` request is cached at all, so there is nothing private to clear on logout; navigations are network-only with `offline.html` as the fallback. Accessibility is checked with axe in the e2e suite (WCAG 2.1 A and AA rules) rather than a Lighthouse score. Backup and restore, performance results and the usability test kit are in `docs/`. The usability test itself has not been run, because it needs real people.

**Built in Sprint 5** (differences from the plan): residents' routes live under `/api/me/billing` (`/statement`, `/statement.pdf`, `/statement/units`, `/certificates`, `/building-summary`); the certificate PDF is `/api/certificates/:id/pdf`. A statement dates a bill by its billing month or the day it was created, whichever is earlier, so that a bill generated ahead for next month is included and "up to today" always closes on the FR-13 outstanding balance. The duplicate transaction ID check also covers pending reports; a rejected report does not count, so a resident can correct a mistake and report the same ID again. A certificate needs at least one bill (`NOTHING_BILLED`), because otherwise there is no month for it to cover. The move-out POST takes `expectedBalance` (the balance the administrator was shown, for `STALE_PREVIEW`) and `duesNote`, kept on `occupancies.moveOutNote`; its date cannot be in the future, because deactivation takes effect at once. An occupancy's end date is the day they left: a stay ending today no longer counts for unit status, the directory or the dashboard, so the unit shows Vacant straight away; bill visibility stays inclusive of that day (BR-08). The resident's spending summary shows category totals only. Not built yet: CSV export of the income and expense report (FR-38), and the demo data for expenses and certificates in the seed (Sprint 7).

**Built in Sprint 4** (differences from the plan): notifications store the type and facts, not text, and the sentence is written in the reader's language when shown; announcement recipients are fixed when published (people who move in later do not receive it) and read status comes from each person's ANNOUNCEMENT notification; announcements cannot be sent to nobody (AUDIENCE_EMPTY); the dashboard and the collection report share one function so their figures cannot differ; bill reminders (3 days before the due date, and when overdue) are unique per person and bill, so the job is safe to repeat. Not built yet: FR-30/FR-34 (search, activity log), FR-51 (scheduled announcements), FR-36 (groups), FR-38 (CSV export), FR-57. The announcement unit picker uses the units list, so staff with only announcements.manage can use All/Owners/Tenants/Floors but need a units permission to pick individual units.

**Built in Sprint 3** (differences from the plan above): residents' and staff lists are `/me/requests` and `/me/tasks`; the scheduled-task source and ratings (FR-49, FR-50) are not built yet, so those columns are not in the table; a request is visible to its submitter and anyone in the same household (`household_peers` view); staff without maintenance permissions see only requests assigned to them; the SLA times (`slaHighHours` 24, `slaMediumHours` 72, `slaLowHours` 168, `reviewDeadlineHours` 48, `autoCloseDays` 7) are read from the settings table with those defaults.

**RequestRating** (FR-50, BR-26) — `requestId PK/FK, stars (CHECK 1–5), comment, ratedById, createdAt`.

**ScheduledTask** (FR-49, BR-25) — `id, title, description, category, intervalMonths (CHECK 1–24), nextDueDate, defaultAssigneeId null, isPaused, createdById, createdAt`.

### 5.6 Files

**Attachment** — `id, storedName (uuid.ext), originalName, mimeType, sizeBytes, uploadedById, createdAt`, plus exactly one owner:
`requestId | requestUpdateId | paymentReportId | expenseId` with `CHECK (num_nonnulls(...) = 1)` *(SQL)*.
Files are stored in `UPLOAD_DIR` and served only through `GET /api/attachments/:id`, which checks access to the owner record.

### 5.7 Announcements and notifications

**Announcement**
| Field | Type | Notes |
|---|---|---|
| id | uuid PK | |
| title, body | text | |
| category | enum `GENERAL \| MAINTENANCE \| MEETING \| SERVICE_INTERRUPTION \| RULES` | |
| isImportant | bool | Pinned. |
| audienceType | enum `ALL \| UNITS \| FLOORS \| OWNERS \| TENANTS \| GROUP` | |
| publishAt | timestamptz | Default now (FR-51). |
| endsAt | timestamptz null | FR-51. |
| recipientsResolvedAt | timestamptz null | Set when audience is resolved at publish time. |
| publishedById, editedAt, archivedAt | | |

Display state is derived: `SCHEDULED` (now < publishAt), `ACTIVE`, `ENDED` (now > endsAt), `ARCHIVED`.

**AnnouncementAudience** — parameters (`unitId`, `floor`, or `groupId` rows).
**AnnouncementRecipient** — `(announcementId, userId)` PK, resolved at publish time, including household members of targeted occupancies.
**ResidentGroup** `(id, name unique)`; **ResidentGroupMember** `(groupId, userId)`.
**EmergencyContact** (FR-52) — `id, name, role, phone, hours, sortOrder`.

**Notification**
| Field | Type | Notes |
|---|---|---|
| id | uuid PK | |
| userId | FK | |
| type | enum | `ANNOUNCEMENT, BILL_NEW, BILL_DUE_SOON, BILL_OVERDUE, PAYMENT_RECORDED, PAYMENT_REPORT_NEW, PAYMENT_REPORT_VERIFIED, PAYMENT_REPORT_REJECTED, REQUEST_NEW, REQUEST_UPDATE, REQUEST_ASSIGNED` |
| params | jsonb | e.g. `{ "unit": "4B", "month": "2026-11" }`. Text is rendered in the reader's language at display time, so switching language also translates old notifications. |
| link | text | Front-end route. |
| entityId | uuid null | |
| readAt | timestamptz null | |
| createdAt | | |

Unique `(userId, type, entityId) WHERE type IN ('BILL_DUE_SOON','BILL_OVERDUE')` *(SQL)* so jobs are safe to re-run.

### 5.8 Administration

**ActivityLog** — `id, actorId null, action ('payment.void', …), entityType, entityId, summary, diff jsonb, ip, createdAt`. The app's DB role has `INSERT, SELECT` only on this table (FR-34).

**Setting** (key/value)

| Key | Default | Used by |
|---|---|---|
| buildingName | "Demo Tower" | PDFs, header |
| goLiveDate | first run date | BR-22 |
| defaultDueDay | 10 | BR-10 |
| slaHighHours / slaMediumHours / slaLowHours | 24 / 72 / 168 | BR-17 |
| reviewDeadlineHours | 48 | BR-17 |
| autoCloseDays | 7 | BR-18 |
| reminderDaysBefore | 3 | BR-20 |
| shareExpenseSummary | false | FR-44 |

**Session** — `connect-pg-simple` table with an added `userId` column so FR-31 can end a user's other sessions.

---

## 6. Key Logic

### 6.1 Access

All resident-facing queries join `unit_access` (§5.2). Unit tests cover these edge cases:

- moved-out resident still sees old bills, not new ones
- new resident does not see the previous occupant's bills
- opening balance visible to a resident who starts on the go-live date
- removed household member loses new bills but keeps old ones
- owner and tenant of the same unit do not see each other's requests

### 6.2 Bill totals and status (BR-09)

A SQL view `bill_summary` is used by every list, report, and the dashboard, so the numbers always agree (FR-28):

```
total   = SUM(charges.amount)
paid    = SUM(payments.amount WHERE voidedAt IS NULL)
balance = total - paid
status  = PAID           if balance = 0
          OVERDUE        if balance > 0 and today > dueDate
          PARTIALLY_PAID if paid > 0
          UNPAID         otherwise
pendingReported = SUM(paymentReports.amount WHERE status = 'PENDING')
```

### 6.3 Generate bills (FR-09)

```
POST /api/bills/generate { month, dueDate?, dryRun }
1. units with access overlapping `month` AND isAvailable
2. skip units already billed for `month`           → "already billed"
3. skip units with no fees                         → "no fees configured"
4. charges = building defaults overridden by unit fees
5. dryRun → preview { count, total, skipped[] }; no writes
6. otherwise ONE transaction: bills + charges + BILL_NEW notifications + activity log.
   The unique (unitId, billingMonth) index makes a double-click fail safely → whole run rolls back.
```

### 6.4 Record a payment (FR-11) and verify a report (FR-40)

Both use one internal function, `recordPayment(tx, input)`:

```
lock bill row (SELECT … FOR UPDATE)
balance = current balance
reject if amount <= 0 or amount > balance                    (BR-11)
reject if paidOn > today
if (method, reference) already used on a payment or another report
     → 409 DUPLICATE_REFERENCE unless confirm=true
receiptNo = Counter('RCPT', year(paidOn)).next()
insert payment; notify bill viewers; activity log
```

- **Report** (`POST /bills/:id/payment-reports`): lock bill; check `amount ≤ balance − pendingReported` (BR-21); save report + screenshot; notify `payments.record` holders.
- **Verify**: in one transaction, run `recordPayment` with the (optionally corrected) values, set report `VERIFIED` and `paymentReportId`, notify the reporter.
- **Reject**: set `REJECTED` + reason, notify the reporter.

### 6.5 Opening balances (FR-41)

Two ways to enter them, both admin-only and transactional:
1. Per unit: `POST /units/:id/opening-balance { amount, dueDate?, note }`.
2. In the unit CSV import (`opening_balance` column).

Each creates a `Bill(kind=OPENING_BALANCE, billingMonth = month before goLiveDate)` with one `OPENING_BALANCE` charge. Reports show opening balances as a separate line.

### 6.6 Statements and certificates (FR-45, FR-46)

**Statement** for unit U, period [from, to]:
```
opening = Σ charges of visible bills with billingMonth < from − Σ valid payments with paidOn < from
rows    = bills (by billingMonth) and valid payments (by paidOn) in the period, merged by date
closing = opening + Σ bills − Σ payments
```
A test asserts that a statement up to today has a `closing` equal to the FR-13 outstanding balance.

**Certificate:** in one transaction, check `Σ balance of all bills of U = 0` (BR-24), take `Counter('NDC', year)`, insert, log, and notify the resident. `coversThroughMonth` = latest `billingMonth` of U.

### 6.7 Maintenance transitions (BR-16)

One table in `maintenance/transitions.ts` drives both the server check and the buttons shown in the UI:

```ts
const transitions = {
  SUBMITTED:    { UNDER_REVIEW: 'reviewer', CANCELLED: 'submitter', REJECTED: 'reviewer' },
  UNDER_REVIEW: { IN_PROGRESS: 'assigneeOrAdmin', REJECTED: 'reviewer' },
  IN_PROGRESS:  { RESOLVED: 'assigneeOrAdmin' },          // note required
  RESOLVED:     { CLOSED: 'submitterOrAdminIfScheduled',  // + system auto-close
                  IN_PROGRESS: 'submitter' },             // reopen ≤ 7 days, note required
}
```

Each transition: insert `RequestUpdate`, update the request, notify the submitter's household and the assignee (not the actor), and write the activity log, all in one transaction. Setting the priority recomputes `dueAt` (BR-17), except for SCHEDULED requests (BR-25).

**Rating** (FR-50): allowed if the actor is the submitter, status is CLOSED (or being confirmed now), `closedAt` is within 7 days, and no rating exists yet.

### 6.8 Jobs

**Daily, 00:15 Asia/Dhaka** (also runs once at server start to catch up):
1. `BILL_DUE_SOON` — balance > 0 and `dueDate = today + reminderDaysBefore` (BR-20).
2. `BILL_OVERDUE` — balance > 0 and `dueDate = today − 1`.
3. Auto-close — RESOLVED requests with `resolvedAt < now − autoCloseDays` (BR-18). *(Built in Sprint 3 as `autoCloseResolved()`, run at server start and then hourly; Sprint 4 added the bill-reminder job beside it (`sendBillReminders()`, same schedule); a true daily schedule is still to do.)*
4. Scheduled tasks — active tasks with `nextDueDate − 7 days ≤ today`: create the request and advance `nextDueDate` by `intervalMonths`; loop until in the future, so missed periods are caught up (BR-25).

**Every 5 minutes:**
5. Publish due scheduled announcements — `publishAt ≤ now AND recipientsResolvedAt IS NULL`: resolve recipients, create notifications, set `recipientsResolvedAt` (FR-51).

Every job is idempotent (unique keys, or marker columns), so a crash or double run is harmless.

### 6.9 Notifications

`notify(tx, userIds[], { type, params, link, entityId })` is always given the caller's transaction. The web app polls `GET /api/notifications/unread-count` every 60 s while the tab is visible. `notify()` is the single extension point for adding SMS/email later (Q5).

### 6.10 PDF service

- One Chromium instance launched lazily with `playwright-core` and reused; at most 2 pages rendering at once (simple queue). Restarted automatically if it crashes.
- Templates are TypeScript functions returning HTML with escaped values. Fonts are embedded with `@font-face` from `server/assets/fonts`.
- Labels are translated with the requesting user's language. Amounts and dates use Western digits (BR-28).
- Output: A4, 15 mm margins, black-and-white friendly. Response: `Content-Type: application/pdf`, `Content-Disposition: attachment; filename="RCPT-2026-00042.pdf"`.
- Setup: `npx playwright install chromium` (free, ~150 MB, one-time).

| Template | FR | Contents |
|---|---|---|
| receipt | 14 | BR-14 fields, "VOID" watermark if voided |
| statement | 45 | header, opening/closing, rows with running balance |
| certificate | 46 | number, unit, resident, covers-through month, issuer, signature/seal box |
| notice | 53 | building name, large title, body, date |
| committee | 57 | occupancy, billing + trend chart, top-10 dues, expenses, maintenance, announcements |

### 6.11 Internationalization

- Translation files are in `packages/shared/locales/{en,bn}/{common,billing,maintenance,…}.json`. Keys only, never hard-coded strings in components. A CI check fails if a key exists in `en` but not in `bn`; admin-only namespaces are excluded in v1 (FR-47).
- The API returns **codes**, not sentences; the web translates them (see §7 error format). The server translates only PDFs and CSV headers.
- The language comes from `user.language`; on the login page it comes from `localStorage`, then `navigator.language`.
- `formatBDT(poisha)` uses `Intl.NumberFormat('en-IN', { minimumFractionDigits: 2 })` (lakh grouping, Western digits) with a `৳ ` prefix (BR-15). Dates use the `dd MMM yyyy` format, with month names translated.

### 6.12 PWA (FR-48)

- `vite-plugin-pwa` with a manifest (name, short name, theme colour, 192/512 px icons, `display: standalone`) and Apple touch icon meta tags for iOS.
- **Precache:** app shell, fonts, `offline.html`.
- **Runtime cache:** `NetworkFirst` for `GET /api/emergency-contacts` **only**. All other `/api/*` requests are `NetworkOnly`, so no private data is stored on the device.
- When offline, navigation falls back to `offline.html`, which shows the cached emergency contacts.
- On logout the service worker clears the runtime cache.

### 6.13 Bulk import (FR-42)

```
POST /api/import/{units|residents}?dryRun=true   body { csv }: UTF-8 text ≤ 700,000 characters
                                                 ≤ 2,000 unit rows or ≤ 200 resident rows
→ 200 { valid: boolean, rows: n, errors: [{ line, field, code }] }     (problems are a normal result of a check)
POST /api/import/{units|residents}               (same body; the web app sends it only after a clean check)
→ one transaction; residents → users + profiles + occupancies + one-time temporary passwords
→ 200 { valid: true, created: n, credentials: [{ fullName, loginId, tempPassword, unitNumber }] }   shown once, printable
→ 422 { error: IMPORT_INVALID, errors: [...] } if the file has problems (nothing is saved)
```

How it works: phase 1 checks every row without touching the database; phase 2 checks against existing data (taken unit
numbers and login IDs, unit exists and is available, billing contacts); phase 3 writes everything in one transaction.
Errors carry the file line, the column, and a code the web app translates.

Resident files are capped at 200 rows because each temporary password is hashed with bcrypt (about 60 ms at cost 10,
used for these single-use random passwords; real passwords stay at cost 12, about 230 ms). 200 rows take about 12 seconds.

Unit columns: `unit_number, floor, size_sqft, bedrooms` (an `opening_balance` column is added in Sprint 2 with FR-41).
Resident columns: `full_name, login_id, phone, unit_number, type (owner|tenant), start_date (YYYY-MM-DD), billing_contact (yes|no)`.

### 6.14 Income vs expense (FR-44)

The report is on a **cash basis**: income = valid payments by `paidOn`; expenses = non-voided expenses by `spentOn`. It returns monthly rows plus category totals. When `shareExpenseSummary` is on, residents call `GET /me/building-summary?month=` and get category totals only (no payee, description, or attachments).

### 6.15 Larger text (FR-55)

- `<html>` gets class `text-lg-mode`, which sets `font-size: 125%`. Because every Tailwind size is in `rem`, text, spacing, and buttons all scale together.
- Saved in `user.textSize` (follows the user across devices) and mirrored in `localStorage` so the login page uses it too.
- E2E checks every main page at 360 px in Large mode for horizontal overflow (`document.documentElement.scrollWidth <= innerWidth`).

### 6.16 Move-out wizard (FR-56)

```
GET  /api/occupancies/:id/move-out-preview?date=
→ { unit, balance, bills[], pendingReports[], openRequests[], isBillingContact,
    otherOccupants[], householdMembers[], hasOtherActiveOccupancy, canIssueCertificate }

POST /api/occupancies/:id/move-out
  { endDate, newBillingContactOccupancyId?, acknowledgeDues?: { note },
    issueCertificate: bool, deactivateAccount: bool }
```

The POST runs in **one transaction**:
1. Re-check the preview conditions. If the balance changed since the preview, return 409 `STALE_PREVIEW` so the admin reviews it again.
2. If the balance > 0, require `acknowledgeDues.note`.
3. Set `occupancy.endDate`.
4. If this resident was the billing contact and other occupants remain, require `newBillingContactOccupancyId` and move the flag (BR-06).
5. Set `removedAt = endDate` on the occupancy's household members (BR-27).
6. If `issueCertificate`, call the certificate service with the same `tx` (§6.6). It fails the whole move-out if the balance ≠ 0.
7. If `deactivateAccount` and the resident has no other active occupancy, deactivate the user and delete their sessions (BR-03).
8. Write one `ActivityLog` entry `occupancy.move_out` with the full summary in `diff`, and notify the resident.

Open maintenance requests stay open: they belong to the unit's problem, not the person. The wizard only lists them so the admin can reassign or close them.

### 6.17 Collection rate, trend, and committee report (FR-57, FR-58)

A SQL view `monthly_collection` built on `bill_summary`:

```
billingMonth, billed  = Σ total   of REGULAR bills in the month,
              collected = Σ paid    of those bills (valid payments, any date),
              rate     = round(collected * 100.0 / NULLIF(billed, 0), 1)       (BR-29)
```

- **Dashboard** (`GET /dashboard`) adds `collectionTrend`, the last 6 billing months from this view. The web shows a Recharts bar (billed vs collected) + line (rate) chart, with a "Show as table" toggle (NFR-12). Colours are taken from the design tokens and must pass contrast in both themes.
- **FR-15** reads the same view, so the dashboard and the report always match.
- **Committee report** (`GET /reports/committee.pdf?month=`) is built by `dashboard/committeeReport.ts`. It calls the existing report services (finance, dues, expenses, maintenance) for that month and renders the `committee` PDF template; the 6-month trend is drawn as inline SVG. Sections for features not built (expenses, ratings) are left out, decided by a `features` config, not by checking for empty data.

---

## 7. API

Base path `/api`. JSON only. All routes need a session except `POST /auth/login` and `GET /auth/csrf`. All state-changing routes need the `X-CSRF-Token` header.

**Error format** (codes only; the web translates them, FR-47 / NFR-11):
```json
{ "error": { "code": "VALIDATION_FAILED",
             "fields": { "amount": { "code": "AMOUNT_EXCEEDS_BALANCE", "params": { "balance": 250000 } } } } }
```
HTTP status codes: `VALIDATION_FAILED` 400, `UNAUTHENTICATED` 401, `FORBIDDEN` / `PASSWORD_CHANGE_REQUIRED` 403, `NOT_FOUND` 404, `CONFLICT` / `DUPLICATE_REFERENCE` 409, `LOCKED` 423, `RATE_LIMITED` 429.

**Lists** accept `?page=1&pageSize=25&sort=field:asc` and return `{ items, page, pageSize, total }`. CSV variants accept `?format=csv`.

| Method & path | Who | FR |
|---|---|---|
| **Auth & me** | | |
| `POST /auth/login` · `POST /auth/logout` · `GET /auth/me` · `GET /auth/csrf` | — | 01, 02 |
| `POST /auth/change-password` | any | 31 |
| `GET /me/profile` · `PATCH /me/profile` | resident | 07, 37 |
| `PATCH /me/preferences` `{ language?, textSize? }` | any | 47, 55 |
| **Residents, staff, households** | | |
| `GET /residents?q=&active=` · `POST /residents` · `GET/PATCH /residents/:id` | `residents.manage` | 03 |
| `POST /residents/:id/deactivate` · `/reactivate` | `residents.manage` | 03 |
| `POST /users/:id/reset-password` | admin | 31 |
| `GET/POST /staff` · `PATCH /staff/:id` · `PUT /staff/:id/permissions` · `POST /staff/:id/deactivate` | admin | 06 |
| `POST /occupancies/:id/members` · `DELETE /household-members/:id` | `residents.manage` | 54 |
| `GET /directory?q=` | `directory.view` | 08 |
| `GET /import/templates/{units\|residents}.csv` · `POST /import/{units\|residents}` | admin | 42 |
| **Units & occupancy** | | |
| `GET/POST /units` · `PATCH /units/:id` | `units.manage` | 04 |
| `GET/POST /units/:id/occupancies` · `PATCH /occupancies/:id` | `residents.manage` | 05 |
| `GET /occupancies/:id/move-out-preview?date=` · `POST /occupancies/:id/move-out` | admin | 56 |
| `POST /units/:id/opening-balance` | admin | 41 |
| **Billing** | | |
| `GET /fees` · `PUT /fees` | `billing.manage` | 32 |
| `POST /bills/generate` | `billing.manage` | 09 |
| `GET /bills?status=&month=&unitId=&kind=` | `billing.view` | 12 |
| `POST /bills` · `POST /bills/:id/charges` · `PATCH/DELETE /charges/:id` | `billing.manage` | 10 |
| `GET /bills/:id` | staff with `billing.view`, `billing.manage` or `payments.record`; or a resident through `bill_access` (404 otherwise) | 12, 13 |
| `POST /bills/:id/payments` | `payments.record` | 11 |
| `POST /payments/:id/void` | admin | 33 |
| `GET /payments/:id/receipt.pdf` | admin, `billing.view`, or `unit_access` | 14 |
| `POST /bills/:id/payment-reports` (multipart) | resident with `unit_access` | 39 |
| `GET /me/payment-reports` | resident | 39 |
| `GET /payment-reports?status=PENDING` · `POST /payment-reports/:id/verify` · `/reject` | `payments.record` | 40 |
| `GET /me/billing/bills` · `GET /me/billing/payments` · `GET /me/billing/balance` | resident | 13 |
| `GET/PUT /settings` · `GET /settings/public` (building name, any logged-in user) | admin · any | — |
| `DELETE /bills/:id` (opening balance only, while unpaid) | admin | 41 |
| `GET /me/statement?unitId=&from=&to=` (+ `.pdf`) | resident | 45 |
| `GET /units/:id/statement?from=&to=` (+ `.pdf`) | `billing.view` | 45 |
| `POST /units/:id/certificates` · `GET /certificates?number=` | admin | 46 |
| `GET /units/:id/certificates` · `GET /certificates/:id.pdf` | admin, `billing.view`, or the resident it was issued to | 46 |
| `GET /me/certificates` | resident | 46 |
| `GET /reports/finance?from=&to=` · `GET /reports/dues` | `reports.view` | 15, 38 |
| **Expenses** | | |
| `GET/POST /expenses` · `PATCH /expenses/:id` · `POST /expenses/:id/void` | `expenses.manage` | 43 |
| `GET /reports/income-expense?from=&to=` | `reports.view` | 44 |
| `GET /me/building-summary?month=` | resident, if shared | 44 |
| **Maintenance** | | |
| `POST /requests` (multipart) | resident | 16, 17 |
| `GET /requests?status=&category=&unitId=&assignedTo=&priority=&source=&from=&to=` | `maintenance.view_all` | 18, 22 |
| `GET /me/requests` · `GET /me/tasks` | resident · staff | 21 · 19, 20 |
| `GET /requests/:id` | scoped | 18, 21 |
| `PATCH /requests/:id/priority` | `maintenance.review` | 18 |
| `POST /requests/:id/assign` | `maintenance.assign` | 19 |
| `POST /requests/:id/transition` `{ to, note }` | per §6.7 | 18, 20, 35 |
| `POST /requests/:id/notes` (multipart) | assignee, reviewer, admin | 20 |
| `POST /requests/:id/rating` | submitter | 50 |
| `GET /attachments/:id` | access to owner record | 16, 39, 43 |
| `GET /reports/maintenance?from=&to=` | `reports.view` | 22, 50 |
| `GET/POST /scheduled-tasks` · `PATCH /scheduled-tasks/:id` · `POST /scheduled-tasks/:id/{pause\|resume}` · `GET /scheduled-tasks/upcoming` | `maintenance.assign` | 49 |
| **Announcements & notifications** | | |
| `GET /announcements?past=` | any (scoped) | 23, 51 |
| `POST /announcements` · `PATCH /announcements/:id` · `POST /announcements/:id/archive` | `announcements.manage` | 23, 24, 51 |
| `GET /announcements/:id/reads` | `announcements.manage` | 26 |
| `GET /announcements/:id/notice.pdf` | `announcements.manage` | 53 |
| `GET/POST/PATCH/DELETE /groups[/:id]` · `PUT /groups/:id/members` | `announcements.manage` | 36 |
| `GET /emergency-contacts` · `PUT /emergency-contacts` (full ordered list) | any · `announcements.manage` | 52 |
| `GET /notifications` · `GET /notifications/unread-count` · `POST /notifications/:id/read` · `POST /notifications/read-all` | any | 25, 26 |
| **Dashboard & admin** | | |
| `GET /dashboard` (incl. `collectionTrend`) | `reports.view` | 27–30, 58 |
| `GET /reports/committee.pdf?month=` | `reports.view` | 57 |
| `GET /search?q=` | admin / staff (filtered by permission) | 30 |
| `GET /activity?actorId=&action=&from=&to=` | admin | 34 |
| `GET/PUT /settings` | admin | — |

---

## 8. Frontend Pages

| Route | Role | Content |
|---|---|---|
| `/login` (language and A/A+ switch), `/change-password` | all | |
| `/` | resident | Balance card with **"I've paid"**, open requests, important + latest announcements, **Report a problem**, building summary (if shared). |
| `/` | staff | My tasks, overdue first. |
| `/` | admin | Dashboard: building, billing (incl. **pending payment reports** and **collection rate**), 6-month collection chart, maintenance cards; recent announcements and activity; search. |
| `/bills`, `/bills/:id` | resident / admin | Status chips; charges, payments, pending reports, receipt links. |
| `/bills/:id/report-payment` | resident | Amount, date, method, transaction ID, screenshot. |
| `/payment-reports` | admin / `payments.record` | Queue with screenshot preview, Verify / Reject. |
| `/bills/generate`, `/fees` | admin | |
| `/statement`, `/certificates` | resident | Period picker → view / PDF; my certificates. |
| `/units/:id` | admin | Occupancy history, household members, opening balance, statement, certificates, **Move out** button per active occupancy. |
| `/occupancies/:id/move-out` | admin | Wizard: date → dues → billing contact → certificate → account → summary → confirm. |
| `/expenses`, `/reports/income-expense` | admin / permitted | |
| `/requests`, `/requests/new`, `/requests/:id` | all (scoped) | Timeline; allowed action buttons; rating prompt. |
| `/scheduled-tasks` | admin / `maintenance.assign` | Task list + "next 90 days". |
| `/announcements[...]` | all / admin | Publish-at / ends-at; read stats; print notice. |
| `/emergency` | all | Tap-to-call list; works offline once loaded. |
| `/notifications` | all | |
| `/residents`, `/staff`, `/units`, `/groups`, `/directory`, `/import` | admin / permitted | |
| `/reports/finance`, `/reports/dues`, `/reports/maintenance` | admin / `reports.view` | Print + CSV. |
| `/reports/committee` | admin / `reports.view` | Month picker → download PDF. |
| `/activity`, `/settings` | admin | |

**UI rules:**
- Mobile-first; tables become cards below 640 px.
- Status = coloured chip + text label.
- Money only through `formatBDT()`.
- Confirm dialogs for destructive actions.
- Route guards hide pages, but the server is the real check.
- Every string goes through `t()`.
- Phone numbers are `tel:` links (UI-09).

---

## 9. Validation Summary

| Field | Rule |
|---|---|
| loginId | Valid email, or BD mobile `^(\+?88)?01[3-9]\d{8}$` normalized to `+8801…` |
| password | ≥ 8 chars, ≥ 1 letter, ≥ 1 digit |
| fullName | 2–100 chars |
| unitNumber | 1–10 chars, letters/digits/dash, unique case-insensitive |
| floor | Integer −2 … 100 |
| amounts | > 0, ≤ ৳1,00,00,000, max 2 decimals |
| payment amount | ≤ current balance |
| payment report amount | ≤ balance − pending reported |
| paidOn / spentOn | ≤ today |
| transaction reference | 4–40 chars, required on payment reports |
| occupancy dates | endDate ≥ startDate, no overlap |
| request title / description | 5–120 / 10–2000 chars |
| request photos | ≤ 3, JPG/PNG/WEBP by content, ≤ 5 MB each |
| payment screenshot / expense receipt | 1 file, JPG/PNG/WEBP/PDF by content, ≤ 5 MB |
| announcement title / body | 3–150 / 1–5000 chars; endsAt > publishAt |
| scheduled task interval | 1–24 months |
| rating | Integer 1–5, comment ≤ 500 chars |
| CSV import | UTF-8, ≤ 1 MB, ≤ 2,000 rows |

---

## 10. Security Checklist

- [ ] bcrypt cost 12; never log bodies of `/auth/*` (NFR-01)
- [ ] `requireAuth` on every router; `requirePermission` on every admin/staff route; a test enumerates all routes × roles (NFR-02)
- [ ] Session: 30 min rolling, `httpOnly`, `sameSite=lax`, `secure` in production; new session ID on login (NFR-03)
- [ ] Zod on every input; raw SQL only in migrations and the reviewed views/reports, always parameterized (NFR-04)
- [ ] `helmet` CSP; React escaping; PDF templates escape every value; no `dangerouslySetInnerHTML` (NFR-05)
- [ ] CSRF token on all non-GET (NFR-05)
- [ ] Uploads: `file-type` sniff, size limits, random names, `nosniff`, `Content-Disposition` (NFR-06)
- [ ] Chromium for PDFs: JavaScript disabled, all network requests blocked (only embedded fonts/data), so user text cannot load remote resources
- [ ] Login rate limit + lockout (NFR-07): the per-address limiter counts only FAILED logins (a building shares one Wi-Fi address); the per-account lockout is the main defence
- [ ] Resident queries always join `unit_access`; 404 on others' IDs; tests per endpoint (NFR-24)
- [ ] Screenshots/receipt photos only to their owners and permitted roles (NFR-23)
- [ ] Service worker caches no private API responses; cache cleared on logout (FR-48)
- [ ] Temp passwords shown once, never stored in plain text or logged
- [ ] CSV export: prefix cells starting with `= + - @` with `'` to prevent spreadsheet formula injection
- [ ] `.env` git-ignored; refuse to start in production with the default `SESSION_SECRET`

---

## 11. Testing Strategy

| Level | Tool | What |
|---|---|---|
| Unit | Vitest | Every BR: bill status, `unit_access` cases (§6.1), SLA/dueAt, transitions, ratings window, statement maths, counters, `formatBDT`, CSV parsing/escaping. |
| API | Vitest + Supertest on a throw-away Postgres DB | Every endpoint × every role; forced-failure rollbacks (NFR-14); concurrent payments and reports on one bill; idempotent jobs (run twice → same result). |
| End-to-end | Playwright (desktop + 375 px phone) | The journeys below, in English and in Bangla. |
| Visual | Manual checklist | Bangla conjuncts in all 4 PDF templates and CSV in Excel (NFR-28). |
| Performance | `autocannon` + `seed:large` | NFR-17–19; PDF render < 3 s. |
| Usability | 3+ real people, scripted tasks, timed | NFR-08, NFR-09. |
| Accessibility | axe in the e2e suite | NFR-12, WCAG 2.1 A and AA rules, every page, desktop and phone. |

**Core journeys (E2E):**
1. Admin imports units (with opening balances) and residents via CSV → resident logs in with temp password, changes it, sees opening balance.
2. Admin sets fees → generates bills → resident reports a bKash payment with screenshot → admin verifies → resident downloads receipt and statement.
3. Resident pays all dues → admin runs the move-out wizard (new billing contact, certificate, deactivate) → resident's household member loses access → unit shows Vacant if empty → certificate downloadable by admin.
4. Resident submits request with photo → admin prioritizes, assigns → staff progresses → resolves → resident confirms and rates.
5. Admin publishes a scheduled, floor-targeted announcement → only targeted residents see it after publish time → admin sees read status and prints notice.
6. Resident tries another resident's bill, request, receipt, and attachment by URL → "not found" each time.
7. Resident switches to Bangla and Large text → home, bills, request form, notification, and receipt are in Bangla, and no page scrolls sideways at 360 px.
8. Admin dashboard collection rate and trend match the finance report; committee report PDF figures match FR-15/22/44 for the same month.

Test names start with the FR or BR ID (e.g. `BR-21 rejects report above remaining balance`).

---

## 12. Seed Data

`npm run seed` creates a demo building:

- **Users:** 1 admin (`admin@demo.local` / `Admin1234`); 2 staff (one with no extra permissions, one with `maintenance.*` + `payments.record`).
- **Units:** 6 floors × 4 units = 24 units (`1A`–`6D`), 20 occupied, 1 unavailable.
- **Residents:** ~30 owners and tenants with a mix of English and Bangla names (e.g. "রহিম উদ্দিন"); one moved-out resident with history; one household with a household member.
- **Billing:**
  - go-live 3 months ago; opening balances on 4 units
  - service charge ৳3,000 building-wide, rent on 5 tenant units
  - bills in every status; one voided payment
  - 3 pending payment reports, 1 rejected
- **Other:**
  - 1 no-dues certificate
  - expenses for 3 months across categories
  - ~15 requests in every status, some overdue, some rated
  - 2 scheduled tasks (lift monthly, water tank every 6 months)
  - 5 announcements (one important, one floor-targeted, one scheduled, one ended); a "Committee" group; 6 emergency contacts

**Demo mode** (`DEMO_MODE=true`, never in production): the login page shows "Log in as Admin / Staff / Resident" buttons, and `npm run demo:reset` reseeds in seconds. This is for the course presentation only.

`npm run seed:large` adds 500 units / 2,000 residents for performance tests.

---

## 13. Environment and Operations

**.env**
```
DATABASE_URL=postgresql://apt:apt@localhost:5432/apartment
SESSION_SECRET=change-me
PORT=4000
UPLOAD_DIR=./uploads
NODE_ENV=development
DEMO_MODE=true
```

**First-time setup** (all free)
1. Install Node 22+ and PostgreSQL 16+ (or Docker Desktop).
2. Create the DB user and database: `powershell -ExecutionPolicy Bypass -File scripts/setup-db.ps1` (or `docker compose up -d`). Tests use a separate `apartment_test` database.
3. Run:
   ```
   npm install
   npx playwright install chromium
   npm run db:migrate
   npm run seed
   npm run dev                  # server :4000 + web :5173 (proxy /api)
   ```

**Other commands**
```
npm test             # shared + server (API, against apartment_test) + web unit tests
npm run test:e2e     # Playwright, desktop + phone; own database apartment_e2e on ports 4100/5174
npm run app          # production build; Express serves web/dist on port 4000
npm run test:pwa     # the built site: install, offline, security policy
npm run demo:reset   # deletes everything and rebuilds the demo (DEMO_MODE=true only)
```

**Backups (NFR-15, NFR-16):**
- `scripts/backup` runs `pg_dump -Fc` to `backups/apartment-YYYY-MM-DD.dump`, copies `uploads/` alongside, and deletes copies older than 7 days.
- Schedule it daily with Windows Task Scheduler or cron.
- `scripts/restore <file>` restores into a fresh DB. Test the restore before the final demo and record the result in the README.

**Demo hosting:** run on a team laptop (most reliable, works offline). Free cloud hosts with 512 MB RAM are too tight for Chromium PDF rendering, so don't rely on them for the demo.

---

## 14. Delivery Plan

A 12-week plan. *Must* items come first so a working product exists by week 9 (SRS risk R6). i18n keys and PWA shell are set up in Sprint 0, so the Bangla work later is only translating text, not rewriting screens.

| Sprint | Goal | Requirements | Exit criteria |
|---|---|---|---|
| 0 (wk 1) | Foundations | — | Repo, CI, Prisma schema v1 + SQL views, auth skeleton, layouts, i18n setup, PWA shell, PDF service "hello world" with Bangla, seed. |
| 1 (wk 2–3) | People & places | FR-01–07, 31, 42 | Admin manages units, residents, occupancies, staff, CSV import; authz tests green. Journey 1 (minus opening balance). |
| 2 (wk 4–5) | Money core | FR-09–14, 32, 41 | Fees, opening balances, bill generation, payments, receipts. Journey 2 via admin entry. |
| 3 (wk 6–7) | Maintenance | FR-16–21, 35 | Full request lifecycle with photos. Journey 4 (minus rating). |
| 4 (wk 8–9) | Communication & overview | FR-15, 23–29 | Announcements, notifications, daily jobs, dashboard, finance report. **All Must done.** |
| 5 (wk 10) | Finance extras | FR-33, 39, 40, 45, 46, 56, 43, 44 | Payment reports, statements, certificates, move-out wizard, expenses. Journeys 2–3. |
| 6 (wk 11) | Polish & Should | FR-08, 22, 30, 34, 47 (Bangla text complete), 48, 55, 58 | Usability test, accessibility pass, perf tests, backup/restore test. Journeys 7–8. |
| 7 (wk 12) | Demo | Could items only if everything above is green (FR-57 first: it reuses existing reports) | Bug fixes, final seed, rehearsed demo script, diagrams and docs final. |

**Cut order if behind:** FR-38 → FR-36 → FR-53 → FR-51 → FR-49 → FR-50 → FR-37 → FR-54 → FR-52 → FR-57 → FR-30 search → FR-44 resident sharing → FR-22 extras. *Must* items are never cut. FR-55 is nearly free if sizes are in `rem` from Sprint 0, so keep it.

**Suggested ownership (4-person team):** A — users + auth + import; B — billing + PDFs; C — maintenance + jobs; D — frontend shell, i18n, PWA, announcements, dashboard. Everyone writes tests for their module.

### Workflow

- One GitHub Issue per FR, labelled with module and priority, on a GitHub Projects board.
- Branches named `feat/FR-39-payment-reports`; PRs into `main`, one reviewer, CI must pass.
- The PR template asks:
  - Which FR/BR does this implement?
  - Are the confirmation bullets tested?
  - Are the permission tests added?
  - Are translation keys added?

### Definition of Done (per story)

- All SRS confirmation bullets met and covered by tests.
- Server-side permission check tested for every role.
- Works at 375 px and desktop; strings translated (EN at minimum; BN for resident/staff screens by Sprint 6).
- Writes listed in FR-34 are logged.
- OpenAPI updated; PR reviewed and merged with CI green.

---

## 15. Technical Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Chromium PDF rendering uses ~150–300 MB RAM | Slow or failing PDFs on weak machines | One shared browser, 2-page queue, lazy start; demo on a laptop. Fallback: a print-friendly HTML page (`/print/...`) that the browser's own "Save as PDF" handles. |
| Bangla translation takes longer than expected | FR-47 incomplete | Keys from day one; translate resident screens first; admin screens may stay English (FR-47). |
| Scope (54 FRs) | Unfinished features | Priorities, cut order, Must complete by week 9. |
| Prisma can't express partial indexes / exclusion constraints | Rules silently unenforced | Raw SQL migrations + tests that try to violate each constraint. |
| Team members unfamiliar with TypeScript/Prisma | Slow Sprint 1 | Sprint 0 includes one fully worked example module (units) as a pattern to copy. |

---

## 16. Open Decisions

These mirror SRS Appendix E. Current defaults are built in.

| # | Decision | Default |
|---|---|---|
| Q1 | Rent collected by management? | Optional `RENT` charge type. |
| Q2 | Staff can record payments? | Only with `payments.record`. |
| Q3 | Non-resident owners get accounts? | Yes, via an OWNER occupancy. |
| Q4 | Late fees? | None in v1. |
| Q5 | SMS/email later? | Add channels inside `notify()`. |
| Q6 | Residents see expense summary? | Off; admin toggle `shareExpenseSummary`. |
| Q7 | Bangla digits? | No, Western digits with lakh grouping. |
| Q8 | Residents add household members? | Admin only. |
| Q9 | Move-out with unpaid dues allowed? | Yes, with an explicit note; dues stay on the unit's bills and in the dues report. |
