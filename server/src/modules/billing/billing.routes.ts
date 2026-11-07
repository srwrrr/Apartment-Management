import { Router, type RequestHandler, type Response } from 'express';
import multer from 'multer';
import {
  billListQuerySchema,
  chargeInputSchema,
  chargeUpdateSchema,
  feeListSchema,
  generateBillsSchema,
  oneOffBillSchema,
  openingBalanceSchema,
  paymentInputSchema,
  voidPaymentSchema,
  BILL_READ_PERMISSIONS,
  MAX_PHOTO_BYTES,
  buildingSummaryQuerySchema,
  certificateIssueSchema,
  certificateLookupSchema,
  myStatementQuerySchema,
  paymentReportCreateSchema,
  paymentReportListQuerySchema,
  paymentReportRejectSchema,
  paymentReportVerifySchema,
  statementQuerySchema,
} from '@apt/shared';
import { prisma } from '../../lib/prisma';
import { asyncHandler, assertUuid, forbidden, notFound } from '../../lib/errors';
import { requireAdmin, requireAnyPermission, requireAuth, requirePermission, requireRole } from '../../middleware/auth';
import { renderPdf } from '../../pdf/render';
import { getSettings } from '../settings/settings.service';
import { canReadAllBills, residentCanSeeBill } from './access';
import {
  addCharge,
  createOneOffBill,
  createOpeningBalance,
  deleteCharge,
  deleteOpeningBalance,
  generateBills,
  getBill,
  listBills,
  myBalance,
  updateCharge,
} from './bills.service';
import { getFees, getUnitFees, setDefaultFees, setUnitFees } from './fees.service';
import { getReceiptData, recordPayment, voidPayment } from './payments.service';
import { receiptHtml } from './receipt';
import { createReport, listBillReports, listReports, rejectReport, verifyReport } from './paymentReports.service';
import { getStatement, myStatementUnits, statementHtml, type Statement } from './statement.service';
import { certificateHtml, getCertificateFor, issueCertificate, listMyCertificates, listUnitCertificates, lookupCertificate } from './certificates.service';
import { buildingSummary } from '../expenses/expenses.service';

const param = (v: unknown) => String(v);
const canSeeAllBills = requireAnyPermission(...BILL_READ_PERMISSIONS);
const canEditBills = requirePermission('billing.manage');
// One screenshot, held in memory so its real content can be checked before anything is written (BR-21, NFR-06).
const screenshot = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PHOTO_BYTES, files: 1, fields: 10 } }).single('screenshot');

function sendPdf(res: Response, pdf: Buffer, filename: string) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}.pdf"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(pdf);
}

async function sendStatement(res: Response, s: Statement, language: 'EN' | 'BN') {
  const { buildingName } = await getSettings();
  sendPdf(res, await renderPdf(statementHtml(s, buildingName, language)), `statement-${s.unit.unitNumber}-${s.from}-${s.to}`);
}

// ---------------------------------------------------------------- fees (FR-32)
export const feesRouter = Router();
feesRouter.use(requireAuth, canEditBills);
feesRouter.get('/', asyncHandler(async (_req, res) => res.json(await getFees())));
feesRouter.put('/defaults', asyncHandler(async (req, res) => res.json(await setDefaultFees(feeListSchema.parse(req.body).fees))));

// ------------------------------------------------- per-unit fees and opening balance
// Mounted at /api/units/:unitId, before the units router.
export const unitBillingRouter = Router({ mergeParams: true });
unitBillingRouter.use(requireAuth);
unitBillingRouter.get('/fees', canEditBills, asyncHandler(async (req, res) => res.json(await getUnitFees(param(req.params.unitId)))));
unitBillingRouter.put(
  '/fees',
  canEditBills,
  asyncHandler(async (req, res) => res.json(await setUnitFees(param(req.params.unitId), feeListSchema.parse(req.body).fees))),
);
// FR-41 / BR-22: only administrators enter opening balances.
unitBillingRouter.post(
  '/opening-balance',
  requireAdmin,
  asyncHandler(async (req, res) => res.status(201).json(await createOpeningBalance(param(req.params.unitId), openingBalanceSchema.parse(req.body), req.user!))),
);

