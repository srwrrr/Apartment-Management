import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { pool } from '../src/lib/pool';
import { client, d, loginAs, makeLoginUser, makeUnit, resetDb } from './helpers';

const app = createApp();
beforeEach(resetDb);
afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
  await pool.end();
});

type C = Awaited<ReturnType<typeof client>>;
const run = (c: C, kind: 'units' | 'residents', csv: string, dry = false) =>
  c.post(`/api/import/${kind}${dry ? '?dryRun=true' : ''}`, { csv });
const admin = () => loginAs(app, 'ADMIN');
const errs = (res: { body: { errors: { line: number; field: string; code: string }[] } }) => res.body.errors;

const UNITS = 'unit_number,floor,size_sqft,bedrooms\r\n1A,1,900,2\r\n1B,1,,\r\n2A,2,1200,3\r\n';
const RES_HEADER = 'full_name,login_id,phone,unit_number,type,start_date,billing_contact\r\n';

describe('FR-42 access', () => {
  it('administrators only: 401, 403 for residents and for staff with every permission', async () => {
    expect((await run(await client(app), 'units', UNITS)).status).toBe(401);
    expect((await run((await loginAs(app, 'RESIDENT')).c, 'units', UNITS)).status).toBe(403);
    const staff = await loginAs(app, 'STAFF', ['units.manage', 'residents.manage', 'directory.view']);
    expect((await run(staff.c, 'units', UNITS)).status).toBe(403);
    expect((await run(staff.c, 'residents', RES_HEADER)).status).toBe(403);
    expect((await staff.c.get('/api/import/templates/units.csv')).status).toBe(403);
    expect(await prisma.unit.count()).toBe(0);
  });

  it('serves header-only templates with a byte-order mark so Excel reads Bangla', async () => {
    const { c } = await admin();
    const units = await c.get('/api/import/templates/units.csv');
    expect(units.status).toBe(200);
    expect(units.headers['content-type']).toMatch(/text\/csv/);
    expect(units.headers['content-disposition']).toMatch(/attachment/);
    expect(units.text).toBe('﻿unit_number,floor,size_sqft,bedrooms\r\n');
    expect((await c.get('/api/import/templates/residents.csv')).text).toContain('full_name,login_id,phone,unit_number,type,start_date,billing_contact');
    expect((await c.get('/api/import/templates/other.csv')).status).toBe(404);
    expect((await run(c, 'nothing' as 'units', UNITS)).status).toBe(404);
  });
});

