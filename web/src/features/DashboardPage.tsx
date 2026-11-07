import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { formatBDT } from '@apt/shared';
import { Card, Chip, Field, Notice, Spinner, TextInput } from '../components/ui';
import { api } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { formatDate, monthLabel, thisMonth } from '../lib/format';
import type { DashboardData } from '../lib/types';

const pct = (rate: number | null) => (rate === null ? '—' : `${rate}%`);

function Stat({ label, value, id, tone }: { label: string; value: string | number; id: string; tone?: 'danger' }) {
  return (
    <div className="rounded-lg border border-line p-3">
      <p className="text-sm text-muted">{label}</p>
      <p className={`text-2xl font-bold ${tone === 'danger' ? 'text-danger-600' : ''}`} data-testid={id}>
        {value}
      </p>
    </div>
  );
}

/** FR-27 to FR-29, FR-58: the administrator's overview. The same figures as the collection report (FR-28). */
export function Dashboard() {
  const { t } = useTranslation();
  const [month, setMonth] = useState(thisMonth());
  const q = useQuery({ queryKey: ['dashboard', month], queryFn: () => api.get<DashboardData>(`/api/dashboard?month=${month}`) });

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-bold">{t('dashboard.title')}</h2>
        <Link to="/reports" className="inline-flex min-h-11 items-center rounded-lg border border-line px-4 py-2 font-semibold text-brand-700 hover:bg-brand-50">
          {t('dashboard.reports')}
        </Link>
      </div>
      <div className="mb-4 max-w-56">
        <Field label={t('dashboard.month')}>{(p) => <TextInput {...p} type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />}</Field>
      </div>
      {q.isLoading ? (
        <Spinner />
      ) : q.isError ? (
        <Notice>{errorMessage(t, q.error)}</Notice>
      ) : (
        <div className="space-y-4">
          <Card>
            <h2 className="mb-3 text-xl font-bold">{t('dashboard.billing', { month: monthLabel(q.data!.month) })}</h2>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat id="dash-billed" label={t('dashboard.billed')} value={formatBDT(q.data!.billing.billed)} />
              <Stat id="dash-collected" label={t('dashboard.collected')} value={formatBDT(q.data!.billing.collected)} />
              <Stat id="dash-outstanding" label={t('dashboard.outstanding')} value={formatBDT(q.data!.billing.outstanding)} />
              <Stat id="dash-rate" label={t('dashboard.rate')} value={q.data!.billing.rate === null ? t('dashboard.noRate') : pct(q.data!.billing.rate)} />
            </div>
            <p className="mt-3 font-semibold text-danger-600" data-testid="dash-overdue">
              {q.data!.billing.overdueBills > 0 ? `${t('dashboard.overdueBills', { count: q.data!.billing.overdueBills })} (${formatBDT(q.data!.billing.overdueAmount)})` : ''}
            </p>
            {q.data!.billing.pendingReports > 0 && (
              <p>
                <Link to="/payment-reports" className="inline-flex min-h-11 items-center font-semibold text-brand-700 underline" data-testid="dash-pending-reports">
                  {t('dashboard.pendingReports', { count: q.data!.billing.pendingReports })}
                </Link>
              </p>
            )}
            {q.data!.billing.openingBalances.outstanding > 0 && <p className="text-muted">{t('dashboard.openingBalances', { amount: formatBDT(q.data!.billing.openingBalances.outstanding) })}</p>}
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <h2 className="mb-3 text-xl font-bold">{t('dashboard.building')}</h2>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Stat id="dash-units" label={t('dashboard.totalUnits')} value={q.data!.building.totalUnits} />
                <Stat id="dash-occupied" label={t('dashboard.occupied')} value={q.data!.building.occupied} />
                <Stat id="dash-vacant" label={t('dashboard.vacant')} value={q.data!.building.vacant} />
                <Stat id="dash-unavailable" label={t('dashboard.unavailable')} value={q.data!.building.unavailable} />
                <Stat id="dash-residents" label={t('dashboard.residents')} value={q.data!.building.residents} />
              </div>
            </Card>
            <Card>
              <h2 className="mb-3 text-xl font-bold">
                <Link to="/requests" className="underline">
                  {t('dashboard.maintenance')}
                </Link>
              </h2>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Stat id="dash-pending" label={t('dashboard.pending')} value={q.data!.maintenance.pending} />
                <Stat id="dash-progress" label={t('dashboard.inProgress')} value={q.data!.maintenance.inProgress} />
                <Stat id="dash-resolved" label={t('dashboard.resolved')} value={q.data!.maintenance.resolved} />
                <Stat id="dash-req-overdue" label={t('dashboard.overdueRequests')} value={q.data!.maintenance.overdue} tone={q.data!.maintenance.overdue > 0 ? 'danger' : undefined} />
              </div>
            </Card>
          </div>

          <Card>
            <h2 className="mb-3 text-xl font-bold">{t('dashboard.trend')}</h2>
            <ul className="space-y-2" data-testid="trend">
              {q.data!.trend.map((m) => (
                <li key={m.month} className="grid grid-cols-[6.5rem_1fr_4rem] items-center gap-3">
                  <span className="text-sm">{monthLabel(m.month)}</span>
                  <span className="h-4 overflow-hidden rounded bg-gray-200" aria-hidden="true">
                    <span className="block h-full bg-brand-600" style={{ width: `${Math.min(100, m.rate ?? 0)}%` }} />
                  </span>
                  <span className="text-end text-sm font-semibold">{pct(m.rate)}</span>
                </li>
              ))}
            </ul>
          </Card>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card>
              <h2 className="mb-2 text-lg font-bold">{t('dashboard.recentPayments')}</h2>
              {q.data!.recent.payments.length === 0 ? (
                <p className="text-muted">{t('dashboard.none')}</p>
              ) : (
                <ul className="space-y-2">
                  {q.data!.recent.payments.map((p) => (
                    <li key={p.id}>
                      <Link to={`/bills/${p.billId}`} className="block hover:underline">
                        <span className="font-semibold">{p.unitNumber}</span> · {formatBDT(p.amount)} <span className="text-sm text-muted">{formatDate(p.paidOn)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card>
              <h2 className="mb-2 text-lg font-bold">{t('dashboard.recentRequests')}</h2>
              {q.data!.recent.requests.length === 0 ? (
                <p className="text-muted">{t('dashboard.none')}</p>
              ) : (
                <ul className="space-y-2">
                  {q.data!.recent.requests.map((r) => (
                    <li key={r.id}>
                      <Link to={`/requests/${r.id}`} className="block hover:underline">
                        #{r.number} · {r.unitNumber} · {r.title} <Chip>{t(`requestStatus.${r.status}`)}</Chip>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card>
              <h2 className="mb-2 text-lg font-bold">
                <Link to="/announcements" className="underline">
                  {t('dashboard.recentAnnouncements')}
                </Link>
              </h2>
              {q.data!.recent.announcements.length === 0 ? (
                <p className="text-muted">{t('dashboard.none')}</p>
              ) : (
                <ul className="space-y-2">
                  {q.data!.recent.announcements.map((a) => (
                    <li key={a.id}>
                      <Link to={`/announcements/${a.id}`} className="block hover:underline">
                        {a.title} <span className="text-sm text-muted">{formatDate(a.publishedAt)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
