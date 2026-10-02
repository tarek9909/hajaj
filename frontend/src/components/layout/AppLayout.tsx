import React, { useState } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
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
} from 'lucide-react';

export const AppLayout: React.FC = () => {
  const { user, logout, activeRestaurantId, setActiveRestaurantId } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);

  const restaurantId = activeRestaurantId || (user?.restaurantId ?? '1');
  const isPlatformView = location.pathname.startsWith('/platform');

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const navItems = isPlatformView
    ? [
        { label: 'All Restaurants', path: '/platform', icon: Building2 },
        { label: 'Switch to Restaurant', path: `/restaurants/${restaurantId}/dashboard`, icon: LayoutDashboard },
      ]
    : [
        { label: 'Dashboard', path: `/restaurants/${restaurantId}/dashboard`, icon: LayoutDashboard },
        { label: 'Employees', path: `/restaurants/${restaurantId}/employees`, icon: Users },
        { label: 'Shift Schedules', path: `/restaurants/${restaurantId}/scheduling`, icon: CalendarDays },
        { label: 'Daily Attendance', path: `/restaurants/${restaurantId}/attendance`, icon: Clock },
        { label: 'Warnings & Limits', path: `/restaurants/${restaurantId}/warnings`, icon: AlertTriangle },
        { label: 'Hour Debt & Waivers', path: `/restaurants/${restaurantId}/debt`, icon: Scale },
        { label: 'Adjustments', path: `/restaurants/${restaurantId}/adjustments`, icon: SlidersHorizontal },
        { label: 'Payroll & Reports', path: `/restaurants/${restaurantId}/payroll`, icon: FileSpreadsheet },
        { label: 'Settings & Policy', path: `/restaurants/${restaurantId}/settings`, icon: Settings },
      ];

  return (
    <div className="app-shell">
      {/* Sidebar */}
      <aside className={`sidebar ${mobileOpen ? 'mobile-open' : ''}`}>
        <div className="sidebar-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flex: 1, minWidth: 0 }}>
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                backgroundColor: 'var(--primary)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fff',
                fontWeight: 700,
                fontSize: 16,
                flexShrink: 0,
              }}
            >
              W
            </div>
            <div style={{ overflow: 'hidden' }}>
              <div style={{ fontWeight: 700, fontSize: '0.95rem', color: '#fff', letterSpacing: '-0.02em' }}>
                WorkforceOS
              </div>
              <div style={{ fontSize: '0.72rem', color: 'var(--nav-text-muted)', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                {isPlatformView ? 'Platform Control' : (restaurantId === '1' ? 'The Grand Bistro' : (restaurantId === '2' ? 'Spice Garden' : `Restaurant #${restaurantId}`))}
              </div>
            </div>
          </div>
          <button
            onClick={() => setMobileOpen(false)}
            style={{ display: mobileOpen ? 'block' : 'none', background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer' }}
          >
            <X size={20} />
          </button>
        </div>

        <nav className="sidebar-nav">
          {navItems.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              onClick={() => setMobileOpen(false)}
              className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
            >
              <item.icon size={18} />
              <span>{item.label}</span>
            </NavLink>
          ))}

          {user?.accountKind === 'SUPERADMIN' && !isPlatformView && (
            <div style={{ marginTop: 'auto', paddingTop: '1rem', borderTop: '1px solid var(--nav-border)' }}>
              <NavLink
                to="/platform"
                onClick={() => setMobileOpen(false)}
                className="nav-item"
                style={{ color: '#38bdf8' }}
              >
                <ShieldCheck size={18} />
                <span>Superadmin Console</span>
              </NavLink>
            </div>
          )}
        </nav>

        <div className="sidebar-footer">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: '0.8125rem', color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {user?.fullName || 'User'}
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--nav-text-muted)' }}>
                {user?.accountKind === 'SUPERADMIN' ? 'Platform Superadmin' : 'Restaurant Admin'}
              </div>
            </div>
            <button
              onClick={handleLogout}
              className="btn btn-secondary btn-sm"
              title="Sign out"
              style={{ padding: '0.35rem', background: 'transparent', borderColor: 'var(--nav-border)', color: '#94a3b8' }}
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="main-content">
        {/* Topbar */}
        <header className="topbar">
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <button
              onClick={() => setMobileOpen(true)}
              style={{ display: 'flex', alignItems: 'center', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-main)' }}
              className="mobile-only"
            >
              <Menu size={22} />
            </button>

            {user?.accountKind === 'SUPERADMIN' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>Active Workspace:</span>
                <select
                  value={restaurantId}
                  onChange={(e) => {
                    setActiveRestaurantId(e.target.value);
                    navigate(`/restaurants/${e.target.value}/dashboard`);
                  }}
                  className="select"
                  style={{ width: 'auto', padding: '0.3rem 0.6rem', fontSize: '0.8125rem' }}
                >
                  <option value="1">The Grand Bistro (USD)</option>
                  <option value="2">Spice Garden (SAR)</option>
                </select>
              </div>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <span className={`badge ${user?.accountKind === 'SUPERADMIN' ? 'badge-info' : 'badge-neutral'}`}>
              {user?.accountKind === 'SUPERADMIN' ? 'Superadmin' : 'Tenant Admin'}
            </span>
          </div>
        </header>

        {/* Page Content */}
        <main className="page-container">
          <Outlet />
        </main>
      </div>
    </div>
  );
};
