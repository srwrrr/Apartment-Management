import { Router } from 'express';
import multer from 'multer';
import { MAX_PHOTO_BYTES, expenseCreateSchema, expenseListQuerySchema, expenseUpdateSchema, expenseVoidSchema } from '@apt/shared';
import { asyncHandler } from '../../lib/errors';
import { requireAuth, requirePermission } from '../../middleware/auth';
import { createExpense, listExpenses, updateExpense, voidExpense } from './expenses.service';

// One receipt, held in memory so its real content can be checked before anything is written (BR-23, NFR-06).
const receipt = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PHOTO_BYTES, files: 1, fields: 10 } }).single('receipt');
const param = (v: unknown) => String(v);

// FR-43: administrators and staff with expenses.manage (Appendix B).
export const expensesRouter = Router();
expensesRouter.use(requireAuth, requirePermission('expenses.manage'));
expensesRouter.get('/', asyncHandler(async (req, res) => res.json(await listExpenses(expenseListQuerySchema.parse(req.query)))));
expensesRouter.post('/', receipt, asyncHandler(async (req, res) => res.status(201).json(await createExpense(expenseCreateSchema.parse(req.body), req.file, req.user!))));
expensesRouter.patch('/:id', receipt, asyncHandler(async (req, res) => res.json(await updateExpense(param(req.params.id), expenseUpdateSchema.parse(req.body), req.file, req.user!))));
expensesRouter.post('/:id/void', asyncHandler(async (req, res) => res.json(await voidExpense(param(req.params.id), expenseVoidSchema.parse(req.body), req.user!))));
