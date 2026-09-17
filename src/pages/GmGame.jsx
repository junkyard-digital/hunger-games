import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import QRCode from 'qrcode';
import { DndContext, PointerSensor, TouchSensor, useDraggable, useDroppable, useSensor, useSensors } from '@dnd-kit/core';
import GameMap from '../components/GameMap';
import { EventFeed, ErrorText, Loading, Modal, NotificationToasts } from '../components/ui';
import { secondsAgo, useAction, useGamemakerSession } from '../lib/hooks';
import { aliveCount, useGame, useServerClock, useStorm, useTicker } from '../lib/useGame';
import { usePushStatus } from '../lib/device';
import { buildStormPlan } from '../lib/storm';
import { formatClock } from '../lib/geo';
import { rpc, supabase } from '../lib/supabaseClient';

export default function GmGame() {
  const { gameId } = useParams();
  const session = useGamemakerSession();
  const data = useGame(session ? gameId : null);
  const [chosenTab, setTab] = useState(null);
  const { game, error } = data;
  const tab = chosenTab ?? (game?.status === 'lobby' ? 'Teams' : 'Map');

  if (error) return <main className="page narrow"><ErrorText error={error} /><Link to="/gm">Back</Link></main>;
  if (!session || !data.loaded) return <Loading />;

  const tabs = ['Map', 'Teams', 'Players', 'Feed', 'Message', 'Share'];
  return (
    <div className="dashboard">
      <NotificationToasts userId={session.user.id} gameId={gameId} />
      <GameHeader data={data} />
      <nav className="tabs">
        {tabs.map((t) => <button key={t} className={t === tab ? 'active' : ''} onClick={() => setTab(t)}>{t}</button>)}
      </nav>
      <div className="dashboard-body">
        {tab === 'Map' && <LiveMap data={data} controls />}
        {tab === 'Teams' && <TeamBoard data={data} />}
        {tab === 'Players' && <PlayerList data={data} />}
        {tab === 'Feed' && <div className="page"><EventFeed events={data.events} /></div>}
        {tab === 'Message' && <MessageForm data={data} />}
        {tab === 'Share' && <SharePanel game={game} />}
      </div>
    </div>
  );
}

function GameHeader({ data }) {
  const { game, players } = data;
  const now = useServerClock();
  const nowMs = useTicker(now);
  const storm = useStorm(game, nowMs);
  const { busy, error, run } = useAction();
  const [pushOn, enablePushNow] = usePushStatus();

  const start = () => run(async () => {
    const assigned = Object.values(players).filter((p) => p.status === 'alive');
    if (assigned.some((p) => !p.team_id) && !window.confirm('Some players have no team. Start anyway?')) return;
    await rpc('gm_start_game', { p_game: game.id, p_storm: buildStormPlan(game.config.storm, game.config.playArea) });
  });
  const end = () => run(async () => {
    if (window.confirm('End the game for everyone?')) await rpc('gm_end_game', { p_game: game.id });
  });

  return (
    <header className="dash-header">
      <div className="row-between">
        <div>
          <Link to="/gm" className="muted small">← Games</Link>
          <h1>{game.name}</h1>
          <p className="muted small">
            Code <strong className="mono">{game.code}</strong> · <span className={`status-tag ${game.status}`}>{game.status}</span>
            {game.status === 'active' && storm && <> · {storm.label} {storm.secondsLeft != null && formatClock(storm.secondsLeft)}</>}
          </p>
        </div>
        <div className="hud-alive"><span className="alive-num">{aliveCount(players)}</span><span className="alive-label">ALIVE</span></div>
      </div>
      <div className="button-row center-row">
        {game.status === 'lobby' && <button className="btn primary" disabled={busy} onClick={start}>Start game</button>}
        {game.status === 'active' && <button className="btn danger" disabled={busy} onClick={end}>End game</button>}
        {game.status !== 'lobby' && <Link className="btn" to={`/replay/${game.id}`}>Replay</Link>}
        {!pushOn && <button className="btn ghost" onClick={() => run(enablePushNow)}>Alerts</button>}
      </div>
      <ErrorText error={error} />
    </header>
  );
}

