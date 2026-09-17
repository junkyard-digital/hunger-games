import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ensureAnonymousSession, getSession, isGamemakerSession, rpc, supabase } from '../lib/supabaseClient';
import { isIOS, isStandalone, useInstallPrompt } from '../lib/device';
import { ErrorText, Loading } from '../components/ui';
import { useAction } from '../lib/hooks';

const MAX_NAME = 16;

export default function Join() {
  const { code } = useParams();
  const navigate = useNavigate();
  const [checking, setChecking] = useState(true);
  const [gmWarning, setGmWarning] = useState(false);
  const [skipInstall, setSkipInstall] = useState(false);
  const [name, setName] = useState('');
  const [rejoin, setRejoin] = useState(false);
  const [rejoinCode, setRejoinCode] = useState('');
  const { busy, error, run } = useAction();
  const [canInstall, install] = useInstallPrompt();

  useEffect(() => {
    (async () => {
      const session = await getSession();
      if (isGamemakerSession(session)) {
        setGmWarning(true);
        setChecking(false);
        return;
      }
      if (session) {
        const { data } = await supabase.from('players').select('game_id, games!inner(code)')
          .eq('user_id', session.user.id).eq('games.code', code.toUpperCase()).maybeSingle();
        if (data) return navigate(`/play/${data.game_id}`, { replace: true });
      }
      setChecking(false);
    })();
  }, [code, navigate]);

  if (checking) return <Loading />;

  if (gmWarning) {
    return (
      <main className="page narrow">
        <section className="card">
          <h2>You're signed in as a gamemaker</h2>
          <p>To play on this device, sign out of the gamemaker account first.</p>
          <button className="btn block" onClick={async () => { await supabase.auth.signOut(); setGmWarning(false); }}>Sign out and join</button>
          <Link className="btn ghost block" to="/gm">Back to dashboard</Link>
        </section>
      </main>
    );
  }

  // Installing keeps the player signed in, allows notifications, and keeps the screen awake.
  // iPhone has no install API, so those players follow written steps instead.
  if (!isStandalone() && !skipInstall && (isIOS() || canInstall)) {
    return (
      <main className="page narrow">
        <section className="card">
          <h1>Install the game first</h1>
          <p>So the game remembers you and can send you alerts:</p>
          {canInstall ? (
            <button className="btn primary block" onClick={install}>Add to Home Screen</button>
          ) : (
            <ol className="steps">
              <li>Tap the <strong>Share</strong> button in Safari</li>
              <li>Tap <strong>Add to Home Screen</strong></li>
              <li>Open <strong>Hunger Games</strong> from your Home Screen</li>
            </ol>
          )}
          <p className="muted">Game code: <strong className="mono">{code.toUpperCase()}</strong></p>
          <button className="btn ghost block" onClick={() => setSkipInstall(true)}>Continue in the browser anyway</button>
        </section>
      </main>
    );
  }

  const join = () => run(async () => {
    await ensureAnonymousSession();
    const player = rejoin
      ? await rpc('rejoin_game', { p_code: code, p_rejoin_code: rejoinCode })
      : await rpc('join_game', { p_code: code, p_name: name });
    navigate(`/play/${player.game_id}`, { replace: true });
  });

  return (
    <main className="page narrow">
      <form className="card" onSubmit={(e) => { e.preventDefault(); join(); }}>
        <p className="muted">Game <strong className="mono">{code.toUpperCase()}</strong></p>
        {rejoin ? (
          <>
            <h1>Rejoin</h1>
            <p className="muted">Enter the rejoin code shown on your other device (or ask a gamemaker).</p>
            <input className="code-input" value={rejoinCode} onChange={(e) => setRejoinCode(e.target.value.toUpperCase())}
              placeholder="REJOIN CODE" maxLength={6} autoCapitalize="characters" />
            <button className="btn primary block" disabled={busy || rejoinCode.length < 6}>Rejoin</button>
          </>
        ) : (
          <>
            <h1>What's your name?</h1>
            <input value={name} onChange={(e) => setName(e.target.value.slice(0, MAX_NAME))} placeholder="Name" maxLength={MAX_NAME}
              autoFocus autoComplete="nickname" />
            <p className="muted small">{name.trim().length}/{MAX_NAME}</p>
            <button className="btn primary block" disabled={busy || !name.trim()}>{busy ? 'Joining…' : 'Join game'}</button>
          </>
        )}
        <ErrorText error={error} />
        <button type="button" className="link-btn" onClick={() => setRejoin(!rejoin)}>
          {rejoin ? 'New player? Join with a name' : 'Already joined on another device?'}
        </button>
      </form>
    </main>
  );
}
