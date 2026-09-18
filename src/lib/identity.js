import { clearCookie, getCookie, setCookie } from './supabaseClient';

// A player's way back in: the game code plus their rejoin code. Kept in localStorage *and* a cookie,
// so losing one still leaves the other. With it, a phone that lost its session rejoins silently
// instead of asking the player who they are again.

const key = (gameId) => `hg:player:${gameId}`;
const COOKIE = 'hg_player';

export function rememberPlayer(gameId, code, rejoinCode) {
  if (!gameId || !code || !rejoinCode) return;
  const value = JSON.stringify({ gameId, code, rejoinCode });
  try {
    localStorage.setItem(key(gameId), value);
  } catch {
    // private mode or storage full: the cookie below still covers us
  }
  setCookie(COOKIE, value);
}

/** Looks up a saved way back in, by game id or by game code. */
export function recallPlayer({ gameId, code } = {}) {
  const candidates = [];
  try {
    if (gameId) candidates.push(localStorage.getItem(key(gameId)));
    if (!gameId) {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith('hg:player:')) candidates.push(localStorage.getItem(k));
      }
    }
  } catch {
    // ignore unreadable storage
  }
  candidates.push(getCookie(COOKIE));

  for (const raw of candidates) {
    if (!raw) continue;
    try {
      const saved = JSON.parse(raw);
      if (gameId && saved.gameId !== gameId) continue;
      if (code && saved.code?.toUpperCase() !== code.toUpperCase()) continue;
      return saved;
    } catch {
      // malformed entry, try the next one
    }
  }
  return null;
}

export function forgetPlayer(gameId) {
  try {
    localStorage.removeItem(key(gameId));
  } catch {
    // ignore
  }
  const saved = recallPlayer({ gameId });
  if (saved) clearCookie(COOKIE);
}
