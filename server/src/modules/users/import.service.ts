// FR-42: bulk import of units and residents from a CSV file.
// Phase 1 checks every row without touching the database, phase 2 checks it against existing data,
// phase 3 (only when everything is clean, and not a dry run) writes it all in ONE transaction (NFR-14).
import { logActivity } from '../activity/activity';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import Papa from 'papaparse';
import { Prisma } from '@prisma/client';
import { MAX_POISHA, normalizeLoginId, normalizePhone, parseTaka, ymdSchema } from '@apt/shared';
import { openingBalanceMonth, openingBalanceRows } from '../billing/bills.service';
import { prisma } from '../../lib/prisma';
import { ApiError } from '../../lib/errors';
import { dateOnly } from '../../lib/dates';
import { generateTempPassword } from './password';

export type ImportKind = 'units' | 'residents';
export interface ImportError {
  line: number; // line in the file: 1 is the header, the first data row is 2
  field: string;
  code: string;
}

export const MAX_ROWS: Record<ImportKind, number> = { units: 2000, residents: 200 };
// Kept under the 1 MB JSON body limit, which the CSV text is sent inside.
export const MAX_CSV_CHARS = 700_000;

const COLUMNS: Record<ImportKind, string[]> = {
  units: ['unit_number', 'floor', 'size_sqft', 'bedrooms', 'opening_balance'],
  residents: ['full_name', 'login_id', 'phone', 'unit_number', 'type', 'start_date', 'billing_contact'],
};
const REQUIRED: Record<ImportKind, string[]> = {
  units: ['unit_number', 'floor'],
  residents: ['full_name', 'login_id', 'phone'],
};

/** Header-only templates, with a byte-order mark so Excel opens the UTF-8 file (and Bangla text) correctly. */
export const template = (kind: ImportKind) => '﻿' + COLUMNS[kind].join(',') + '\r\n';

interface Parsed {
  rows: { line: number; v: Record<string, string> }[];
  errors: ImportError[];
}

/** Parses the file and checks the header. Returns row-level data keyed by column name. */
function parse(kind: ImportKind, csv: string): Parsed {
  const errors: ImportError[] = [];
  const text = csv.replace(/^﻿/, '');
  if (text.trim() === '') return { rows: [], errors: [{ line: 1, field: '_', code: 'EMPTY_FILE' }] };

  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim().toLowerCase(),
    transform: (v) => v.trim(),
  });

  const fields = result.meta.fields ?? [];
  for (const col of REQUIRED[kind]) if (!fields.includes(col)) errors.push({ line: 1, field: col, code: 'MISSING_COLUMN' });
  for (const col of fields) if (!COLUMNS[kind].includes(col)) errors.push({ line: 1, field: col, code: 'UNKNOWN_COLUMN' });
  if (errors.length) return { rows: [], errors };

  // A row with too many or too few cells usually means an unquoted comma; point at it instead of guessing.
  for (const e of result.errors) {
    if (e.row !== undefined && (e.code === 'TooFewFields' || e.code === 'TooManyFields')) {
      errors.push({ line: e.row + 2, field: '_', code: 'ROW_COLUMN_MISMATCH' });
    }
  }
  const rows = result.data.map((v, i) => ({ line: i + 2, v }));
  if (rows.length === 0) errors.push({ line: 1, field: '_', code: 'NO_ROWS' });
  if (rows.length > MAX_ROWS[kind]) errors.push({ line: 1, field: '_', code: 'TOO_MANY_ROWS' });
  return { rows, errors };
}

const intIn = (s: string, min: number, max: number) => /^-?\d+$/.test(s) && +s >= min && +s <= max;

// ---------------------------------------------------------------- units

interface UnitRow {
  line: number;
  unitNumber: string;
  floor: number;
  sizeSqft: number | null;
  bedrooms: number | null;
  openingBalance: number | null; // poisha (FR-41)
}

