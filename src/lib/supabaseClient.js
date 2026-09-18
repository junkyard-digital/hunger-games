import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

export const supabase = createClient(supabaseUrl, supabasePublishableKey, {
  auth: { persistSession: true, autoRefreshToken: true },
  realtime: { params: { eventsPerSecond: 20 } },
});

export const functionsUrl = `${supabaseUrl}/functions/v1`;

// Gamemaker accounts are username + password; Supabase needs an email, so we map usernames onto a fixed domain.
export const GM_EMAIL_DOMAIN = 'gamemakers.hunger-games.local';

/** Calls an RPC and throws a readable Error on failure. */
export async function rpc(name, args) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message);
  return data;
}

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

/** Players and spectators get a silent anonymous account that stays on this device. */
export async function ensureAnonymousSession() {
  const session = await restoreSession();
  if (session) return session;
  const { data, error } = await supabase.auth.signInAnonymously();
  if (error) {
    // The one Supabase setting this app can't work without.
    if (error.code === 'anonymous_provider_disabled' || /anonymous/i.test(error.message)) {
      throw new Error('This game server has anonymous sign-ins turned off, so players can\'t join. '
        + 'A gamemaker needs to enable them in Supabase → Authentication → Sign In / Providers → Anonymous sign-ins.');
    }
    throw new Error(error.message);
  }
  return data.session;
}

export const isGamemakerSession = (session) => !!session && !session.user.is_anonymous;

// ───────────── staying signed in ─────────────
// Supabase keeps the session in localStorage. Phones (especially iOS home-screen apps) clear that
// more eagerly than you'd like, so the refresh token is mirrored into a long-lived cookie and the
// session is rebuilt from it when localStorage comes back empty.

const REFRESH_COOKIE = 'hg_refresh';

export function setCookie(name, value, days = 365) {
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${name}=${encodeURIComponent(value)}; Max-Age=${days * 86400}; Path=/; SameSite=Lax${secure}`;
}

export function getCookie(name) {
  const hit = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
}

export const clearCookie = (name) => setCookie(name, '', -1);

supabase.auth.onAuthStateChange((event, session) => {
  if (session?.refresh_token) setCookie(REFRESH_COOKIE, session.refresh_token);
  else if (event === 'SIGNED_OUT') clearCookie(REFRESH_COOKIE);
});

/** The session, rebuilt from the cookie if localStorage lost it. Use this instead of getSession(). */
export async function restoreSession() {
  const session = await getSession();
  if (session) return session;
  const refreshToken = getCookie(REFRESH_COOKIE);
  if (!refreshToken) return null;
  const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken });
  if (error || !data.session) {
    clearCookie(REFRESH_COOKIE);
    return null;
  }
  return data.session;
}
