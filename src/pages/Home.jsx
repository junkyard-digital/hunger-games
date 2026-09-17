import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getSession, supabase } from '../lib/supabaseClient';

export default function Home() {
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [myGames, setMyGames] = useState([]);

  useEffect(() => {
    (async () => {
      const session = await getSession();
      if (!session?.user.is_anonymous) return;
      const { data } = await supabase.from('players')
        .select('id, name, status, games(id, name, code, status)')
        .eq('user_id', session.user.id)
        .order('joined_at', { ascending: false });
      const current = (data ?? []).filter((p) => p.games && p.games.status !== 'ended');
      // Opened from the home screen with exactly one live game: go straight back in.
      if (current.length === 1) navigate(`/play/${current[0].games.id}`, { replace: true });
      setMyGames(current);
    })();
  }, [navigate]);

  return (
    <main className="page narrow">
      <header className="hero">
        <h1>Hunger Games</h1>
        <p className="muted">Real-life battle royale. Stay out of the storm.</p>
      </header>

      {myGames.length > 0 && (
        <section className="card">
          <h2>Your games</h2>
          {myGames.map((p) => (
            <Link key={p.id} className="btn block" to={`/play/${p.games.id}`}>
              Return to {p.games.name} as {p.name}
            </Link>
          ))}
        </section>
      )}

      <form className="card" onSubmit={(e) => { e.preventDefault(); if (code.trim()) navigate(`/join/${code.trim().toUpperCase()}`); }}>
        <h2>Join a game</h2>
        <input
          className="code-input" id="game-code" name="gameCode" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="GAME CODE" maxLength={5} autoCapitalize="characters" autoComplete="off"
        />
        <button className="btn primary block" disabled={code.trim().length < 5}>Join</button>
      </form>

      <p className="center"><Link to="/gm">I'm a gamemaker →</Link></p>
    </main>
  );
}
