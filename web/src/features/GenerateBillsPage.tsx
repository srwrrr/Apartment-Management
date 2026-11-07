import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { formatBDT } from '@apt/shared';
import { Button, Card, Field, Notice, PageHeader, TextInput } from '../components/ui';
import { api } from '../lib/api';
import { errorMessage, fieldErrorsOf } from '../lib/errors';
import { formatDate, monthLabel, thisMonth } from '../lib/format';

interface Plan {
  month: string;
  dueDate: string;
  count: number;
  total: number;
  created: number;
  willCreate: { unitId: string; unitNumber: string; total: number }[];
  skipped: { unitId: string; unitNumber: string; reason: 'ALREADY_BILLED' | 'NO_FEES' }[];
}

/** FR-09: preview, then confirm. Nothing is saved until the second step. */
export function GenerateBillsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [month, setMonth] = useState(thisMonth());
  const [dueDate, setDueDate] = useState('');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [done, setDone] = useState<Plan | null>(null);

  const body = () => ({ month, ...(dueDate ? { dueDate } : {}) });
  const preview = useMutation({
    mutationFn: () => api.post<Plan>('/api/bills/generate?dryRun=true', body()),
    onSuccess: (p) => {
      setPlan(p);
      setDone(null);
    },
  });
  const generate = useMutation({
    mutationFn: () => api.post<Plan>('/api/bills/generate', body()),
    onSuccess: async (p) => {
      setDone(p);
      setPlan(null);
      await qc.invalidateQueries({ queryKey: ['bills'] });
    },
    onError: () => setPlan(null), // the data changed under us; ask for a fresh preview
  });
  const error = preview.error ?? generate.error;
  const fields = fieldErrorsOf(t, error);
  const change = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPlan(null);
    setDone(null);
  };

  return (
    <>
      <div className="mb-2">
        <Link to="/bills" className="inline-flex min-h-11 items-center font-semibold text-brand-700 underline">
          ← {t('billing.title')}
        </Link>
      </div>
      <PageHeader title={t('generate.title')} />
      <p className="mb-4 max-w-2xl text-muted">{t('generate.intro')}</p>

      <Card className="mb-4 max-w-2xl">
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            preview.mutate();
          }}
        >
          {error != null && Object.keys(fields).length === 0 && <Notice>{errorMessage(t, error)}</Notice>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('generate.month')} error={fields.month}>
              {(p) => <TextInput {...p} type="month" required value={month} onChange={(e) => change(setMonth)(e.target.value)} />}
            </Field>
            <Field label={t('generate.dueDate')} help={t('generate.dueHelp')} error={fields.dueDate}>
              {(p) => <TextInput {...p} type="date" value={dueDate} onChange={(e) => change(setDueDate)(e.target.value)} />}
            </Field>
          </div>
          <Button type="submit" disabled={preview.isPending || !/^\d{4}-\d{2}$/.test(month)}>
            {preview.isPending ? t('generate.previewing') : t('generate.preview')}
          </Button>
        </form>
      </Card>

      {plan && (
        <Card className="max-w-2xl space-y-4">
          <h2 className="text-xl font-bold">{monthLabel(plan.month)}</h2>
          {plan.count === 0 ? (
            <Notice tone="info">{t('generate.nothing')}</Notice>
          ) : (
            <>
              <Notice tone="info">{t('generate.willCreate', { count: plan.count, total: formatBDT(plan.total) })}</Notice>
              <p className="text-sm text-muted">{t('billing.dueOn', { date: formatDate(plan.dueDate) })}</p>
              <details>
                <summary className="min-h-11 cursor-pointer py-2 font-semibold">{t('generate.units')} ({plan.count})</summary>
                <ul className="divide-y divide-line">
                  {plan.willCreate.map((u) => (
                    <li key={u.unitId} className="flex justify-between py-2">
                      <span className="font-semibold">{u.unitNumber}</span>
                      <span>{formatBDT(u.total)}</span>
                    </li>
                  ))}
                </ul>
              </details>
            </>
          )}
          {plan.skipped.length > 0 && (
            <div>
              <h3 className="font-semibold">{t('generate.skipped')}</h3>
              <ul className="divide-y divide-line">
                {plan.skipped.map((s) => (
                  <li key={s.unitId} className="flex flex-wrap justify-between gap-2 py-2">
                    <span className="font-semibold">{s.unitNumber}</span>
                    <span className="text-muted">{t(`generate.reason${s.reason}`)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {plan.count > 0 && (
            <Button disabled={generate.isPending} onClick={() => generate.mutate()}>
              {t('generate.confirm', { count: plan.count })}
            </Button>
          )}
        </Card>
      )}

      {done && (
        <Card className="max-w-2xl space-y-3">
          <Notice tone="info">{t('generate.done', { count: done.created })}</Notice>
          <Link to="/bills" className="inline-flex min-h-11 items-center font-semibold text-brand-700 underline">
            {t('generate.viewBills')}
          </Link>
        </Card>
      )}
    </>
  );
}
