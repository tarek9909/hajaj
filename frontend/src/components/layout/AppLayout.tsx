import React, { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate, useLocation, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  LayoutDashboard,
  Users,
  CalendarDays,
  Clock,
  AlertTriangle,
  Scale,
  SlidersHorizontal,
  FileSpreadsheet,
  Settings,
  ShieldCheck,
  LogOut,
  Building2,
  Menu,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { platformApi, payrollApi } from '../../lib/api';
import { usePeriod } from '../../context/PeriodContext';
import { initials } from '../../lib/format';
import { useRestaurant } from '../../hooks/useRestaurant';
import { PeriodPicker, ErrorBoundary } from '../ui';

interface NavItem {
  label: string;
  path: string;
  icon: LucideIcon;
}
interface NavGroup {
  label: string;
  items: NavItem[];
}

const PERIOD_SCREENS = ['dashboard', 'scheduling', 'warnings', 'debt', 'adjustments', 'payroll'];

export const AppLayout: React.FC = () => {
  const { user, logout, setActiveRestaurantId } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { restaurantId } = useParams<{ restaurantId: string }>();
  const [mobileOpen, setMobileOpen] = useState(false);

  const isPlatformView = location.pathname.startsWith('/platform');
  const isSuperadmin = user?.accountKind === 'SUPERADMIN';
  const screen = location.pathname.split('/').filter(Boolean).pop() || '';

  const { restaurant } = useRestaurant();

  const { data: restaurants = [] } = useQuery({
    queryKey: ['platform-restaurants-switcher'],
    queryFn: () => platformApi.listRestaurants(),
    enabled: isSuperadmin,
    staleTime: 60_000,
  });

  // First visit: open on the latest month that actually has payroll data instead of an empty calendar month
  const { hasChosen, setMonth } = usePeriod();
  const { data: periods } = useQuery({
    queryKey: ['payroll-periods', restaurantId],
    queryFn: () => payrollApi.listPeriods(restaurantId!),
    enabled: Boolean(restaurantId) && !hasChosen && !isPlatformView,
  });
  useEffect(() => {
    if (hasChosen || !periods) return;
    const latest = periods.find((p) => p.currentCalculationRunId || p.status === 'FINALIZED');
    if (latest) setMonth(latest.month);
  }, [hasChosen, periods, setMonth]);

  // Remember which restaurant a superadmin is working in
  useEffect(() => {
    if (isSuperadmin && restaurantId) setActiveRestaurantId(restaurantId);
  }, [isSuperadmin, restaurantId, setActiveRestaurantId]);

  useEffect(() => setMobileOpen(false), [location.pathname]);

  const base = `/restaurants/${restaurantId}`;
  const groups: NavGroup[] = isPlatformView
    ? [{ label: 'Platform', items: [{ label: 'Restaurants', path: '/platform', icon: Building2 }] }]
    : [
        { label: 'Overview', items: [{ label: 'Dashboard', path: `${base}/dashboard`, icon: LayoutDashboard }] },
        {
          label: 'Operations',
          items: [
            { label: 'Schedule', path: `${base}/scheduling`, icon: CalendarDays },
            { label: 'Attendance', path: `${base}/attendance`, icon: Clock },
          ],
        },
        {
          label: 'People',
          items: [
            { label: 'Employees', path: `${base}/employees`, icon: Users },
            { label: 'Warnings', path: `${base}/warnings`, icon: AlertTriangle },
          ],
        },
        {
          label: 'Payroll',
          items: [
            { label: 'Hour debt', path: `${base}/debt`, icon: Scale },
            { label: 'Adjustments', path: `${base}/adjustments`, icon: SlidersHorizontal },
            { label: 'Payroll & reports', path: `${base}/payroll`, icon: FileSpreadsheet },
          ],
        },
        { label: 'Workspace', items: [{ label: 'Settings & policy', path: `${base}/settings`, icon: Settings }] },
      ];

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  const showPeriod = !isPlatformView && PERIOD_SCREENS.includes(screen);
  const workspaceName = isPlatformView ? 'Platform console' : restaurant?.name ?? user?.restaurantName ?? 'Workspace';

  return (
    <div className="app-shell">
      <div className={`sidebar-scrim ${mobileOpen ? 'open' : ''}`} onClick={() => setMobileOpen(false)} />

      <aside className={`sidebar ${mobileOpen ? 'mobile-open' : ''}`}>
        <div className="sidebar-header">
          <div className="brand-mark">W</div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="brand-name">WorkforceOS</div>
            <div className="brand-sub">{workspaceName}</div>
          </div>
          <button
            className="btn btn-ghost btn-icon mobile-only"
            onClick={() => setMobileOpen(false)}
            aria-label="Close menu"
            style={{ color: 'var(--nav-text-muted)' }}
          >
            <X size={18} />
          </button>
        </div>

        <nav className="sidebar-nav">
          {groups.map((group) => (
            <div className="nav-group" key={group.label}>
              <div className="nav-group-label">{group.label}</div>
              {group.items.map((item) => (
                <NavLink
                  key={item.path}
                  to={item.path}
                  end={item.path === '/platform'}
                  className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                >
                  <item.icon size={17} />
                  <span>{item.label}</span>
                </NavLink>
              ))}
            </div>
          ))}

          {isSuperadmin && (
            <div className="nav-group" style={{ marginTop: 'auto' }}>
              <div className="nav-group-label">Superadmin</div>
              <NavLink to="/platform" end className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
                <ShieldCheck size={17} />
                <span>Platform console</span>
              </NavLink>
            </div>
          )}
        </nav>

        <div className="sidebar-footer">
          <div className="row" style={{ gap: '0.65rem' }}>
            <div className="avatar" style={{ background: 'var(--nav-surface)', color: '#7ee8d3' }}>
              {initials(user?.fullName)}
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: '0.8125rem', color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {user?.fullName || 'User'}
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--nav-text-muted)' }}>
                {isSuperadmin ? 'Platform superadmin' : 'Restaurant admin'}
              </div>
            </div>
            <button
              onClick={handleLogout}
              className="btn btn-ghost btn-icon"
              title="Sign out"
              aria-label="Sign out"
              style={{ color: 'var(--nav-text-muted)' }}
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>

      <div className="main-content">
        <header className="topbar">
          <div className="row">
            <button className="btn btn-ghost btn-icon mobile-only" onClick={() => setMobileOpen(true)} aria-label="Open menu">
              <Menu size={20} />
            </button>

            {isSuperadmin && !isPlatformView ? (
              <select
                value={restaurantId}
                onChange={(e) => navigate(`/restaurants/${e.target.value}/${screen || 'dashboard'}`)}
                className="select"
                aria-label="Active restaurant"
                style={{ width: 'auto', minWidth: 200, fontWeight: 600 }}
              >
                {restaurants.length === 0 && <option value={restaurantId}>{restaurant?.name ?? 'Restaurant'}</option>}
                {restaurants.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} · {r.currencyCode}
                  </option>
                ))}
              </select>
            ) : (
              <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>{isPlatformView ? 'All restaurants' : workspaceName}</span>
            )}
          </div>

          <div className="row">
            {showPeriod && <PeriodPicker />}
            {restaurant && !isPlatformView && (
              <span className="badge badge-neutral hide-sm" title="Restaurant timezone and currency">
                {restaurant.timezone} · {restaurant.currencyCode}
              </span>
            )}
          </div>
        </header>

        <main className="page-container">
          <ErrorBoundary key={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
};
