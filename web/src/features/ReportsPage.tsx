import { useSearchParams } from 'react-router-dom';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { formatBDT } from '@apt/shared';
import { Button, Card, Field, Notice, PageHeader, Spinner, TextInput } from '../components/ui';
import { api } from '../lib/api';
import { errorMessage, fieldErrorsOf } from '../lib/errors';
import { formatDate, monthLabel, thisMonth } from '../lib/format';
import type { DuesReport, FinanceReport } from '../lib/types';

const pct = (rate: number | null) => (rate === null ? '—' : `${rate}%`);

function addMonthsYm(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function Finance() {
  const { t } = useTranslation();
  // The period lives in the address, so a report can be bookmarked or reloaded (FR-30 style filters).
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
  const q = useQuery({ queryKey: ['finance-report', from, to], queryFn: () => api.get<FinanceReport>(`/api/reports/finance?from=${from}&to=${to}`), retry: false });
  const fe = fieldErrorsOf(t, q.error);

  return (
    <Card>
      <h2 className="mb-3 text-xl font-bold">{t('reports.finance')}</h2>
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
          <div className="overflow-x-auto">
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
          </div>
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
      <h2 className="mb-1 text-xl font-bold">{t('reports.dues')}</h2>
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
          <div className="overflow-x-auto">
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
          </div>
        </>
      )}
    </Card>
  );
}

export function ReportsPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t('reports.title')}>
        <Button variant="secondary" className="no-print" onClick={() => window.print()}>
          {t('reports.print')}
        </Button>
      </PageHeader>
      <Finance />
      <Dues />
    </>
  );
}
