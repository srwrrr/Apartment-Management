import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { formatBDT } from '@apt/shared';
import { useAuth } from '../app/auth';
import { Button, Card, Field, Notice, PageHeader, Spinner, TextInput, ScrollTable } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { errorMessage, fieldErrorsOf } from '../lib/errors';
import { formatDate, monthLabel, thisMonth } from '../lib/format';
import type { Certificate, DuesReport, FinanceReport, IncomeExpenseReport, MaintenanceReport } from '../lib/types';

const pct = (rate: number | null) => (rate === null ? '—' : `${rate}%`);

function addMonthsYm(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The period lives in the address, so a report can be bookmarked or reloaded. */
function usePeriod() {
  const [params, setParams] = useSearchParams();
  const to = params.get('to') ?? thisMonth();
  const from = params.get('from') ?? addMonthsYm(to, -5);
  const set = (k: 'from' | 'to', v: string) => {
    if (!v) return;
    const next = new URLSearchParams(params);
    next.set('from', k === 'from' ? v : from);
    next.set('to', k === 'to' ? v : to);
    setParams(next, { replace: true });
  };
  return { from, to, set };
}

/** FR-38. */
function CsvLink({ href }: { href: string }) {
  const { t } = useTranslation();
  return (
    <a href={href} download className="no-print inline-flex min-h-11 items-center font-semibold text-brand-700 underline">
      {t('reports.exportCsv')}
    </a>
  );
}

/** FR-57. */
function Committee() {
  const { t } = useTranslation();
  const { to } = usePeriod();
  const [month, setMonth] = useState(to);
  return (
    <Card className="no-print mt-4">
      <h2 className="mb-1 text-xl font-bold">{t('committee.title')}</h2>
      <p className="mb-3 text-muted">{t('committee.help')}</p>
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('committee.month')}>{(p) => <TextInput {...p} type="month" value={month} onChange={(e) => setMonth(e.target.value)} />}</Field>
        <a href={`/api/reports/committee.pdf?month=${month}`} target="_blank" rel="noopener" className="inline-flex min-h-11 items-center rounded-lg bg-brand-600 px-4 py-2 font-semibold text-white hover:bg-brand-700">
          {t('committee.download')}
        </a>
      </div>
    </Card>
  );
}