describe('FR-42 units import', () => {
  it('a dry run checks the file and saves nothing', async () => {
    const { c } = await admin();
    const res = await run(c, 'units', UNITS, true);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ valid: true, rows: 3, errors: [] });
    expect(await prisma.unit.count()).toBe(0);
  });

  it('imports every unit, with optional columns left empty', async () => {
    const { c } = await admin();
    const res = await run(c, 'units', UNITS);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ valid: true, created: 3 });
    const units = await prisma.unit.findMany({ orderBy: { unitNumber: 'asc' } });
    expect(units.map((u) => [u.unitNumber, u.floor, u.sizeSqft, u.bedrooms])).toEqual([
      ['1A', 1, 900, 2],
      ['1B', 1, null, null],
      ['2A', 2, 1200, 3],
    ]);
    expect((await c.get('/api/units')).body.total).toBe(3);
  });

  it('accepts a byte-order mark, quoted cells, odd header case/spacing and blank lines', async () => {
    const { c } = await admin();
    const csv = '﻿ Unit_Number , FLOOR ,size_sqft,bedrooms\n"3A", 3 ,,\n\n"3B",3,"1,000",\n'.replace('"1,000"', '1000');
    const res = await run(c, 'units', csv);
    expect(res.body).toMatchObject({ valid: true, created: 2 });
    expect(await prisma.unit.count({ where: { unitNumber: { in: ['3A', '3B'] } } })).toBe(2);
  });

  it('reports a missing required column and unknown columns at line 1', async () => {
    const { c } = await admin();
    const missing = await run(c, 'units', 'unit_number,size_sqft\r\n1A,100\r\n', true);
    expect(missing.body.valid).toBe(false);
    expect(errs(missing)).toContainEqual({ line: 1, field: 'floor', code: 'MISSING_COLUMN' });
    const unknown = await run(c, 'units', 'unit_number,floor,flor\r\n1A,1,1\r\n', true);
    expect(errs(unknown)).toContainEqual({ line: 1, field: 'flor', code: 'UNKNOWN_COLUMN' }); // a typo must not silently drop data
  });

  it('rejects an empty file and a header-only file', async () => {
    const { c } = await admin();
    expect(errs(await run(c, 'units', '', true))[0]).toMatchObject({ code: 'EMPTY_FILE' });
    expect(errs(await run(c, 'units', '﻿  \r\n ', true))[0]).toMatchObject({ code: 'EMPTY_FILE' });
    expect(errs(await run(c, 'units', 'unit_number,floor\r\n', true))[0]).toMatchObject({ code: 'NO_ROWS' });
  });

  it('points at the exact line and field of every problem', async () => {
    const { c } = await admin();
    const csv = [
      'unit_number,floor,size_sqft,bedrooms',
      '1A,1,900,2', // line 2: fine
      ',1,,', // line 3: unit number missing
      'TOOLONGUNIT1,1,,', // line 4: too long
      'B 5,1,,', // line 5: space not allowed
      '2A,abc,,', // line 6: floor not a number
      '2B,101,,', // line 7: floor out of range
      '2C,2,-5,', // line 8: size
      '2D,2,,21', // line 9: bedrooms
      '2E,,,', // line 10: floor missing
    ].join('\r\n');
    const res = await run(c, 'units', csv, true);
    expect(res.body.valid).toBe(false);
    expect(errs(res)).toEqual([
      { line: 3, field: 'unit_number', code: 'REQUIRED' },
      { line: 4, field: 'unit_number', code: 'UNIT_NUMBER_INVALID' },
      { line: 5, field: 'unit_number', code: 'UNIT_NUMBER_INVALID' },
      { line: 6, field: 'floor', code: 'FLOOR_INVALID' },
      { line: 7, field: 'floor', code: 'FLOOR_INVALID' },
      { line: 8, field: 'size_sqft', code: 'SIZE_INVALID' },
      { line: 9, field: 'bedrooms', code: 'BEDROOMS_INVALID' },
      { line: 10, field: 'floor', code: 'REQUIRED' },
    ]);
  });

  it('BR-04 rejects duplicates inside the file (any letter case) and units that already exist', async () => {
    const { c } = await admin();
    await makeUnit('9Z', 9);
    const res = await run(c, 'units', 'unit_number,floor\r\n4B,4\r\n4b,4\r\n9z,9\r\n5A,5\r\n', true);
    expect(errs(res)).toEqual([
      { line: 3, field: 'unit_number', code: 'UNIT_NUMBER_DUPLICATE_IN_FILE' },
      { line: 4, field: 'unit_number', code: 'UNIT_NUMBER_TAKEN' },
    ]);
  });

  it('NFR-14 one bad row means nothing is saved, and a real import of a bad file is refused', async () => {
    const { c } = await admin();
    const res = await run(c, 'units', 'unit_number,floor\r\n1A,1\r\n1B,1\r\n1C,not-a-number\r\n');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('IMPORT_INVALID');
    expect(errs(res)).toEqual([{ line: 4, field: 'floor', code: 'FLOOR_INVALID' }]);
    expect(await prisma.unit.count()).toBe(0);
  });

  it('importing the same file twice does not create duplicates', async () => {
    const { c } = await admin();
    expect((await run(c, 'units', UNITS)).status).toBe(200);
    const again = await run(c, 'units', UNITS);
    expect(again.status).toBe(422);
    expect(errs(again).every((e) => e.code === 'UNIT_NUMBER_TAKEN')).toBe(true);
    expect(await prisma.unit.count()).toBe(3);
  });

  it('allows up to 2000 rows and refuses more', async () => {
    const { c } = await admin();
    const make = (n: number) => 'unit_number,floor\r\n' + Array.from({ length: n }, (_, i) => `U${i + 1},${(i % 20) + 1}`).join('\r\n');
    const ok = await run(c, 'units', make(2000));
    expect(ok.body).toMatchObject({ valid: true, created: 2000 });
    await resetDb();
    const { c: c2 } = await admin();
    const tooMany = await run(c2, 'units', make(2001), true);
    expect(errs(tooMany)[0]).toMatchObject({ code: 'TOO_MANY_ROWS' });
    expect(await prisma.unit.count()).toBe(0);
  });

  it('reports a row with the wrong number of cells', async () => {
    const { c } = await admin();
    const res = await run(c, 'units', 'unit_number,floor\r\n1A,1\r\n1B,1,extra,more\r\n', true);
    expect(errs(res)).toContainEqual({ line: 3, field: '_', code: 'ROW_COLUMN_MISMATCH' });
  });

  it('refuses a file that is far too large with a clear error', async () => {
    const { c } = await admin();
    const res = await run(c, 'units', 'x'.repeat(900_000), true);
    expect([400, 413]).toContain(res.status);
    expect(res.status).not.toBe(500);
  });
});

