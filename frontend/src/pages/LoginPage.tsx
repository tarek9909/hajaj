import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { ShieldCheck, Utensils, KeyRound, AlertCircle } from 'lucide-react';

export const LoginPage: React.FC = () => {
  const { login } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState('superadmin@workforce.local');
  const [password, setPassword] = useState('SuperAdminPassword123!');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      navigate('/');
    } catch (err: any) {
      setError(err.message || 'Login failed. Please verify credentials.');
    } finally {
      setSubmitting(false);
    }
  };

  const setDemoUser = (userEmail: string, userPass: string) => {
    setEmail(userEmail);
    setPassword(userPass);
    setError(null);
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#0f172a',
        padding: '1.5rem',
      }}
    >
      <div
        className="card"
        style={{
          width: '100%',
          maxWidth: '440px',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.4)',
          border: '1px solid #1e293b',
          backgroundColor: '#1e293b',
          color: '#f8fafc',
        }}
      >
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: 12,
              backgroundColor: 'var(--primary)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fff',
              marginBottom: '1rem',
            }}
          >
            <Utensils size={24} />
          </div>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 700, color: '#f8fafc', letterSpacing: '-0.02em' }}>
            WorkforceOS
          </h1>
          <p style={{ fontSize: '0.875rem', color: '#94a3b8', marginTop: '0.35rem' }}>
            Restaurant Workforce & Operational Payroll Platform
          </p>
        </div>

        {error && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.75rem',
              backgroundColor: 'rgba(239, 68, 68, 0.15)',
              border: '1px solid #ef4444',
              borderRadius: 'var(--radius-md)',
              color: '#fca5a5',
              fontSize: '0.8125rem',
              marginBottom: '1.25rem',
            }}
          >
            <AlertCircle size={16} style={{ flexShrink: 0 }} />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label" style={{ color: '#cbd5e1' }}>
              Email Address
            </label>
            <input
              type="email"
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              style={{ backgroundColor: '#0f172a', borderColor: '#334155', color: '#fff' }}
            />
          </div>

          <div className="form-group">
            <label className="form-label" style={{ color: '#cbd5e1' }}>
              Password
            </label>
            <input
              type="password"
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              style={{ backgroundColor: '#0f172a', borderColor: '#334155', color: '#fff' }}
            />
          </div>

          <button
            type="submit"
            className="btn btn-primary btn-lg"
            disabled={submitting}
            style={{ width: '100%', marginTop: '0.5rem' }}
          >
            <KeyRound size={18} />
            <span>{submitting ? 'Authenticating...' : 'Sign In to Workspace'}</span>
          </button>
        </form>

        <div style={{ marginTop: '2rem', paddingTop: '1.5rem', borderTop: '1px solid #334155' }}>
          <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.75rem', textAlign: 'center' }}>
            Quick Demo Login Switches:
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setDemoUser('superadmin@workforce.local', 'SuperAdminPassword123!')}
              style={{ justifyContent: 'flex-start', backgroundColor: '#0f172a', borderColor: '#334155', color: '#38bdf8' }}
            >
              <ShieldCheck size={14} />
              <span>Platform Superadmin</span>
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setDemoUser('admin.bistro@workforce.local', 'BistroAdmin123!')}
              style={{ justifyContent: 'flex-start', backgroundColor: '#0f172a', borderColor: '#334155', color: '#a7f3d0' }}
            >
              <Utensils size={14} />
              <span>The Grand Bistro GM (Julian Vance)</span>
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setDemoUser('admin.spice@workforce.local', 'SpiceAdmin123!')}
              style={{ justifyContent: 'flex-start', backgroundColor: '#0f172a', borderColor: '#334155', color: '#fde68a' }}
            >
              <Utensils size={14} />
              <span>Spice Garden GM (Tariq Al-Mansoor)</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