function Finance() {
  const { t } = useTranslation();
  const { from, to, set } = usePeriod();
  const q = useQuery({ queryKey: ['finance-report', from, to], queryFn: () => api.get<FinanceReport>(`/api/reports/finance?from=${from}&to=${to}`), retry: false });
  const fe = fieldErrorsOf(t, q.error);

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-bold">{t('reports.finance')}</h2>
        <CsvLink href={`/api/reports/finance.csv?from=${from}&to=${to}`} />
      </div>
      <div className="mb-4 flex flex-wrap gap-4">
        <Field label={t('reports.from')}>{(p) => <TextInput {...p} type="month" value={from} onChange={(e) => set('from', e.target.value)} />}</Field>
        <Field label={t('reports.to')} error={fe.to}>
          {(p) => <TextInput {...p} type="month" value={to} onChange={(e) => set('to', e.target.value)} />}
        </Field>
      </div>
      {q.isLoading ? (
        <Spinner />
      ) : q.isError ? (
        !Object.keys(fe).length && <Notice>{errorMessage(t, q.error)}</Notice>
      ) : (
        <>
          <ScrollTable label={t('reports.finance')}>
            <table className="w-full min-w-[34rem] text-start" data-testid="finance-table">
              <thead>
                <tr className="border-b border-line text-sm text-muted">
                  <th className="py-2 text-start">{t('reports.month')}</th>
                  <th className="py-2 text-end">{t('reports.bills')}</th>
                  <th className="py-2 text-end">{t('reports.billed')}</th>
                  <th className="py-2 text-end">{t('reports.collected')}</th>
                  <th className="py-2 text-end">{t('reports.outstanding')}</th>
                  <th className="py-2 text-end">{t('reports.rate')}</th>
                </tr>
              </thead>
              <tbody>
                {q.data!.months.map((m) => (
                  <tr key={m.month} className="border-b border-line">
                    <td className="py-2">{monthLabel(m.month)}</td>
                    <td className="py-2 text-end">{m.bills}</td>
                    <td className="py-2 text-end">{formatBDT(m.billed)}</td>
                    <td className="py-2 text-end">{formatBDT(m.collected)}</td>
                    <td className="py-2 text-end">{formatBDT(m.outstanding)}</td>
                    <td className="py-2 text-end">{pct(m.rate)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-bold">
                  <td className="py-2">{t('reports.total')}</td>
                  <td />
                  <td className="py-2 text-end" data-testid="fin-billed">{formatBDT(q.data!.billed)}</td>
                  <td className="py-2 text-end" data-testid="fin-collected">{formatBDT(q.data!.collected)}</td>
                  <td className="py-2 text-end" data-testid="fin-outstanding">{formatBDT(q.data!.outstanding)}</td>
                  <td className="py-2 text-end" data-testid="fin-rate">{pct(q.data!.rate)}</td>
                </tr>
              </tfoot>
            </table>
          </ScrollTable>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <h3 className="font-semibold">{t('reports.byChargeType')}</h3>
              <ul>
                {q.data!.byChargeType.map((c) => (
                  <li key={c.type} className="flex justify-between border-b border-line py-1">
                    <span>{t(`chargeTypes.${c.type}`, { defaultValue: c.type })}</span>
                    <span>{formatBDT(c.billed)}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="font-semibold">{t('reports.byMethod')}</h3>
              <ul>
                {q.data!.byMethod.map((c) => (
                  <li key={c.method} className="flex justify-between border-b border-line py-1">
                    <span>{t(`paymentMethods.${c.method}`, { defaultValue: c.method })}</span>
                    <span>{formatBDT(c.collected)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          {q.data!.openingBalances.bills > 0 && (
            <p className="mt-4 text-muted">
              {t('reports.opening')}: {formatBDT(q.data!.openingBalances.billed)} — {t('reports.outstanding')}: {formatBDT(q.data!.openingBalances.outstanding)}
            </p>
          )}
        </>
      )}
    </Card>
  );
}

function Dues() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['dues-report'], queryFn: () => api.get<DuesReport>('/api/reports/dues') });
  return (
    <Card className="mt-4">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-bold">{t('reports.dues')}</h2>
        <CsvLink href="/api/reports/dues.csv" />
      </div>
      {q.isLoading ? (
        <Spinner />
      ) : q.isError ? (
        <Notice>{errorMessage(t, q.error)}</Notice>
      ) : q.data!.units.length === 0 ? (
        <p className="text-muted">{t('reports.noDues')}</p>
      ) : (
        <>
          <p className="mb-3 text-lg font-bold" data-testid="dues-total">
            {t('reports.totalOwed')}: {formatBDT(q.data!.totalOwed)}
          </p>
          <ScrollTable label={t('reports.dues')}>
            <table className="w-full min-w-[34rem]" data-testid="dues-table">
              <thead>
                <tr className="border-b border-line text-sm text-muted">
                  <th className="py-2 text-start">{t('reports.unit')}</th>
                  <th className="py-2 text-start">{t('reports.contact')}</th>
                  <th className="py-2 text-end">{t('reports.owed')}</th>
                  <th className="py-2 text-end">{t('reports.overdueBills')}</th>
                  <th className="py-2 text-end">{t('reports.oldestOverdue')}</th>
                </tr>
              </thead>
              <tbody>
                {q.data!.units.map((u) => (
                  <tr key={u.unit.id} className="border-b border-line">
                    <td className="py-2 font-bold">
                      <Link to={`/bills?q=${encodeURIComponent(u.unit.unitNumber)}`} className="underline">
                        {u.unit.unitNumber}
                      </Link>
                    </td>
                    <td className="py-2">
                      {u.contact ? (
                        <>
                          {u.contact.name}
                          {u.contact.phone && <span className="block text-sm text-muted">{u.contact.phone}</span>}
                        </>
                      ) : (
                        <span className="text-muted">{t('reports.noContact')}</span>
                      )}
                    </td>
                    <td className="py-2 text-end font-semibold">{formatBDT(u.owed)}</td>
                    <td className="py-2 text-end">{u.overdueBills}</td>
                    <td className="py-2 text-end">{u.oldestOverdue ? formatDate(u.oldestOverdue) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollTable>
        </>
      )}
    </Card>
  );
}

/** FR-44: money actually received against money actually spent, for the same period as the report above. */
function IncomeExpense() {
  const { t } = useTranslation();
  const { from, to } = usePeriod();
  const q = useQuery({ queryKey: ['income-expense', from, to], queryFn: () => api.get<IncomeExpenseReport>(`/api/reports/income-expense?from=${from}&to=${to}`), retry: false });
  if (!q.data) return null;
  const r = q.data;
  return (
    <Card className="mt-4">
      <h2 className="mb-1 text-xl font-bold">{t('incomeExpense.title')}</h2>
      <p className="mb-3 text-sm text-muted">{t('incomeExpense.help')}</p>
      <ScrollTable label={t('incomeExpense.title')}>
        <table className="w-full min-w-[28rem]" data-testid="income-expense">
          <thead>
            <tr className="border-b border-line text-sm text-muted">
              <th className="py-2 text-start">{t('reports.month')}</th>
              <th className="py-2 text-end">{t('incomeExpense.income')}</th>
              <th className="py-2 text-end">{t('incomeExpense.expenses')}</th>
              <th className="py-2 text-end">{t('incomeExpense.net')}</th>
            </tr>
          </thead>
          <tbody>
            {r.months.map((m) => (
              <tr key={m.month} className="border-b border-line">
                <td className="py-2">{monthLabel(m.month)}</td>
                <td className="py-2 text-end">{formatBDT(m.income)}</td>
                <td className="py-2 text-end">{formatBDT(m.expenses)}</td>
                <td className="py-2 text-end">{formatBDT(m.net)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-bold">
              <td className="py-2">{t('reports.total')}</td>
              <td className="py-2 text-end" data-testid="ie-income">{formatBDT(r.income)}</td>
              <td className="py-2 text-end" data-testid="ie-expenses">{formatBDT(r.expenses)}</td>
              <td className="py-2 text-end" data-testid="ie-net">{formatBDT(r.net)}</td>
            </tr>
          </tfoot>
        </table>
      </ScrollTable>
      {r.byCategory.length > 0 && (
        <div className="mt-4 max-w-md">
          <h3 className="font-semibold">{t('incomeExpense.byCategory')}</h3>
          <ul>
            {r.byCategory.map((c) => (
              <li key={c.category} className="flex justify-between border-b border-line py-1">
                <span>{t(`expenses.categories.${c.category}`)}</span>
                <span>{formatBDT(c.amount)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

/** FR-22: for the same period as the reports above. */
function Maintenance() {
  const { t } = useTranslation();
  const { from, to } = usePeriod();
  const q = useQuery({ queryKey: ['maintenance-report', from, to], queryFn: () => api.get<MaintenanceReport>(`/api/reports/maintenance?from=${from}&to=${to}`), retry: false });
  if (!q.data) return null;
  const r = q.data;
  const hours = (h: number | null) => (h === null ? '—' : t('maintenanceReport.hours', { hours: h }));
  const stars = (s: number | null) => (s === null ? '—' : t('maintenanceReport.outOfFive', { rating: s }));
  return (
    <Card className="mt-4">
      <h2 className="mb-3 text-xl font-bold">{t('maintenanceReport.title')}</h2>
      {r.total === 0 ? (
        <p className="text-muted">{t('maintenanceReport.none')}</p>
      ) : (
        <>
          <dl className="mb-4 grid gap-3 sm:grid-cols-2">
            <div>
              <dt className="text-sm text-muted">{t('maintenanceReport.total')}</dt>
              <dd className="text-2xl font-bold" data-testid="mr-total">{r.total}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted">{t('maintenanceReport.average')}</dt>
              <dd className="text-2xl font-bold" data-testid="mr-average">{r.averageHours === null ? t('maintenanceReport.noAverage') : hours(r.averageHours)}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted">{t('maintenanceReport.overdue')}</dt>
              <dd className="text-2xl font-bold" data-testid="mr-overdue">{r.overdue}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted">{t('maintenanceReport.rating')}</dt>
              <dd className="text-2xl font-bold" data-testid="mr-rating">{r.averageRating === null ? t('maintenanceReport.noRating') : stars(r.averageRating)}</dd>
            </div>
          </dl>
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <h3 className="font-semibold">{t('maintenanceReport.byStatus')}</h3>
              <ul>
                {r.byStatus.map((s) => (
                  <li key={s.status} className="flex justify-between border-b border-line py-1">
                    <span>{t(`requestStatus.${s.status}`)}</span>
                    <span>{s.n}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="font-semibold">{t('maintenanceReport.topUnits')}</h3>
              <ul>
                {r.topUnits.map((u) => (
                  <li key={u.id} className="flex justify-between border-b border-line py-1">
                    <span>{u.unitNumber}</span>
                    <span>{u.requests}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <h3 className="mt-4 font-semibold">{t('maintenanceReport.byCategory')}</h3>
          <ScrollTable label={t('maintenanceReport.byCategory')}>
            <table className="w-full min-w-[26rem]" data-testid="mr-categories">
              <thead>
                <tr className="border-b border-line text-sm text-muted">
                  <th className="py-2 text-start">{t('maintenanceReport.category')}</th>
                  <th className="py-2 text-end">{t('maintenanceReport.requests')}</th>
                  <th className="py-2 text-end">{t('maintenanceReport.resolved')}</th>
                  <th className="py-2 text-end">{t('maintenanceReport.averageShort')}</th>
                  <th className="py-2 text-end">{t('maintenanceReport.ratingShort')}</th>
                </tr>
              </thead>
              <tbody>
                {r.byCategory.map((c) => (
                  <tr key={c.category} className="border-b border-line">
                    <td className="py-2">{t(`requestCategory.${c.category}`)}</td>
                    <td className="py-2 text-end">{c.requests}</td>
                    <td className="py-2 text-end">{c.resolved}</td>
                    <td className="py-2 text-end">{hours(c.averageHours)}</td>
                    <td className="py-2 text-end">{stars(c.averageRating)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollTable>
          {r.byStaff.length > 0 && (
            <>
              <h3 className="mt-4 font-semibold">{t('maintenanceReport.byStaff')}</h3>
              <ul data-testid="mr-staff">
                {r.byStaff.map((s) => (
                  <li key={s.id} className="flex justify-between gap-3 border-b border-line py-1">
                    <span>{s.fullName}</span>
                    <span>
                      {stars(s.averageRating)} ({s.ratings})
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </Card>
  );
}

/** FR-46: someone shows a certificate; is it genuine? */
function CertificateCheck() {
  const { t } = useTranslation();
  const [number, setNumber] = useState('');
  const check = useMutation({ mutationFn: () => api.get<Certificate>(`/api/certificates?number=${encodeURIComponent(number.trim())}`) });
  const missing = check.error instanceof ApiError && check.error.status === 404;
  return (
    <Card className="no-print mt-4">
      <h2 className="mb-3 text-xl font-bold">{t('certificate.lookup')}</h2>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          check.mutate();
        }}
      >
        <div className="min-w-56">
          <Field label={t('certificate.lookupNumber')}>{(p) => <TextInput {...p} value={number} onChange={(e) => setNumber(e.target.value)} />}</Field>
        </div>
        <Button type="submit" variant="secondary" disabled={check.isPending || !number.trim()}>
          {t('certificate.lookupButton')}
        </Button>
      </form>
      {check.data && (
        <p className="mt-3 font-semibold" data-testid="certificate-result">
          {t('certificate.genuine', { number: check.data.number, unit: check.data.unit.unitNumber, name: check.data.issuedTo.fullName, date: formatDate(check.data.issuedAt) })}
        </p>
      )}
      {missing && <p className="mt-3 font-semibold text-danger-600">{t('certificate.notFound')}</p>}
      {check.isError && !missing && <div className="mt-3"><Notice>{errorMessage(t, check.error)}</Notice></div>}
    </Card>
  );
}

export function ReportsPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  return (
    <>
      <PageHeader title={t('reports.title')}>
        <Button variant="secondary" className="no-print" onClick={() => window.print()}>
          {t('reports.print')}
        </Button>
      </PageHeader>
      <Finance />
      <Dues />
      <IncomeExpense />
      <Maintenance />
      <Committee />
      {user?.role === 'ADMIN' && <CertificateCheck />}
    </>
  );
}
