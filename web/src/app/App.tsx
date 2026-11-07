import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChangePasswordPage } from '../features/ChangePasswordPage';
import { DirectoryPage } from '../features/DirectoryPage';
import { ImportPage } from '../features/ImportPage';
import { HomePage } from '../features/HomePage';
import { LoginPage } from '../features/LoginPage';
import { ProfilePage } from '../features/ProfilePage';
import { ResidentDetailPage } from '../features/ResidentDetailPage';
import { ResidentsPage } from '../features/ResidentsPage';
import { StaffPage } from '../features/StaffPage';
import { UnitDetailPage } from '../features/UnitDetailPage';
import { UnitsPage } from '../features/UnitsPage';
import { Layout } from './Layout';
import { RequireAccess, RequireAuth } from './guards';
import { useAuth } from './auth';

function NotFound() {
  const { t } = useTranslation();
  return (
    <div className="mx-auto max-w-md py-12 text-center">
      <h1 className="mb-2 text-2xl font-bold">{t('notFound.title')}</h1>
      <p className="mb-6 text-muted">{t('notFound.body')}</p>
      <Link to="/" className="font-semibold text-brand-700 underline">
        {t('denied.home')}
      </Link>
    </div>
  );
}

export function App() {
  const { user, loading } = useAuth();
  return (
    <Routes>
      <Route path="/login" element={!loading && user ? <Navigate to="/" replace /> : <LoginPage />} />
      <Route
        path="/change-password"
        element={
          <RequireAuth allowTempPassword>
            <ChangePasswordPage />
          </RequireAuth>
        }
      />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<HomePage />} />
        <Route path="units" element={<RequireAccess anyOf={['units.manage', 'residents.manage']}><UnitsPage /></RequireAccess>} />
        <Route path="units/:id" element={<RequireAccess anyOf={['units.manage', 'residents.manage']}><UnitDetailPage /></RequireAccess>} />
        <Route path="residents" element={<RequireAccess anyOf={['residents.manage']}><ResidentsPage /></RequireAccess>} />
        <Route path="residents/:id" element={<RequireAccess anyOf={['residents.manage']}><ResidentDetailPage /></RequireAccess>} />
        <Route path="directory" element={<RequireAccess anyOf={['directory.view']}><DirectoryPage /></RequireAccess>} />
        <Route path="import" element={<RequireAccess role="ADMIN"><ImportPage /></RequireAccess>} />
        <Route path="staff" element={<RequireAccess role="ADMIN"><StaffPage /></RequireAccess>} />
        <Route path="profile" element={<RequireAccess role="RESIDENT"><ProfilePage /></RequireAccess>} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
