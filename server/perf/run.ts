// Load test against generated data (NFR-17, NFR-18, NFR-19, and the 3-second PDF target).
// Run with: npm run perf   (from the server folder). It uses its own database, apartment_perf, and rebuilds it.
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { pool } from '../src/lib/pool';
import { hashPassword } from '../src/modules/users/auth.service';
import { closePdfBrowser } from '../src/pdf/render';
import { addMonths, currentMonthDhaka, todayDhaka } from '../src/lib/dates';

const UNITS = 500;
const RESIDENTS = 2000;
const MONTHS = 6;
const USERS = 20; // concurrent people (NFR-17)
const SECONDS = 20;
const PASSWORD = 'Passw0rd1';
const day = (s: string) => new Date(`${s}T00:00:00Z`);

async function chunked<T>(rows: T[], size: number, write: (part: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += size) await write(rows.slice(i, i + size));
}

async function seed() {
  const hash = await hashPassword(PASSWORD);
  const adminId = crypto.randomUUID();
  await prisma.user.create({ data: { id: adminId, loginId: 'admin@perf.local', passwordHash: hash, role: 'ADMIN', fullName: 'Perf Admin', phone: '+8801700000000', mustChangePassword: false } });
  await prisma.setting.createMany({ data: [{ key: 'buildingName', value: 'Perf Tower' }, { key: 'goLiveDate', value: '2020-01-01' }] });
  await prisma.unitFee.createMany({ data: [{ unitId: null, chargeType: 'SERVICE', amount: 300000, description: 'Service charge' }, { unitId: null, chargeType: 'WATER', amount: 50000, description: 'Water' }] });

  const units = Array.from({ length: UNITS }, (_, i) => ({ id: crypto.randomUUID(), unitNumber: `${Math.floor(i / 10) + 1}${String.fromCharCode(65 + (i % 10))}`, floor: Math.floor(i / 10) + 1 }));
  await prisma.unit.createMany({ data: units });

  const names = ['Rahim', 'Karim', 'Salma', 'Nasrin', 'Jamal', 'Farida', 'Hasan', 'Ayesha', 'Tanvir', 'Mitu'];
  const residents = Array.from({ length: RESIDENTS }, (_, i) => ({
    id: crypto.randomUUID(),
    loginId: `r${i}@perf.local`,
    passwordHash: hash,
    role: 'RESIDENT' as const,
    fullName: `${names[i % 10]} ${['Uddin', 'Mia', 'Begum', 'Khan'][i % 4]} ${i}`,
    phone: `+88017${String(10000000 + i).slice(-8)}`,
    mustChangePassword: false,
  }));
  await chunked(residents, 500, (part) => prisma.user.createMany({ data: part }));
  // Four residents to a unit; the first is the billing contact.
  await chunked(
    residents.map((r, i) => ({ unitId: units[i % UNITS]!.id, residentId: r.id, type: 'TENANT' as const, startDate: day('2020-01-01'), isBillingContact: i < UNITS })),
    500,
    (part) => prisma.occupancy.createMany({ data: part }),
  );

  const now = currentMonthDhaka();
  const billRows: { id: string; unitId: string; billingMonth: Date; dueDate: Date; billingContactId: string; createdById: string }[] = [];
  for (let m = 1; m <= MONTHS; m++) {
    const month = addMonths(now, -m);
    units.forEach((u, i) => billRows.push({ id: crypto.randomUUID(), unitId: u.id, billingMonth: day(`${month}-01`), dueDate: day(`${month}-10`), billingContactId: residents[i]!.id, createdById: adminId }));
  }
  await chunked(billRows, 1000, (part) => prisma.bill.createMany({ data: part }));
  await chunked(billRows.map((b) => ({ billId: b.id, type: 'SERVICE' as const, amount: 300000, description: 'Service charge' })), 1000, (part) => prisma.charge.createMany({ data: part }));
  const paid = billRows.filter((_, i) => i % 5 !== 0);
  await chunked(
    paid.map((b, i) => ({ billId: b.id, amount: 300000, paidOn: b.dueDate, method: 'BKASH' as const, reference: `T${i}`, receiptNo: `RCPT-2000-${i}`, recordedById: adminId })),
    1000,
    (part) => prisma.payment.createMany({ data: part }),
  );
  const cats = ['PLUMBING', 'ELECTRICAL', 'LIFT', 'OTHER'] as const;
  await chunked(
    Array.from({ length: 2000 }, (_, i) => ({
      submittedById: residents[i % RESIDENTS]!.id,
      unitId: units[i % UNITS]!.id,
      location: 'UNIT' as const,
      category: cats[i % 4]!,
      title: `Problem number ${i} with the kitchen tap`,
      description: 'Generated for the load test.',
      dueAt: new Date(Date.now() + 86_400_000),
    })),
    500,
    (part) => prisma.maintenanceRequest.createMany({ data: part }),
  );
  return { units, residents, paid };
}

interface Session {
  cookie: string;
  csrf: string;
}

async function login(base: string, loginId: string): Promise<Session> {
  const first = await fetch(`${base}/api/auth/csrf`);
  const firstCookie = first.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const { csrfToken } = (await first.json()) as { csrfToken: string };
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken, Cookie: firstCookie },
    body: JSON.stringify({ loginId, password: PASSWORD }),
  });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return { cookie: res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '), csrf: ((await res.json()) as { csrfToken: string }).csrfToken };
}

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))]!;

