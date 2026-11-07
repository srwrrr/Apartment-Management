import fs from 'node:fs';
import path from 'node:path';
import type { Express } from 'express';
import { prisma } from '../src/lib/prisma';
import { UPLOAD_ROOT } from '../src/lib/files';
import { client, loginAs, makeLoginUser, occupy } from './helpers';

// ---------------------------------------------------------------- sample files
/** A real 1x1 PNG. */
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
/** Enough of a JPEG for its signature to be recognised (FF D8 FF E0 … JFIF). */
export const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0'), Buffer.alloc(64, 1), Buffer.from([0xff, 0xd9])]);
/** Enough of a WEBP: "RIFF" + size + "WEBP" + a VP8 chunk header. */
export const WEBP = (() => {
  const body = Buffer.concat([Buffer.from('WEBPVP8 '), Buffer.from([0x0a, 0, 0, 0]), Buffer.alloc(10, 2)]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from('RIFF'), size, body]);
})();
export const GIF = Buffer.from('GIF89a\x01\x00\x01\x00\x80\x00\x00\xff\xff\xff\x00\x00\x00;', 'binary');
/** A Windows program: starts with "MZ". */
export const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 0x90)]);
export const SCRIPT = Buffer.from('<script>alert(1)</script>');

export interface Upload {
  name: string;
  data: Buffer;
  type?: string;
}

export const REQUEST_FIELDS = {
  category: 'PLUMBING',
  location: 'UNIT',
  title: 'Kitchen tap is leaking',
  description: 'The kitchen tap has been dripping since yesterday evening.',
};

type C = Awaited<ReturnType<typeof client>>;

/** Submit a maintenance request the way the web app does: form fields plus photos. */
export function submit(c: C, fields: Record<string, string> = {}, uploads: Upload[] = []) {
  let req = c.form('/api/requests');
  for (const [k, v] of Object.entries({ ...REQUEST_FIELDS, ...fields })) req = req.field(k, v);
  for (const u of uploads) req = req.attach('photos', u.data, { filename: u.name, contentType: u.type ?? 'application/octet-stream' });
  return req;
}

export function addNoteReq(c: C, requestId: string, fields: Record<string, string>, uploads: Upload[] = []) {
  let req = c.form(`/api/requests/${requestId}/notes`);
  for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
  for (const u of uploads) req = req.attach('photos', u.data, { filename: u.name, contentType: u.type ?? 'application/octet-stream' });
  return req;
}

export function filesOnDisk(): string[] {
  return fs.existsSync(UPLOAD_ROOT) ? fs.readdirSync(UPLOAD_ROOT).filter((f) => !f.startsWith('.')) : [];
}
export function clearUploads() {
  fs.rmSync(UPLOAD_ROOT, { recursive: true, force: true });
}
export const uploadPath = (storedName: string) => path.join(UPLOAD_ROOT, storedName);

// ----------------------------------------------------------------------- people
export const MANAGER_PERMS = ['maintenance.view_all', 'maintenance.review', 'maintenance.assign'];

/** Log in as a user that occupy() created. */
export async function asResident(app: Express, resident: { loginId: string }) {
  const c = await client(app);
  const res = await c.login(resident.loginId);
  if (res.status !== 200) throw new Error('login failed');
  return c;
}

/** A resident living in a unit, already logged in. */
export async function residentIn(app: Express, unitNumber: string, over: Parameters<typeof occupy>[1] = {}) {
  const o = await occupy(unitNumber, over);
  return { ...o, c: await asResident(app, o.resident) };
}

export const manager = (app: Express) => loginAs(app, 'STAFF', MANAGER_PERMS);
export const admin = (app: Express) => loginAs(app, 'ADMIN');
/** Caretaker: ordinary staff with no maintenance permissions, who works on what is assigned. */
export const caretaker = (app: Express) => loginAs(app, 'STAFF');

/** Create a request straight in the database, for tests that are not about submitting. */
export async function makeRequest(
  residentId: string,
  unitId: string,
  over: Partial<{ status: string; priority: string | null; assignedToId: string | null; title: string; createdAt: Date; dueAt: Date; resolvedAt: Date | null; closedAt: Date | null; category: string }> = {},
) {
  const createdAt = over.createdAt ?? new Date();
  return prisma.maintenanceRequest.create({
    data: {
      submittedById: residentId,
      unitId,
      location: 'UNIT',
      category: (over.category ?? 'PLUMBING') as 'PLUMBING',
      title: over.title ?? 'Kitchen tap is leaking',
      description: 'The kitchen tap has been dripping since yesterday.',
      status: (over.status ?? 'SUBMITTED') as 'SUBMITTED',
      priority: (over.priority ?? null) as 'LOW' | null,
      assignedToId: over.assignedToId ?? null,
      createdAt,
      dueAt: over.dueAt ?? new Date(createdAt.getTime() + 48 * 3_600_000),
      resolvedAt: over.resolvedAt ?? (over.status === 'RESOLVED' || over.status === 'CLOSED' ? new Date() : null),
      closedAt: over.closedAt ?? (over.status === 'CLOSED' ? new Date() : null),
    },
  });
}

export { makeLoginUser };
