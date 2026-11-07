import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { MANUAL_CHARGE_TYPES, PAYMENT_METHODS, formatBDT, parseTaka } from '@apt/shared';
import { useAuth } from '../app/auth';
import { BillStatusChip } from '../components/BillStatusChip';
import { Button, Card, Chip, Field, Modal, Notice, PageHeader, Select, Spinner, TextInput } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { errorMessage, fieldErrorsOf } from '../lib/errors';
import { formatDate, monthLabel, takaString, todayYmd } from '../lib/format';
import type { BillDetail, Charge, PaymentEntry } from '../lib/types';

/** After any change to a bill, refresh everything that shows money. */
function useBillRefresh(id: string) {
  const qc = useQueryClient();
  return async (bill?: BillDetail) => {
    if (bill) qc.setQueryData(['bill', id], bill);
    await Promise.all(['bills', 'my-bills', 'my-balance', 'my-payments'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
  };
}

// ------------------------------------------------------------------ charges

function ChargeModal({ bill, charge, onClose }: { bill: BillDetail; charge?: Charge; onClose: () => void }) {
  const { t } = useTranslation();
  const refresh = useBillRefresh(bill.id);
  const used = new Set(bill.charges.map((c) => c.type));
  // A recurring type may appear once per bill; "Other" as often as needed (BR-07).
  const available = MANUAL_CHARGE_TYPES.filter((ty) => ty === 'OTHER' || !used.has(ty));
  const [type, setType] = useState<string>(available[0] ?? 'OTHER');
  const [amount, setAmount] = useState(charge ? takaString(charge.amount) : '');
  const [description, setDescription] = useState(charge?.description ?? '');
  const [localError, setLocalError] = useState('');

  const save = useMutation({
    mutationFn: () => {
      const poisha = parseTaka(amount);
      const body = { amount: poisha, description: description.trim() || t(`chargeTypes.${charge?.type ?? type}`) };
      return charge ? api.patch<BillDetail>(`/api/charges/${charge.id}`, body) : api.post<BillDetail>(`/api/bills/${bill.id}/charges`, { ...body, type });
    },
    onSuccess: async (b) => {
      await refresh(b);
      onClose();
    },
  });
  const fields = fieldErrorsOf(t, save.error);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (parseTaka(amount) === null) return setLocalError(t('fieldErrors.INVALID'));
    setLocalError('');
    save.mutate();
  }

  return (
    <Modal title={charge ? t('billing.editCharge') : t('billing.addCharge')} onClose={onClose}>
      <form className="space-y-4" noValidate onSubmit={submit}>
        {save.isError && Object.keys(fields).length === 0 && <Notice>{errorMessage(t, save.error)}</Notice>}
        {!charge && (
          <Field label={t('billing.chargeType')} error={fields.type}>
            {(p) => (
              <Select {...p} value={type} onChange={(e) => setType(e.target.value)}>
                {available.map((ty) => (
                  <option key={ty} value={ty}>
                    {t(`chargeTypes.${ty}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Field label={t('billing.amount')} help={t('billing.amountHelp')} error={localError || fields.amount}>
          {(p) => <TextInput {...p} inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} />}
        </Field>
        <Field label={t('billing.description')} optional>
          {(p) => <TextInput {...p} maxLength={200} value={description} onChange={(e) => setDescription(e.target.value)} />}
        </Field>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={save.isPending || !amount}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ChargesCard({ bill }: { bill: BillDetail }) {
  const { t } = useTranslation();
  const { can, user } = useAuth();
  const refresh = useBillRefresh(bill.id);
  const [modal, setModal] = useState<{ charge?: Charge } | null>(null);
  const isOpening = bill.kind === 'OPENING_BALANCE';
  const canEdit = can('billing.manage');

  const remove = useMutation({
    mutationFn: (id: string) => api.delete<BillDetail>(`/api/charges/${id}`),
    onSuccess: (b) => refresh(b),
  });

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-bold">{t('billing.charges')}</h2>
        {canEdit && !isOpening && <Button variant="secondary" onClick={() => setModal({})}>{t('billing.addCharge')}</Button>}
      </div>
      {remove.isError && <div className="mb-3"><Notice>{errorMessage(t, remove.error)}</Notice></div>}
      <ul className="divide-y divide-line">
        {bill.charges.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3">
            <span className="min-w-32 flex-1">
              <span className="block font-semibold">{t(`chargeTypes.${c.type}`)}</span>
              {c.description && c.description !== t(`chargeTypes.${c.type}`) && <span className="block text-sm text-muted">{c.description}</span>}
            </span>
            <span className="font-bold">{formatBDT(c.amount)}</span>
            {canEdit && (!isOpening || user?.role === 'ADMIN') && (
              <span className="flex gap-2">
                <Button variant="ghost" onClick={() => setModal({ charge: c })}>
                  {t('common.edit')}
                </Button>
                {!isOpening && (
                  <Button
                    variant="ghost"
                    disabled={remove.isPending}
                    onClick={() => {
                      if (window.confirm(t('billing.confirmRemove'))) remove.mutate(c.id);
                    }}
                  >
                    {t('billing.deleteCharge')}
                  </Button>
                )}
              </span>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-3 flex justify-between border-t border-line pt-3 text-lg font-bold">
        <span>{t('billing.total')}</span>
        <span data-testid="bill-total">{formatBDT(bill.total)}</span>
      </p>
      {modal && <ChargeModal bill={bill} charge={modal.charge} onClose={() => setModal(null)} />}
    </Card>
  );
}

// ----------------------------------------------------------------- payments

function RecordPaymentForm({ bill }: { bill: BillDetail }) {
  const { t } = useTranslation();
  const refresh = useBillRefresh(bill.id);
  const [amount, setAmount] = useState('');
  const [paidOn, setPaidOn] = useState(todayYmd());
  const [method, setMethod] = useState('CASH');
  const [reference, setReference] = useState('');
  const [duplicate, setDuplicate] = useState(false);
  const [localError, setLocalError] = useState('');
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: (confirm: boolean) =>
      api.post<{ paymentId: string; bill: BillDetail }>(`/api/bills/${bill.id}/payments`, {
        amount: parseTaka(amount),
        paidOn,
        method,
        reference: reference.trim(),
        confirm: confirm || undefined,
      }),
    onSuccess: async (res) => {
      await refresh(res.bill);
      setAmount('');
      setReference('');
      setDuplicate(false);
      setSaved(true);
    },
    onError: (e) => {
      // The same transaction ID was used before: ask, rather than guess.
      if (e instanceof ApiError && e.code === 'DUPLICATE_REFERENCE') setDuplicate(true);
    },
  });
  const fields = fieldErrorsOf(t, save.error);
  const touch = () => {
    setSaved(false);
    setDuplicate(false);
  };

  function submit(e: FormEvent) {
    e.preventDefault();
    if (parseTaka(amount) === null) return setLocalError(t('fieldErrors.INVALID'));
    setLocalError('');
    save.mutate(false);
  }

  return (
    <form className="space-y-4" noValidate onSubmit={submit}>
      <h3 className="text-lg font-semibold">{t('billing.recordPayment')}</h3>
      <p className="font-semibold">{t('billing.balanceDue', { amount: formatBDT(bill.balance) })}</p>
      {saved && <Notice tone="info">{t('billing.paymentSaved')}</Notice>}
      {save.isError && !duplicate && Object.keys(fields).length === 0 && <Notice>{errorMessage(t, save.error)}</Notice>}
      {duplicate && (
        <div className="space-y-2">
          <Notice>{t('billing.duplicateWarning')}</Notice>
          <Button variant="danger" disabled={save.isPending} onClick={() => save.mutate(true)}>
            {t('billing.saveAnyway')}
          </Button>
        </div>
      )}
      <Field label={t('billing.amount')} error={localError || fields.amount}>
        {(p) => (
          <div className="flex gap-2">
            <TextInput {...p} inputMode="decimal" required value={amount} onChange={(e) => { touch(); setAmount(e.target.value); }} />
            <Button variant="secondary" onClick={() => { touch(); setAmount((bill.balance / 100).toFixed(2)); }}>
              {t('billing.payAll')}
            </Button>
          </div>
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('billing.paidOn')} error={fields.paidOn}>
          {(p) => <TextInput {...p} type="date" required max={todayYmd()} value={paidOn} onChange={(e) => { touch(); setPaidOn(e.target.value); }} />}
        </Field>
        <Field label={t('billing.method')}>
          {(p) => (
            <Select {...p} value={method} onChange={(e) => { touch(); setMethod(e.target.value); }}>
              {PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {t(`paymentMethods.${m}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <Field label={t('billing.reference')} optional error={fields.reference}>
        {(p) => <TextInput {...p} maxLength={40} value={reference} onChange={(e) => { touch(); setReference(e.target.value); }} />}
      </Field>
      <Button type="submit" disabled={save.isPending || !amount}>
        {t('billing.recordPayment')}
      </Button>
    </form>
  );
}

function VoidModal({ payment, billId, onClose }: { payment: PaymentEntry; billId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const refresh = useBillRefresh(billId);
  const [reason, setReason] = useState('');
  const run = useMutation({
    mutationFn: () => api.post<BillDetail>(`/api/payments/${payment.id}/void`, { reason }),
    onSuccess: async (b) => {
      await refresh(b);
      onClose();
    },
  });
  const fields = fieldErrorsOf(t, run.error);
  return (
    <Modal title={t('billing.voidTitle')} onClose={onClose}>
      <form
        className="space-y-4"
        noValidate
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          run.mutate();
        }}
      >
        <p>
          <strong>{payment.receiptNo}</strong> · {formatBDT(payment.amount)}
        </p>
        <p className="text-sm text-muted">{t('billing.voidHelp')}</p>
        {run.isError && Object.keys(fields).length === 0 && <Notice>{errorMessage(t, run.error)}</Notice>}
        <Field label={t('billing.voidReason')} error={fields.reason}>
          {(p) => <TextInput {...p} required maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="danger" disabled={run.isPending || reason.trim().length < 3}>
            {t('billing.voidPayment')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function PaymentsCard({ bill }: { bill: BillDetail }) {
  const { t } = useTranslation();
  const { can, user } = useAuth();
  const [voiding, setVoiding] = useState<PaymentEntry | null>(null);

  return (
    <Card>
      <h2 className="mb-3 text-xl font-bold">{t('billing.payments')}</h2>
      {bill.payments.length === 0 ? (
        <p className="text-muted">{t('billing.noPayments')}</p>
      ) : (
        <ul className="divide-y divide-line">
          {bill.payments.map((p) => (
            <li key={p.id} className={`py-3 ${p.voided ? 'opacity-70' : ''}`} data-testid="payment">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="min-w-28 flex-1">
                  <span className={`block font-bold ${p.voided ? 'line-through' : ''}`}>{formatBDT(p.amount)}</span>
                  <span className="block text-sm text-muted">
                    {formatDate(p.paidOn)} · {t(`paymentMethods.${p.method}`, { defaultValue: p.method })}
                    {p.reference ? ` · ${p.reference}` : ''}
                  </span>
                </span>
                {p.voided && <Chip tone="red">{t('billing.voided')}</Chip>}
                <a href={`/api/payments/${p.id}/receipt.pdf`} target="_blank" rel="noopener" className="inline-flex min-h-11 items-center font-semibold text-brand-700 underline">
                  {t('billing.downloadReceipt')}
                </a>
                {user?.role === 'ADMIN' && !p.voided && (
                  <Button variant="ghost" onClick={() => setVoiding(p)}>
                    {t('billing.voidPayment')}
                  </Button>
                )}
              </div>
              <p className="text-sm text-muted">
                {p.receiptNo}
                {p.recordedBy ? ` · ${t('billing.recordedBy', { name: p.recordedBy })}` : ''}
              </p>
              {p.voided && (
                <p className="text-sm font-medium text-danger-600">
                  {p.voidReason}
                  {p.voidedBy ? ` — ${t('billing.voidedBy', { name: p.voidedBy })}` : ''}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      {can('payments.record') && (
        <div className="mt-4 border-t border-line pt-4">
          {bill.balance > 0 ? <RecordPaymentForm bill={bill} /> : <Notice tone="info">{t('billing.billPaid')}</Notice>}
        </div>
      )}
      {voiding && <VoidModal payment={voiding} billId={bill.id} onClose={() => setVoiding(null)} />}
    </Card>
  );
}

// --------------------------------------------------------------------- page

export function BillDetailPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const { user, can } = useAuth();
  const navigate = useNavigate();
  const refresh = useBillRefresh(id);
  const q = useQuery({ queryKey: ['bill', id], queryFn: () => api.get<BillDetail>(`/api/bills/${id}`) });

  const removeOpening = useMutation({
    mutationFn: () => api.delete(`/api/bills/${id}`),
    onSuccess: async () => {
      await refresh();
      navigate('/bills');
    },
  });

  if (q.isLoading) return <Spinner />;
  if (q.isError) return <Notice>{errorMessage(t, q.error)}</Notice>;
  const b = q.data!;
  const title = b.kind === 'OPENING_BALANCE' ? t('billing.openingBalance') : t('billing.billFor', { month: monthLabel(b.billingMonth) });
  const canSeeUnits = can('units.manage') || can('residents.manage');

  return (
    <>
      <div className="mb-2">
        <Link to="/bills" className="inline-flex min-h-11 items-center font-semibold text-brand-700 underline">
          ← {user?.role === 'RESIDENT' ? t('billing.mineTitle') : t('billing.title')}
        </Link>
      </div>
      <PageHeader title={title}>
        {user?.role === 'ADMIN' && b.kind === 'OPENING_BALANCE' && b.payments.length === 0 && (
          <Button
            variant="danger"
            disabled={removeOpening.isPending}
            onClick={() => {
              if (window.confirm(t('billing.confirmDeleteOpening'))) removeOpening.mutate();
            }}
          >
            {t('billing.deleteOpening')}
          </Button>
        )}
      </PageHeader>
      {removeOpening.isError && <div className="mb-4"><Notice>{errorMessage(t, removeOpening.error)}</Notice></div>}

      <Card className="mb-4">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <BillStatusChip status={b.status} />
          <span className="text-muted">{t('billing.dueOn', { date: formatDate(b.dueDate) })}</span>
        </div>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div>
            <dt className="text-sm text-muted">{t('billing.unit')}</dt>
            <dd className="font-bold">
              {canSeeUnits ? (
                <Link to={`/units/${b.unit.id}`} className="text-brand-700 underline">
                  {b.unit.unitNumber}
                </Link>
              ) : (
                b.unit.unitNumber
              )}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-muted">{t('billing.total')}</dt>
            <dd className="font-bold">{formatBDT(b.total)}</dd>
          </div>
          <div>
            <dt className="text-sm text-muted">{t('billing.paid')}</dt>
            <dd className="font-bold" data-testid="bill-paid">{formatBDT(b.paid)}</dd>
          </div>
          <div>
            <dt className="text-sm text-muted">{t('billing.balance')}</dt>
            <dd className="text-xl font-bold" data-testid="bill-balance">{formatBDT(b.balance)}</dd>
          </div>
        </dl>
        {b.billingContact && (
          <p className="mt-3 text-sm text-muted">
            {t('billing.billingContact')}: <span className="font-semibold text-ink">{b.billingContact.fullName}</span>
          </p>
        )}
        {b.kind === 'OPENING_BALANCE' && <p className="mt-2 text-sm text-muted">{t('billing.openingNote')}</p>}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChargesCard bill={b} />
        <PaymentsCard bill={b} />
      </div>
    </>
  );
}