function validateUnits(rows: Parsed['rows']) {
  const errors: ImportError[] = [];
  const valid: UnitRow[] = [];
  const seen = new Map<string, number>();
  for (const { line, v } of rows) {
    const before = errors.length;
    const un = v.unit_number ?? '';
    if (!un) errors.push({ line, field: 'unit_number', code: 'REQUIRED' });
    else if (un.length > 10 || !/^[A-Za-z0-9-]+$/.test(un)) errors.push({ line, field: 'unit_number', code: 'UNIT_NUMBER_INVALID' });
    else if (seen.has(un.toUpperCase())) errors.push({ line, field: 'unit_number', code: 'UNIT_NUMBER_DUPLICATE_IN_FILE' }); // BR-04
    else seen.set(un.toUpperCase(), line);

    const floor = v.floor ?? '';
    if (!floor) errors.push({ line, field: 'floor', code: 'REQUIRED' });
    else if (!intIn(floor, -2, 100)) errors.push({ line, field: 'floor', code: 'FLOOR_INVALID' });

    const size = v.size_sqft ?? '';
    if (size && !(intIn(size, 1, 1_000_000))) errors.push({ line, field: 'size_sqft', code: 'SIZE_INVALID' });
    const beds = v.bedrooms ?? '';
    if (beds && !intIn(beds, 0, 20)) errors.push({ line, field: 'bedrooms', code: 'BEDROOMS_INVALID' });

    // Dues from before the system was used, in taka (FR-41). Empty means nothing owed.
    const ob = v.opening_balance ?? '';
    let openingBalance: number | null = null;
    if (ob) {
      const poisha = parseTaka(ob);
      if (poisha === null || poisha <= 0 || poisha > MAX_POISHA) errors.push({ line, field: 'opening_balance', code: 'OPENING_BALANCE_INVALID' });
      else openingBalance = poisha;
    }

    if (errors.length === before) {
      valid.push({ line, unitNumber: un, floor: +floor, sizeSqft: size ? +size : null, bedrooms: beds ? +beds : null, openingBalance });
    }
  }
  return { errors, valid };
}

// ------------------------------------------------------------ residents

interface ResidentRow {
  line: number;
  fullName: string;
  loginId: string;
  phone: string;
  unitNumber: string | null; // upper-cased for matching
  type: 'OWNER' | 'TENANT' | null;
  startDate: string | null;
  billingContact: boolean;
}

function validateResidents(rows: Parsed['rows']) {
  const errors: ImportError[] = [];
  const valid: ResidentRow[] = [];
  const seenLogin = new Set<string>();
  for (const { line, v } of rows) {
    const before = errors.length;
    const err = (field: string, code: string) => errors.push({ line, field, code });

    const name = v.full_name ?? '';
    if (!name) err('full_name', 'REQUIRED');
    else if (name.length < 2 || name.length > 100) err('full_name', 'FULL_NAME_INVALID');

    let loginId = '';
    if (!v.login_id) err('login_id', 'REQUIRED');
    else {
      const n = normalizeLoginId(v.login_id);
      if (!n) err('login_id', 'LOGIN_ID_INVALID');
      else if (seenLogin.has(n)) err('login_id', 'LOGIN_ID_DUPLICATE_IN_FILE');
      else {
        seenLogin.add(n);
        loginId = n;
      }
    }

    let phone = '';
    if (!v.phone) err('phone', 'REQUIRED');
    else {
      const n = normalizePhone(v.phone);
      if (!n) err('phone', 'PHONE_INVALID');
      else phone = n;
    }

    // Unit, type and start date go together: all three, or none (a resident not yet in a unit).
    const un = v.unit_number ?? '';
    const type = (v.type ?? '').toLowerCase();
    const start = v.start_date ?? '';
    const anyUnit = !!(un || type || start);
    let typeOk: 'OWNER' | 'TENANT' | null = null;
    if (anyUnit) {
      if (!un) err('unit_number', 'REQUIRED');
      else if (un.length > 10 || !/^[A-Za-z0-9-]+$/.test(un)) err('unit_number', 'UNIT_NUMBER_INVALID');
      if (!type) err('type', 'REQUIRED');
      else if (type !== 'owner' && type !== 'tenant') err('type', 'TYPE_INVALID');
      else typeOk = type === 'owner' ? 'OWNER' : 'TENANT';
      if (!start) err('start_date', 'REQUIRED');
      else if (!ymdSchema.safeParse(start).success) err('start_date', 'START_DATE_INVALID');
    }

    const bc = (v.billing_contact ?? '').toLowerCase();
    if (bc && bc !== 'yes' && bc !== 'no') err('billing_contact', 'BILLING_CONTACT_INVALID');
    if (bc === 'yes' && !anyUnit) err('billing_contact', 'BILLING_CONTACT_INVALID');

    if (errors.length === before) {
      valid.push({
        line,
        fullName: name,
        loginId,
        phone,
        unitNumber: anyUnit ? un.toUpperCase() : null,
        type: anyUnit ? typeOk : null,
        startDate: anyUnit ? start : null,
        billingContact: bc === 'yes',
      });
    }
  }
  return { errors, valid };
}