async function timed(base: string, s: Session, path: string, init: RequestInit = {}) {
  const started = performance.now();
  const res = await fetch(`${base}${path}`, { ...init, headers: { Cookie: s.cookie, 'X-CSRF-Token': s.csrf, ...(init.headers ?? {}) } });
  await res.arrayBuffer();
  return { ms: performance.now() - started, status: res.status };
}

const line = (name: string, value: string, limit: string, ok: boolean) => console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(52)} ${value.padStart(12)}   target ${limit}`);

async function main() {
  console.log(`Seeding ${UNITS} units, ${RESIDENTS} residents, ${UNITS * MONTHS} bills, 2000 requests...`);
  const { paid } = await seed();
  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const admin = await login(base, 'admin@perf.local');
  let failed = false;
  const report = (name: string, ms: number, limit: number) => {
    if (ms > limit) failed = true;
    line(name, `${Math.round(ms)} ms`, `<= ${limit} ms`, ms <= limit);
  };

  // NFR-19
  const gen = await timed(base, admin, '/api/bills/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ month: currentMonthDhaka() }) });
  if (gen.status !== 200) throw new Error(`generate failed: ${gen.status}`);
  report(`NFR-19 generate bills for ${UNITS} units`, gen.ms, 10_000);

  // NFR-18: each search on its own, repeated, slowest 5% excluded by p95
  const month = addMonths(currentMonthDhaka(), -1);
  const searches = ['/api/search?q=rahim', '/api/search?q=0171', '/api/search?q=12A', `/api/search?q=12A%20${month}`, '/api/units?q=12', '/api/residents?q=karim', `/api/bills?month=${month}&status=OVERDUE`, '/api/requests?q=kitchen', '/api/requests?status=SUBMITTED&category=LIFT', '/api/activity?action=login.success'];
  for (const path of searches) {
    const runs: number[] = [];
    for (let i = 0; i < 20; i++) {
      const r = await timed(base, admin, path);
      if (r.status !== 200) throw new Error(`${path}: ${r.status}`);
      runs.push(r.ms);
    }
    report(`NFR-18 ${path}`, percentile(runs.sort((a, b) => a - b), 95), 1000);
  }

  // PDF
  const pdfRuns: number[] = [];
  const someone = await prisma.payment.findFirstOrThrow({ select: { id: true } });
  await timed(base, admin, `/api/payments/${someone.id}/receipt.pdf`); // the browser starts on first use
  for (let i = 0; i < 5; i++) pdfRuns.push((await timed(base, admin, `/api/payments/${someone.id}/receipt.pdf`)).ms);
  report('PDF receipt', percentile(pdfRuns.sort((a, b) => a - b), 95), 3000);

  // NFR-17: 20 people working at once, half of them office staff, with some saving records.
  const sessions: Session[] = [];
  for (let i = 0; i < USERS / 2; i++) sessions.push(await login(base, 'admin@perf.local'));
  const residents: Session[] = [];
  for (let i = 0; i < USERS / 2; i++) residents.push(await login(base, `r${i}@perf.local`));
  const openBills = await prisma.$queryRaw<{ id: string }[]>`SELECT "billId"::text AS id FROM bill_summary WHERE balance > 0 LIMIT 2000`;

  const lat: number[] = [];
  let errors = 0;
  let next = 0;
  const stop = Date.now() + SECONDS * 1000;
  const today = todayDhaka();
  const record = (r: { ms: number; status: number }) => {
    lat.push(r.ms);
    if (r.status >= 500) errors++;
  };
  const office = async (s: Session) => {
    const pages = ['/api/dashboard', '/api/units?page=3', '/api/residents?page=5', `/api/bills?month=${month}`, '/api/requests', '/api/reports/dues', '/api/notifications', '/api/search?q=salma'];
    let i = 0;
    while (Date.now() < stop) {
      record(await timed(base, s, pages[i++ % pages.length]!));
      if (i % 5 === 0) {
        const bill = openBills[next++ % openBills.length]!;
        record(await timed(base, s, `/api/bills/${bill.id}/payments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: 100, paidOn: today, method: 'CASH' }) }));
      }
    }
  };
  const person = async (s: Session) => {
    const pages = ['/api/me/billing/balance', '/api/me/billing/bills', '/api/me/requests', '/api/notifications/unread-count', '/api/announcements'];
    let i = 0;
    while (Date.now() < stop) record(await timed(base, s, pages[i++ % pages.length]!));
  };
  await Promise.all([...sessions.map(office), ...residents.map(person)]);
  lat.sort((a, b) => a - b);
  console.log(`\n${lat.length} requests in ${SECONDS}s from ${USERS} people (${Math.round(lat.length / SECONDS)}/s), ${errors} server errors`);
  report('NFR-17 p50', percentile(lat, 50), 2000);
  report('NFR-17 p95', percentile(lat, 95), 2000);
  line('NFR-17 slowest single request', `${Math.round(lat.at(-1)!)} ms`, '(information)', true);
  if (errors > 0) failed = true;

  void paid;
  server.close();
  await closePdfBrowser();
  await prisma.$disconnect();
  await pool.end();
  console.log(failed ? '\nSome targets were missed.' : '\nAll targets met.');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
