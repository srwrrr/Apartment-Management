import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { config } from './config';
import { prisma } from './lib/prisma';
import { errorHandler } from './lib/errors';
import { sessionMiddleware } from './middleware/session';
import { csrfProtection } from './middleware/csrf';
import { loadUser } from './middleware/auth';
import { requestContext } from './lib/requestContext';
import { activityRouter } from './modules/activity/activity.routes';
import { searchRouter } from './modules/reports/search.routes';
import { authRouter } from './modules/users/auth.routes';
import { unitsRouter } from './modules/users/units.routes';
import { householdMembersRouter, occupanciesRouter, unitOccupanciesRouter } from './modules/users/occupancies.routes';
import { residentsRouter } from './modules/users/residents.routes';
import { staffRouter, usersRouter } from './modules/users/staff.routes';
import { meRouter } from './modules/users/me.routes';
import { importRouter } from './modules/users/import.routes';
import { directoryRouter } from './modules/users/directory.routes';
import { settingsRouter } from './modules/settings/settings.routes';
import { attachmentsRouter, myRequestsRouter, myTasksRouter, requestsRouter, scheduledTasksRouter } from './modules/maintenance/maintenance.routes';
import { billsRouter, certificatesRouter, chargesRouter, feesRouter, meBillingRouter, paymentReportsRouter, paymentsRouter, unitBillingRouter } from './modules/billing/billing.routes';
import { expensesRouter } from './modules/expenses/expenses.routes';
import { preferencesRouter } from './modules/users/preferences.routes';
import { notificationsRouter } from './modules/notifications/notifications.routes';
import { announcementsRouter } from './modules/announcements/announcements.routes';
import { emergencyContactsRouter, groupsRouter } from './modules/announcements/groups.routes';
import { dashboardRouter, reportsRouter } from './modules/reports/reports.routes';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Behind a host's HTTPS proxy (Render): believe its X-Forwarded-* headers, so secure cookies are set
  // and each visitor's own address is used for login rate limits.
  if (config.TRUST_PROXY) app.set('trust proxy', 1);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          imgSrc: ["'self'", 'data:', 'blob:'], // blob: for previews of photos before they are uploaded
          upgradeInsecureRequests: null, // the demo runs on plain http over a local network
        },
      },
    }),
  );
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
  app.use('/api', sessionMiddleware, csrfProtection, loadUser, requestContext);
  app.use('/api/auth', authRouter);
  app.use('/api/me/requests', myRequestsRouter); // a resident's own requests
  app.use('/api/me/tasks', myTasksRouter); // staff: what is assigned to me
  app.use('/api/me/billing', meBillingRouter); // a resident's own bills (before the generic /api/me)
  app.use('/api/me/preferences', preferencesRouter); // any role; must come before the resident-only /api/me
  app.use('/api/me', meRouter);
  app.use('/api/units/:unitId', unitBillingRouter); // fees and opening balance (before /api/units)
  app.use('/api/units/:unitId/occupancies', unitOccupanciesRouter); // before /api/units (different permission)
  app.use('/api/units', unitsRouter);
  app.use('/api/occupancies', occupanciesRouter);
  app.use('/api/household-members', householdMembersRouter);
  app.use('/api/residents', residentsRouter);
  app.use('/api/staff', staffRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/import', importRouter);
  app.use('/api/directory', directoryRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/fees', feesRouter);
  app.use('/api/bills', billsRouter);
  app.use('/api/charges', chargesRouter);
  app.use('/api/payments', paymentsRouter);
  app.use('/api/payment-reports', paymentReportsRouter);
  app.use('/api/certificates', certificatesRouter);
  app.use('/api/expenses', expensesRouter);
  app.use('/api/requests', requestsRouter);
  app.use('/api/scheduled-tasks', scheduledTasksRouter);
  app.use('/api/attachments', attachmentsRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/announcements', announcementsRouter);
  app.use('/api/groups', groupsRouter);
  app.use('/api/emergency-contacts', emergencyContactsRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/activity', activityRouter);
  app.use('/api/search', searchRouter);

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND' } });
  });
  app.use(errorHandler);

  if (config.SERVE_WEB) {
    const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
    app.use(express.static(web));
    app.get('*', (_req, res) => res.sendFile(path.join(web, 'index.html'))); // the web app handles its own routes
  }

  return app;
}
