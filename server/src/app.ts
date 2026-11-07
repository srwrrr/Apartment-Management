import express from 'express';
import helmet from 'helmet';
import { prisma } from './lib/prisma';
import { errorHandler } from './lib/errors';
import { sessionMiddleware } from './middleware/session';
import { csrfProtection } from './middleware/csrf';
import { loadUser } from './middleware/auth';
import { authRouter } from './modules/users/auth.routes';
import { unitsRouter } from './modules/users/units.routes';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: 'ok', db: 'up' });
    } catch {
      res.status(503).json({ status: 'degraded', db: 'down' });
    }
  });

  // Everything below needs a session, CSRF protection on writes, and the current user loaded.
  app.use('/api', sessionMiddleware, csrfProtection, loadUser);
  app.use('/api/auth', authRouter);
  app.use('/api/units', unitsRouter);

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND' } });
  });
  app.use(errorHandler);

  return app;
}
