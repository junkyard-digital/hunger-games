import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import GameMap from '../components/GameMap';
import { EventFeed, ErrorText, Loading } from '../components/ui';
import { ensureAnonymousSession, supabase } from '../lib/supabaseClient';
import { stormAt } from '../lib/storm';
import { formatClock } from '../lib/geo';

const SPEEDS = [1, 5, 15, 30, 60];

async function fetchAll(query) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await query().range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

export default function Replay() {
  const { gameId } = useParams();
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(15);
  const [hideLabels, setHideLabels] = useState(false);
  const last = useRef(null);

  useEffect(() => {
    (async () => {
      try {
        await ensureAnonymousSession();
        const [{ data: game }, { data: teams }, { data: players }] = await Promise.all([
          supabase.from('games').select('*').eq('id', gameId).maybeSingle(),
          supabase.from('teams').select('*').eq('game_id', gameId),
          supabase.from('players').select('*').eq('game_id', gameId),
        ]);
        if (!game?.started_at) throw new Error('Replay is available once the game has started (for gamemakers and spectators).');
        const [history, events] = await Promise.all([
          fetchAll(() => supabase.from('location_history').select('player_id, lng, lat, recorded_at').eq('game_id', gameId).order('recorded_at')),
          fetchAll(() => supabase.from('events').select('*').eq('game_id', gameId).order('id')),
        ]);
        const start = new Date(game.started_at).getTime();
        const end = new Date(game.ended_at ?? Date.now()).getTime();
        const tracks = {};
        for (const h of history) (tracks[h.player_id] ??= []).push({ t: (new Date(h.recorded_at).getTime() - start) / 1000, lng: h.lng, lat: h.lat });
        setState({ game, teams: Object.fromEntries(teams.map((x) => [x.id, x])), players, tracks, events, start, duration: (end - start) / 1000 });
      } catch (e) {
        setError(e.message);
      }
    })();
  }, [gameId]);

  useEffect(() => {
    if (!playing) return;
    let frame;
    const step = (ts) => {
      if (last.current != null) {
        setT((prev) => {
          const next = prev + ((ts - last.current) / 1000) * speed;
          if (next >= state.duration) {
            setPlaying(false);
            return state.duration;
          }
          return next;
        });
      }
      last.current = ts;
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
      last.current = null;
    };
  }, [playing, speed, state]);

  const view = useMemo(() => {
    if (!state) return null;
    const at = state.start + t * 1000;
    const mapPlayers = state.players.map((p) => {
      const track = state.tracks[p.id] ?? [];
      const pos = lastBefore(track, t);
      const dead = p.died_at && new Date(p.died_at).getTime() <= at;
      return { id: p.id, name: p.name, lng: pos?.lng, lat: pos?.lat, color: state.teams[p.team_id]?.color ?? '#94a3b8', dim: dead };
    });
    const events = state.events.filter((e) => new Date(e.created_at).getTime() <= at);
    const alive = state.players.filter((p) => p.status !== 'removed' && !(p.died_at && new Date(p.died_at).getTime() <= at)).length;
    return { mapPlayers, storm: stormAt(state.game.storm, t), events, alive };
  }, [state, t]);

  if (error) return <main className="page narrow"><ErrorText error={error} /><Link to="/">Home</Link></main>;
  if (!state) return <Loading label="Loading replay…" />;

  return (
    <div className="dashboard">
      <header className="dash-header row-between">
        <div>
          <p className="muted small">Replay</p>
          <h1>{state.game.name}</h1>
        </div>
        <div className="hud-alive"><span className="alive-num">{view.alive}</span><span className="alive-label">ALIVE</span></div>
      </header>
      <div className="watch-body">
        <div className="live-map">
          <GameMap playArea={state.game.config.playArea} storm={view.storm} players={view.mapPlayers} hideLabels={hideLabels} />
        </div>
        <aside className="watch-feed"><EventFeed events={view.events} limit={30} hideTypes={['joined', 'chest_public']} /></aside>
      </div>
      <footer className="replay-bar">
        <button className="btn" onClick={() => { if (t >= state.duration) setT(0); setPlaying(!playing); }}>{playing ? 'Pause' : 'Play'}</button>
        <input type="range" min={0} max={state.duration} step={1} value={t} onChange={(e) => setT(Number(e.target.value))} />
        <span className="mono small">{formatClock(t)} / {formatClock(state.duration)}</span>
        <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
          {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
        </select>
        <label className="inline-check" title="Hides player names and every street and place name, for sharing">
          <input type="checkbox" checked={hideLabels} onChange={(e) => setHideLabels(e.target.checked)} />
          Hide names
        </label>
      </footer>
    </div>
  );
}

function lastBefore(track, t) {
  let lo = 0, hi = track.length - 1, found = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (track[mid].t <= t) {
      found = track[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}
