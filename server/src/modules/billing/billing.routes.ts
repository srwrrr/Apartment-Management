import { Router, type RequestHandler } from 'express';
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

const param = (v: unknown) => String(v);
const canSeeAllBills = requireAnyPermission(...BILL_READ_PERMISSIONS);
const canEditBills = requirePermission('billing.manage');

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
