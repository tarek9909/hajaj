import React, { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { authApi } from '../lib/api';
import { Alert } from '../components/ui';
import { errorMessage } from '../lib/format';

type Mode = 'forgot' | 'reset' | 'setup';

const COPY: Record<Mode, { title: string; lede: string; cta: string }> = {
  forgot: { title: 'Reset your password', lede: 'Enter your email and we will issue a reset link.', cta: 'Send reset link' },
  reset: { title: 'Choose a new password', lede: 'Use at least 8 characters. You will be signed out everywhere.', cta: 'Update password' },
  setup: { title: 'Set up your account', lede: 'Create a password to activate your administrator account.', cta: 'Activate account' },
};

export const AccountTokenPage: React.FC<{ mode: Mode }> = ({ mode }) => {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [devLink, setDevLink] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const copy = COPY[mode];
  const missingToken = mode !== 'forgot' && !token;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (mode !== 'forgot') {
      if (password.length < 8) return setError('Password must be at least 8 characters.');
      if (password !== confirm) return setError('Passwords do not match.');
    }
    setSubmitting(true);
    try {
      if (mode === 'forgot') {
        const res: any = await authApi.requestPasswordReset(email.trim());
        setNotice(res.message);
        // Non-production servers hand back the link so the flow is testable without email
        if (res.resetPath) setDevLink(res.resetPath);
      } else {
        const res = mode === 'reset' ? await authApi.completePasswordReset(token, password) : await authApi.setupPassword(token, password);
        setNotice(res.message);
        setTimeout(() => navigate('/login', { replace: true }), 1800);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-shell auth-shell-single">
      <main className="auth-panel">
        <div className="auth-card">
          <Link to="/login" className="auth-link row" style={{ gap: '0.35rem', marginBottom: '1.25rem' }}>
            <ArrowLeft size={14} /> Back to sign in
          </Link>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 650, letterSpacing: '-0.025em' }}>{copy.title}</h2>
          <p className="text-muted" style={{ fontSize: '0.9rem', margin: '0.35rem 0 1.5rem' }}>{copy.lede}</p>

          {missingToken && <Alert tone="danger">This link is missing its token. Request a new one.</Alert>}
          {error && <Alert tone="danger">{error}</Alert>}
          {notice && <Alert tone="success">{notice}</Alert>}
          {devLink && (
            <Alert tone="info">
              Development mode: <Link to={devLink} className="auth-link">open the reset link</Link>
            </Alert>
          )}

          {!notice || mode === 'forgot' ? (
            <form onSubmit={submit}>
              {mode === 'forgot' ? (
                <div className="form-group">
                  <label className="form-label" htmlFor="email">Email</label>
                  <input id="email" type="email" className="input" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} />
                </div>
              ) : (
                <>
                  <div className="form-group">
                    <label className="form-label" htmlFor="pw">New password</label>
                    <input id="pw" type="password" className="input" autoComplete="new-password" autoFocus required value={password} onChange={(e) => setPassword(e.target.value)} />
                  </div>
                  <div className="form-group">
                    <label className="form-label" htmlFor="pw2">Confirm password</label>
                    <input id="pw2" type="password" className="input" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
                  </div>
                </>
              )}
              <button type="submit" className="btn btn-primary btn-lg" disabled={submitting || missingToken} style={{ width: '100%' }}>
                {submitting ? 'Please wait…' : copy.cta}
              </button>
            </form>
          ) : null}
        </div>
      </main>
    </div>
  );
};
