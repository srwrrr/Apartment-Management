import type { ReactNode } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { Permission } from '@apt/shared';
import { Spinner } from '../components/ui';
import { useAuth } from './auth';
import type { Role } from '../lib/types';

/** Logged in, and past the forced first-login password change. */
export function RequireAuth({ children, allowTempPassword = false }: { children: ReactNode; allowTempPassword?: boolean }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Spinner />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (user.mustChangePassword && !allowTempPassword) return <Navigate to="/change-password" replace />;
  return <>{children}</>;
}

export function AccessDenied() {
  const { t } = useTranslation();
  return (
    <div className="mx-auto max-w-md py-12 text-center">
      <h1 className="mb-2 text-2xl font-bold">{t('denied.title')}</h1>
      <p className="mb-6 text-muted">{t('denied.body')}</p>
      <Link to="/" className="font-semibold text-accent underline">
        {t('denied.home')}
      </Link>
    </div>
  );
}

/**
 * Hides pages the user may not use. This is a convenience only: the server checks every request (NFR-02),
 * so typing the address of a page never gives access to its data (FR-02).
 */
export function RequireAccess({ children, anyOf, role, orRole }: { children: ReactNode; anyOf?: Permission[]; role?: Role; orRole?: Role }) {
  const { user, can } = useAuth();
  // orRole: a whole role may also enter (e.g. residents on the bills pages, alongside billing staff).
  const allowed = (!!orRole && user?.role === orRole) || ((!role || user?.role === role) && (!anyOf || anyOf.some((p) => can(p))));
  return allowed ? <>{children}</> : <AccessDenied />;
}
