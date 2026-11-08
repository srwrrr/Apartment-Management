import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { formatBDT } from '@apt/shared';
import { Button, Card, Chip, Field, Notice, ScrollTable, Spinner, TextInput } from '../components/ui';
import { MonthInput } from '../components/MonthInput';
import { api } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { formatDate, monthLabel, monthShort, thisMonth } from '../lib/format';
import type { DashboardData } from '../lib/types';
import { ActivityRow } from './ActivityPage';

const pct = (rate: number | null) => (rate === null ? '—' : `${rate}%`);

function Stat({ label, value, id, tone }: { label: string; value: string | number; id: string; tone?: 'danger' }) {
  return (
    <div className="tile stat">
      <p className="text-sm text-muted">{label}</p>
      <p className={`figure mt-0.5 ${typeof value === 'string' ? 'figure-fit' : ''} ${tone === 'danger' ? 'text-danger' : ''}`} data-testid={id}>
        {value}
      </p>
    </div>
  );
}

// Checked with the palette validator: they stay apart for colour-blind readers and against the dark glass.
const BILLED = 'var(--color-chart-billed)';
const COLLECTED = 'var(--color-chart-collected)';

/** FR-58: billed against collected on one scale, with the rate under each month, and the same numbers as a table. */
function Trend({ months }: { months: DashboardData['trend'] }) {
  const { t } = useTranslation();
  const [asTable, setAsTable] = useState(false);
  const max = Math.max(...months.map((m) => m.billed), 1);
  const height = (v: number) => `${(v / max) * 100}%`;
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="heading-section">{t('dashboard.trend')}</h2>
        <Button variant="secondary" aria-pressed={asTable} onClick={() => setAsTable(!asTable)}>
          {asTable ? t('dashboard.showChart') : t('dashboard.showTable')}
        </Button>
      </div>
      {asTable ? (
        <ScrollTable label={t('dashboard.trend')}>
          <table className="w-full min-w-[30rem]" data-testid="trend-table">
            <thead>
              <tr className="border-b border-line text-sm text-muted">
                <th className="py-2 text-start">{t('dashboard.month')}</th>
                <th className="py-2 text-end">{t('dashboard.billed')}</th>
                <th className="py-2 text-end">{t('dashboard.collected')}</th>
                <th className="py-2 text-end">{t('dashboard.rate')}</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => (
                <tr key={m.month} className="border-b border-line">
                  <td className="py-2">{monthLabel(m.month)}</td>
                  <td className="py-2 text-end">{formatBDT(m.billed)}</td>
                  <td className="py-2 text-end">{formatBDT(m.collected)}</td>
                  <td className="py-2 text-end font-semibold">{pct(m.rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollTable>
      ) : (
        <>
          <p className="mb-2 flex flex-wrap gap-4 text-sm">
            <span><span className="me-1 inline-block size-3 rounded-sm" style={{ background: BILLED }} aria-hidden="true" />{t('dashboard.billed')}</span>
            <span><span className="me-1 inline-block size-3 rounded-sm" style={{ background: COLLECTED }} aria-hidden="true" />{t('dashboard.collected')}</span>
          </p>
          <ul className="grid grid-cols-6 gap-1 sm:gap-3" data-testid="trend">
            {months.map((m) => {
              const summary = t('dashboard.trendSummary', { month: monthLabel(m.month), billed: formatBDT(m.billed), collected: formatBDT(m.collected), rate: pct(m.rate) });
              return (
                <li key={m.month} title={summary} className="group min-w-0 text-center">
                  <span className="sr-only">{summary}</span>
                  <span className="flex h-44 items-end justify-center gap-[2px] border-b border-line-strong transition-colors group-hover:bg-raised" aria-hidden="true">
                    <span className="w-1/3 max-w-4 rounded-t" style={{ height: height(m.billed), background: BILLED }} />
                    <span className="w-1/3 max-w-4 rounded-t" style={{ height: height(m.collected), background: COLLECTED }} />
                  </span>
                  <span className="mt-1.5 block text-xs text-muted" aria-hidden="true">{monthShort(m.month)}</span>
                  <span className="block text-sm font-semibold" aria-hidden="true">{pct(m.rate)}</span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </>
  );
}

/** FR-27 to FR-29, FR-58: the administrator's overview. The same figures as the collection report (FR-28). */
export function Dashboard() {
  const { t } = useTranslation();
  const [month, setMonth] = useState(thisMonth());
  const [term, setTerm] = useState('');
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['dashboard', month], queryFn: () => api.get<DashboardData>(`/api/dashboard?month=${month}`) });

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="heading-section">{t('dashboard.title')}</h2>
        <Link to="/reports" className="btn btn-secondary">
          {t('dashboard.reports')}
        </Link>
      </div>
      <div className="mb-5 flex flex-wrap items-end gap-3">
      <form
        className="min-w-56 flex-1"
        role="search"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (term.trim()) navigate(`/search?q=${encodeURIComponent(term.trim())}`);
        }}
      >
        <Field label={t('search.label')}>{(p) => <TextInput {...p} type="search" value={term} onChange={(e) => setTerm(e.target.value)} />}</Field>
      </form>
      <div className="w-full sm:w-52">
        <Field label={t('dashboard.month')}>{(p) => <MonthInput {...p} value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />}</Field>
      </div>
      </div>
      {q.isLoading ? (
        <Spinner />
      ) : q.isError ? (
        <Notice>{errorMessage(t, q.error)}</Notice>
      ) : (
        <div className="space-y-4">
          <Card>
            <h2 className="mb-3 heading-section">{t('dashboard.billing', { month: monthLabel(q.data!.month) })}</h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat id="dash-billed" label={t('dashboard.billed')} value={formatBDT(q.data!.billing.billed)} />
              <Stat id="dash-collected" label={t('dashboard.collected')} value={formatBDT(q.data!.billing.collected)} />
              <Stat id="dash-outstanding" label={t('dashboard.outstanding')} value={formatBDT(q.data!.billing.outstanding)} />
              <Stat id="dash-rate" label={t('dashboard.rate')} value={q.data!.billing.rate === null ? t('dashboard.noRate') : pct(q.data!.billing.rate)} />
            </div>
            {q.data!.billing.rate !== null && (
              <div className="meter mt-4" aria-hidden="true">
                <span style={{ width: `${Math.min(q.data!.billing.rate, 100)}%` }} />
              </div>
            )}
            <p className="mt-3 font-semibold text-danger" data-testid="dash-overdue">
              {q.data!.billing.overdueBills > 0 ? `${t('dashboard.overdueBills', { count: q.data!.billing.overdueBills })} (${formatBDT(q.data!.billing.overdueAmount)})` : ''}
            </p>
            {q.data!.billing.pendingReports > 0 && (
              <p>
                <Link to="/payment-reports" className="link-action" data-testid="dash-pending-reports">
                  {t('dashboard.pendingReports', { count: q.data!.billing.pendingReports })}
                </Link>
              </p>
            )}
            {q.data!.billing.openingBalances.outstanding > 0 && <p className="text-muted">{t('dashboard.openingBalances', { amount: formatBDT(q.data!.billing.openingBalances.outstanding) })}</p>}
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <h2 className="mb-3 heading-section">{t('dashboard.building')}</h2>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Stat id="dash-units" label={t('dashboard.totalUnits')} value={q.data!.building.totalUnits} />
                <Stat id="dash-occupied" label={t('dashboard.occupied')} value={q.data!.building.occupied} />
                <Stat id="dash-vacant" label={t('dashboard.vacant')} value={q.data!.building.vacant} />
                <Stat id="dash-unavailable" label={t('dashboard.unavailable')} value={q.data!.building.unavailable} />
                <Stat id="dash-residents" label={t('dashboard.residents')} value={q.data!.building.residents} />
              </div>
            </Card>
            <Card>
              <h2 className="mb-3 heading-section">
                <Link to="/requests" className="underline decoration-line-strong hover:decoration-accent">
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
            <Trend months={q.data!.trend} />
          </Card>

          {q.data!.recent.activity && (
            <Card className="card-flush">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2 sm:px-6">
                <h2 className="heading-card">{t('activity.recent')}</h2>
                <Link to="/activity" className="link-action">
                  {t('activity.seeAll')}
                </Link>
              </div>
              <ul className="divide-y divide-line">
                {q.data!.recent.activity.map((e) => (
                  <ActivityRow key={e.id} e={e} />
                ))}
              </ul>
            </Card>
          )}

          <div className="grid gap-4 lg:grid-cols-3">
            <Card>
              <h2 className="mb-2 heading-card">{t('dashboard.recentPayments')}</h2>
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
              <h2 className="mb-2 heading-card">{t('dashboard.recentRequests')}</h2>
              {q.data!.recent.requests.length === 0 ? (
                <p className="text-muted">{t('dashboard.none')}</p>
              ) : (
                <ul className="space-y-2">
                  {q.data!.recent.requests.map((r) => (
                    <li key={r.id}>
                      <Link to={`/requests/${r.id}`} className="block hover:underline">
                        #{r.number} · {r.unitNumber ?? t('maintenance.noUnit')} · {r.title} <Chip>{t(`requestStatus.${r.status}`)}</Chip>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card>
              <h2 className="mb-2 heading-card">
                <Link to="/announcements" className="underline decoration-line-strong hover:decoration-accent">
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