// -------------------------------------------------------------- running

export interface ImportResult {
  valid: boolean;
  rows: number;
  errors: ImportError[];
  created?: number;
  credentials?: { fullName: string; loginId: string; tempPassword: string; unitNumber: string | null }[];
}

const sortErrors = (e: ImportError[]) => e.sort((a, b) => a.line - b.line);

async function importUnits(rows: Parsed['rows'], dryRun: boolean, actorId: string): Promise<ImportResult> {
  const { errors, valid } = validateUnits(rows);
  if (valid.length > 0) {
    // Phase 2: unit numbers that already exist (BR-04, case-insensitive).
    const taken = await prisma.$queryRaw<{ n: string }[]>`
      SELECT upper("unitNumber") AS n FROM "units" WHERE upper("unitNumber") IN (${Prisma.join(valid.map((u) => u.unitNumber.toUpperCase()))})`;
    const takenSet = new Set(taken.map((t) => t.n));
    for (const u of valid) if (takenSet.has(u.unitNumber.toUpperCase())) errors.push({ line: u.line, field: 'unit_number', code: 'UNIT_NUMBER_TAKEN' });
  }
  if (errors.length || dryRun) return { valid: errors.length === 0, rows: rows.length, errors: sortErrors(errors) };

  // Units and their opening balances go in together: all or nothing.
  const ids = valid.map(() => crypto.randomUUID());
  const withBalance = valid.map((u, i) => ({ u, id: ids[i]! })).filter((x) => x.u.openingBalance !== null);
  const { month, goLive } = await openingBalanceMonth();
  const balances = withBalance.map(({ u, id }) =>
    openingBalanceRows({ unitId: id, amount: u.openingBalance!, month, dueDate: dateOnly(goLive), actorId, billingContactId: null }),
  );
  try {
    await prisma.$transaction(async (tx) => {
      await logActivity(tx, 'import.run', { details: { kind: 'units', rows: valid.length } });
      await tx.unit.createMany({
        data: valid.map((u, i) => ({ id: ids[i]!, unitNumber: u.unitNumber, floor: u.floor, sizeSqft: u.sizeSqft, bedrooms: u.bedrooms })),
      });
      if (balances.length) {
        await tx.bill.createMany({ data: balances.map((b) => b.bill) });
        await tx.charge.createMany({ data: balances.map((b) => b.charge) });
      }
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ApiError(409, 'IMPORT_CONFLICT');
    throw e;
  }
  return { valid: true, rows: rows.length, errors: [], created: valid.length };
}

async function importResidents(rows: Parsed['rows'], dryRun: boolean): Promise<ImportResult> {
  const { errors, valid } = validateResidents(rows);

  if (valid.length > 0) {
    // Phase 2a: login IDs already in use (BR-01).
    const existing = await prisma.user.findMany({ where: { loginId: { in: valid.map((r) => r.loginId) } }, select: { loginId: true } });
    const takenLogin = new Set(existing.map((e) => e.loginId));
    for (const r of valid) if (takenLogin.has(r.loginId)) errors.push({ line: r.line, field: 'login_id', code: 'LOGIN_ID_TAKEN' });

    // Phase 2b: units must exist and accept residents (BR-05).
    const wanted = [...new Set(valid.filter((r) => r.unitNumber).map((r) => r.unitNumber!))];
    const units = wanted.length
      ? await prisma.$queryRaw<{ id: string; n: string; isAvailable: boolean }[]>`
          SELECT id::text, upper("unitNumber") AS n, "isAvailable" FROM "units" WHERE upper("unitNumber") IN (${Prisma.join(wanted)})`
      : [];
    const unitByNumber = new Map(units.map((u) => [u.n, u]));
    for (const r of valid) {
      if (!r.unitNumber) continue;
      const u = unitByNumber.get(r.unitNumber);
      if (!u) errors.push({ line: r.line, field: 'unit_number', code: 'UNIT_NOT_FOUND' });
      else if (!u.isAvailable) errors.push({ line: r.line, field: 'unit_number', code: 'UNIT_UNAVAILABLE' });
    }

    // Phase 2c: one billing contact per unit (BR-06). The first occupant becomes it if nobody is yet.
    const unitIds = units.map((u) => u.id);
    const hasContact = new Set(
      unitIds.length
        ? (await prisma.occupancy.findMany({ where: { unitId: { in: unitIds }, isBillingContact: true, endDate: null }, select: { unitId: true } })).map((o) => o.unitId)
        : [],
    );
    const claimed = new Set<string>();
    for (const r of valid) {
      const u = r.unitNumber ? unitByNumber.get(r.unitNumber) : undefined;
      if (!u || !r.billingContact) continue;
      if (hasContact.has(u.id)) errors.push({ line: r.line, field: 'billing_contact', code: 'BILLING_CONTACT_EXISTS' });
      else if (claimed.has(u.id)) errors.push({ line: r.line, field: 'billing_contact', code: 'BILLING_CONTACT_DUPLICATE_IN_FILE' });
      else claimed.add(u.id);
    }

    if (errors.length === 0 && !dryRun) {
      return createResidents(valid, unitByNumber, hasContact, claimed, rows.length);
    }
  }
  return { valid: errors.length === 0, rows: rows.length, errors: sortErrors(errors) };
}

async function createResidents(
  valid: ResidentRow[],
  unitByNumber: Map<string, { id: string }>,
  hasContact: Set<string>,
  claimed: Set<string>,
  totalRows: number,
): Promise<ImportResult> {
  // Temporary passwords are random, single-use and must be changed at first login, so cost 10 (about 60 ms)
  // keeps a few hundred residents quick without weakening real passwords (those stay at cost 12).
  const credentials: NonNullable<ImportResult['credentials']> = [];
  const users: Prisma.UserCreateManyInput[] = [];
  for (const r of valid) {
    const tempPassword = generateTempPassword();
    credentials.push({ fullName: r.fullName, loginId: r.loginId, tempPassword, unitNumber: r.unitNumber });
    users.push({
      id: crypto.randomUUID(),
      loginId: r.loginId,
      passwordHash: await bcrypt.hash(tempPassword, 10),
      role: 'RESIDENT',
      fullName: r.fullName,
      phone: r.phone,
      mustChangePassword: true,
    });
  }

  // Occupancies: honour explicit billing contacts; otherwise the first occupant of a unit without one gets it.
  const contactGiven = new Set(hasContact);
  for (const id of claimed) contactGiven.add(id);
  const occupancies: Prisma.OccupancyCreateManyInput[] = [];
  valid.forEach((r, i) => {
    if (!r.unitNumber) return;
    const unitId = unitByNumber.get(r.unitNumber)!.id;
    let isBillingContact = r.billingContact;
    if (!isBillingContact && !contactGiven.has(unitId)) {
      isBillingContact = true;
      contactGiven.add(unitId);
    }
    occupancies.push({ unitId, residentId: users[i]!.id!, type: r.type!, startDate: dateOnly(r.startDate!), isBillingContact });
  });

  try {
    await prisma.$transaction(async (tx) => {
      await logActivity(tx, 'import.run', { details: { kind: 'residents', rows: valid.length } });
      await tx.user.createMany({ data: users });
      await tx.residentProfile.createMany({ data: users.map((u) => ({ userId: u.id! })) });
      if (occupancies.length) await tx.occupancy.createMany({ data: occupancies });
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ApiError(409, 'IMPORT_CONFLICT');
    throw e;
  }
  return { valid: true, rows: totalRows, errors: [], created: valid.length, credentials };
}

export async function runImport(kind: ImportKind, csv: string, dryRun: boolean, actorId: string): Promise<ImportResult> {
  const parsed = parse(kind, csv);
  if (parsed.errors.length) return { valid: false, rows: parsed.rows.length, errors: parsed.errors };
  return kind === 'units' ? importUnits(parsed.rows, dryRun, actorId) : importResidents(parsed.rows, dryRun);
}
