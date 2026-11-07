import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { formatBDT } from '@apt/shared';
import { useAuth } from '../app/auth';
import { Button, Card, Field, Notice, PageHeader, Select, Spinner, TextInput, ScrollTable } from '../components/ui';
import { api } from '../lib/api';
import { errorMessage, fieldErrorsOf } from '../lib/errors';
import { formatDate, formatDateTime, monthLabel, todayYmd } from '../lib/format';
import type { Certificate, Occupancy, Statement, UnitCertificates, Unit } from '../lib/types';

/** The first day of the month, a year ago: a sensible first view of an account. */
function aYearAgo(): string {
  const [y, m] = todayYmd().split('-');
  return `${Number(y) - 1}-${m}-01`;
}

/** The chosen period lives in the address, so a statement can be reloaded or bookmarked. */
function usePeriod() {
  const [params, setParams] = useSearchParams();
  const from = params.get('from') ?? aYearAgo();
  const to = params.get('to') ?? todayYmd();
  const set = (k: 'from' | 'to', v: string) => {
    if (!v) return;
    const next = new URLSearchParams(params);
    next.set('from', k === 'from' ? v : from);
    next.set('to', k === 'to' ? v : to);
    setParams(next, { replace: true });
  };
  return { from, to, set };
}

function StatementView({ url, pdfUrl, queryKey }: { url: string; pdfUrl: string; queryKey: unknown[] }) {
  const { t } = useTranslation();
  const q = useQuery({ queryKey, queryFn: () => api.get<Statement>(url), retry: false });
  const fields = fieldErrorsOf(t, q.error);
  if (q.isLoading) return <Spinner />;
  if (q.isError) return <Notice>{fields.to ?? errorMessage(t, q.error)}</Notice>;
  const s = q.data!;
  return (
    <Card>
      <div className="no-print mb-3 flex justify-end">
        <a href={pdfUrl} target="_blank" rel="noopener" className="inline-flex min-h-11 items-center font-semibold text-brand-700 underline">
          {t('statement.downloadPdf')}
        </a>
      </div>
      <ScrollTable label={t('statement.title')}>
        <table className="w-full min-w-[34rem]" data-testid="statement">
          <thead>
            <tr className="border-b border-line text-sm text-muted">
              <th className="py-2 text-start">{t('statement.date')}</th>
              <th className="py-2 text-start">{t('statement.description')}</th>
              <th className="py-2 text-end">{t('statement.charged')}</th>
              <th className="py-2 text-end">{t('statement.paid')}</th>
              <th className="py-2 text-end">{t('statement.balance')}</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-line font-semibold">
              <td className="py-2" colSpan={4}>
                {t('statement.opening')}
              </td>
              <td className="py-2 text-end" data-testid="statement-opening">
                {formatBDT(s.opening)}
              </td>
            </tr>
            {s.rows.map((r) => {
              const what = r.billKind === 'OPENING_BALANCE' ? t('billing.openingBalance') : monthLabel(r.billingMonth);
              return (
                <tr key={r.paymentId ?? r.billId} className="border-b border-line" data-testid="statement-row">
                  <td className="py-2 whitespace-nowrap">{formatDate(r.date)}</td>
                  <td className="py-2">
                    <Link to={`/bills/${r.billId}`} className="underline">
                      {r.kind === 'BILL' ? `${t('statement.bill')}: ${what}` : `${t('statement.payment')}: ${what}`}
                    </Link>
                    {r.receiptNo && (
                      <span className="block text-sm text-muted">
                        {t(`paymentMethods.${r.method}`, { defaultValue: r.method ?? '' })} · {r.receiptNo}
                      </span>
                    )}
                  </td>
                  <td className="py-2 text-end">{r.charged ? formatBDT(r.charged) : ''}</td>
                  <td className="py-2 text-end">{r.paid ? formatBDT(r.paid) : ''}</td>
                  <td className="py-2 text-end">{formatBDT(r.balance)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="font-bold">
              <td className="py-2" colSpan={2}>
                {t('statement.closing')}
              </td>
              <td className="py-2 text-end">{formatBDT(s.totalCharged)}</td>
              <td className="py-2 text-end">{formatBDT(s.totalPaid)}</td>
              <td className="py-2 text-end" data-testid="statement-closing">
                {formatBDT(s.closing)}
              </td>
            </tr>
          </tfoot>
        </table>
      </ScrollTable>
      {s.rows.length === 0 && <p className="mt-3 text-muted">{t('statement.none')}</p>}
    </Card>
  );
}

function PeriodPicker({ from, to, set }: ReturnType<typeof usePeriod>) {
  const { t } = useTranslation();
  return (
    <>
      <Field label={t('statement.from')}>{(p) => <TextInput {...p} type="date" value={from} onChange={(e) => set('from', e.target.value)} />}</Field>
      <Field label={t('statement.to')}>{(p) => <TextInput {...p} type="date" value={to} onChange={(e) => set('to', e.target.value)} />}</Field>
    </>
  );
}

function CertificateList({ items }: { items: Certificate[] }) {
  const { t } = useTranslation();
  if (items.length === 0) return <p className="text-muted">{t('certificate.none')}</p>;
  return (
    <ul className="divide-y divide-line">
      {items.map((c) => (
        <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-3" data-testid="certificate">
          <span>
            <span className="block font-bold">{c.number}</span>
            <span className="block text-sm text-muted">
              {c.unit.unitNumber} · {c.issuedTo.fullName} · {formatDateTime(c.issuedAt)} · {monthLabel(c.coversThroughMonth)}
            </span>
          </span>
          <a href={`/api/certificates/${c.id}/pdf`} target="_blank" rel="noopener" className="inline-flex min-h-11 items-center font-semibold text-brand-700 underline">
            {t('certificate.download')}
          </a>
        </li>
      ))}
    </ul>
  );
}

/** FR-45, FR-46: a resident's own statement and certificates. */
export function MyStatementPage() {
  const { t } = useTranslation();
  const period = usePeriod();
  const units = useQuery({ queryKey: ['my-statement-units'], queryFn: () => api.get<{ items: { id: string; unitNumber: string }[] }>('/api/me/billing/statement/units') });
  const certificates = useQuery({ queryKey: ['my-certificates'], queryFn: () => api.get<{ items: Certificate[] }>('/api/me/billing/certificates') });
  const [chosen, setChosen] = useState('');
  const items = units.data?.items ?? [];
  const unitId = chosen || items[0]?.id || '';
  const qs = `unitId=${unitId}&from=${period.from}&to=${period.to}`;

  return (
    <>
      <PageHeader title={t('statement.title')} />
      {units.isLoading ? (
        <Spinner />
      ) : units.isError ? (
        <Notice>{errorMessage(t, units.error)}</Notice>
      ) : items.length === 0 ? (
        <p className="py-6 text-muted">{t('statement.noUnits')}</p>
      ) : (
        <>
          <div className="no-print mb-4 grid gap-4 sm:grid-cols-3">
            {items.length > 1 && (
              <Field label={t('statement.unit')}>
                {(p) => (
                  <Select {...p} value={unitId} onChange={(e) => setChosen(e.target.value)}>
                    {items.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.unitNumber}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            )}
            <PeriodPicker {...period} />
          </div>
          <StatementView url={`/api/me/billing/statement?${qs}`} pdfUrl={`/api/me/billing/statement.pdf?${qs}`} queryKey={['my-statement', unitId, period.from, period.to]} />
        </>
      )}
      <Card className="mt-4">
        <h2 className="mb-2 text-xl font-bold">{t('certificate.mine')}</h2>
        {certificates.data && <CertificateList items={certificates.data.items} />}
      </Card>
    </>
  );
}

/** FR-45: any unit's statement, for those who work with bills. */
export function UnitStatementPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const period = usePeriod();
  const unit = useQuery({ queryKey: ['unit', id], queryFn: () => api.get<Unit>(`/api/units/${id}`), retry: false });
  const qs = `from=${period.from}&to=${period.to}`;
  return (
    <>
      <div className="mb-2">
        <Link to={`/units/${id}`} className="inline-flex min-h-11 items-center font-semibold text-brand-700 underline">
          ← {unit.data ? `${t('units.number')} ${unit.data.unitNumber}` : t('nav.units')}
        </Link>
      </div>
      <PageHeader title={unit.data ? `${t('statement.title')}: ${unit.data.unitNumber}` : t('statement.title')} />
      <div className="no-print mb-4 grid gap-4 sm:grid-cols-3">
        <PeriodPicker {...period} />
      </div>
      <StatementView url={`/api/units/${id}/statement?${qs}`} pdfUrl={`/api/units/${id}/statement.pdf?${qs}`} queryKey={['unit-statement', id, period.from, period.to]} />
    </>
  );
}

/** FR-46: on a unit's page. The action appears only when BR-24 is met; otherwise it says what is owed. */
export function UnitCertificatesSection({ unitId, stays }: { unitId: string; stays: Occupancy[] }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['unit-certificates', unitId], queryFn: () => api.get<UnitCertificates>(`/api/units/${unitId}/certificates`) });
  const people = [...new Map(stays.filter((s) => s.resident).map((s) => [s.resident!.id, s])).values()];
  const contact = stays.find((s) => !s.endDate && s.isBillingContact)?.resident?.id;
  const [residentId, setResidentId] = useState('');
  const issue = useMutation({
    mutationFn: () => api.post(`/api/units/${unitId}/certificates`, { residentId: residentId || contact || undefined }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['unit-certificates', unitId] }),
  });
  const fields = fieldErrorsOf(t, issue.error);
  if (!q.data) return null;
  return (
    <Card className="mt-4">
      <h2 className="mb-2 text-xl font-bold">{t('certificate.section')}</h2>
      <CertificateList items={q.data.items} />
      {user?.role === 'ADMIN' && (
        <div className="mt-3 border-t border-line pt-3">
          {q.data.canIssue ? (
            <div className="flex flex-wrap items-end gap-3">
              {people.length > 0 && (
                <div className="min-w-48">
                  <Field label={t('certificate.issueTo')} error={fields.residentId}>
                    {(p) => (
                      <Select {...p} value={residentId || contact || ''} onChange={(e) => setResidentId(e.target.value)}>
                        {!contact && <option value="">{t('moveOut.choose')}</option>}
                        {people.map((s) => (
                          <option key={s.resident!.id} value={s.resident!.id}>
                            {s.resident!.fullName}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                </div>
              )}
              <Button disabled={issue.isPending} onClick={() => issue.mutate()}>
                {t('certificate.issue')}
              </Button>
            </div>
          ) : (
            <p className="font-semibold" data-testid="certificate-blocked">
              {q.data.balance > 0 ? t('certificate.blocked', { amount: formatBDT(q.data.balance) }) : t('certificate.neverBilled')}
            </p>
          )}
          {issue.isError && Object.keys(fields).length === 0 && (
            <div className="mt-2">
              <Notice>{errorMessage(t, issue.error)}</Notice>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
