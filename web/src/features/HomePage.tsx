import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Wrench } from 'lucide-react';
import { useAuth } from '../app/auth';
import { Card, Chip, Notice, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { formatDate } from '../lib/format';
import { BILL_READ_PERMISSIONS, formatBDT } from '@apt/shared';
import type { MyProfile } from '../lib/types';
import { Dashboard } from './DashboardPage';

function BalanceCard() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['my-balance'], queryFn: () => api.get<{ outstanding: number; overdueBills: number; openBills: number }>('/api/me/billing/balance') });
  // While loading, a placeholder of the same shape holds the space, so nothing below jumps when the figure arrives.
  if (q.isLoading) return (
    <Card>
      <div aria-busy="true" aria-label={t('common.loading')}>
        <span className="skeleton h-5 w-24" />
        <span className="skeleton mt-1 h-14 w-56" />
        <span className="skeleton mt-2 h-7 w-28" />
        <span className="skeleton mt-3 h-5 w-28" />
      </div>
    </Card>
  );
  if (!q.data) return null;
  return (
    <Card>
      {q.data.outstanding > 0 ? (
        <>
          <p className="text-muted">{t('billing.youOwe')}</p>
          <p className="figure-hero mt-1" data-testid="home-outstanding">{formatBDT(q.data.outstanding)}</p>
          {q.data.overdueBills > 0 && <p className="mt-2"><Chip tone="red">{t('billing.overdueCount', { count: q.data.overdueBills })}</Chip></p>}
        </>
      ) : (
        <p className="heading-section">{t('billing.allPaid')}</p>
      )}
      <Link to="/bills" className="mt-2 link-action">
        {t('billing.viewBills')}
      </Link>
    </Card>
  );
}

function ResidentHome() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['my-profile'], queryFn: () => api.get<MyProfile>('/api/me/profile') });
  if (q.isLoading) return (
    <Card>
      <h2 className="mb-3 heading-section">{t('home.yourUnits')}</h2>
      <div aria-busy="true" aria-label={t('common.loading')}>
        <span className="skeleton h-8 w-48" />
      </div>
    </Card>
  );
  if (q.isError) return <Notice>{errorMessage(t, q.error)}</Notice>;
  const current = q.data!.occupancies.filter((o) => !o.endDate);
  return (
    <Card>
      <h2 className="mb-3 heading-section">{t('home.yourUnits')}</h2>
      {current.length === 0 ? (
        <p className="text-muted">{t('home.noUnits')}</p>
      ) : (
        <ul className="space-y-3">
          {current.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center gap-3">
              <span className="figure">{o.unit.unitNumber}</span>
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
        <div className="space-y-5">
          <p className="max-w-2xl text-muted">{t('home.residentIntro')}</p>
          <div className="grid gap-4 lg:grid-cols-2">
            <BalanceCard />
            <ResidentHome />
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <Link to="/requests/new" className="btn btn-primary">
              <Wrench className="size-4" aria-hidden="true" />
              {t('maintenance.report')}
            </Link>
            <Link to="/profile" className="link-action">
              {t('nav.profile')}
            </Link>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-muted">{t('home.staffIntro')}</p>
          {shortcuts.length > 0 && (
            <Card>
              <h2 className="mb-3 heading-section">{t('home.shortcuts')}</h2>
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {shortcuts.map((s) => (
                  <li key={s.to}>
                    <Link to={s.to} className="tile tile-link flex min-h-16 items-center justify-between gap-2 font-semibold">
                      {s.label}
                      <ArrowRight className="size-4 flex-none text-muted rtl:rotate-180" aria-hidden="true" />
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
