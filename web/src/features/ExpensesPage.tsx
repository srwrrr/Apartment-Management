import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { EXPENSE_CATEGORIES, formatBDT, parseTaka } from '@apt/shared';
import { Button, Card, Chip, Field, Modal, Notice, PageHeader, Pagination, Select, Spinner, TextInput } from '../components/ui';
import { MonthInput } from '../components/MonthInput';
import { api } from '../lib/api';
import { errorMessage, fieldErrorsOf } from '../lib/errors';
import { formatDate, takaString, thisMonth, todayYmd } from '../lib/format';
import type { BuildingSummary, Expense, ExpenseList } from '../lib/types';

const ACCEPTED = 'image/jpeg,image/png,image/webp,application/pdf';

function ExpenseModal({ expense, onClose }: { expense?: Expense; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [spentOn, setSpentOn] = useState(expense?.spentOn ?? todayYmd());
  const [category, setCategory] = useState<string>(expense?.category ?? 'CLEANING');
  const [amount, setAmount] = useState(expense ? takaString(expense.amount) : '');
  const [payee, setPayee] = useState(expense?.payee ?? '');
  const [description, setDescription] = useState(expense?.description ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [localError, setLocalError] = useState('');

  const save = useMutation({
    mutationFn: (poisha: number) => {
      const form = new FormData();
      form.append('spentOn', spentOn);
      form.append('category', category);
      form.append('amount', String(poisha));
      form.append('payee', payee.trim());
      form.append('description', description.trim());
      if (file) form.append('receipt', file);
      return expense ? api.patchForm(`/api/expenses/${expense.id}`, form) : api.postForm('/api/expenses', form);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['expenses'] });
      onClose();
    },
  });
  const fields = fieldErrorsOf(t, save.error);

  function submit(e: FormEvent) {
    e.preventDefault();
    const poisha = parseTaka(amount);
    if (poisha === null) return setLocalError(t('fieldErrors.INVALID'));
    setLocalError('');
    save.mutate(poisha);
  }

  return (
    <Modal title={expense ? t('expenses.editTitle') : t('expenses.add')} onClose={onClose}>
      <form className="space-y-4" noValidate onSubmit={submit}>
        {save.isError && Object.keys(fields).length === 0 && <Notice>{errorMessage(t, save.error)}</Notice>}
        <Field label={t('expenses.date')} error={fields.spentOn}>
          {(p) => <TextInput {...p} type="date" required max={todayYmd()} value={spentOn} onChange={(e) => setSpentOn(e.target.value)} />}
        </Field>
        <Field label={t('expenses.category')} error={fields.category}>
          {(p) => (
            <Select {...p} value={category} onChange={(e) => setCategory(e.target.value)}>
              {EXPENSE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {t(`expenses.categories.${c}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('expenses.amount')} error={localError || fields.amount}>
          {(p) => <TextInput {...p} inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} />}
        </Field>
        <Field label={t('expenses.payee')} error={fields.payee}>
          {(p) => <TextInput {...p} required maxLength={120} value={payee} onChange={(e) => setPayee(e.target.value)} />}
        </Field>
        <Field label={t('expenses.description')} optional error={fields.description}>
          {(p) => <TextInput {...p} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />}
        </Field>
        <Field label={expense?.receiptId ? t('expenses.receiptReplace') : t('expenses.receipt')} optional help={t('expenses.receiptHelp')} error={fields.receipt}>
          {(p) => <input {...p} type="file" accept={ACCEPTED} className="block min-h-11 w-full text-base" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />}
        </Field>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={save.isPending || !amount || !payee.trim()}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function VoidModal({ expense, onClose }: { expense: Expense; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const run = useMutation({
    mutationFn: () => api.post(`/api/expenses/${expense.id}/void`, { reason }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['expenses'] });
      onClose();
    },
  });
  const fields = fieldErrorsOf(t, run.error);
  return (
    <Modal title={t('expenses.voidTitle')} onClose={onClose}>
      <form
        className="space-y-4"
        noValidate
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          run.mutate();
        }}
      >
        <p>
          <strong>{expense.payee}</strong> · {formatBDT(expense.amount)}
        </p>
        <p className="text-sm text-muted">{t('expenses.voidHelp')}</p>
        {run.isError && Object.keys(fields).length === 0 && <Notice>{errorMessage(t, run.error)}</Notice>}
        <Field label={t('expenses.voidReason')} error={fields.reason}>
          {(p) => <TextInput {...p} required maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="danger" disabled={run.isPending || reason.trim().length < 3}>
            {t('expenses.void')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** FR-43. */
export function ExpensesPage() {
  const { t } = useTranslation();
  const [category, setCategory] = useState('');
  const [month, setMonth] = useState('');
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [voiding, setVoiding] = useState<Expense | null>(null);
  const q = useQuery({
    queryKey: ['expenses', category, month, page],
    queryFn: () => api.get<ExpenseList>(`/api/expenses?page=${page}${category ? `&category=${category}` : ''}${month ? `&month=${month}` : ''}`),
  });

  return (
    <>
      <PageHeader title={t('expenses.title')}>
        <Button onClick={() => setAdding(true)}>{t('expenses.add')}</Button>
      </PageHeader>
      <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:max-w-xl">
        <Field label={t('expenses.category')}>
          {(p) => (
            <Select
              {...p}
              value={category}
              onChange={(e) => {
                setCategory(e.target.value);
                setPage(1);
              }}
            >
              <option value="">{t('expenses.allCategories')}</option>
              {EXPENSE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {t(`expenses.categories.${c}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('expenses.month')}>
          {(p) => (
            <MonthInput
              {...p}
              value={month}
              onChange={(e) => {
                setMonth(e.target.value);
                setPage(1);
              }}
            />
          )}
        </Field>
      </div>
      {q.isLoading ? (
        <Spinner />
      ) : q.isError ? (
        <Notice>{errorMessage(t, q.error)}</Notice>
      ) : q.data!.items.length === 0 ? (
        <p className="py-6 text-muted">{t('expenses.empty')}</p>
      ) : (
        <>
          <p className="mb-2 heading-card" data-testid="expenses-total">
            {t('expenses.total', { amount: formatBDT(q.data!.totalAmount) })}
          </p>
          <Card className="card-flush">
            <ul className="divide-y divide-line">
              {q.data!.items.map((e) => (
                <li key={e.id} className="px-4 py-3" data-testid="expense">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="min-w-40 flex-1">
                      <span className={`block font-bold ${e.voided ? 'line-through' : ''}`}>
                        {formatBDT(e.amount)} · {e.payee}
                      </span>
                      <span className="block text-sm text-muted">
                        {formatDate(e.spentOn)} · {t(`expenses.categories.${e.category}`)}
                        {e.description ? ` · ${e.description}` : ''}
                      </span>
                    </span>
                    {e.voided && <Chip tone="red">{t('expenses.voided')}</Chip>}
                    {e.receiptId && (
                      <a href={`/api/attachments/${e.receiptId}`} target="_blank" rel="noopener" className="link-action">
                        {t('expenses.viewReceipt')}
                      </a>
                    )}
                    {!e.voided && (
                      <span className="flex gap-2">
                        <Button variant="ghost" onClick={() => setEditing(e)}>
                          {t('common.edit')}
                        </Button>
                        <Button variant="ghost" onClick={() => setVoiding(e)}>
                          {t('expenses.void')}
                        </Button>
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-muted">{t('expenses.recordedBy', { name: e.recordedBy })}</p>
                  {e.voided && (
                    <p className="text-sm font-medium text-danger">
                      {e.voidReason}
                      {e.voidedBy ? ` — ${t('billing.voidedBy', { name: e.voidedBy })}` : ''}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}
      {q.data && <Pagination page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={setPage} />}
      {adding && <ExpenseModal onClose={() => setAdding(false)} />}
      {editing && <ExpenseModal expense={editing} onClose={() => setEditing(null)} />}
      {voiding && <VoidModal expense={voiding} onClose={() => setVoiding(null)} />}
    </>
  );
}

/** FR-44: what residents see, only when the administrator shares it. */
export function BuildingSummaryPage() {
  const { t } = useTranslation();
  const [month, setMonth] = useState(thisMonth());
  const q = useQuery({ queryKey: ['building-summary', month], queryFn: () => api.get<BuildingSummary>(`/api/me/billing/building-summary?month=${month}`), retry: false });
  return (
    <>
      <PageHeader title={t('buildingSummary.title')} />
      <div className="mb-4 max-w-56">
        <Field label={t('buildingSummary.month')}>{(p) => <MonthInput {...p} value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />}</Field>
      </div>
      {q.isLoading ? (
        <Spinner />
      ) : q.isError ? (
        <p className="py-6 text-muted">{t('buildingSummary.off')}</p>
      ) : q.data!.byCategory.length === 0 ? (
        <p className="py-6 text-muted">{t('buildingSummary.none')}</p>
      ) : (
        <Card className="max-w-xl">
          <ul data-testid="summary">
            {q.data!.byCategory.map((c) => (
              <li key={c.category} className="flex justify-between border-b border-line py-2">
                <span>{t(`expenses.categories.${c.category}`)}</span>
                <span className="font-semibold">{formatBDT(c.amount)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 flex justify-between heading-card">
            <span>{t('buildingSummary.total')}</span>
            <span data-testid="summary-total">{formatBDT(q.data!.total)}</span>
          </p>
        </Card>
      )}
    </>
  );
}
