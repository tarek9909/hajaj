import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Users,
  CalendarDays,
  Clock,
  AlertTriangle,
  Scale,
  FileSpreadsheet,
  ArrowRight,
  Wallet,
  TrendingUp,
  CheckCircle2,
  RefreshCw,
  Lock,
  type LucideIcon,
} from 'lucide-react';
import { employeesApi, payrollApi, warningsApi } from '../lib/api';
import { formatMinutes, monthLabel } from '../lib/format';
import { usePeriod } from '../context/PeriodContext';
import { useRestaurant } from '../hooks/useRestaurant';
import { PageHeader, Stat, Skeleton } from '../components/ui';

interface Attention {
  tone: 'danger' | 'warning' | 'info';
  icon: LucideIcon;
  title: string;
  detail: string;
  to: string;
  cta: string;
}

export const RestaurantDashboardPage: React.FC = () => {
  const { restaurantId, restaurant, money } = useRestaurant();
  const { month } = usePeriod();
  const base = `/restaurants/${restaurantId}`;

  const employees = useQuery({
    queryKey: ['employees', restaurantId, 'ACTIVE'],
    queryFn: () => employeesApi.list(restaurantId, 'ACTIVE'),
  });
  const payroll = useQuery({
    queryKey: ['payroll-period', restaurantId, month],
    queryFn: () => payrollApi.getPeriodOverview(restaurantId, month),
  });
  const blockers = useQuery({
    queryKey: ['payroll-blockers', restaurantId, month],
    queryFn: () => payrollApi.getBlockers(restaurantId, month),
  });
  const warnings = useQuery({
    queryKey: ['warnings', restaurantId, month],
    queryFn: () => warningsApi.list(restaurantId, month),
  });

  const period = payroll.data?.period;
  const summary = payroll.data?.summary;
  const calculated = Boolean(period && period.currentCalculationRunId);
  const finalized = period?.status === 'FINALIZED';
  const limitReached = Object.values(warnings.data?.employeeWarningCounts ?? {}).filter((w) => w.limitReached).length;
  const blockerCount = blockers.data?.totalBlockersCount ?? 0;
  const loading = payroll.isLoading || employees.isLoading;

  const attention: Attention[] = [];
  if (!finalized && !calculated) {
    attention.push({
      tone: 'info', icon: RefreshCw, title: `${monthLabel(month)} has not been calculated`,
      detail: 'Run the payroll calculation to see totals, debt recovery and blockers.', to: `${base}/payroll`, cta: 'Open payroll',
    });
  } else if (!finalized && period?.isStale) {
    attention.push({
      tone: 'warning', icon: RefreshCw, title: 'Payroll is out of date',
      detail: 'Attendance, adjustments or policy changed since the last calculation.', to: `${base}/payroll`, cta: 'Recalculate',
    });
  }
  if (!finalized && blockerCount > 0) {
    attention.push({
      tone: 'danger', icon: AlertTriangle, title: `${blockerCount} issue${blockerCount === 1 ? '' : 's'} blocking finalization`,
      detail: (blockers.data?.affectedEmployees ?? []).slice(0, 3).map((a) => a.fullName).join(', ') || 'Review affected employees.',
      to: `${base}/payroll`, cta: 'Resolve',
    });
  }
  if (limitReached > 0) {
    attention.push({
      tone: 'danger', icon: AlertTriangle, title: `${limitReached} employee${limitReached === 1 ? ' has' : 's have'} reached the warning limit`,
      detail: `Threshold is ${warnings.data?.threshold ?? 3} counted warnings in a month.`, to: `${base}/warnings`, cta: 'Review warnings',
    });
  }
  if ((summary?.totalRemainingDebtMinutes ?? 0) > 0) {
    attention.push({
      tone: 'warning', icon: Scale, title: `${formatMinutes(summary!.totalRemainingDebtMinutes)} of hour debt still open`,
      detail: 'Extra hours will clear this before any overtime is paid.', to: `${base}/debt`, cta: 'View debt',
    });
  }

  const steps = [
    { label: 'Schedule', done: true, to: `${base}/scheduling`, icon: CalendarDays },
    { label: 'Attendance', done: calculated && blockerCount === 0, to: `${base}/attendance`, icon: Clock },
    { label: 'Calculate', done: calculated && !period?.isStale, to: `${base}/payroll`, icon: RefreshCw },
    { label: 'Finalize', done: finalized, to: `${base}/payroll`, icon: Lock },
  ];

  return (
    <div className="stack" style={{ gap: '1.5rem' }}>
      <PageHeader
        eyebrow={monthLabel(month)}
        title={restaurant?.name ?? 'Dashboard'}
        subtitle="Where this month stands and what needs you next."
        badge={
          finalized ? (
            <span className="badge badge-success"><Lock size={12} /> Finalized</span>
          ) : calculated ? (
            <span className={`badge ${period?.isStale ? 'badge-warning' : 'badge-info'}`}>{period?.isStale ? 'Needs recalculation' : 'Calculated'}</span>
          ) : (
            <span className="badge badge-neutral">Not calculated</span>
          )
        }
        actions={
          <>
            <Link to={`${base}/attendance`} className="btn btn-secondary"><Clock size={16} />Today's attendance</Link>
            <Link to={`${base}/payroll`} className="btn btn-primary"><FileSpreadsheet size={16} />Payroll</Link>
          </>
        }
      />

      <div className="grid-4">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => <div className="stat" key={i}><Skeleton width="45%" /><Skeleton height={28} width="70%" /><Skeleton width="55%" /></div>)
        ) : (
          <>
            <Stat label="Active staff" icon={Users} value={employees.data?.length ?? 0} foot={<Link to={`${base}/employees`} className="auth-link">View roster</Link>} />
            <Stat label="Net payable" icon={Wallet} accent value={calculated ? money(summary?.totalNetPayable) : '—'} foot={calculated ? `${summary?.totalEmployees ?? 0} employees in this run` : 'Awaiting calculation'} />
            <Stat label="Overtime pay" icon={TrendingUp} value={calculated ? money(summary?.totalOvertimePay) : '—'} foot="After hour debt is recovered" />
            <Stat
              label="Open hour debt"
              icon={Scale}
              tone={(summary?.totalRemainingDebtMinutes ?? 0) > 0 ? 'warning' : 'default'}
              value={calculated ? formatMinutes(summary?.totalRemainingDebtMinutes) : '—'}
              foot={calculated ? `${formatMinutes(summary?.totalRecoveredDebtMinutes)} recovered this month` : 'Awaiting calculation'}
            />
          </>
        )}
      </div>

      <div className="grid-aside">
        <section className="card card-flush">
          <div className="card-section-head">
            <div>
              <div className="card-title">Needs your attention</div>
              <div className="card-subtitle">{attention.length === 0 ? 'Nothing is blocking you.' : `${attention.length} item${attention.length === 1 ? '' : 's'} to review`}</div>
            </div>
          </div>
          {attention.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon" style={{ background: 'var(--status-success-bg)', color: 'var(--status-success)' }}><CheckCircle2 size={20} /></div>
              <h3>All clear</h3>
              <p>No blockers, stale calculations or warning limits for {monthLabel(month)}.</p>
            </div>
          ) : (
            <ul className="attention-list">
              {attention.map((a) => (
                <li key={a.title}>
                  <div className={`attention-icon attention-${a.tone}`}><a.icon size={16} /></div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{a.title}</div>
                    <div className="text-muted" style={{ fontSize: '0.8125rem', marginTop: '0.15rem' }}>{a.detail}</div>
                  </div>
                  <Link to={a.to} className="btn btn-secondary btn-sm">{a.cta}<ArrowRight size={13} /></Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <div className="card-title" style={{ marginBottom: '0.25rem' }}>Month workflow</div>
          <div className="card-subtitle" style={{ marginBottom: '1.1rem' }}>From roster to locked payroll</div>
          <ol className="steps">
            {steps.map((s, i) => (
              <li key={s.label} className={s.done ? 'done' : ''}>
                <Link to={s.to}>
                  <span className="step-dot">{s.done ? <CheckCircle2 size={16} /> : <s.icon size={14} />}</span>
                  <span className="step-label">{s.label}</span>
                  <span className="text-subtle" style={{ fontSize: '0.75rem' }}>{i + 1}/{steps.length}</span>
                </Link>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
};