// FR-45: any unit's statement, for those who work with bills.
unitBillingRouter.get(
  '/statement',
  canSeeAllBills,
  asyncHandler(async (req, res) => {
    const { from, to } = statementQuerySchema.parse(req.query);
    res.json(await getStatement(param(req.params.unitId), from, to));
  }),
);
unitBillingRouter.get(
  '/statement.pdf',
  canSeeAllBills,
  asyncHandler(async (req, res) => {
    const { from, to } = statementQuerySchema.parse(req.query);
    await sendStatement(res, await getStatement(param(req.params.unitId), from, to), req.user!.language);
  }),
);

// FR-46: issuing is for administrators only (never grantable); billing.view may look.
unitBillingRouter.get('/certificates', requirePermission('billing.view'), asyncHandler(async (req, res) => res.json(await listUnitCertificates(param(req.params.unitId)))));
unitBillingRouter.post(
  '/certificates',
  requireAdmin,
  asyncHandler(async (req, res) => res.status(201).json(await issueCertificate(param(req.params.unitId), certificateIssueSchema.parse(req.body).residentId, req.user!))),
);

// ---------------------------------------------------------------------- bills
export const billsRouter = Router();
billsRouter.use(requireAuth);

billsRouter.get('/', canSeeAllBills, asyncHandler(async (req, res) => res.json(await listBills(billListQuerySchema.parse(req.query)))));

// FR-09: ?dryRun=true shows what would be created and saves nothing.
billsRouter.post(
  '/generate',
  canEditBills,
  asyncHandler(async (req, res) =>
    res.json(await generateBills(generateBillsSchema.parse(req.body), req.user!, req.query.dryRun === 'true')),
  ),
);
billsRouter.post('/', canEditBills, asyncHandler(async (req, res) => res.status(201).json(await createOneOffBill(oneOffBillSchema.parse(req.body), req.user!))));

/** Staff who work with bills see any bill; a resident sees only their own, and gets "not found" for others (NFR-24). */
const billVisibility: RequestHandler = asyncHandler(async (req, res) => {
  const id = param(req.params.id);
  assertUuid(id);
  const user = req.user!;
  if (canReadAllBills(user)) return void res.json(await getBill(id));
  if (user.role !== 'RESIDENT') throw forbidden();
  if (!(await residentCanSeeBill(user.id, id))) throw notFound();
  res.json(await getBill(id, { forResident: true }));
});
billsRouter.get('/:id', billVisibility);

billsRouter.post('/:id/charges', canEditBills, asyncHandler(async (req, res) => res.status(201).json(await addCharge(param(req.params.id), chargeInputSchema.parse(req.body)))));
billsRouter.post(
  '/:id/payments',
  requirePermission('payments.record'),
  asyncHandler(async (req, res) => res.status(201).json(await recordPayment(param(req.params.id), paymentInputSchema.parse(req.body), req.user!))),
);
// FR-39: "I've paid". Residents and household members, on a bill they can see.
billsRouter.post(
  '/:id/payment-reports',
  requireRole('RESIDENT'),
  screenshot,
  asyncHandler(async (req, res) => res.status(201).json(await createReport(param(req.params.id), paymentReportCreateSchema.parse(req.body), req.file, req.user!))),
);
billsRouter.get('/:id/payment-reports', asyncHandler(async (req, res) => res.json(await listBillReports(param(req.params.id), req.user!))));
billsRouter.delete(
  '/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    await deleteOpeningBalance(param(req.params.id));
    res.status(204).end();
  }),
);

// -------------------------------------------------------------------- charges
export const chargesRouter = Router();
chargesRouter.use(requireAuth, canEditBills);
chargesRouter.patch('/:id', asyncHandler(async (req, res) => res.json(await updateCharge(param(req.params.id), chargeUpdateSchema.parse(req.body), req.user!))));
chargesRouter.delete('/:id', asyncHandler(async (req, res) => res.json(await deleteCharge(param(req.params.id), req.user!))));

// ------------------------------------------------------------ payment reports
// FR-40: the verification queue.
export const paymentReportsRouter = Router();
paymentReportsRouter.use(requireAuth, requirePermission('payments.record'));
paymentReportsRouter.get('/', asyncHandler(async (req, res) => res.json(await listReports(paymentReportListQuerySchema.parse(req.query)))));
paymentReportsRouter.post('/:id/verify', asyncHandler(async (req, res) => res.json(await verifyReport(param(req.params.id), paymentReportVerifySchema.parse(req.body), req.user!))));
paymentReportsRouter.post('/:id/reject', asyncHandler(async (req, res) => res.json(await rejectReport(param(req.params.id), paymentReportRejectSchema.parse(req.body), req.user!))));

