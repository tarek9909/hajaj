import React from 'react';
import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './context/AuthContext';
import { AppLayout } from './components/layout/AppLayout';

import { LoginPage } from './pages/LoginPage';
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
      retry: 1,
      staleTime: 1000 * 30, // 30 seconds
    },
  },
});

const LoadingScreen: React.FC = () => (
  <div
    style={{
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'var(--bg-app)',
      gap: '1rem',
    }}
  >
    <div
      style={{
        width: '40px',
        height: '40px',
        border: '3px solid var(--border-color)',
        borderTopColor: 'var(--primary)',
        borderRadius: '50%',
        animation: 'spin 0.8s linear infinite',
      }}
    />
    <div style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>Loading WorkforceOS...</div>
  </div>
);

const ProtectedRoute: React.FC<{ children: React.ReactElement; requiredRole?: 'SUPERADMIN' }> = ({
  children,
  requiredRole,
}) => {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return <LoadingScreen />;
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (requiredRole === 'SUPERADMIN' && user.accountKind !== 'SUPERADMIN') {
    return <Navigate to={`/restaurants/${user.restaurantId}/dashboard`} replace />;
  }

  return children;
};

// Tenant guard to prevent Restaurant Admins from accessing other restaurants
const TenantGuard: React.FC<{ children: React.ReactElement }> = ({ children }) => {
  const { user } = useAuth();
  const { restaurantId } = useParams<{ restaurantId: string }>();

  if (user?.accountKind === 'RESTAURANT_ADMIN' && user.restaurantId !== restaurantId) {
    return <Navigate to={`/restaurants/${user.restaurantId}/dashboard`} replace />;
  }

  return children;
};

const DefaultRedirect: React.FC = () => {
  const { user, isLoading } = useAuth();

  if (isLoading) return <LoadingScreen />;

  if (!user) return <Navigate to="/login" replace />;

  if (user.accountKind === 'SUPERADMIN') {
    return <Navigate to="/platform" replace />;
  }

  return <Navigate to={`/restaurants/${user.restaurantId || '1'}/dashboard`} replace />;
};

export const App: React.FC = () => {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />

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
      </AuthProvider>
    </QueryClientProvider>
  );
};
