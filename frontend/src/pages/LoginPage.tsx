import React, { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { ArrowRight, Clock, Scale, ShieldCheck, FileSpreadsheet } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { Alert } from '../components/ui';
import { errorMessage } from '../lib/format';

const DEMO_USERS = [
  { label: 'Platform superadmin', email: 'superadmin@workforce.local', password: 'SuperAdminPassword123!' },
  { label: 'Grand Bistro admin', email: 'admin.bistro@workforce.local', password: 'BistroAdmin123!' },
  { label: 'Spice Garden admin', email: 'admin.spice@workforce.local', password: 'SpiceAdmin123!' },
];

const HIGHLIGHTS = [
  { icon: Clock, title: 'Attendance that explains itself', text: 'Lateness, grace periods and warnings are calculated from the clock, not from memory.' },
  { icon: Scale, title: 'Debt before overtime', text: 'Missed hours are recovered first, so overtime is only ever paid when it is truly extra.' },
  { icon: FileSpreadsheet, title: 'Payroll you can defend', text: 'Immutable monthly snapshots, a full audit trail and one-click Excel statements.' },
];

export const LoginPage: React.FC = () => {
  const { user, isLoading, login } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!isLoading && user) return <Navigate to="/" replace />;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email.trim(), password);
      navigate('/', { replace: true });
    } catch (err) {
      setError(errorMessage(err, 'Sign-in failed. Check your email and password.'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-shell">
      <aside className="auth-hero">
        <div className="row" style={{ gap: '0.7rem' }}>
          <div className="brand-mark" style={{ width: 36, height: 36, fontSize: 18 }}>W</div>
          <span style={{ fontWeight: 650, fontSize: '1.05rem', letterSpacing: '-0.02em' }}>WorkforceOS</span>
        </div>

        <div>
          <h1 className="auth-headline">Run your restaurant team with calm, exact numbers.</h1>
          <p className="auth-lede">Scheduling, attendance and payroll in one place, built around how restaurants really work.</p>
          <ul className="auth-points">
            {HIGHLIGHTS.map((h) => (
              <li key={h.title}>
                <div className="auth-point-icon"><h.icon size={16} /></div>
                <div>
                  <strong>{h.title}</strong>
                  <span>{h.text}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="auth-foot">Secure sessions · Audit-logged changes · Tenant-isolated data</div>
      </aside>

      <main className="auth-panel">
        <div className="auth-card">
          <h2 style={{ fontSize: '1.5rem', fontWeight: 650, letterSpacing: '-0.025em' }}>Welcome back</h2>
          <p className="text-muted" style={{ fontSize: '0.9rem', margin: '0.35rem 0 1.5rem' }}>
            Sign in to your workspace.
          </p>

          {error && <Alert tone="danger">{error}</Alert>}

          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label className="form-label" htmlFor="email">Email</label>
              <input
                id="email"
                type="email"
                className="input"
                autoComplete="username"
                autoFocus
                placeholder="you@restaurant.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>

            <div className="form-group">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <label className="form-label" htmlFor="password">Password</label>
                <Link to="/forgot-password" className="auth-link">Forgot password?</Link>
              </div>
              <input
                id="password"
                type="password"
                className="input"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>

            <button type="submit" className="btn btn-primary btn-lg" disabled={submitting} style={{ width: '100%', marginTop: '0.5rem' }}>
              <span>{submitting ? 'Signing in…' : 'Sign in'}</span>
              {!submitting && <ArrowRight size={16} />}
            </button>
          </form>

          {import.meta.env.DEV && (
            <div className="auth-demo">
              <div className="eyebrow row" style={{ gap: '0.4rem', marginBottom: '0.6rem' }}>
                <ShieldCheck size={12} /> Development accounts
              </div>
              <div className="row-wrap" style={{ gap: '0.4rem' }}>
                {DEMO_USERS.map((d) => (
                  <button
                    key={d.email}
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => {
                      setEmail(d.email);
                      setPassword(d.password);
                      setError(null);
                    }}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
};
