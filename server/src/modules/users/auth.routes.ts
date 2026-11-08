import { Router } from 'express';
import { logActivity } from '../activity/activity';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../../config';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/errors';
import { requireAuthAllowTempPassword } from '../../middleware/auth';
import { ensureCsrfToken } from '../../middleware/csrf';
import { changePassword, verifyLogin } from './auth.service';

export const authRouter = Router();

// NFR-07: slow down password guessing from one address (account lockout is separate, per user).
// Only FAILED attempts count: a whole building often shares one Wi-Fi address, and many residents
// logging in successfully must never lock each other out.
const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 30,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => config.NODE_ENV === 'test',
  handler: (_req, res) => {
    res.status(429).json({ error: { code: 'RATE_LIMITED' } });
  },
});

const loginSchema = z.object({ loginId: z.string().min(1).max(254), password: z.string().min(1).max(200) });
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(1).max(200),
});

// The session store reports failures as `any`; always reject with a real Error, so the stack trace survives.
const asError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)));
const regenerate = (req: Express.Request) =>
  new Promise<void>((resolve, reject) => req.session.regenerate((e) => (e ? reject(asError(e)) : resolve())));
const save = (req: Express.Request) =>
  new Promise<void>((resolve, reject) => req.session.save((e) => (e ? reject(asError(e)) : resolve())));

// Demo mode (spec §12) fills in the login form for a presentation. It is never on in production.
const DEMO_ACCOUNTS = [
  { role: 'ADMIN', loginId: 'admin@demo.local', password: 'Admin1234' },
  { role: 'STAFF', loginId: 'manager@demo.local', password: 'Manager1234' },
  { role: 'RESIDENT', loginId: 'resident@demo.local', password: 'Resident1234' },
];
export const demoAccountsFor = (c: { DEMO_MODE: boolean; NODE_ENV: string }) => (c.DEMO_MODE && c.NODE_ENV !== 'production' ? DEMO_ACCOUNTS : []);
authRouter.get('/demo-accounts', (_req, res) => {
  res.json({ items: demoAccountsFor(config) });
});

authRouter.get('/csrf', (req, res) => {
  res.json({ csrfToken: ensureCsrfToken(req) });
});

authRouter.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const { loginId, password } = loginSchema.parse(req.body);
    const user = await verifyLogin(loginId, password);

    await regenerate(req); // new session ID on login: prevents session fixation
    req.session.userId = user.id;
    const csrfToken = ensureCsrfToken(req);
    await save(req);
    // Tag the session row with the user so FR-31 can end their other sessions.
    await prisma.$executeRaw`UPDATE "session" SET "userId" = ${user.id}::uuid WHERE sid = ${req.sessionID}`;
    await logActivity(prisma, 'login.success', { actorId: user.id, entityType: 'user', entityId: user.id });

    res.json({ csrfToken, mustChangePassword: user.mustChangePassword });
  }),
);

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    await new Promise<void>((resolve) => req.session.destroy(() => resolve()));
    res.clearCookie('apt.sid');
    res.status(204).end();
  }),
);

authRouter.get('/me', (req, res) => {
  if (!req.user) {
    res.status(401).json({ error: { code: 'UNAUTHENTICATED' } });
    return;
  }
  res.json({ user: req.user, csrfToken: ensureCsrfToken(req) });
});

authRouter.post(
  '/change-password',
  requireAuthAllowTempPassword,
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);
    await changePassword(req.user!.id, req.sessionID, currentPassword, newPassword);
    res.status(204).end();
  }),
);
