import { useEffect, useMemo, useState } from 'react';
import { supabase } from './supabaseClient';
import { stormAt } from './storm';

const byKey = (rows, key) => Object.fromEntries((rows ?? []).map((r) => [r[key], r]));

/**
 * Loads a game and keeps it live over Supabase Realtime. Row-level security decides what this
 * user can see (e.g. players only receive positions of teammates and revealed enemies).
 */
export function useGame(gameId) {
  const [game, setGame] = useState(null);
  const [teams, setTeams] = useState({});
  const [players, setPlayers] = useState({});
  const [states, setStates] = useState({});
  const [chests, setChests] = useState({});
  const [events, setEvents] = useState([]);
  const [inventory, setInventory] = useState({});
  const [reveals, setReveals] = useState({});
  const [error, setError] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!gameId) return;
    let cancelled = false;
    const eq = (q) => q.eq('game_id', gameId);

    async function load() {
      const [g, t, p, s, c, e, inv, rev] = await Promise.all([
        supabase.from('games').select('*').eq('id', gameId).maybeSingle(),
        eq(supabase.from('teams').select('*')).order('sort'),
        eq(supabase.from('players').select('*')),
        eq(supabase.from('player_state').select('*')),
        eq(supabase.from('chests').select('*')),
        eq(supabase.from('events').select('*')).order('id', { ascending: false }).limit(200),
        eq(supabase.from('inventory').select('*')),
        eq(supabase.from('reveals').select('*')),
      ]);
      if (cancelled) return;
      const failed = [g, t, p, s, c, e, inv, rev].find((r) => r.error);
      if (failed) return setError(failed.error.message);
      if (!g.data) return setError('Game not found (or you are not part of it).');
      setGame(g.data);
      setTeams(byKey(t.data, 'id'));
      setPlayers(byKey(p.data, 'id'));
      setStates(byKey(s.data, 'player_id'));
      setChests(byKey(c.data, 'id'));
      setEvents(e.data.reverse());
      setInventory(byKey(inv.data, 'id'));
      setReveals(byKey(rev.data, 'id'));
      setLoaded(true);
    }

    const upsert = (setter, key) => (payload) => {
      if (payload.eventType === 'DELETE') {
        const id = payload.old?.[key];
        setter((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
      } else {
        setter((prev) => ({ ...prev, [payload.new[key]]: payload.new }));
      }
    };
    const filter = `game_id=eq.${gameId}`;
    const channel = supabase
      .channel(`game:${gameId}:${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'games', filter: `id=eq.${gameId}` },
        (payload) => payload.new?.id && setGame(payload.new))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'teams', filter }, upsert(setTeams, 'id'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'players', filter }, upsert(setPlayers, 'id'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'player_state', filter }, upsert(setStates, 'player_id'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chests', filter }, upsert(setChests, 'id'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'inventory', filter }, upsert(setInventory, 'id'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'reveals', filter }, upsert(setReveals, 'id'))
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'events', filter },
        (payload) => setEvents((prev) => [...prev.slice(-199), payload.new]))
      .subscribe((status) => {
        // After a reconnect (e.g. phone slept), reload so nothing that happened meanwhile is missed.
        if (status === 'SUBSCRIBED') load();
      });

    const onVisible = () => document.visibilityState === 'visible' && setReloadKey((k) => k + 1);
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      supabase.removeChannel(channel);
    };
  }, [gameId, reloadKey]);

  return { game, teams, players, states, chests, events, inventory, reveals, error, loaded };
}

/** Server-synced clock: returns a function giving "now" in ms, corrected for this phone's clock drift. */
export function useServerClock() {
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const t0 = Date.now();
      const { data } = await supabase.rpc('server_now');
      const t1 = Date.now();
      if (!cancelled && data) setOffset(new Date(data).getTime() - (t0 + t1) / 2);
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return useMemo(() => () => Date.now() + offset, [offset]);
}

/** Re-renders every `ms` milliseconds and returns the current (server-corrected) time. */
export function useTicker(now, ms = 1000) {
  const [t, setT] = useState(now());
  useEffect(() => {
    const id = setInterval(() => setT(now()), ms);
    return () => clearInterval(id);
  }, [now, ms]);
  return t;
}

export function useStorm(game, nowMs) {
  return useMemo(() => {
    if (!game?.storm || !game.started_at) return null;
    const t = (Math.min(nowMs, game.ended_at ? new Date(game.ended_at).getTime() : Infinity)
      - new Date(game.started_at).getTime()) / 1000;
    return stormAt(game.storm, t);
  }, [game, nowMs]);
}

export const aliveCount = (players) => Object.values(players).filter((p) => p.status === 'alive').length;
