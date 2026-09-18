import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import GameMap from '../components/GameMap';
import { EventFeed, ErrorText, Loading, Modal, NotificationToasts, Toasts } from '../components/ui';
import { useAction } from '../lib/hooks';
import { aliveCount, useGame, useServerClock, useStorm, useTicker } from '../lib/useGame';
import { isIOS, isStandalone, screenTimeoutHint, useGeolocationPermission, useLocationReporter, usePushStatus, useWakeLock } from '../lib/device';
import { rpc, supabase } from '../lib/supabaseClient';
import { distanceM, formatClock, formatDistance, nearestPointOnCircle } from '../lib/geo';
import { prizeInfo } from '../lib/prizes';

export default function Play() {
  const { gameId } = useParams();
  const [userId, setUserId] = useState(null);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setUserId(data.session?.user.id ?? null));
  }, []);

  const data = useGame(gameId);
  const now = useServerClock();
  const nowMs = useTicker(now, 1000);
  const { game, teams, players, states, chests, events, inventory, reveals, error, loaded } = data;
  const me = useMemo(() => Object.values(players).find((p) => p.user_id === userId), [players, userId]);
  const storm = useStorm(game, nowMs);

  const [setupDone, setSetupDone] = useState(() => localStorage.getItem('hg:setup') === '1');
  const [showBag, setShowBag] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [localToasts, setLocalToasts] = useState([]);

  const alive = me?.status === 'alive';
  // Dead players stop reporting: nothing left to track, and it saves their battery.
  const reporting = !!me && game?.status === 'active' && setupDone && me.status === 'alive';
  const intervalSec = game?.config?.rules?.locationIntervalSeconds ?? 3;
  const onClaimed = useCallback((prizes) => {
    const toasts = prizes.map((p, i) => ({ id: `chest-${Date.now()}-${i}`, kind: 'prize', title: 'Chest opened!', body: p?.label ?? 'You found a prize' }));
    setLocalToasts((prev) => [...prev, ...toasts]);
    navigator.vibrate?.([100, 50, 100, 50, 300]);
    setTimeout(() => setLocalToasts((prev) => prev.filter((t) => !toasts.includes(t))), 6000);
  }, []);
  const location = useLocationReporter({ gameId, enabled: reporting, intervalSec, onClaimed });
  const wake = useWakeLock(reporting);

  if (error) return <main className="page narrow"><div className="card"><ErrorText error={error} /><Link to="/">Home</Link></div></main>;
  if (!loaded || !userId) return <Loading />;
  if (!me) return <main className="page narrow"><div className="card"><p>You're not in this game on this device.</p><Link className="btn block" to={`/join/${game.code}`}>Join or rejoin</Link></div></main>;
  if (!setupDone) return <Setup onDone={() => { localStorage.setItem('hg:setup', '1'); setSetupDone(true); }} />;

  const myTeam = me.team_id ? teams[me.team_id] : null;
  const teammates = Object.values(players).filter((p) => p.id !== me.id && me.team_id && p.team_id === me.team_id);
  const myPos = location.position;
  const myState = states[me.id];
  const activeReveals = Object.values(reveals).filter((r) => r.viewer_player_id === me.id && new Date(r.expires_at).getTime() > nowMs);
  const revealedIds = new Set(activeReveals.map((r) => r.target_player_id));

  const mapPlayers = Object.values(players)
    .filter((p) => p.status !== 'removed')
    .filter((p) => p.id === me.id || teammates.includes(p) || revealedIds.has(p.id))
    .map((p) => {
      const s = p.id === me.id && myPos ? myPos : states[p.id];
      return {
        id: p.id, name: p.id === me.id ? 'You' : p.name, lng: s?.lng, lat: s?.lat, isMe: p.id === me.id,
        color: teams[p.team_id]?.color ?? '#94a3b8', dim: p.status !== 'alive',
        ring: revealedIds.has(p.id) ? '#f43f5e' : undefined,
      };
    });
  const chestList = Object.values(chests).map((c) => ({ id: c.id, lng: c.lng, lat: c.lat, claimed: !!c.claimed_by }));

  const goal = storm?.target ?? (storm ? { center: storm.center, radius: storm.radius } : null);
  const distToGoal = goal && myPos ? distanceM(goal.center, [myPos.lng, myPos.lat]) - goal.radius : null;
  const inStorm = storm?.active && myPos && distanceM(storm.center, [myPos.lng, myPos.lat]) > storm.radius;
  const shielded = myState?.shield_until && new Date(myState.shield_until).getTime() > nowMs;
  const deathSec = game.config.rules?.stormDeathSeconds ?? 10;
  const stormSince = myState?.storm_since ? new Date(myState.storm_since).getTime() : null;
  const stormLeft = stormSince ? deathSec - (nowMs - stormSince) / 1000 : deathSec;
  const bag = Object.values(inventory).filter((i) => i.player_id === me.id && !i.used_at);
  const showAlive = game.config.rules?.showAliveCount !== false;

  return (
    <div className={`play ${inStorm && alive && !shielded ? 'in-storm' : ''}`}>
      <NotificationToasts userId={userId} gameId={gameId} />
      <Toasts toasts={localToasts} onDismiss={(id) => setLocalToasts((prev) => prev.filter((t) => t.id !== id))} />

      <header className="hud-top">
        <div className="hud-pill">
          {game.status === 'lobby' && <span>Waiting to start</span>}
          {game.status === 'ended' && <span>Game over</span>}
          {game.status === 'active' && storm && (
            <span>{storm.label}{storm.secondsLeft != null && <strong> {formatClock(storm.secondsLeft)}</strong>}</span>
          )}
        </div>
        {showAlive && (
          <div className="hud-alive" title="Players alive">
            <span className="alive-num">{aliveCount(players)}</span>
            <span className="alive-label">ALIVE</span>
          </div>
        )}
      </header>

      {alive && game.status === 'active' && inStorm && !shielded && (
        <div className="storm-banner">
          <strong>YOU'RE IN THE STORM</strong>
          <span>{formatClock(stormLeft)} to get out · {formatDistance(distanceM(storm.center, [myPos.lng, myPos.lat]) - storm.radius)} to safety</span>
        </div>
      )}
      {shielded && <div className="info-banner">Storm shield · {formatClock((new Date(myState.shield_until).getTime() - nowMs) / 1000)}</div>}
      {activeReveals.length > 0 && (
        <div className="info-banner reveal">Enemies revealed · {formatClock(Math.max(...activeReveals.map((r) => new Date(r.expires_at).getTime())) / 1000 - nowMs / 1000)}</div>
      )}
      {myState?.out_of_bounds && alive && <div className="warn-banner">You're outside the play area</div>}
      {location.error && <div className="warn-banner">{location.error}</div>}
      {wake !== 'on' && game.status !== 'ended' && (
        <div className="warn-banner subtle">Keep your screen on ({screenTimeoutHint()})</div>
      )}

      {!alive && (
        <div className={`status-card ${me.status}`}>
          {me.status === 'dead' ? <><h2>Eliminated</h2><p>{me.death_cause === 'storm' ? 'The storm got you.' : 'Better luck next time.'}</p></> : <h2>You were removed from the game</h2>}
        </div>
      )}
      {game.status === 'ended' && <div className="status-card"><h2>Game over</h2><p>Thanks for playing!</p></div>}

      <div className="map-wrap">
        <GameMap
          playArea={game.config.playArea} storm={game.status === 'active' ? storm : null} me={alive ? myPos : null}
          players={mapPlayers} chests={game.config.chests?.visibleToPlayers === false ? [] : chestList}
          cooperativeGestures
        />
      </div>

      <section className="play-panel">
        <div className="me-row">
          <div>
            <div className="muted small">You are</div>
            <div className="me-name">{me.name}</div>
          </div>
          <div className="team-chip" style={{ '--team': myTeam?.color ?? '#475569' }}>{myTeam?.name ?? 'No team yet'}</div>
        </div>

        {game.status === 'active' && alive && distToGoal != null && (
          <div className="goal-row">
            {distToGoal > 0
              ? <><strong>{formatDistance(distToGoal)}</strong> to the {storm.target ? 'next safe zone' : 'safe zone'}</>
              : <>You're inside the {storm.target ? 'next safe zone' : 'safe zone'}</>}
            {distToGoal > 0 && myPos && <Compass from={[myPos.lng, myPos.lat]} to={nearestPointOnCircle(goal.center, goal.radius, [myPos.lng, myPos.lat])} />}
          </div>
        )}

        {teammates.length > 0 && (
          <div>
            <h3>Team</h3>
            <ul className="mate-list">
              {teammates.map((p) => {
                const s = states[p.id];
                return (
                  <li key={p.id} className={p.status}>
                    <span>{p.name}{p.status === 'alive' ? '' : ' (out)'}</span>
                    <span className="muted small">
                      {p.status === 'alive' && s?.is_dark ? 'dark' : ''}
                      {p.status === 'alive' && s?.lng != null && myPos ? ` ${formatDistance(distanceM([s.lng, s.lat], [myPos.lng, myPos.lat]))}` : ''}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <div className="button-row">
          <button className="btn" onClick={() => setShowBag(true)}>Items {bag.length > 0 && <span className="badge">{bag.length}</span>}</button>
          <button className="btn" onClick={() => setShowInfo(true)}>Info</button>
        </div>

        <h3>Feed</h3>
        <EventFeed events={events} limit={8} />
      </section>

      {showBag && (
        <Bag items={bag} me={me} players={players} teams={teams} onClose={() => setShowBag(false)} canUse={alive && game.status === 'active'} />
      )}
      {showInfo && <Info game={game} me={me} onClose={() => setShowInfo(false)} wake={wake} lastSent={location.lastSent} />}
    </div>
  );
}

function Compass({ from, to }) {
  const [heading, setHeading] = useState(null);
  useEffect(() => {
    const onOrient = (e) => {
      const h = e.webkitCompassHeading ?? (e.alpha != null ? 360 - e.alpha : null);
      if (h != null) setHeading(h);
    };
    window.addEventListener('deviceorientation', onOrient);
    return () => window.removeEventListener('deviceorientation', onOrient);
  }, []);
  const toRad = (d) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(to[0] - from[0])) * Math.cos(toRad(to[1]));
  const x = Math.cos(toRad(from[1])) * Math.sin(toRad(to[1])) - Math.sin(toRad(from[1])) * Math.cos(toRad(to[1])) * Math.cos(toRad(to[0] - from[0]));
  const bearing = (Math.atan2(y, x) * 180) / Math.PI;
  const rotation = heading == null ? bearing : bearing - heading;
  return <span className="compass" style={{ transform: `rotate(${rotation}deg)` }} title={heading == null ? 'North is up' : ''}>⬆</span>;
}

function Setup({ onDone }) {
  const [geo, requestGeo] = useGeolocationPermission();
  const [pushOn, enablePushNow] = usePushStatus();
  const { busy, error, run } = useAction();

  const askCompass = () => {
    // iOS needs explicit permission for the compass arrow.
    window.DeviceOrientationEvent?.requestPermission?.().catch(() => {});
  };

  return (
    <main className="page narrow">
      <section className="card">
        <h1>Get ready</h1>
        <p className="muted">Three quick things so the game works.</p>

        <div className="setup-step">
          <div><strong>1. Location</strong><p className="muted small">Gamemakers and your team see where you are.</p></div>
          {geo === 'granted'
            ? <span className="ok">✓</span>
            : <button className="btn primary" onClick={() => { askCompass(); requestGeo(); }}>Allow</button>}
        </div>
        {geo === 'denied' && <p className="error">Location is blocked. Turn it back on for this site in your browser settings, then reload.</p>}

        <div className="setup-step">
          <div><strong>2. Notifications</strong><p className="muted small">Storm warnings and gamemaker messages, even when locked.{isIOS() && !isStandalone() && ' On iPhone this needs the app added to your Home Screen.'}</p></div>
          {pushOn ? <span className="ok">✓</span> : <button className="btn" disabled={busy} onClick={() => run(enablePushNow)}>Enable</button>}
        </div>
        <ErrorText error={error} />

        <div className="setup-step">
          <div>
            <strong>3. Screen stays on</strong>
            <p className="muted small">Location only updates while the app is open. If your screen locks you "go dark" and the gamemakers are alerted. Set <em>{screenTimeoutHint()}</em> for the game.</p>
          </div>
        </div>

        <button className="btn primary block" disabled={geo !== 'granted'} onClick={onDone}>I'm ready</button>
      </section>
    </main>
  );
}

function Bag({ items, me, players, teams, onClose, canUse }) {
  const [choosing, setChoosing] = useState(null);
  const { busy, error, run } = useAction();
  const enemies = Object.values(players).filter((p) => p.status === 'alive' && p.id !== me.id && (!me.team_id || p.team_id !== me.team_id));

  const use = (item, target = null) => run(async () => {
    await rpc('use_item', { p_item: item.id, p_target: target });
    setChoosing(null);
    onClose();
  });

  return (
    <Modal title={choosing ? 'Choose an enemy' : 'Your items'} onClose={onClose}>
      {choosing ? (
        <ul className="pick-list">
          {enemies.map((p) => (
            <li key={p.id}>
              <button className="btn block" disabled={busy} onClick={() => use(choosing, p.id)}>
                <span className="dot" style={{ background: teams[p.team_id]?.color ?? '#94a3b8' }} /> {p.name}
              </button>
            </li>
          ))}
          {!enemies.length && <p className="muted">No enemies left to reveal.</p>}
        </ul>
      ) : (
        <ul className="pick-list">
          {items.map((item) => {
            const info = prizeInfo(item.prize);
            return (
              <li key={item.id} className="item-row">
                <span className="grow">{item.prize?.label ?? info.name}</span>
                <button className="btn primary" disabled={!canUse || busy}
                  onClick={() => (info.needsTarget ? setChoosing(item) : use(item))}>Use</button>
              </li>
            );
          })}
          {!items.length && <p className="muted">No items yet. Find chests on the map.</p>}
        </ul>
      )}
      <ErrorText error={error} />
    </Modal>
  );
}

const localNow = () => Date.now();

function Info({ game, me, onClose, wake, lastSent }) {
  const nowMs = useTicker(localNow);
  const [rejoinCode, setRejoinCode] = useState(null);
  const [pushOn, enablePushNow] = usePushStatus();
  const { busy, error, run } = useAction();
  useEffect(() => {
    supabase.from('player_secrets').select('rejoin_code').eq('player_id', me.id).maybeSingle()
      .then(({ data }) => setRejoinCode(data?.rejoin_code));
  }, [me.id]);

  return (
    <Modal title={game.name} onClose={onClose}>
      {game.config.rules?.text?.length > 0 && (
        <>
          <h3>Rules</h3>
          <ul className="rules">{game.config.rules.text.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </>
      )}
      <h3>Your device</h3>
      <ul className="kv">
        <li><span>Rejoin code</span><strong className="mono">{rejoinCode ?? '…'}</strong></li>
        <li><span>Game code</span><strong className="mono">{game.code}</strong></li>
        <li><span>Screen lock</span><span>{wake === 'on' ? '✓ kept awake' : 'not held, set Auto-Lock to Never'}</span></li>
        <li><span>Last location sent</span><span>{lastSent ? `${Math.round((nowMs - lastSent) / 1000)}s ago` : 'not yet'}</span></li>
        <li><span>Notifications</span>{pushOn ? <span>✓ on</span> : <button className="btn small" disabled={busy} onClick={() => run(enablePushNow)}>Enable</button>}</li>
      </ul>
      <ErrorText error={error} />
      <p className="muted small">Use the rejoin code if you switch phones or browsers.</p>
    </Modal>
  );
}