/** Live map for gamemakers and spectators. */
export function LiveMap({ data, controls }) {
  const { game, teams, players, states, chests } = data;
  const now = useServerClock();
  const nowMs = useTicker(now);
  const storm = useStorm(game, nowMs);
  const [selected, setSelected] = useState(null);

  const mapPlayers = Object.values(players).filter((p) => p.status !== 'removed').map((p) => {
    const s = states[p.id];
    return {
      id: p.id, name: p.name + (s?.is_dark && p.status === 'alive' ? ' (dark)' : ''), lng: s?.lng, lat: s?.lat,
      color: teams[p.team_id]?.color ?? '#94a3b8', dim: p.status !== 'alive' || s?.is_dark,
      ring: s?.storm_since && p.status === 'alive' ? '#a855f7' : s?.out_of_bounds ? '#f97316' : undefined,
    };
  });
  const chestList = Object.values(chests).map((c) => ({ id: c.id, lng: c.lng, lat: c.lat, claimed: !!c.claimed_by }));

  return (
    <div className="live-map">
      <GameMap playArea={game.config.playArea} storm={game.status === 'active' ? storm : null} players={mapPlayers}
        chests={chestList} onPlayerClick={controls ? setSelected : undefined} />
      <div className="map-legend small">
        <span><i className="ring purple" /> in storm</span><span><i className="ring orange" /> out of bounds</span><span>faded: no recent location</span>
      </div>
      {selected && players[selected] && <PlayerSheet data={data} player={players[selected]} nowMs={nowMs} onClose={() => setSelected(null)} />}
    </div>
  );
}

function PlayerSheet({ data, player, nowMs, onClose }) {
  const { teams, states, game, inventory } = data;
  const s = states[player.id];
  const { busy, error, run } = useAction();
  const [rejoinCode, setRejoinCode] = useState(null);
  const [message, setMessage] = useState('');
  const items = Object.values(inventory).filter((i) => i.player_id === player.id);

  const setStatus = (status) => run(async () => {
    const verb = { dead: 'Eliminate', removed: 'Remove', alive: 'Revive' }[status];
    if (window.confirm(`${verb} ${player.name}?`)) await rpc('gm_set_player_status', { p_player: player.id, p_status: status });
  });

  const loadCode = () => run(async () => {
    const { data: secret } = await supabase.from('player_secrets').select('rejoin_code').eq('player_id', player.id).maybeSingle();
    setRejoinCode(secret?.rejoin_code ?? 'n/a');
  });

  return (
    <Modal title={player.name} onClose={onClose}>
      <ul className="kv">
        <li><span>Status</span><strong>{player.status}{player.death_cause ? ` (${player.death_cause})` : ''}</strong></li>
        <li><span>Team</span>
          <select value={player.team_id ?? ''} disabled={busy}
            onChange={(e) => run(() => rpc('gm_set_team', { p_player: player.id, p_team: e.target.value || null }))}>
            <option value="">No team</option>
            {Object.values(teams).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </li>
        <li><span>Last location</span><span>{s?.last_seen ? `${secondsAgo(s.last_seen, nowMs)}s ago` : 'never'}{s?.accuracy ? ` · ±${Math.round(s.accuracy)}m` : ''}</span></li>
        <li><span>Flags</span><span>{[s?.is_dark && 'dark', s?.storm_since && 'in storm', s?.out_of_bounds && 'out of bounds'].filter(Boolean).join(' · ') || 'none'}</span></li>
        <li><span>Items</span><span>{items.length ? items.map((i) => `${i.prize?.label}${i.used_at ? ' (used)' : ''}`).join(', ') : 'none'}</span></li>
        <li><span>Rejoin code</span>{rejoinCode ? <strong className="mono">{rejoinCode}</strong> : <button className="btn small" onClick={loadCode}>Show</button>}</li>
      </ul>
      <div className="button-row">
        {player.status === 'alive' && <button className="btn danger" disabled={busy} onClick={() => setStatus('dead')}>Eliminate</button>}
        {player.status !== 'alive' && <button className="btn" disabled={busy} onClick={() => setStatus('alive')}>Revive</button>}
        {player.status !== 'removed' && <button className="btn ghost" disabled={busy} onClick={() => setStatus('removed')}>Remove</button>}
      </div>
      <form className="inline-form" onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          await rpc('gm_send_message', { p_game: game.id, p_target: 'player', p_target_id: player.id, p_title: 'Gamemaker', p_body: message });
          setMessage('');
        });
      }}>
        <input value={message} onChange={(e) => setMessage(e.target.value)} placeholder={`Message ${player.name}…`} maxLength={200} />
        <button className="btn" disabled={busy || !message.trim()}>Send</button>
      </form>
      <ErrorText error={error} />
    </Modal>
  );
}

// ───────────── Teams (drag & drop) ─────────────

const TEAM_COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#eab308', '#a855f7', '#f97316', '#14b8a6', '#ec4899'];

