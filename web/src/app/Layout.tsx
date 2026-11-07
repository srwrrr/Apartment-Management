import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { BILL_READ_PERMISSIONS } from '@apt/shared';
import { api } from '../lib/api';
import { useTranslation } from 'react-i18next';
import { LanguageSwitch, TextSizeSwitch } from '../components/Preferences';
import { Button } from '../components/ui';
import { useAuth } from './auth';

export function Layout() {
  const { t } = useTranslation();
  const { user, can, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  // The building's name is a setting the administrator can change (shown for everyone who is logged in).
  const building = useQuery({ queryKey: ['public-settings'], queryFn: () => api.get<{ buildingName: string }>('/api/settings/public'), staleTime: 5 * 60_000 });

  // Menus show only what the user is allowed to use (FR-02).
  const links: { to: string; label: string; show: boolean }[] = [
    { to: '/', label: t('nav.home'), show: true },
    { to: '/units', label: t('nav.units'), show: can('units.manage') || can('residents.manage') },
    { to: '/residents', label: t('nav.residents'), show: can('residents.manage') },
    { to: '/bills', label: t('nav.bills'), show: user?.role === 'RESIDENT' || BILL_READ_PERMISSIONS.some((p) => can(p)) },
    { to: '/fees', label: t('nav.fees'), show: can('billing.manage') },
    { to: '/directory', label: t('nav.directory'), show: can('directory.view') },
    { to: '/staff', label: t('nav.staff'), show: user?.role === 'ADMIN' },
    { to: '/import', label: t('nav.import'), show: user?.role === 'ADMIN' },
    { to: '/settings', label: t('nav.settings'), show: user?.role === 'ADMIN' },
    { to: '/profile', label: t('nav.profile'), show: user?.role === 'RESIDENT' },
  ];

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `block rounded-lg px-3 py-2 text-base font-semibold min-h-11 ${isActive ? 'bg-brand-100 text-brand-900' : 'text-ink hover:bg-brand-50'}`;

  return (
    <div className="min-h-screen">
      <a href="#main" className="no-print sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:p-2">
        {t('common.skipToContent')}
      </a>
      <header className="no-print border-b border-line bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div>
            <p className="text-lg font-bold text-brand-700">{building.data?.buildingName ?? t('app.building')}</p>
            <p className="text-sm text-muted">{t('app.name')}</p>
          </div>
          <Button variant="secondary" className="sm:hidden" aria-expanded={open} aria-controls="site-nav" onClick={() => setOpen((o) => !o)}>
            {t('common.menu')}
          </Button>
          <div className="hidden items-center gap-3 sm:flex">
            <LanguageSwitch />
            <TextSizeSwitch />
          </div>
        </div>
        <div className="mx-auto max-w-6xl px-4 pb-3">
          <nav id="site-nav" aria-label="main" className={`${open ? 'block' : 'hidden'} sm:block`}>
            <ul className="flex flex-col gap-1 sm:flex-row sm:flex-wrap">
              {links
                .filter((l) => l.show)
                .map((l) => (
                  <li key={l.to}>
                    <NavLink to={l.to} end={l.to === '/'} className={linkClass} onClick={() => setOpen(false)}>
                      {l.label}
                    </NavLink>
                  </li>
                ))}
              <li className="sm:ml-auto">
                <NavLink to="/change-password" className={linkClass} onClick={() => setOpen(false)}>
                  {t('common.changePassword')}
                </NavLink>
              </li>
              <li>
                <button
                  type="button"
                  className="block min-h-11 w-full rounded-lg px-3 py-2 text-start text-base font-semibold text-danger-600 hover:bg-danger-50"
                  onClick={async () => {
                    await logout();
                    navigate('/login');
                  }}
                >
                  {t('common.logout')}
                </button>
              </li>
            </ul>
            <div className="mt-2 flex flex-wrap items-center gap-3 sm:hidden">
              <LanguageSwitch />
              <TextSizeSwitch />
            </div>
          </nav>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
