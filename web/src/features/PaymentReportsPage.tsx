import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { PAYMENT_METHODS, PAYMENT_REPORT_STATUSES, formatBDT, parseTaka } from '@apt/shared';
import { useAuth } from '../app/auth';
import { Button, Card, Chip, Field, Modal, Notice, PageHeader, Pagination, Select, Spinner, TextInput } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { errorMessage, fieldErrorsOf } from '../lib/errors';
import { formatDate, monthLabel, takaString, todayYmd } from '../lib/format';
import type { BillDetail, BillPaymentReports, Page, PaymentReportStatus, QueueReport } from '../lib/types';

const statusTone: Record<PaymentReportStatus, 'amber' | 'green' | 'red'> = { PENDING: 'amber', VERIFIED: 'green', REJECTED: 'red' };

const ACCEPTED = 'image/jpeg,image/png,image/webp,application/pdf';

// ------------------------------------------------- a resident, on their bill

function ReportForm({ bill, available, onClose, onSent }: { bill: BillDetail; available: number; onClose: () => void; onSent: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [amount, setAmount] = useState(takaString(available));
  const [paidOn, setPaidOn] = useState(todayYmd());
  const [method, setMethod] = useState('BKASH');
  const [reference, setReference] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [localError, setLocalError] = useState('');

  const send = useMutation({
    mutationFn: (poisha: number) => {
      const form = new FormData();
      form.append('amount', String(poisha));
      form.append('paidOn', paidOn);
      form.append('method', method);
      form.append('reference', reference.trim());
      if (file) form.append('screenshot', file);
      return api.postForm(`/api/bills/${bill.id}/payment-reports`, form);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['bill-reports', bill.id] });
      onSent();
    },
  });
  const fields = fieldErrorsOf(t, send.error);

  function submit(e: FormEvent) {
    e.preventDefault();
    const poisha = parseTaka(amount);
    if (poisha === null) return setLocalError(t('fieldErrors.INVALID'));
    setLocalError('');
    send.mutate(poisha);
  }

  return (
    <Modal title={t('paymentReports.reportTitle')} onClose={onClose}>
      <form className="space-y-4" noValidate onSubmit={submit}>
        <p className="text-sm text-muted">{t('paymentReports.reportHelp')}</p>
        <p className="font-semibold">{t('paymentReports.canReport', { amount: formatBDT(available) })}</p>
        {send.isError && Object.keys(fields).length === 0 && <Notice>{errorMessage(t, send.error)}</Notice>}
        <Field label={t('billing.amount')} error={localError || fields.amount}>
          {(p) => <TextInput {...p} inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} />}
        </Field>
        <Field label={t('billing.paidOn')} error={fields.paidOn}>
          {(p) => <TextInput {...p} type="date" required max={todayYmd()} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />}
        </Field>
        <Field label={t('billing.method')}>
          {(p) => (
            <Select {...p} value={method} onChange={(e) => setMethod(e.target.value)}>
              {PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {t(`paymentMethods.${m}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('paymentReports.reference')} error={fields.reference}>
          {(p) => <TextInput {...p} required maxLength={40} value={reference} onChange={(e) => setReference(e.target.value)} />}
        </Field>
        <Field label={t('paymentReports.screenshot')} optional help={t('paymentReports.screenshotHelp')} error={fields.screenshot}>
          {(p) => <input {...p} type="file" accept={ACCEPTED} className="block w-full min-h-11 text-base" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />}
        </Field>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={send.isPending || !amount || !reference.trim()}>
            {t('paymentReports.send')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** FR-39: on a bill, what was reported and, for a resident, the "I've paid" button. */
export function BillReportsCard({ bill }: { bill: BillDetail }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);
  const q = useQuery({ queryKey: ['bill-reports', bill.id], queryFn: () => api.get<BillPaymentReports>(`/api/bills/${bill.id}/payment-reports`) });
  const resident = user?.role === 'RESIDENT';
  if (!q.data) return null;
  if (!resident && q.data.items.length === 0) return null;
  if (resident && q.data.items.length === 0 && bill.balance <= 0) return null;

  return (
    <Card className="mt-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-bold">{t('paymentReports.onThisBill')}</h2>
        {resident && q.data.available > 0 && (
          <Button
            onClick={() => {
              setSent(false);
              setOpen(true);
            }}
          >
            {t('paymentReports.iPaid')}
          </Button>
        )}
      </div>
      {sent && <Notice tone="info">{t('paymentReports.sent')}</Notice>}
      {resident && bill.balance > 0 && q.data.available === 0 && <p className="text-muted">{t('paymentReports.nothingToReport')}</p>}
      {q.data.items.length > 0 && (
        <ul className="divide-y divide-line">
          {q.data.items.map((r) => (
            <li key={r.id} className="py-3" data-testid="bill-report">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="min-w-28 flex-1">
                  <span className="block font-bold">{formatBDT(r.amount)}</span>
                  <span className="block text-sm text-muted">
                    {formatDate(r.paidOn)} · {t(`paymentMethods.${r.method}`, { defaultValue: r.method })} · {r.reference}
                  </span>
                </span>
                <Chip tone={statusTone[r.status]}>{t(`paymentReports.status.${r.status}`)}</Chip>
              </div>
              {r.rejectReason && <p className="mt-1 text-sm font-medium text-danger-600">{r.rejectReason}</p>}
            </li>
          ))}
        </ul>
      )}
      {open && (
        <ReportForm
          bill={bill}
          available={q.data.available}
          onClose={() => setOpen(false)}
          onSent={() => {
            setOpen(false);
            setSent(true);
          }}
        />
      )}
    </Card>
  );
}

// ------------------------------------------------------- the office's queue

function VerifyModal({ report, onClose, onDone }: { report: QueueReport; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [amount, setAmount] = useState(takaString(report.amount));
  const [paidOn, setPaidOn] = useState(report.paidOn);
  const [localError, setLocalError] = useState('');
  const [duplicate, setDuplicate] = useState(false);
  const run = useMutation({
    mutationFn: ({ poisha, confirm }: { poisha: number; confirm: boolean }) => api.post(`/api/payment-reports/${report.id}/verify`, { amount: poisha, paidOn, confirm: confirm || undefined }),
    onSuccess: onDone,
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'DUPLICATE_REFERENCE') setDuplicate(true);
    },
  });
  const fields = fieldErrorsOf(t, run.error);

  function go(confirm: boolean) {
    const poisha = parseTaka(amount);
    if (poisha === null) return setLocalError(t('fieldErrors.INVALID'));
    setLocalError('');
    run.mutate({ poisha, confirm });
  }

  return (
    <Modal title={t('paymentReports.verifyTitle')} onClose={onClose}>
      <form
        className="space-y-4"
        noValidate
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          go(false);
        }}
      >
        <p className="text-sm text-muted">{t('paymentReports.verifyHelp')}</p>
        {run.isError && !duplicate && Object.keys(fields).length === 0 && <Notice>{errorMessage(t, run.error)}</Notice>}
        <Field label={t('billing.amount')} error={localError || fields.amount}>
          {(p) => <TextInput {...p} inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} />}
        </Field>
        <Field label={t('billing.paidOn')} error={fields.paidOn}>
          {(p) => <TextInput {...p} type="date" required max={todayYmd()} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />}
        </Field>
        {duplicate && <Notice>{t('paymentReports.duplicate')}</Notice>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          {duplicate ? (
            <Button variant="danger" disabled={run.isPending} onClick={() => go(true)}>
              {t('paymentReports.verifyAnyway')}
            </Button>
          ) : (
            <Button type="submit" disabled={run.isPending}>
              {t('paymentReports.verify')}
            </Button>
          )}
        </div>
      </form>
    </Modal>
  );
}

function RejectModal({ report, onClose, onDone }: { report: QueueReport; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const run = useMutation({ mutationFn: () => api.post(`/api/payment-reports/${report.id}/reject`, { reason }), onSuccess: onDone });
  const fields = fieldErrorsOf(t, run.error);
  return (
    <Modal title={t('paymentReports.rejectTitle')} onClose={onClose}>
      <form
        className="space-y-4"
        noValidate
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          run.mutate();
        }}
      >
        {run.isError && Object.keys(fields).length === 0 && <Notice>{errorMessage(t, run.error)}</Notice>}
        <Field label={t('paymentReports.rejectReason')} error={fields.reason}>
          {(p) => <TextInput {...p} required maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="danger" disabled={run.isPending || reason.trim().length < 3}>
            {t('paymentReports.reject')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** FR-40: oldest first, so nobody waits longest for being unlucky. */
export function PaymentReportsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [status, setStatus] = useState<PaymentReportStatus>('PENDING');
  const [page, setPage] = useState(1);
  const [verifying, setVerifying] = useState<QueueReport | null>(null);
  const [rejecting, setRejecting] = useState<QueueReport | null>(null);
  const q = useQuery({ queryKey: ['payment-reports', status, page], queryFn: () => api.get<Page<QueueReport>>(`/api/payment-reports?status=${status}&page=${page}`) });

  const decided = async () => {
    setVerifying(null);
    setRejecting(null);
    await Promise.all(['payment-reports', 'dashboard', 'bills', 'bill', 'bill-reports'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
  };

  return (
    <>
      <PageHeader title={t('paymentReports.title')} />
      <div role="tablist" className="mb-4 flex flex-wrap gap-2">
        {PAYMENT_REPORT_STATUSES.map((s) => (
          <Button
            key={s}
            role="tab"
            aria-selected={status === s}
            variant={status === s ? 'primary' : 'secondary'}
            onClick={() => {
              setStatus(s);
              setPage(1);
            }}
          >
            {t(`paymentReports.tabs.${s}`)}
          </Button>
        ))}
      </div>
      {q.isLoading ? (
        <Spinner />
      ) : q.isError ? (
        <Notice>{errorMessage(t, q.error)}</Notice>
      ) : q.data!.items.length === 0 ? (
        <p className="py-6 text-muted">{t('paymentReports.empty')}</p>
      ) : (
        <ul className="space-y-3">
          {q.data!.items.map((r) => (
            <li key={r.id} data-testid="queue-report">
              <Card>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-xl font-bold">
                      {r.unitNumber} · {formatBDT(r.amount)}
                    </p>
                    <p className="text-muted">
                      {r.billKind === 'OPENING_BALANCE' ? t('billing.openingBalance') : monthLabel(r.billingMonth)} · {t('paymentReports.balanceNow', { amount: formatBDT(r.balance) })}
                    </p>
                    <p>
                      {formatDate(r.paidOn)} · {t(`paymentMethods.${r.method}`, { defaultValue: r.method })} · <strong>{r.reference}</strong>
                    </p>
                    <p className="text-sm text-muted">{t('paymentReports.reportedBy', { name: r.reportedBy })}</p>
                    {r.rejectReason && <p className="text-sm font-medium text-danger-600">{r.rejectReason}</p>}
                  </div>
                  <div className="flex flex-wrap gap-3">
                    {r.screenshotId ? (
                      <a href={`/api/attachments/${r.screenshotId}`} target="_blank" rel="noopener" className="inline-flex min-h-11 items-center font-semibold text-brand-700 underline">
                        {t('paymentReports.viewScreenshot')}
                      </a>
                    ) : (
                      <span className="inline-flex min-h-11 items-center text-muted">{t('paymentReports.noScreenshot')}</span>
                    )}
                    <Link to={`/bills/${r.billId}`} className="inline-flex min-h-11 items-center font-semibold text-brand-700 underline">
                      {t('paymentReports.openBill')}
                    </Link>
                  </div>
                </div>
                {r.duplicate && (
                  <div className="mt-3">
                    <Notice>{t('paymentReports.duplicate')}</Notice>
                  </div>
                )}
                {r.status === 'PENDING' && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button onClick={() => setVerifying(r)}>{t('paymentReports.verify')}</Button>
                    <Button variant="secondary" onClick={() => setRejecting(r)}>
                      {t('paymentReports.reject')}
                    </Button>
                  </div>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}
      {q.data && <Pagination page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={setPage} />}
      {verifying && <VerifyModal report={verifying} onClose={() => setVerifying(null)} onDone={decided} />}
      {rejecting && <RejectModal report={rejecting} onClose={() => setRejecting(null)} onDone={decided} />}
    </>
  );
}
