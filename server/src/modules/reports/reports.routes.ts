import { Router } from 'express';
import { dashboardQuerySchema, financeReportQuerySchema } from '@apt/shared';
import { asyncHandler } from '../../lib/errors';
import { requireAuth, requirePermission } from '../../middleware/auth';
import { dashboard, duesReport, financeReport } from './reports.service';
import { incomeExpenseReport } from '../expenses/expenses.service';

// FR-15, FR-27 to FR-29: administrators, and staff granted reports.view (Appendix B).
const guard = [requireAuth, requirePermission('reports.view')];

export const dashboardRouter = Router();
dashboardRouter.use(...guard);
dashboardRouter.get('/', asyncHandler(async (req, res) => res.json(await dashboard(dashboardQuerySchema.parse(req.query).month))));

export const reportsRouter = Router();
reportsRouter.use(...guard);
reportsRouter.get(
  '/finance',
  asyncHandler(async (req, res) => {
    const { from, to } = financeReportQuerySchema.parse(req.query);
    res.json(await financeReport(from, to));
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