describe('FR-42 residents import', () => {
  async function withUnits() {
    await prisma.unit.createMany({
      data: [
        { unitNumber: '1A', floor: 1 },
        { unitNumber: '1B', floor: 1 },
        { unitNumber: '2A', floor: 2 },
        { unitNumber: 'X9', floor: 9, isAvailable: false },
      ],
    });
  }

  it('a dry run saves nothing', async () => {
    const { c } = await admin();
    await withUnits();
    const res = await run(c, 'residents', RES_HEADER + 'Rahim Uddin,rahim@example.com,01712345678,1A,tenant,2026-01-01,yes\r\n', true);
    expect(res.body).toMatchObject({ valid: true, rows: 1, errors: [] });
    expect(res.body.credentials).toBeUndefined();
    expect(await prisma.user.count({ where: { role: 'RESIDENT' } })).toBe(0);
  });

  it('creates residents, stays and billing contacts, and returns one-time temporary passwords', async () => {
    const { c } = await admin();
    await withUnits();
    const csv =
      RES_HEADER +
      'রহিম উদ্দিন,rahim@example.com,01712345678,1A,owner,2025-01-01,yes\r\n' +
      'Karima Begum,01812345679,01812345679,1A,tenant,2025-06-01,no\r\n' +
      'Selim Khan,selim@example.com,+8801912345678,1B,tenant,2025-03-01,\r\n' + // first in 1B becomes billing contact
      'No Unit Yet,nounit@example.com,01612345678,,,,\r\n';
    const res = await run(c, 'residents', csv);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ valid: true, created: 4 });
    expect(res.body.credentials).toHaveLength(4);

    const users = await prisma.user.findMany({ where: { role: 'RESIDENT' }, include: { profile: true, occupancies: { include: { unit: true } } } });
    expect(users).toHaveLength(4);
    for (const u of users) {
      expect(u.mustChangePassword).toBe(true);
      expect(u.profile).toBeTruthy();
      expect(u.passwordHash).toMatch(/^\$2[aby]\$/);
    }
    const rahim = users.find((u) => u.loginId === 'rahim@example.com')!;
    expect(rahim.fullName).toBe('রহিম উদ্দিন');
    expect(rahim.occupancies[0]).toMatchObject({ type: 'OWNER', isBillingContact: true });
    expect(users.find((u) => u.loginId === '+8801812345679')!.occupancies[0]).toMatchObject({ type: 'TENANT', isBillingContact: false });
    expect(users.find((u) => u.loginId === 'selim@example.com')!.occupancies[0]).toMatchObject({ isBillingContact: true });
    expect(users.find((u) => u.loginId === 'nounit@example.com')!.occupancies).toHaveLength(0);

    // exactly one active billing contact per occupied unit (BR-06), and units now show as occupied (BR-05)
    for (const unitNumber of ['1A', '1B']) {
      expect(await prisma.occupancy.count({ where: { unit: { unitNumber }, isBillingContact: true, endDate: null } })).toBe(1);
    }
    const unitList = (await c.get('/api/units')).body.items as { unitNumber: string; status: string }[];
    expect(unitList.find((u) => u.unitNumber === '1A')!.status).toBe('OCCUPIED');
    expect(unitList.find((u) => u.unitNumber === '2A')!.status).toBe('VACANT');
  });

  it('every returned temporary password really logs that resident in, and must then be changed', async () => {
    const { c } = await admin();
    await withUnits();
    const res = await run(c, 'residents', RES_HEADER + 'A One,a1@example.com,01711111111,,,,\r\nB Two,b2@example.com,01722222222,,,,\r\n');
    const creds = res.body.credentials as { loginId: string; tempPassword: string }[];
    expect(new Set(creds.map((x) => x.tempPassword)).size).toBe(2);
    for (const cred of creds) {
      const login = await (await client(app)).login(cred.loginId, cred.tempPassword);
      expect(login.status).toBe(200);
      expect(login.body.mustChangePassword).toBe(true);
    }
  });

  it('BR-06 an explicit billing contact wins over file order', async () => {
    const { c } = await admin();
    await withUnits();
    const csv =
      RES_HEADER +
      'First Person,first@example.com,01711111111,1A,tenant,2025-01-01,no\r\n' +
      'Second Person,second@example.com,01722222222,1A,owner,2025-01-01,yes\r\n';
    expect((await run(c, 'residents', csv)).status).toBe(200);
    const contact = await prisma.occupancy.findFirstOrThrow({ where: { isBillingContact: true }, include: { resident: true } });
    expect(contact.resident.loginId).toBe('second@example.com');
    expect(await prisma.occupancy.count({ where: { isBillingContact: true } })).toBe(1);
  });

  it('points at the exact line and field of every problem', async () => {
    const { c } = await admin();
    await withUnits();
    const csv = [
      RES_HEADER.trim(),
      'A,ok1@example.com,01711111111,,,,', // 2: name too short
      'Good Name,not-an-id,01711111111,,,,', // 3: login id
      'Good Name,ok3@example.com,12345,,,,', // 4: phone
      'Good Name,ok4@example.com,01711111111,1A,,,', // 5: type + start date missing
      'Good Name,ok5@example.com,01711111111,1A,landlord,2026-01-01,', // 6: type
      'Good Name,ok6@example.com,01711111111,1A,owner,2026-02-30,', // 7: date
      'Good Name,ok7@example.com,01711111111,1A,owner,2026-01-01,maybe', // 8: billing contact value
      'Good Name,ok8@example.com,01711111111,,,,yes', // 9: contact without a unit
      'Good Name,ok9@example.com,01711111111,ZZ9,owner,2026-01-01,', // 10: unknown unit
      'Good Name,ok10@example.com,01711111111,X9,owner,2026-01-01,', // 11: unavailable unit
      ',ok11@example.com,01711111111,,,,', // 12: name missing
    ].join('\r\n');
    const res = await run(c, 'residents', csv, true);
    expect(res.body.valid).toBe(false);
    expect(errs(res)).toEqual([
      { line: 2, field: 'full_name', code: 'FULL_NAME_INVALID' },
      { line: 3, field: 'login_id', code: 'LOGIN_ID_INVALID' },
      { line: 4, field: 'phone', code: 'PHONE_INVALID' },
      { line: 5, field: 'type', code: 'REQUIRED' },
      { line: 5, field: 'start_date', code: 'REQUIRED' },
      { line: 6, field: 'type', code: 'TYPE_INVALID' },
      { line: 7, field: 'start_date', code: 'START_DATE_INVALID' },
      { line: 8, field: 'billing_contact', code: 'BILLING_CONTACT_INVALID' },
      { line: 9, field: 'billing_contact', code: 'BILLING_CONTACT_INVALID' },
      { line: 10, field: 'unit_number', code: 'UNIT_NOT_FOUND' },
      { line: 11, field: 'unit_number', code: 'UNIT_UNAVAILABLE' },
      { line: 12, field: 'full_name', code: 'REQUIRED' },
    ]);
  });

  it('BR-01 rejects login IDs repeated in the file or already used (any letter case)', async () => {
    const { c } = await admin();
    await makeLoginUser('RESIDENT', [], { loginId: 'taken@example.com' });
    const csv =
      RES_HEADER +
      'One,dup@example.com,01711111111,,,,\r\n' +
      'Two,DUP@Example.com,01722222222,,,,\r\n' +
      'Three,01733333333,01733333333,,,,\r\n' +
      'Four,+8801733333333,01744444444,,,,\r\n' + // same phone number, other format
      'Five,Taken@Example.com,01755555555,,,,\r\n';
    const res = await run(c, 'residents', csv, true);
    expect(errs(res)).toEqual([
      { line: 3, field: 'login_id', code: 'LOGIN_ID_DUPLICATE_IN_FILE' },
      { line: 5, field: 'login_id', code: 'LOGIN_ID_DUPLICATE_IN_FILE' },
      { line: 6, field: 'login_id', code: 'LOGIN_ID_TAKEN' },
    ]);
  });

  it('BR-06 only one billing contact per unit: against the file and against existing data', async () => {
    const { c } = await admin();
    await withUnits();
    const unit = await prisma.unit.findFirstOrThrow({ where: { unitNumber: '2A' } });
    const holder = await makeLoginUser('RESIDENT');
    await prisma.occupancy.create({ data: { unitId: unit.id, residentId: holder.id, type: 'OWNER', startDate: d('2020-01-01'), isBillingContact: true } });
    const csv =
      RES_HEADER +
      'A One,a1@example.com,01711111111,1A,owner,2026-01-01,yes\r\n' +
      'B Two,b2@example.com,01722222222,1A,tenant,2026-01-01,yes\r\n' + // second 'yes' in the same unit
      'C Three,c3@example.com,01733333333,2A,tenant,2026-01-01,yes\r\n'; // 2A already has a contact
    const res = await run(c, 'residents', csv, true);
    expect(errs(res)).toEqual([
      { line: 3, field: 'billing_contact', code: 'BILLING_CONTACT_DUPLICATE_IN_FILE' },
      { line: 4, field: 'billing_contact', code: 'BILLING_CONTACT_EXISTS' },
    ]);
  });

  it('adding a resident to a unit that already has a billing contact does not take the role', async () => {
    const { c } = await admin();
    await withUnits();
    const unit = await prisma.unit.findFirstOrThrow({ where: { unitNumber: '2A' } });
    const holder = await makeLoginUser('RESIDENT');
    await prisma.occupancy.create({ data: { unitId: unit.id, residentId: holder.id, type: 'OWNER', startDate: d('2020-01-01'), isBillingContact: true } });
    expect((await run(c, 'residents', RES_HEADER + 'New Tenant,nt@example.com,01711111111,2A,tenant,2026-01-01,\r\n')).status).toBe(200);
    const contacts = await prisma.occupancy.findMany({ where: { unitId: unit.id, isBillingContact: true, endDate: null } });
    expect(contacts.map((o) => o.residentId)).toEqual([holder.id]);
  });

  it('NFR-14 one bad row means no residents, no stays, and no temporary passwords', async () => {
    const { c } = await admin();
    await withUnits();
    const csv =
      RES_HEADER +
      'Good One,g1@example.com,01711111111,1A,owner,2026-01-01,\r\n' +
      'Good Two,g2@example.com,01722222222,1B,owner,2026-01-01,\r\n' +
      'Bad Row,bad@example.com,not-a-phone,,,,\r\n';
    const res = await run(c, 'residents', csv);
    expect(res.status).toBe(422);
    expect(res.body.credentials).toBeUndefined();
    expect(await prisma.user.count({ where: { role: 'RESIDENT' } })).toBe(0);
    expect(await prisma.occupancy.count()).toBe(0);
  });

  it('there is no way to create admins or staff through the import', async () => {
    const { c } = await admin();
    const res = await run(c, 'residents', 'full_name,login_id,phone,role\r\nEvil Admin,evil@example.com,01711111111,ADMIN\r\n', true);
    expect(errs(res)).toContainEqual({ line: 1, field: 'role', code: 'UNKNOWN_COLUMN' });
    expect(await prisma.user.count({ where: { loginId: 'evil@example.com' } })).toBe(0);
  });

  it('allows 200 residents and refuses more', async () => {
    const { c } = await admin();
    const make = (n: number) => RES_HEADER + Array.from({ length: n }, (_, i) => `Person ${i},p${i}@example.com,0171${String(1000000 + i)},,,,`).join('\r\n');
    const big = await run(c, 'residents', make(200));
    expect(big.body).toMatchObject({ valid: true, created: 200 });
    const tooMany = await run(c, 'residents', make(201), true);
    expect(errs(tooMany)[0]).toMatchObject({ code: 'TOO_MANY_ROWS' });
  }, 60_000);

  it('units imported first can be used by a residents file straight after', async () => {
    const { c } = await admin();
    expect((await run(c, 'units', 'unit_number,floor\r\n7A,7\r\n7B,7\r\n')).status).toBe(200);
    const res = await run(c, 'residents', RES_HEADER + 'Tenant One,t1@example.com,01711111111,7a,tenant,2026-01-01,\r\n'); // letter case differs
    expect(res.body).toMatchObject({ valid: true, created: 1 });
    expect((await c.get('/api/units?q=7')).body.items.map((u: { status: string }) => u.status)).toEqual(['OCCUPIED', 'VACANT']);
  });
});
