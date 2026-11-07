import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../app/auth';
import { Card, Chip, Notice, PageHeader, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { formatDate } from '../lib/format';
import { BILL_READ_PERMISSIONS, formatBDT } from '@apt/shared';
import type { MyProfile } from '../lib/types';
import { Dashboard } from './DashboardPage';

function BalanceCard() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['my-balance'], queryFn: () => api.get<{ outstanding: number; overdueBills: number; openBills: number }>('/api/me/billing/balance') });
  if (!q.data) return null;
  return (
    <Card>
      {q.data.outstanding > 0 ? (
        <>
          <p className="text-muted">{t('billing.youOwe')}</p>
          <p className="text-3xl font-bold" data-testid="home-outstanding">{formatBDT(q.data.outstanding)}</p>
          {q.data.overdueBills > 0 && <p className="mt-1 font-semibold text-danger-600">{t('billing.overdueCount', { count: q.data.overdueBills })}</p>}
        </>
      ) : (
        <p className="font-semibold">{t('billing.allPaid')}</p>
      )}
      <Link to="/bills" className="mt-2 inline-flex min-h-11 items-center font-semibold text-brand-700 underline">
        {t('billing.viewBills')}
      </Link>
    </Card>
  );
}

function ResidentHome() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['my-profile'], queryFn: () => api.get<MyProfile>('/api/me/profile') });
  if (q.isLoading) return <Spinner />;
  if (q.isError) return <Notice>{errorMessage(t, q.error)}</Notice>;
  const current = q.data!.occupancies.filter((o) => !o.endDate);
  return (
    <Card>
      <h2 className="mb-3 text-xl font-bold">{t('home.yourUnits')}</h2>
      {current.length === 0 ? (
        <p className="text-muted">{t('home.noUnits')}</p>
      ) : (
        <ul className="space-y-3">
          {current.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center gap-3">
              <span className="text-2xl font-bold">{o.unit.unitNumber}</span>
              <Chip tone="blue">{t(`units.type.${o.type}`)}</Chip>
              <span className="text-muted">{t('profile.since', { date: formatDate(o.startDate) })}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function HomePage() {
  const { t } = useTranslation();
  const { user, can } = useAuth();
  if (!user) return null;
  // Administrators, and staff granted reports.view, open on the building overview (FR-27).
  if (user.role !== 'RESIDENT' && can('reports.view')) return (
      <>
        <PageHeader title={t('home.welcome', { name: user.fullName })} />
        <Dashboard />
      </>
    );
  const shortcuts = [
    { to: '/units', label: t('nav.units'), show: can('units.manage') || can('residents.manage') },
    { to: '/residents', label: t('nav.residents'), show: can('residents.manage') },
    { to: '/bills', label: t('nav.bills'), show: BILL_READ_PERMISSIONS.some((p) => can(p)) },
    { to: '/requests', label: user.role === 'STAFF' && !['maintenance.view_all', 'maintenance.review', 'maintenance.assign'].some((p) => can(p as 'maintenance.review')) ? t('nav.myTasks') : t('nav.requests'), show: user.role !== 'RESIDENT' },
    { to: '/fees', label: t('nav.fees'), show: can('billing.manage') },
    { to: '/directory', label: t('nav.directory'), show: can('directory.view') },
    { to: '/staff', label: t('nav.staff'), show: user.role === 'ADMIN' },
    { to: '/import', label: t('nav.import'), show: user.role === 'ADMIN' },
  ].filter((s) => s.show);

  return (
    <>
      <PageHeader title={t('home.welcome', { name: user.fullName })} />
      {user.role === 'RESIDENT' ? (
        <div className="space-y-4">
          <p className="text-muted">{t('home.residentIntro')}</p>
          <BalanceCard />
          <Link to="/requests/new" className="inline-flex min-h-11 items-center rounded-lg bg-brand-600 px-4 py-2 font-semibold text-white hover:bg-brand-700">
            {t('maintenance.report')}
          </Link>
          <ResidentHome />
          <Link to="/profile" className="inline-block min-h-11 font-semibold text-brand-700 underline">
            {t('nav.profile')}
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-muted">{t('home.staffIntro')}</p>
          {shortcuts.length > 0 && (
            <Card>
              <h2 className="mb-3 text-xl font-bold">{t('home.shortcuts')}</h2>
              <ul className="flex flex-wrap gap-3">
                {shortcuts.map((s) => (
                  <li key={s.to}>
                    <Link to={s.to} className="inline-flex min-h-11 items-center rounded-lg border border-line px-4 py-2 font-semibold text-brand-700 hover:bg-brand-50">
                      {s.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}
    </>
  );
}
