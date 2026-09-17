import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { rpc, supabase } from '../lib/supabaseClient';
import { ErrorText, Loading } from '../components/ui';
import { useAction, useGamemakerSession } from '../lib/hooks';

export default function GmHome() {
  const session = useGamemakerSession();
  const navigate = useNavigate();
  const [games, setGames] = useState(null);
  const [invite, setInvite] = useState('');
  const { busy, error, run } = useAction();

  useEffect(() => {
    if (!session) return;
    supabase.from('game_gamemakers').select('games(*)').eq('user_id', session.user.id)
      .then(({ data }) => setGames((data ?? []).map((r) => r.games).filter(Boolean)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))));
  }, [session]);

  if (!session || !games) return <Loading />;
  const username = session.user.user_metadata?.username ?? session.user.email.split('@')[0];

  return (
    <main className="page narrow">
      <header className="row-between">
        <div>
          <p className="muted small">Gamemaker</p>
          <h1>{username}</h1>
        </div>
        <button className="btn ghost" onClick={async () => { await supabase.auth.signOut(); navigate('/'); }}>Log out</button>
      </header>

      <Link className="btn primary block big" to="/gm/new">+ Create game</Link>

      <section className="card">
        <h2>Your games</h2>
        {!games.length && <p className="muted">No games yet.</p>}
        <ul className="game-list">
          {games.map((g) => (
            <li key={g.id}>
              <Link to={`/gm/game/${g.id}`} className="game-link">
                <span><strong>{g.name}</strong><span className="muted small"> · {new Date(g.created_at).toLocaleDateString()}</span></span>
                <span className={`status-tag ${g.status}`}>{g.status}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <form className="card" onSubmit={(e) => {
        e.preventDefault();
        run(async () => navigate(`/gm/game/${await rpc('gm_join_game', { p_invite_code: invite })}`));
      }}>
        <h2>Join as co-gamemaker</h2>
        <p className="muted small">Another gamemaker can share their game's gamemaker invite code with you.</p>
        <input value={invite} onChange={(e) => setInvite(e.target.value.toUpperCase())} placeholder="INVITE CODE" maxLength={8} />
        <button className="btn block" disabled={busy || invite.length < 8}>Join</button>
        <ErrorText error={error} />
      </form>
    </main>
  );
}
