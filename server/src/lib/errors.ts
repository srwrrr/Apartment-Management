import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';

/** Errors carry a machine code; the web app translates it (SRS FR-47 / NFR-11). */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public fields?: Record<string, { code: string; params?: Record<string, unknown> }>,
  ) {
    super(code);
  }
}

export const notFound = () => new ApiError(404, 'NOT_FOUND');
export const forbidden = () => new ApiError(403, 'FORBIDDEN');

/** Express 4 does not catch rejected promises; wrap async handlers with this. */
export const asyncHandler =
  (fn: (...args: Parameters<RequestHandler>) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: { code: err.code, ...(err.fields && { fields: err.fields }) } });
    return;
  }
  if (err instanceof ZodError) {
    const fields: Record<string, { code: string }> = {};
    for (const issue of err.issues) {
      fields[issue.path.join('.') || '_'] = { code: `INVALID_${issue.code.toUpperCase()}` };
    }
    res.status(400).json({ error: { code: 'VALIDATION_FAILED', fields } });
    return;
  }
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'VALIDATION_FAILED' } });
    return;
  }
  console.error(err);
  res.status(500).json({ error: { code: 'INTERNAL' } });
};
