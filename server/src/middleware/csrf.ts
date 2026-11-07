import crypto from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { ApiError } from '../lib/errors';

/** Create (or reuse) the CSRF token stored in this session. */
export function ensureCsrfToken(req: Request): string {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(32).toString('hex');
  return req.session.csrf;
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Every state-changing request must send the session's token in X-CSRF-Token (NFR-05). */
export const csrfProtection: RequestHandler = (req, _res, next) => {
  if (SAFE.has(req.method)) return next();
  const expected = req.session?.csrf;
  const got = req.get('x-csrf-token');
  const ok =
    !!expected &&
    !!got &&
    got.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  if (!ok) return next(new ApiError(403, 'CSRF_INVALID'));
  next();
};
