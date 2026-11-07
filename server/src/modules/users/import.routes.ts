import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, notFound } from '../../lib/errors';
import { requireAdmin, requireAuth } from '../../middleware/auth';
import { MAX_CSV_CHARS, runImport, template, type ImportKind } from './import.service';

// FR-42: administrators only (Appendix B).
export const importRouter = Router();
importRouter.use(requireAuth, requireAdmin);

const kindOf = (s: string): ImportKind => {
  if (s === 'units' || s === 'residents') return s;
  throw notFound();
};

importRouter.get('/templates/:file', (req, res) => {
  const m = /^(units|residents)\.csv$/.exec(String(req.params.file));
  if (!m) throw notFound();
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${m[1]}-template.csv"`);
  res.send(template(m[1] as ImportKind));
});

const bodySchema = z.object({ csv: z.string().max(MAX_CSV_CHARS) });

// ?dryRun=true checks the file and saves nothing. The real import needs a file that checks out clean.
importRouter.post(
  '/:kind',
  asyncHandler(async (req, res) => {
    const kind = kindOf(String(req.params.kind));
    const { csv } = bodySchema.parse(req.body);
    const result = await runImport(kind, csv, req.query.dryRun === 'true', req.user!.id);
    // A file with problems is a normal, expected outcome of checking it: 200 with the list of problems.
    // Only a real import of an invalid file is refused.
    if (!result.valid && req.query.dryRun !== 'true') {
      res.status(422).json({ error: { code: 'IMPORT_INVALID' }, ...result });
      return;
    }
    res.json(result);
  }),
);