function TeamBoard({ data }) {
  const { game, teams, players } = data;
  const { busy, error, run } = useAction();
  const [optimistic, setOptimistic] = useState({});
  const [deleted, setDeleted] = useState([]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 120, tolerance: 8 } }),
  );

  const teamOf = (p) => (p.id in optimistic ? optimistic[p.id] : p.team_id);
  const list = Object.values(players).filter((p) => p.status !== 'removed').sort((a, b) => a.name.localeCompare(b.name));
  const teamList = Object.values(teams).filter((t) => !deleted.includes(t.id)).sort((a, b) => a.sort - b.sort);

  const move = (playerId, teamId) => {
    if (teamOf(players[playerId]) === teamId) return;
    setOptimistic((o) => ({ ...o, [playerId]: teamId }));
    run(async () => {
      try {
        await rpc('gm_set_team', { p_player: playerId, p_team: teamId });
      } finally {
        setOptimistic((o) => {
          const next = { ...o };
          delete next[playerId];
          return next;
        });
      }
    });
  };

  const autoBalance = () => run(async () => {
    if (!teamList.length) throw new Error('Add a team first.');
    const shuffled = [...list].sort(() => Math.random() - 0.5);
    await Promise.all(shuffled.map((p, i) => rpc('gm_set_team', { p_player: p.id, p_team: teamList[i % teamList.length].id })));
  });

  const deleteTeam = (team) => {
    if (!window.confirm(`Delete ${team.name}? Its players become unassigned.`)) return;
    setDeleted((d) => [...d, team.id]);
    run(async () => {
      try {
        await rpc('gm_delete_team', { p_team: team.id });
      } catch (e) {
        setDeleted((d) => d.filter((id) => id !== team.id));
        throw e;
      }
    });
  };

  const addTeam = () => run(() => rpc('gm_upsert_team', {
    p_game: game.id, p_team: null, p_name: `Team ${teamList.length + 1}`, p_color: TEAM_COLORS[teamList.length % TEAM_COLORS.length],
  }));

  return (
    <div className="page">
      <div className="button-row center-row">
        <button className="btn" onClick={addTeam} disabled={busy}>+ Team</button>
        <button className="btn" onClick={autoBalance} disabled={busy || !list.length}>Shuffle evenly</button>
      </div>
      <p className="muted small">Press and drag players between teams. {list.length} players.</p>
      <ErrorText error={error} />
      <DndContext sensors={sensors} onDragEnd={({ active, over }) => over && move(active.id, over.id === 'none' ? null : over.id)}>
        <div className="team-board">
          <TeamColumn id="none" title="No team" color="#475569" players={list.filter((p) => !teamOf(p))} />
          {teamList.map((t) => (
            <TeamColumn key={t.id} id={t.id} team={t} title={t.name} color={t.color} players={list.filter((p) => teamOf(p) === t.id)} run={run} onDelete={() => deleteTeam(t)} />
          ))}
        </div>
      </DndContext>
    </div>
  );
}

function TeamColumn({ id, team, title, color, players, run, onDelete }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(title);

  return (
    <div ref={setNodeRef} className={`team-col ${isOver ? 'over' : ''}`} style={{ '--team': color }}>
      <div className="team-col-head">
        {editing ? (
          <form className="inline-form" onSubmit={(e) => {
            e.preventDefault();
            run(() => rpc('gm_upsert_team', { p_game: team.game_id, p_team: team.id, p_name: name, p_color: team.color }));
            setEditing(false);
          }}>
            <input type="color" value={team.color} onChange={(e) => run(() => rpc('gm_upsert_team', { p_game: team.game_id, p_team: team.id, p_name: team.name, p_color: e.target.value }))} />
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={30} autoFocus />
            <button className="btn small">Save</button>
            <button type="button" className="icon-btn" title="Delete team" onClick={onDelete}>Delete</button>
          </form>
        ) : (
          <>
            <strong>{title}</strong>
            <span className="muted small">{players.length}</span>
            {team && <button className="icon-btn" onClick={() => { setName(team.name); setEditing(true); }}>Rename</button>}
          </>
        )}
      </div>
      <div className="team-col-body">
        {players.map((p) => <PlayerChip key={p.id} player={p} />)}
        {!players.length && <span className="muted small drop-hint">Drop players here</span>}
      </div>
    </div>
  );
}

function PlayerChip({ player }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: player.id });
  const style = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined;
  return (
    <div ref={setNodeRef} style={style} {...listeners} {...attributes} className={`player-chip ${player.status} ${isDragging ? 'dragging' : ''}`}>
      {player.status === 'dead' ? `${player.name} (out)` : player.name}
    </div>
  );
}

// ───────────── Players ─────────────

