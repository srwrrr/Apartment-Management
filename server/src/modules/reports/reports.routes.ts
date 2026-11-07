import { Router } from 'express';
import { committeeQuerySchema, dashboardQuerySchema, financeReportQuerySchema } from '@apt/shared';
import { asyncHandler } from '../../lib/errors';
import { requireAuth, requirePermission } from '../../middleware/auth';
import { dashboard, duesReport, financeReport, maintenanceReport } from './reports.service';
import { incomeExpenseReport } from '../expenses/expenses.service';
import { committeeData, committeeHtml } from './committee';
import { getSettings } from '../settings/settings.service';
import { renderPdf } from '../../pdf/render';
import { sendCsv, taka, toCsv } from '../../lib/csv';
import { strings } from '../billing/receipt';

// FR-15, FR-27 to FR-29: administrators, and staff granted reports.view (Appendix B).
const guard = [requireAuth, requirePermission('reports.view')];

export const dashboardRouter = Router();
dashboardRouter.use(...guard);
dashboardRouter.get('/', asyncHandler(async (req, res) => res.json(await dashboard(dashboardQuerySchema.parse(req.query).month, { activity: req.user!.role === 'ADMIN' }))));

export const reportsRouter = Router();
reportsRouter.use(...guard);
reportsRouter.get(
  '/finance',
  asyncHandler(async (req, res) => {
    const { from, to } = financeReportQuerySchema.parse(req.query);
    res.json(await financeReport(from, to));
  }),
);
// FR-22.
reportsRouter.get(
  '/maintenance',
  asyncHandler(async (req, res) => {
    const { from, to } = financeReportQuerySchema.parse(req.query);
    res.json(await maintenanceReport(from, to));
  }),
);
// FR-44.
reportsRouter.get(
  '/income-expense',
  asyncHandler(async (req, res) => {
    const { from, to } = financeReportQuerySchema.parse(req.query);
    res.json(await incomeExpenseReport(from, to));
  }),
);
reportsRouter.get('/dues', asyncHandler(async (_req, res) => res.json(await duesReport())));

// FR-38: the same figures as the reports above, for a spreadsheet. Money is in taka so the columns add up.
reportsRouter.get(
  '/finance.csv',
  asyncHandler(async (req, res) => {
    const { from, to } = financeReportQuerySchema.parse(req.query);
    const t = strings[req.user!.language].csv;
    const r = await financeReport(from, to);
    sendCsv(
      res,
      `collection-${from}-${to}.csv`,
      toCsv(
        [t.month, t.bills, t.billed, t.collected, t.outstanding, t.rate],
        r.months.map((m) => [m.month, m.bills, taka(m.billed), taka(m.collected), taka(m.outstanding), m.rate]),
      ),
    );
  }),
);
reportsRouter.get(
  '/dues.csv',
  asyncHandler(async (req, res) => {
    const t = strings[req.user!.language].csv;
    const r = await duesReport();
    sendCsv(
      res,
      'dues.csv',
      toCsv(
        [t.unit, t.contact, t.phone, t.owed, t.overdueBills, t.oldestOverdue],
        r.units.map((u) => [u.unit.unitNumber, u.contact?.name, u.contact?.phone, taka(u.owed), u.overdueBills, u.oldestOverdue]),
      ),
    );
  }),
);

// FR-57: one PDF for the committee meeting, in the language of the person downloading it.
reportsRouter.get(
  '/committee.pdf',
  asyncHandler(async (req, res) => {
    const { month } = committeeQuerySchema.parse(req.query);
    const [data, { buildingName }] = await Promise.all([committeeData(month), getSettings()]);
    const pdf = await renderPdf(committeeHtml(data, buildingName, req.user!.language));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="committee-${month}.pdf"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(pdf);
  }),
);
