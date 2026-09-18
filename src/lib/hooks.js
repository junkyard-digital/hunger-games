import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { isGamemakerSession, restoreSession } from './supabaseClient';

/** Wraps an async action with busy + error state. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}

/** Redirects to login unless signed in as a gamemaker. Returns the session once confirmed. */
export function useGamemakerSession() {
  const navigate = useNavigate();
  const [session, setSession] = useState(null);
  useEffect(() => {
    restoreSession().then((s) => (isGamemakerSession(s) ? setSession(s) : navigate('/gm/login', { replace: true })));
  }, [navigate]);
  return session;
}

export function secondsAgo(ts, nowMs) {
  if (!ts) return null;
  return Math.max(0, Math.round((nowMs - new Date(ts).getTime()) / 1000));
}
