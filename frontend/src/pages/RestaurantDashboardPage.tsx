import React from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Users,
  CalendarDays,
  Clock,
  AlertTriangle,
  Scale,
  FileSpreadsheet,
  ArrowRight,
  TrendingUp,
} from 'lucide-react';
import { employeesApi, payrollApi, warningsApi, debtApi, platformApi } from '../lib/api';

export const RestaurantDashboardPage: React.FC = () => {
  const { restaurantId = '1' } = useParams<{ restaurantId: string }>();
  const currentMonth = '2026-09';

  const { data: restaurant } = useQuery({
    queryKey: ['restaurant-info', restaurantId],
    queryFn: () => platformApi.getRestaurant(restaurantId),
  });

  const { data: employees = [] } = useQuery({
    queryKey: ['employees', restaurantId],
    queryFn: () => employeesApi.list(restaurantId),
  });

  const { data: payrollData } = useQuery({
    queryKey: ['payroll-period', restaurantId, currentMonth],
    queryFn: () => payrollApi.getPeriodOverview(restaurantId, currentMonth),
  });

  const { data: warningsData } = useQuery({
    queryKey: ['warnings', restaurantId, currentMonth],
    queryFn: () => warningsApi.list(restaurantId, currentMonth),
  });

  const { data: debtData } = useQuery({
    queryKey: ['debt', restaurantId, currentMonth],
    queryFn: () => debtApi.list(restaurantId, currentMonth),
  });

  const activeEmployees = employees.filter((e) => e.status === 'ACTIVE');
  const currency = restaurant?.currencyCode || 'USD';
  const decimals = restaurant?.currencyDecimalPlaces ?? 2;

  const totalOutstandingDebt = debtData?.sources.reduce((sum, s) => {
    const unrecovered = (s.shortfallMinutes || s.importedMinutes || 0) - (s.waivedMinutes || 0);
    return sum + Math.max(0, unrecovered);
  }, 0) || 0;

  const limitReachedCount = warningsData?.employeeWarningCounts
    ? Object.values(warningsData.employeeWarningCounts).filter((w) => w.limitReached).length
    : 0;

  return (
    <div>
      {/* Welcome & Status Banner */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '1.75rem',
          flexWrap: 'wrap',
          gap: '1rem',
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <h1 style={{ fontSize: '1.75rem', fontWeight: 700, letterSpacing: '-0.02em' }}>
              {restaurant?.name || 'Restaurant Workspace'}
            </h1>
            <span
              className={`badge ${
                payrollData?.period?.status === 'FINALIZED'
                  ? 'badge-success'
                  : payrollData?.period?.isStale
                  ? 'badge-warning'
                  : 'badge-info'
              }`}
            >
              {payrollData?.period?.status === 'FINALIZED'
                ? 'Payroll Finalized'
                : payrollData?.period?.isStale
                ? 'Recalculation Required'
                : 'Active Month: September 2026'}
            </span>
          </div>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', marginTop: '0.25rem' }}>
            Operating in {restaurant?.timezone || 'UTC'} · Currency: {currency} · Threshold:{' '}
            {warningsData?.threshold || 3} warnings/month
          </p>
        </div>

        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <Link to={`/restaurants/${restaurantId}/attendance`} className="btn btn-secondary">
            <Clock size={16} />
            <span>Today's Attendance</span>
          </Link>
          <Link to={`/restaurants/${restaurantId}/payroll`} className="btn btn-primary">
            <FileSpreadsheet size={16} />
            <span>Review Payroll</span>
          </Link>
        </div>
      </div>

      {/* Debt Before Overtime Callout */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: '0.75rem',
          padding: '1rem 1.25rem',
          backgroundColor: '#f0fdf4',
          border: '1px solid #bbf7d0',
          borderRadius: 'var(--radius-lg)',
          marginBottom: '1.75rem',
        }}
      >
        <Scale size={20} style={{ color: '#15803d', marginTop: '0.1rem', flexShrink: 0 }} />
        <div>
          <div style={{ fontSize: '0.875rem', fontWeight: 600, color: '#14532d' }}>
            Debt Before Overtime Policy Enforced
          </div>
          <div style={{ fontSize: '0.8125rem', color: '#166534', marginTop: '0.15rem' }}>
            Additional hours worked clear outstanding working-hour debt before any remaining time becomes payable overtime.
            Recovered minutes are calculated automatically from previous and current shortfalls.
          </div>
        </div>
      </div>

      {/* Operational Metrics Cards */}
      <div className="grid-4" style={{ marginBottom: '2rem' }}>
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-muted)' }}>Active Workforce</span>
            <Users size={18} style={{ color: 'var(--primary)' }} />
          </div>
          <div className="tabular-nums" style={{ fontSize: '2rem', fontWeight: 700, marginTop: '0.5rem' }}>
            {activeEmployees.length}
          </div>
          <Link
            to={`/restaurants/${restaurantId}/employees`}
            style={{ fontSize: '0.75rem', color: 'var(--primary)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '0.25rem', marginTop: '0.5rem' }}
          >
            <span>View employee rosters</span>
            <ArrowRight size={12} />
          </Link>
        </div>

        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-muted)' }}>Provisional Overtime</span>
            <TrendingUp size={18} style={{ color: 'var(--accent)' }} />
          </div>
          <div className="tabular-nums" style={{ fontSize: '2rem', fontWeight: 700, marginTop: '0.5rem' }}>
            {currency} {Number(payrollData?.summary?.totalOvertimePay || 0).toFixed(decimals)}
          </div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.5rem' }}>
            Net payable: {currency} {Number(payrollData?.summary?.totalNetPayable || 0).toFixed(decimals)}
          </div>
        </div>

        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-muted)' }}>Outstanding Debt</span>
            <Scale size={18} style={{ color: '#b45309' }} />
          </div>
          <div className="tabular-nums" style={{ fontSize: '2rem', fontWeight: 700, marginTop: '0.5rem' }}>
            {totalOutstandingDebt} <span style={{ fontSize: '1rem', fontWeight: 500 }}>mins</span>
          </div>
          <Link
            to={`/restaurants/${restaurantId}/debt`}
            style={{ fontSize: '0.75rem', color: '#b45309', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '0.25rem', marginTop: '0.5rem' }}
          >
            <span>Debt recovery & waivers</span>
            <ArrowRight size={12} />
          </Link>
        </div>

        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-muted)' }}>Warning Limits</span>
            <AlertTriangle size={18} style={{ color: 'var(--status-danger)' }} />
          </div>
          <div className="tabular-nums" style={{ fontSize: '2rem', fontWeight: 700, marginTop: '0.5rem' }}>
            {limitReachedCount > 0 ? (
              <span className="warning-dot-limit" style={{ fontSize: '1.25rem', padding: '0.25rem 0.75rem' }}>
                {limitReachedCount} Staff Reached Limit
              </span>
            ) : (
              <span style={{ color: 'var(--status-success)', fontSize: '1.5rem' }}>No Limits Hit</span>
            )}
          </div>
          <Link
            to={`/restaurants/${restaurantId}/warnings`}
            style={{ fontSize: '0.75rem', color: 'var(--status-danger)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '0.25rem', marginTop: '0.5rem' }}
          >
            <span>Review warnings breakdown</span>
            <ArrowRight size={12} />
          </Link>
        </div>
      </div>

      {/* Quick Access Grid */}
      <h2 style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: '1rem' }}>Operational Workflows</h2>
      <div className="grid-3" style={{ marginBottom: '2rem' }}>
        <Link
          to={`/restaurants/${restaurantId}/scheduling`}
          className="card"
          style={{ textDecoration: 'none', color: 'inherit', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--primary)' }}>
            <CalendarDays size={20} />
            <h3 style={{ fontSize: '1rem', fontWeight: 600 }}>Bulk Scheduling Grid</h3>
          </div>
          <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
            Assign morning, evening, or split shifts across days with template auto-fill and conflict preview.
          </p>
        </Link>

        <Link
          to={`/restaurants/${restaurantId}/attendance`}
          className="card"
          style={{ textDecoration: 'none', color: 'inherit', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--accent)' }}>
            <Clock size={20} />
            <h3 style={{ fontSize: '1rem', fontWeight: 600 }}>Daily Attendance Register</h3>
          </div>
          <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
            Record check-in/out, evaluate lateness with grace period rules, and approve extra working time.
          </p>
        </Link>

        <Link
          to={`/restaurants/${restaurantId}/payroll`}
          className="card"
          style={{ textDecoration: 'none', color: 'inherit', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--status-success)' }}>
            <FileSpreadsheet size={20} />
            <h3 style={{ fontSize: '1rem', fontWeight: 600 }}>Monthly Payroll & Finalization</h3>
          </div>
          <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
            Authoritative calculation runs, blocker resolution, period lock, and Excel (.xlsx) statement download.
          </p>
        </Link>
      </div>
    </div>
  );
};
