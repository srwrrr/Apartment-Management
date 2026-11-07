import express from 'express';
import helmet from 'helmet';
import { prisma } from './lib/prisma';

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

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND' } });
  });

  return app;
}
