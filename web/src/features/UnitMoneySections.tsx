import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { parseTaka } from '@apt/shared';
import { Button, Card, Field, Notice, Spinner, TextInput } from '../components/ui';
import { api } from '../lib/api';
import { errorMessage, fieldErrorsOf } from '../lib/errors';
import type { BillDetail, BillList, FeeItem } from '../lib/types';
import { FeeEditor } from './FeeEditor';

/** This unit's own fees; only the types filled in replace the building-wide amounts (FR-32). */
export function UnitFeesSection({ unitId }: { unitId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [saved, setSaved] = useState(false);
  const q = useQuery({ queryKey: ['unit-fees', unitId], queryFn: () => api.get<{ fees: FeeItem[] }>(`/api/units/${unitId}/fees`) });
  const save = useMutation({
    mutationFn: (fees: FeeItem[]) => api.put<{ fees: FeeItem[] }>(`/api/units/${unitId}/fees`, { fees }),
    onMutate: () => setSaved(false),
    onSuccess: async (data) => {
      qc.setQueryData(['unit-fees', unitId], data);
      await qc.invalidateQueries({ queryKey: ['fees'] });
      setSaved(true);
    },
  });
  return (
    <Card className="mt-4">
      <h2 className="mb-1 heading-section">{t('fees.unitTitle')}</h2>
      <p className="mb-1 text-sm text-muted">{t('fees.unitHelp')}</p>
      <p className="mb-4 text-sm font-semibold">{t('fees.futureOnly')}</p>
      {q.isLoading ? (
        <Spinner />
      ) : q.isError ? (
        <Notice>{errorMessage(t, q.error)}</Notice>
      ) : (
        <FeeEditor key={JSON.stringify(q.data!.fees)} initial={q.data!.fees} saving={save.isPending} saved={saved} error={save.error} onSave={(fees) => save.mutate(fees)} />
      )}
    </Card>
  );
}

/** What this unit already owed before the system was used (FR-41). Administrators only. */
export function OpeningBalanceSection({ unitId }: { unitId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [amount, setAmount] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [note, setNote] = useState('');
  const [localError, setLocalError] = useState('');

  const existing = useQuery({
    queryKey: ['opening-balance', unitId],
    queryFn: () => api.get<BillList>(`/api/bills?unitId=${unitId}&kind=OPENING_BALANCE`),
  });
  const record = useMutation({
    mutationFn: () => api.post<BillDetail>(`/api/units/${unitId}/opening-balance`, { amount: parseTaka(amount), ...(dueDate ? { dueDate } : {}), note: note.trim() }),
    onSuccess: async () => {
      setAmount('');
      setNote('');
      await Promise.all(['opening-balance', 'bills'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
    },
  });
  const fields = fieldErrorsOf(t, record.error);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (parseTaka(amount) === null) return setLocalError(t('fieldErrors.INVALID'));
    setLocalError('');
    record.mutate();
  }

  const bill = existing.data?.items[0];
  return (
    <Card className="mt-4">
      <h2 className="mb-1 heading-section">{t('opening.title')}</h2>
      <p className="mb-4 text-sm text-muted">{t('opening.help')}</p>
      {existing.isLoading ? (
        <Spinner />
      ) : bill ? (
        <div className="space-y-2">
          <Notice tone="info">{t('opening.recorded')}</Notice>
          <Link to={`/bills/${bill.id}`} className="link-action">
            {t('opening.view')}
          </Link>
        </div>
      ) : (
        <form className="space-y-4" noValidate onSubmit={submit}>
          {record.isError && Object.keys(fields).length === 0 && <Notice>{errorMessage(t, record.error)}</Notice>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('opening.amount')} help={t('billing.amountHelp')} error={localError || fields.amount}>
              {(p) => <TextInput {...p} inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="opening-amount" />}
            </Field>
            <Field label={t('opening.dueDate')} optional error={fields.dueDate}>
              {(p) => <TextInput {...p} type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />}
            </Field>
          </div>
          <Field label={t('opening.note')} optional>
            {(p) => <TextInput {...p} maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />}
          </Field>
          <Button type="submit" disabled={record.isPending || !amount}>
            {t('opening.record')}
          </Button>
        </form>
      )}
    </Card>
  );
}
