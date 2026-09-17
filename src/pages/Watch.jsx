import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { EventFeed, ErrorText, Loading } from '../components/ui';
import { LiveMap } from './GmGame';
import { aliveCount, useGame, useServerClock, useStorm, useTicker } from '../lib/useGame';
import { ensureAnonymousSession, rpc } from '../lib/supabaseClient';
import { formatClock } from '../lib/geo';

export default function Watch() {
  const { token } = useParams();
  const [gameId, setGameId] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    ensureAnonymousSession()
      .then(() => rpc('spectate', { p_token: token }))
      .then(setGameId)
      .catch((e) => setError(e.message));
  }, [token]);

  const data = useGame(gameId);
  const now = useServerClock();
  const nowMs = useTicker(now);
  const storm = useStorm(data.game, nowMs);

  if (error || data.error) return <main className="page narrow"><ErrorText error={error ?? data.error} /></main>;
  if (!data.loaded) return <Loading label="Joining as spectator…" />;
  const { game, players, events } = data;

  return (
    <div className="dashboard watch">
      <header className="dash-header row-between">
        <div>
          <p className="muted small">Spectating</p>
          <h1>{game.name}</h1>
          <p className="muted small">
            <span className={`status-tag ${game.status}`}>{game.status}</span>
            {game.status === 'active' && storm && <> · {storm.label} {storm.secondsLeft != null && formatClock(storm.secondsLeft)}</>}
            {game.status !== 'lobby' && <> · <Link to={`/replay/${game.id}`}>Replay</Link></>}
          </p>
        </div>
        <div className="hud-alive"><span className="alive-num">{aliveCount(players)}</span><span className="alive-label">ALIVE</span></div>
      </header>
      <div className="watch-body">
        <LiveMap data={data} />
        <aside className="watch-feed"><EventFeed events={events} hideTypes={['joined']} /></aside>
      </div>
    </div>
  );
}
