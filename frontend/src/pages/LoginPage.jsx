import { useMemo, useState } from 'react';
import { fetchJson } from '../lib/api';

function Notice({ notice }) {
  if (!notice) {
    return null;
  }

  const className = notice.type === 'error' ? 'notice error' : notice.type === 'success' ? 'notice success' : 'notice';
  return <div className={className}>{notice.message}</div>;
}

export default function LoginPage({ onLogin }) {
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [notice, setNotice] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const title = useMemo(() => (mode === 'login' ? 'Login to MailPilot' : 'Create User Account'), [mode]);
  const subtitle = useMemo(
    () =>
      mode === 'login'
        ? 'Access campaigns from this login only. Admin can view all campaigns.'
        : 'Create a user account to manage only your own campaigns.',
    [mode]
  );

  async function handleSubmit(event) {
    event.preventDefault();
    setNotice(null);
    setIsSubmitting(true);

    try {
      if (mode === 'register') {
        const response = await fetchJson('/api/app-auth/register', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            email: String(email || '').trim().toLowerCase(),
            password: String(password || '')
          })
        });

        setNotice({ type: 'success', message: response.message || 'Account created. Please login now.' });
        setMode('login');
        setPassword('');
        return;
      }

      const result = await fetchJson('/api/app-auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          email: String(email || '').trim().toLowerCase(),
          password: String(password || '')
        })
      });

      onLogin({
        token: result.token,
        expiresAt: result.expiresAt || null,
        user: result.user
      });
    } catch (error) {
      setNotice({ type: 'error', message: error.message || 'Authentication failed.' });
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="auth-page">
      <section className="auth-card">
        <div className="auth-brand">MailPilot</div>
        <h1 className="auth-title">{title}</h1>
        <p className="auth-subtitle">{subtitle}</p>

        <form className="auth-form" onSubmit={handleSubmit}>
          <label htmlFor="auth-email">Email</label>
          <input
            id="auth-email"
            type="email"
            required
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@company.com"
          />

          <label htmlFor="auth-password">Password</label>
          <input
            id="auth-password"
            type="password"
            required
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Enter password"
          />

          <button className="btn btn-primary auth-submit" type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Please wait...' : mode === 'login' ? 'Login' : 'Create Account'}
          </button>
        </form>

        <div className="auth-switch-row">
          <button
            className="btn btn-secondary"
            type="button"
            onClick={() => {
              setMode((current) => (current === 'login' ? 'register' : 'login'));
              setNotice(null);
            }}
          >
            {mode === 'login' ? 'Create User Account' : 'Back to Login'}
          </button>
        </div>

        <Notice notice={notice} />
      </section>
    </div>
  );
}
