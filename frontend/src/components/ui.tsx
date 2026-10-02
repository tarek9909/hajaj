import React, { useEffect } from 'react';
import { AlertCircle, CheckCircle2, ChevronLeft, ChevronRight, Info, TriangleAlert, X, type LucideIcon } from 'lucide-react';
import { usePeriod } from '../context/PeriodContext';

export const PageHeader: React.FC<{
  title: string;
  subtitle?: React.ReactNode;
  eyebrow?: string;
  badge?: React.ReactNode;
  actions?: React.ReactNode;
}> = ({ title, subtitle, eyebrow, badge, actions }) => (
  <div className="page-header">
    <div>
      {eyebrow && <div className="eyebrow" style={{ marginBottom: '0.35rem' }}>{eyebrow}</div>}
      <div className="row-wrap" style={{ gap: '0.75rem' }}>
        <h1 className="page-title">{title}</h1>
        {badge}
      </div>
      {subtitle && <p className="page-subtitle">{subtitle}</p>}
    </div>
    {actions && <div className="page-actions">{actions}</div>}
  </div>
);

export const Stat: React.FC<{
  label: string;
  value: React.ReactNode;
  foot?: React.ReactNode;
  icon?: LucideIcon;
  accent?: boolean;
  tone?: 'default' | 'success' | 'danger' | 'warning';
}> = ({ label, value, foot, icon: Icon, accent, tone = 'default' }) => {
  const color =
    tone === 'success' ? 'var(--status-success)' : tone === 'danger' ? 'var(--status-danger)' : tone === 'warning' ? 'var(--status-warning)' : undefined;
  return (
    <div className={`stat ${accent ? 'stat-accent' : ''}`}>
      <div className="stat-label">
        <span>{label}</span>
        {Icon && <Icon size={16} style={{ color: 'var(--text-subtle)' }} />}
      </div>
      <div className="stat-value" style={color ? { color } : undefined}>{value}</div>
      {foot && <div className="stat-foot">{foot}</div>}
    </div>
  );
};

export const EmptyState: React.FC<{
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
}> = ({ icon: Icon = Info, title, description, action }) => (
  <div className="empty-state">
    <div className="empty-icon"><Icon size={20} /></div>
    <h3>{title}</h3>
    {description && <p>{description}</p>}
    {action}
  </div>
);

const ALERT_ICONS = { danger: AlertCircle, warning: TriangleAlert, success: CheckCircle2, info: Info } as const;

export const Alert: React.FC<{
  tone?: 'danger' | 'warning' | 'success' | 'info';
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ tone = 'info', children, style }) => {
  const Icon = ALERT_ICONS[tone];
  return (
    <div className={`alert alert-${tone}`} role={tone === 'danger' ? 'alert' : 'status'} style={style}>
      <Icon size={16} />
      <div>{children}</div>
    </div>
  );
};

export const Skeleton: React.FC<{ height?: number | string; width?: number | string }> = ({ height = 16, width = '100%' }) => (
  <div className="skeleton" style={{ height, width }} />
);

export const TableSkeleton: React.FC<{ rows?: number; cols: number }> = ({ rows = 5, cols }) => (
  <>
    {Array.from({ length: rows }).map((_, r) => (
      <tr key={r}>
        {Array.from({ length: cols }).map((__, c) => (
          <td key={c}><Skeleton height={14} width={c === 0 ? '70%' : '50%'} /></td>
        ))}
      </tr>
    ))}
  </>
);

export const Modal: React.FC<{
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  maxWidth?: number;
}> = ({ title, onClose, children, maxWidth }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-content"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={maxWidth ? { maxWidth } : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 className="modal-title">{title}</h2>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
};

/** Month stepper bound to the shared period context. */
export const PeriodPicker: React.FC = () => {
  const { label, shift, isCurrent, reset } = usePeriod();
  return (
    <div className="row" style={{ gap: '0.4rem' }}>
      <div className="period-picker">
        <button onClick={() => shift(-1)} aria-label="Previous month"><ChevronLeft size={16} /></button>
        <span className="period-label">{label}</span>
        <button onClick={() => shift(1)} aria-label="Next month"><ChevronRight size={16} /></button>
      </div>
      {!isCurrent && (
        <button className="btn btn-ghost btn-sm" onClick={reset}>Today</button>
      )}
    </div>
  );
};

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="page-container">
          <div className="card">
            <EmptyState
              icon={TriangleAlert}
              title="This screen hit a problem"
              description={this.state.error.message}
              action={<button className="btn btn-primary" onClick={() => window.location.reload()}>Reload</button>}
            />
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