function PlayerList({ data }) {
  const { players, states, teams } = data;
  const now = useServerClock();
  const nowMs = useTicker(now);
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState('all');

  const list = useMemo(() => Object.values(players)
    .filter((p) => filter === 'all' || p.status === filter || (filter === 'alerts' && p.status === 'alive'
      && (states[p.id]?.is_dark || states[p.id]?.storm_since || states[p.id]?.out_of_bounds)))
    .sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === 'alive' ? -1 : 1)), [players, states, filter]);

  return (
    <div className="page">
      <div className="chip-row">
        {['all', 'alive', 'dead', 'removed', 'alerts'].map((f) => (
          <button key={f} className={`chip ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>{f}</button>
        ))}
      </div>
      <ul className="player-rows">
        {list.map((p) => {
          const s = states[p.id];
          const ago = secondsAgo(s?.last_seen, nowMs);
          return (
            <li key={p.id} onClick={() => setSelected(p.id)} className={p.status}>
              <span className="dot" style={{ background: teams[p.team_id]?.color ?? '#475569' }} />
              <span className="grow"><strong>{p.name}</strong> <span className="muted small">{teams[p.team_id]?.name ?? 'no team'}</span></span>
              <span className="small">
                {p.status !== 'alive' ? p.status : [s?.is_dark && 'dark', s?.storm_since && 'in storm', s?.out_of_bounds && 'out of bounds'].filter(Boolean).join(', ')}
              </span>
              <span className={`small mono ${ago > 15 ? 'stale' : 'muted'}`}>{ago != null ? `${ago}s` : '–'}</span>
            </li>
          );
        })}
      </ul>
      {selected && <PlayerSheet data={data} player={players[selected]} nowMs={nowMs} onClose={() => setSelected(null)} />}
    </div>
  );
}

// ───────────── Messages ─────────────

function MessageForm({ data }) {
  const { game, teams, players } = data;
  const [target, setTarget] = useState('all');
  const [targetId, setTargetId] = useState('');
  const [title, setTitle] = useState('Gamemaker');
  const [body, setBody] = useState('');
  const [sent, setSent] = useState(false);
  const { busy, error, run } = useAction();

  return (
    <form className="page narrow" onSubmit={(e) => {
      e.preventDefault();
      run(async () => {
        await rpc('gm_send_message', { p_game: game.id, p_target: target, p_target_id: target === 'all' ? null : targetId, p_title: title, p_body: body });
        setBody('');
        setSent(true);
        setTimeout(() => setSent(false), 2500);
      });
    }}>
      <h2>Send a notification</h2>
      <p className="muted small">Shows in the app and as a push notification for players who turned them on.</p>
      <div className="chip-row">
        {['all', 'team', 'player'].map((t) => (
          <button type="button" key={t} className={`chip ${target === t ? 'active' : ''}`} onClick={() => { setTarget(t); setTargetId(''); }}>{t}</button>
        ))}
      </div>
      {target === 'team' && (
        <select value={targetId} onChange={(e) => setTargetId(e.target.value)} required>
          <option value="">Choose team…</option>
          {Object.values(teams).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      )}
      {target === 'player' && (
        <select value={targetId} onChange={(e) => setTargetId(e.target.value)} required>
          <option value="">Choose player…</option>
          {Object.values(players).filter((p) => p.status !== 'removed').sort((a, b) => a.name.localeCompare(b.name))
            .map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      )}
      <label>Title<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={60} required /></label>
      <label>Message<textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} maxLength={300} required /></label>
      <button className="btn primary block" disabled={busy || (target !== 'all' && !targetId)}>{sent ? '✓ Sent' : 'Send'}</button>
      <ErrorText error={error} />
    </form>
  );
}

// ───────────── Share ─────────────

function SharePanel({ game }) {
  const origin = window.location.origin;
  const joinUrl = `${origin}/join/${game.code}`;
  const watchUrl = `${origin}/watch/${game.spectator_token}`;
  const [qr, setQr] = useState(null);
  const [copied, setCopied] = useState(null);

  useEffect(() => {
    QRCode.toDataURL(joinUrl, { width: 480, margin: 1 }).then(setQr);
  }, [joinUrl]);

  const copy = async (label, text) => {
    await navigator.clipboard?.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <div className="page narrow">
      <section className="card center">
        <h2>Players join here</h2>
        {qr && <img className="qr" src={qr} alt="Join QR code" />}
        <p className="big-code mono">{game.code}</p>
        <button className="btn block" onClick={() => copy('join', joinUrl)}>{copied === 'join' ? '✓ Copied' : 'Copy join link'}</button>
      </section>
      <section className="card">
        <h2>Spectator link</h2>
        <p className="muted small">Read-only live map with <strong>everyone's</strong> location. Don't share it with players.</p>
        <button className="btn block" onClick={() => copy('watch', watchUrl)}>{copied === 'watch' ? '✓ Copied' : 'Copy spectator link'}</button>
      </section>
      <section className="card">
        <h2>Add a co-gamemaker</h2>
        <p className="muted small">They log in as a gamemaker, then enter this code under "Join as co-gamemaker".</p>
        <p className="big-code mono">{game.gm_invite_code}</p>
      </section>
    </div>
  );
}
