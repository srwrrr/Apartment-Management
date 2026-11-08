import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { BILL_READ_PERMISSIONS } from '@apt/shared';
import { api } from '../lib/api';
import { useTranslation } from 'react-i18next';
import {
  Bell, CalendarClock, ChartColumn, Contact, CreditCard, DoorOpen, FileInput, HandCoins, History, House, KeyRound, LogOut, Megaphone, Menu, PieChart, Receipt, ScrollText, Search, Settings, Siren, Tags, UserCog, UserRound, Users, UsersRound, Wrench, X, type LucideIcon,
} from 'lucide-react';
import { LanguageSwitch, TextSizeSwitch } from '../components/Preferences';
import { BrandMark } from '../components/BrandMark';
import { Button } from '../components/ui';
import { useUnreadCount } from '../features/NotificationsPage';
import { useAuth } from './auth';

type Group = 'overview' | 'building' | 'money' | 'upkeep' | 'community' | 'admin' | 'account';
const GROUPS: Group[] = ['overview', 'building', 'money', 'upkeep', 'community', 'admin', 'account'];

export function Layout() {
  const { t } = useTranslation();
  const { user, can, logout } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const unread = useUnreadCount().data ?? 0;
  const [open, setOpen] = useState(false);
  const main = useRef<HTMLElement>(null);
  // The building's name is a setting the administrator can change (shown for everyone who is logged in).
  const building = useQuery({ queryKey: ['public-settings'], queryFn: () => api.get<{ buildingName: string; shareExpenseSummary: boolean }>('/api/settings/public'), staleTime: 5 * 60_000 });

  // A soft arrival on each page. The Web Animations API leaves the page's own components and state alone.
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    main.current?.animate?.([{ opacity: 0.35 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' });
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // The same page shows each person what is theirs to deal with.
  const seesAllRequests = user?.role === 'ADMIN' || ['maintenance.view_all', 'maintenance.review', 'maintenance.assign'].some((p) => can(p as 'maintenance.review'));
  const requestsLabel = user?.role === 'RESIDENT' ? t('nav.myRequests') : seesAllRequests ? t('nav.requests') : t('nav.myTasks');

  // Menus show only what the user is allowed to use (FR-02).
  const links: { to: string; label: string; show: boolean; group: Group; icon: LucideIcon }[] = [
    { to: '/', label: t('nav.home'), show: true, group: 'overview', icon: House },
    { to: '/search', label: t('nav.search'), show: user?.role !== 'RESIDENT', group: 'overview', icon: Search },
    { to: '/units', label: t('nav.units'), show: can('units.manage') || can('residents.manage'), group: 'building', icon: DoorOpen },
    { to: '/residents', label: t('nav.residents'), show: can('residents.manage'), group: 'building', icon: Users },
    { to: '/directory', label: t('nav.directory'), show: can('directory.view'), group: 'building', icon: Contact },
    { to: '/bills', label: t('nav.bills'), show: user?.role === 'RESIDENT' || BILL_READ_PERMISSIONS.some((p) => can(p)), group: 'money', icon: Receipt },
    { to: '/statement', label: t('nav.statement'), show: user?.role === 'RESIDENT', group: 'money', icon: ScrollText },
    { to: '/payment-reports', label: t('nav.paymentReports'), show: can('payments.record'), group: 'money', icon: CreditCard },
    { to: '/expenses', label: t('nav.expenses'), show: can('expenses.manage'), group: 'money', icon: HandCoins },
    { to: '/fees', label: t('nav.fees'), show: can('billing.manage'), group: 'money', icon: Tags },
    { to: '/reports', label: t('nav.reports'), show: can('reports.view'), group: 'money', icon: ChartColumn },
    { to: '/building-summary', label: t('nav.buildingSummary'), show: user?.role === 'RESIDENT' && !!building.data?.shareExpenseSummary, group: 'money', icon: PieChart },
    { to: '/requests', label: requestsLabel, show: true, group: 'upkeep', icon: Wrench },
    { to: '/scheduled-tasks', label: t('nav.scheduledTasks'), show: can('maintenance.assign'), group: 'upkeep', icon: CalendarClock },
    { to: '/announcements', label: t('nav.announcements'), show: true, group: 'community', icon: Megaphone },
    { to: '/groups', label: t('nav.groups'), show: can('announcements.manage'), group: 'community', icon: UsersRound },
    { to: '/emergency', label: t('nav.emergency'), show: true, group: 'community', icon: Siren },
    { to: '/staff', label: t('nav.staff'), show: user?.role === 'ADMIN', group: 'admin', icon: UserCog },
    { to: '/activity', label: t('nav.activity'), show: user?.role === 'ADMIN', group: 'admin', icon: History },
    { to: '/import', label: t('nav.import'), show: user?.role === 'ADMIN', group: 'admin', icon: FileInput },
    { to: '/settings', label: t('nav.settings'), show: user?.role === 'ADMIN', group: 'admin', icon: Settings },
    { to: '/profile', label: t('nav.profile'), show: user?.role === 'RESIDENT', group: 'account', icon: UserRound },
  ];

  return (
    <div className="app-shell min-h-screen lg:grid lg:grid-cols-[17.5rem_minmax(0,1fr)]">
      <a href="#main" className="no-print sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-lg focus:bg-panel focus:p-2">
        {t('common.skipToContent')}
      </a>
      {open && <div className="modal-backdrop fixed inset-0 z-30 lg:hidden" aria-hidden="true" onClick={() => setOpen(false)} />}
      <header className="no-print glass topbar !rounded-none !border-x-0 !border-t-0 sticky top-0 z-40 lg:top-3 lg:m-3 lg:me-0 lg:flex lg:h-[calc(100dvh-1.5rem)] lg:flex-col lg:!rounded-3xl lg:!border-x lg:!border-t">
        <div className="flex h-[4.5rem] items-center justify-between gap-3 px-4 lg:h-auto lg:px-5 lg:pb-3 lg:pt-5">
          <div className="flex min-w-0 items-center gap-3">
            <BrandMark />
            <div className="min-w-0">
              <p className="font-display truncate text-base font-bold leading-tight">{building.data?.buildingName ?? t('app.building')}</p>
              <p className="truncate text-sm leading-tight text-muted">{t('app.name')}</p>
            </div>
          </div>
          <Button variant="secondary" className="shrink-0 whitespace-nowrap lg:hidden" aria-expanded={open} aria-controls="site-nav" onClick={() => setOpen((o) => !o)}>
            {open ? <X className="size-5" aria-hidden="true" /> : <Menu className="size-5" aria-hidden="true" />}
            {t('common.menu')}
          </Button>
        </div>
        <nav
          id="site-nav"
          aria-label="main"
          className={`${open ? 'drawer-in block' : 'hidden'} scroll-quiet absolute inset-x-2 top-full mt-2 max-h-[calc(100dvh-5.5rem)] overflow-y-auto rounded-3xl border border-line bg-panel p-3 shadow-2xl lg:static lg:mt-0 lg:block lg:max-h-none lg:min-h-0 lg:flex-1 lg:rounded-none lg:border-0 lg:bg-transparent lg:px-3 lg:py-2 lg:shadow-none lg:[animation:none]`}
        >
          {GROUPS.map((g) => {
            const items = links.filter((l) => l.show && l.group === g);
            return (
              <div key={g} className="mb-4 last:mb-0">
                {g !== 'overview' && <p id={`nav-${g}`} className="nav-group-label">{t(`nav.group.${g}`)}</p>}
                <ul aria-labelledby={g !== 'overview' ? `nav-${g}` : undefined} className="space-y-0.5">
                  {items.map((l) => (
                    <li key={l.to}>
                      <NavLink to={l.to} end={l.to === '/'} className="nav-link" onClick={() => setOpen(false)}>
                        <l.icon aria-hidden />
                        {l.label}
                      </NavLink>
                    </li>
                  ))}
                  {g === 'overview' && (
                    <li>
                      <NavLink to="/notifications" className="nav-link" onClick={() => setOpen(false)}>
                        <Bell aria-hidden />
                        {t('nav.notifications')}
                        {unread > 0 && (
                          <span data-testid="unread-badge" className="ms-auto inline-block min-w-6 rounded-full bg-danger-solid px-1.5 text-center text-xs font-bold leading-6 text-white">
                            {unread > 99 ? '99+' : unread}
                          </span>
                        )}
                        {unread > 0 && <span className="sr-only"> ({t('notifications.unread')})</span>}
                      </NavLink>
                    </li>
                  )}
                  {g === 'account' && (
                    <>
                      <li>
                        <NavLink to="/change-password" className="nav-link" onClick={() => setOpen(false)}>
                          <KeyRound aria-hidden />
                          {t('common.changePassword')}
                        </NavLink>
                      </li>
                      <li>
                        <button
                          type="button"
                          className="nav-link !text-danger hover:!bg-danger-soft"
                          onClick={async () => {
                            await logout();
                            navigate('/login');
                          }}
                        >
                          <LogOut aria-hidden />
                          {t('common.logout')}
                        </button>
                      </li>
                    </>
                  )}
                </ul>
              </div>
            );
          })}
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line px-1 pt-3">
            <LanguageSwitch />
            <TextSizeSwitch />
          </div>
        </nav>
      </header>
      <main id="main" ref={main} className="mx-auto w-full max-w-[76rem] px-4 py-6 sm:px-6 lg:px-10 lg:py-9">
        <Outlet />
      </main>
    </div>
  );
}