// --------------------------------------------------------------- certificates
export const certificatesRouter = Router();
certificatesRouter.use(requireAuth);
// FR-46: an administrator confirms that a number is genuine.
certificatesRouter.get('/', requireAdmin, asyncHandler(async (req, res) => res.json(await lookupCertificate(certificateLookupSchema.parse(req.query).number))));
certificatesRouter.get(
  '/:id/pdf',
  asyncHandler(async (req, res) => {
    const user = req.user!;
    const c = await getCertificateFor(param(req.params.id), user);
    const { buildingName } = await getSettings();
    sendPdf(res, await renderPdf(certificateHtml(c, buildingName, user.language)), c.number);
  }),
);

// ------------------------------------------------------------------- payments
export const paymentsRouter = Router();
paymentsRouter.use(requireAuth);
paymentsRouter.post('/:id/void', requireAdmin, asyncHandler(async (req, res) => res.json(await voidPayment(param(req.params.id), voidPaymentSchema.parse(req.body), req.user!))));

// FR-14: the receipt as a PDF, in the reader's language.
paymentsRouter.get(
  '/:id/receipt.pdf',
  asyncHandler(async (req, res) => {
    const user = req.user!;
    const data = await getReceiptData(param(req.params.id), user);
    const { buildingName } = await getSettings();
    const pdf = await renderPdf(receiptHtml(data, buildingName, user.language));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${data.receiptNo}.pdf"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(pdf);
  }),
);

// ------------------------------------------------------ a resident's own money
// Mounted at /api/me/billing. Always scoped to the logged-in user (NFR-16).
export const meBillingRouter = Router();
meBillingRouter.use(requireAuth, requireRole('RESIDENT'));
meBillingRouter.get('/bills', asyncHandler(async (req, res) => res.json(await listBills(billListQuerySchema.parse(req.query), req.user!.id))));
meBillingRouter.get('/balance', asyncHandler(async (req, res) => res.json(await myBalance(req.user!.id))));

// FR-45: only what this resident may see (BR-08).
meBillingRouter.get('/statement/units', asyncHandler(async (req, res) => res.json({ items: await myStatementUnits(req.user!.id) })));
meBillingRouter.get(
  '/statement',
  asyncHandler(async (req, res) => {
    const { unitId, from, to } = myStatementQuerySchema.parse(req.query);
    res.json(await getStatement(unitId, from, to, req.user!.id));
  }),
);
meBillingRouter.get(
  '/statement.pdf',
  asyncHandler(async (req, res) => {
    const { unitId, from, to } = myStatementQuerySchema.parse(req.query);
    await sendStatement(res, await getStatement(unitId, from, to, req.user!.id), req.user!.language);
  }),
);
meBillingRouter.get('/certificates', asyncHandler(async (req, res) => res.json(await listMyCertificates(req.user!.id))));
// FR-44: only when the administrator shares it.
meBillingRouter.get('/building-summary', asyncHandler(async (req, res) => res.json(await buildingSummary(buildingSummaryQuerySchema.parse(req.query).month))));

/** Every payment on the bills this resident may see, newest first (FR-13). */
meBillingRouter.get(
  '/payments',
  asyncHandler(async (req, res) => {
    const rows = await prisma.$queryRaw<
      { id: string; amount: number; paidOn: string; method: string; reference: string | null; receiptNo: string; voided: boolean; billId: string; unitNumber: string; billingMonth: string; kind: string }[]
    >`
      SELECT p.id, p.amount, p."paidOn"::text AS "paidOn", p.method::text AS method, p.reference, p."receiptNo",
             (p."voidedAt" IS NOT NULL) AS voided, b.id AS "billId", u."unitNumber", b."billingMonth"::text AS "billingMonth", b.kind::text AS kind
      FROM "payments" p
      JOIN "bills" b ON b.id = p."billId"
      JOIN "units" u ON u.id = b."unitId"
      WHERE EXISTS (SELECT 1 FROM bill_access ba WHERE ba."userId" = ${req.user!.id}::uuid AND ba."billId" = b.id)
      ORDER BY p."paidOn" DESC, p."createdAt" DESC, p.id
      LIMIT 100`;
    res.json({ items: rows });
  }),
);
