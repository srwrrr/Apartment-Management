import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileTypeFromBuffer } from 'file-type';
import { config } from '../config';
import { ApiError } from './errors';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const UPLOAD_ROOT = path.resolve(serverRoot, config.UPLOAD_DIR);

// BR-19, NFR-06: only real JPG, PNG and WEBP images. The type is read from the file's own bytes,
// never from its name or what the browser claims, so a renamed program or script is refused.
const ALLOWED: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
// BR-21: a payment screenshot or expense receipt may also be a PDF.
const ALLOWED_DOCUMENTS: Record<string, string> = { ...ALLOWED, 'application/pdf': 'pdf' };

export interface StoredFile {
  storedName: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
}

/** A display name only: no folders, no control characters, not too long. It is never used to find the file. */
function cleanName(name: string): string {
  const base = path.basename(name.split('\\').join('/')).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (base || 'photo').slice(0, 100);
}

/**
 * Checks every file first, then saves them under random names. Either all are saved or none is,
 * and nothing is written if any file is not an allowed image.
 */
export const storeImages = (files: Express.Multer.File[]) => store(files, ALLOWED, 'photos');

/** One optional proof of payment or receipt: an image or a PDF. `field` names the form field in any error. */
export const storeDocument = (file: Express.Multer.File | undefined, field: string) => store(file ? [file] : [], ALLOWED_DOCUMENTS, field);

async function store(files: Express.Multer.File[], allowed: Record<string, string>, field: string): Promise<StoredFile[]> {
  const checked: { buffer: Buffer; mime: string; ext: string; original: string }[] = [];
  for (const f of files) {
    const type = await fileTypeFromBuffer(f.buffer);
    if (!type || !allowed[type.mime]) {
      throw new ApiError(400, 'VALIDATION_FAILED', { [field]: { code: 'FILE_TYPE_NOT_ALLOWED' } });
    }
    checked.push({ buffer: f.buffer, mime: type.mime, ext: allowed[type.mime]!, original: cleanName(f.originalname) });
  }
  await fs.mkdir(UPLOAD_ROOT, { recursive: true });
  const stored: StoredFile[] = [];
  try {
    for (const c of checked) {
      const storedName = `${crypto.randomUUID()}.${c.ext}`;
      await fs.writeFile(path.join(UPLOAD_ROOT, storedName), c.buffer, { flag: 'wx' });
      stored.push({ storedName, originalName: c.original, mimeType: c.mime, sizeBytes: c.buffer.length });
    }
  } catch (e) {
    await removeStored(stored.map((s) => s.storedName));
    throw e;
  }
  return stored;
}

export async function removeStored(names: string[]) {
  await Promise.all(names.map((n) => fs.rm(path.join(UPLOAD_ROOT, path.basename(n)), { force: true }).catch(() => undefined)));
}

export async function readStored(name: string): Promise<Buffer> {
  return fs.readFile(path.join(UPLOAD_ROOT, path.basename(name))); // basename: a stored name can never point outside the folder
}
