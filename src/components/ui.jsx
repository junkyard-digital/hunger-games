import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabaseClient';

/** Live in-app alerts from the notifications table (the same rows that become push notifications). */
export function NotificationToasts({ userId, gameId }) {
  const [toasts, setToasts] = useState([]);
  const startedAt = useRef(new Date().toISOString());

  useEffect(() => {
    if (!userId) return;
    const channel = supabase
      .channel(`notifications:${userId}:${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${userId}` },
        ({ new: n }) => {
          if (gameId && n.game_id !== gameId) return;
          if (n.created_at < startedAt.current) return;
          setToasts((prev) => [...prev.slice(-3), n]);
          navigator.vibrate?.(n.kind === 'storm' || n.kind === 'death' ? [200, 100, 200] : 120);
          setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== n.id)), n.kind === 'storm' ? 8000 : 6000);
        })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId, gameId]);

  return <Toasts toasts={toasts} onDismiss={(id) => setToasts((prev) => prev.filter((t) => t.id !== id))} />;
}

export function Toasts({ toasts, onDismiss }) {
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <button key={t.id} className={`toast toast-${t.kind ?? 'info'}`} onClick={() => onDismiss(t.id)}>
          <span>
            <strong>{t.title}</strong>
            <span className="toast-body">{t.body}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

export function EventFeed({ events, limit, hideTypes = [] }) {
  const list = events.filter((e) => !hideTypes.includes(e.type)).slice(limit ? -limit : undefined).reverse();
  if (!list.length) return <p className="muted">Nothing yet.</p>;
  return (
    <ul className="feed">
      {list.map((e) => (
        <li key={e.id} className={`feed-item feed-${e.type}`}>
          <span className="feed-msg">{e.message}</span>
          <time>{new Date(e.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>
        </li>
      ))}
    </ul>
  );
}

/** Errors appear as a red bar pinned to the bottom of the screen, and fade out on their own. */
export function ErrorText({ error }) {
  const [dismissed, setDismissed] = useState(null);
  const shown = error && error !== dismissed ? error : null;
  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(() => setDismissed(shown), 8000);
    return () => clearTimeout(timer);
  }, [shown]);

  if (!shown) return null;
  return (
    <p className="error" role="alert">
      {shown}
      <button type="button" className="error-close" onClick={() => setDismissed(shown)} aria-label="Dismiss">Dismiss</button>
    </p>
  );
}

export function Loading({ label = 'Loading…' }) {
  return <div className="center-screen"><p>{label}</p></div>;
}

export function Modal({ title, onClose, children }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}
