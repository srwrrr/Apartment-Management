import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { BILL_READ_PERMISSIONS } from '@apt/shared';
import { useTranslation } from 'react-i18next';
import { AnnouncementDetailPage, AnnouncementsPage, NewAnnouncementPage } from '../features/AnnouncementsPage';
import { NotificationsPage } from '../features/NotificationsPage';
import { ReportsPage } from '../features/ReportsPage';
import { PaymentReportsPage } from '../features/PaymentReportsPage';
import { MyStatementPage, UnitStatementPage } from '../features/StatementPage';
import { MoveOutPage } from '../features/MoveOutPage';
import { BuildingSummaryPage, ExpensesPage } from '../features/ExpensesPage';
import { ActivityPage } from '../features/ActivityPage';
import { EmergencyPage } from '../features/EmergencyPage';
import { GroupDetailPage, GroupsPage } from '../features/GroupsPage';
import { ScheduledTasksPage } from '../features/ScheduledTasksPage';
import { SearchPage } from '../features/SearchPage';
import { BillDetailPage } from '../features/BillDetailPage';
import { BillsPage } from '../features/BillsPage';
import { ChangePasswordPage } from '../features/ChangePasswordPage';
import { NewRequestPage } from '../features/NewRequestPage';
import { RequestDetailPage } from '../features/RequestDetailPage';
import { RequestsPage } from '../features/RequestsPage';
import { FeesPage } from '../features/FeesPage';
import { GenerateBillsPage } from '../features/GenerateBillsPage';
import { SettingsPage } from '../features/SettingsPage';
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
      <h1 className="heading-page mb-2">{t('notFound.title')}</h1>
      <p className="mb-6 text-muted">{t('notFound.body')}</p>
      <Link to="/" className="font-semibold text-accent underline">
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
        <Route path="bills" element={<RequireAccess anyOf={BILL_READ_PERMISSIONS} orRole="RESIDENT"><BillsPage /></RequireAccess>} />
        <Route path="bills/generate" element={<RequireAccess anyOf={['billing.manage']}><GenerateBillsPage /></RequireAccess>} />
        <Route path="bills/:id" element={<RequireAccess anyOf={BILL_READ_PERMISSIONS} orRole="RESIDENT"><BillDetailPage /></RequireAccess>} />
        <Route path="requests" element={<RequestsPage />} />
        <Route path="requests/new" element={<RequireAccess role="RESIDENT"><NewRequestPage /></RequireAccess>} />
        <Route path="requests/:id" element={<RequestDetailPage />} />
        <Route path="payment-reports" element={<RequireAccess anyOf={['payments.record']}><PaymentReportsPage /></RequireAccess>} />
        <Route path="statement" element={<RequireAccess role="RESIDENT"><MyStatementPage /></RequireAccess>} />
        <Route path="units/:id/statement" element={<RequireAccess anyOf={BILL_READ_PERMISSIONS}><UnitStatementPage /></RequireAccess>} />
        <Route path="occupancies/:id/move-out" element={<RequireAccess role="ADMIN"><MoveOutPage /></RequireAccess>} />
        <Route path="expenses" element={<RequireAccess anyOf={['expenses.manage']}><ExpensesPage /></RequireAccess>} />
        <Route path="building-summary" element={<RequireAccess role="RESIDENT"><BuildingSummaryPage /></RequireAccess>} />
        <Route path="activity" element={<RequireAccess role="ADMIN"><ActivityPage /></RequireAccess>} />
        <Route path="search" element={user?.role === 'RESIDENT' ? <Navigate to="/" replace /> : <SearchPage />} />
        <Route path="notifications" element={<NotificationsPage />} />
        <Route path="announcements" element={<AnnouncementsPage />} />
        <Route path="announcements/new" element={<RequireAccess anyOf={['announcements.manage']}><NewAnnouncementPage /></RequireAccess>} />
        <Route path="announcements/:id" element={<AnnouncementDetailPage />} />
        <Route path="emergency" element={<EmergencyPage />} />
        <Route path="groups" element={<RequireAccess anyOf={['announcements.manage']}><GroupsPage /></RequireAccess>} />
        <Route path="groups/:id" element={<RequireAccess anyOf={['announcements.manage']}><GroupDetailPage /></RequireAccess>} />
        <Route path="scheduled-tasks" element={<RequireAccess anyOf={['maintenance.assign']}><ScheduledTasksPage /></RequireAccess>} />
        <Route path="reports" element={<RequireAccess anyOf={['reports.view']}><ReportsPage /></RequireAccess>} />
        <Route path="fees" element={<RequireAccess anyOf={['billing.manage']}><FeesPage /></RequireAccess>} />
        <Route path="settings" element={<RequireAccess role="ADMIN"><SettingsPage /></RequireAccess>} />
        <Route path="directory" element={<RequireAccess anyOf={['directory.view']}><DirectoryPage /></RequireAccess>} />
        <Route path="import" element={<RequireAccess role="ADMIN"><ImportPage /></RequireAccess>} />
        <Route path="staff" element={<RequireAccess role="ADMIN"><StaffPage /></RequireAccess>} />
        <Route path="profile" element={<RequireAccess role="RESIDENT"><ProfilePage /></RequireAccess>} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
