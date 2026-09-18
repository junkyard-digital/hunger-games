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
  const session = await getSession();
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
