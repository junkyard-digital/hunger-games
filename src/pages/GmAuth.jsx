import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { functionsUrl, GM_EMAIL_DOMAIN, isGamemakerSession, restoreSession, supabase } from '../lib/supabaseClient';
import { ErrorText } from '../components/ui';
import { useAction } from '../lib/hooks';

export default function GmAuth() {
  const navigate = useNavigate();
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [signupCode, setSignupCode] = useState('');
  const [anonWarning, setAnonWarning] = useState(false);
  const { busy, error, run } = useAction();

  useEffect(() => {
    restoreSession().then((s) => {
      if (isGamemakerSession(s)) navigate('/gm', { replace: true });
      else if (s) setAnonWarning(true);
    });
  }, [navigate]);

  const submit = () => run(async () => {
    const name = username.trim().toLowerCase();
    if (mode === 'signup') {
      const res = await fetch(`${functionsUrl}/gm-signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: name, password, signupCode: signupCode || undefined }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Signup failed');
    }
    const { error: loginError } = await supabase.auth.signInWithPassword({ email: `${name}@${GM_EMAIL_DOMAIN}`, password });
    if (loginError) throw new Error(loginError.message === 'Invalid login credentials' ? 'Wrong username or password' : loginError.message);
    navigate('/gm', { replace: true });
  });

  return (
    <main className="page narrow">
      <form className="card" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <h1>{mode === 'login' ? 'Gamemaker login' : 'Create gamemaker account'}</h1>
        {anonWarning && (
          <p className="warn">This device is currently a player. Logging in as a gamemaker will sign that player out on this device (use their rejoin code to get back).</p>
        )}
        <label>Username
          <input id="gm-username" name="username" value={username} onChange={(e) => setUsername(e.target.value)} autoCapitalize="none" autoComplete="username" required />
        </label>
        <label>Password
          <span className="password-field">
            <input id="gm-password" name="password" type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={8} required />
            <button type="button" className="eye-btn" onClick={() => setShowPassword(!showPassword)}
              aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword}>
              <EyeIcon open={!showPassword} />
            </button>
          </span>
        </label>
        {mode === 'signup' && (
          <label>Signup code <span className="muted small">(only if your server requires one)</span>
            <input id="gm-signup-code" name="signupCode" value={signupCode} onChange={(e) => setSignupCode(e.target.value)} autoCapitalize="none" />
          </label>
        )}
        <button className="btn primary block" disabled={busy}>{busy ? '…' : mode === 'login' ? 'Log in' : 'Create account'}</button>
        <ErrorText error={error} />
        <button type="button" className="link-btn" onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}>
          {mode === 'login' ? 'New gamemaker? Create an account' : 'Have an account? Log in'}
        </button>
      </form>
      <p className="center"><Link to="/">← Player home</Link></p>
    </main>
  );
}

function EyeIcon({ open }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
      {!open && <line x1="3" y1="3" x2="21" y2="21" />}
    </svg>
  );
}
