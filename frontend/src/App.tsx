import React from 'react';
import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './context/AuthContext';
import { PeriodProvider } from './context/PeriodContext';
import { AppLayout } from './components/layout/AppLayout';

import { LoginPage } from './pages/LoginPage';
import { AccountTokenPage } from './pages/AccountTokenPage';
import { PlatformDashboardPage } from './pages/PlatformDashboardPage';
import { RestaurantDashboardPage } from './pages/RestaurantDashboardPage';
import { EmployeesPage } from './pages/EmployeesPage';
import { SchedulingPage } from './pages/SchedulingPage';
import { AttendancePage } from './pages/AttendancePage';
import { WarningsPage } from './pages/WarningsPage';
import { DebtPage } from './pages/DebtPage';
import { AdjustmentsPage } from './pages/AdjustmentsPage';
import { PayrollPage } from './pages/PayrollPage';
import { SettingsPage } from './pages/SettingsPage';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: (count, err: any) => (err?.status && err.status < 500 ? false : count < 1),
      staleTime: 1000 * 30,
    },
  },
});

const LoadingScreen: React.FC = () => (
  <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--bg-app)' }}>
    <div className="row" style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>
      <span className="spinner" />
      <span>Loading WorkforceOS…</span>
    </div>
  </div>
);

/** Where a signed-in user belongs when they hit "/" or an unknown path. */
function homeFor(user: { accountKind: string; restaurantId: string | null }): string {
  if (user.accountKind === 'SUPERADMIN') return '/platform';
  return user.restaurantId ? `/restaurants/${user.restaurantId}/dashboard` : '/login';
}

const ProtectedRoute: React.FC<{ children: React.ReactElement; requiredRole?: 'SUPERADMIN' }> = ({
  children,
  requiredRole,
}) => {
  const { user, isLoading } = useAuth();
  if (isLoading) return <LoadingScreen />;
  if (!user) return <Navigate to="/login" replace />;
  if (requiredRole === 'SUPERADMIN' && user.accountKind !== 'SUPERADMIN') {
    return <Navigate to={homeFor(user)} replace />;
  }
  return children;
};

// Restaurant admins may only ever see their own restaurant
const TenantGuard: React.FC<{ children: React.ReactElement }> = ({ children }) => {
  const { user } = useAuth();
  const { restaurantId } = useParams<{ restaurantId: string }>();
  if (user?.accountKind === 'RESTAURANT_ADMIN' && user.restaurantId !== restaurantId) {
    return <Navigate to={homeFor(user)} replace />;
  }
  return children;
};

const DefaultRedirect: React.FC = () => {
  const { user, isLoading } = useAuth();
  if (isLoading) return <LoadingScreen />;
  if (!user) return <Navigate to="/login" replace />;
  return <Navigate to={homeFor(user)} replace />;
};

export const App: React.FC = () => (
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <PeriodProvider>
        <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/forgot-password" element={<AccountTokenPage mode="forgot" />} />
            <Route path="/reset-password" element={<AccountTokenPage mode="reset" />} />
            <Route path="/setup-password" element={<AccountTokenPage mode="setup" />} />

            <Route
              path="/platform"
              element={
                <ProtectedRoute requiredRole="SUPERADMIN">
                  <AppLayout />
                </ProtectedRoute>
              }
            >
              <Route index element={<PlatformDashboardPage />} />
            </Route>

            <Route
              path="/restaurants/:restaurantId"
              element={
                <ProtectedRoute>
                  <TenantGuard>
                    <AppLayout />
                  </TenantGuard>
                </ProtectedRoute>
              }
            >
              <Route index element={<Navigate to="dashboard" replace />} />
              <Route path="dashboard" element={<RestaurantDashboardPage />} />
              <Route path="employees" element={<EmployeesPage />} />
              <Route path="scheduling" element={<SchedulingPage />} />
              <Route path="attendance" element={<AttendancePage />} />
              <Route path="warnings" element={<WarningsPage />} />
              <Route path="debt" element={<DebtPage />} />
              <Route path="adjustments" element={<AdjustmentsPage />} />
              <Route path="payroll" element={<PayrollPage />} />
              <Route path="settings" element={<SettingsPage />} />
            </Route>

            <Route path="/" element={<DefaultRedirect />} />
            <Route path="*" element={<DefaultRedirect />} />
          </Routes>
        </BrowserRouter>
      </PeriodProvider>
    </AuthProvider>
  </QueryClientProvider>
);
