import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const REQUIRED = {
  VITE_SUPABASE_URL: 'Supabase → Project Settings → API → Project URL',
  VITE_SUPABASE_PUBLISHABLE_KEY: 'Supabase → Project Settings → API → publishable (anon) key',
  VITE_MAPBOX_TOKEN: 'Mapbox → Account → Tokens → public token',
};

const root = createRoot(document.getElementById('root'));
const missing = Object.keys(REQUIRED).filter((key) => !import.meta.env[key]);

if (missing.length) {
  // Without these the app can't start, so say so instead of rendering a blank page.
  root.render(
    <main className="page narrow">
      <h1>Missing configuration</h1>
      <p>This build has no value for {missing.length === 1 ? 'this setting' : 'these settings'}:</p>
      <ul>
        {missing.map((key) => <li key={key}><strong>{key}</strong> — {REQUIRED[key]}</li>)}
      </ul>
      <p>
        Locally, put them in <code>.env</code> (see <code>.env.example</code>). When hosting, add them as
        environment variables and deploy again — on Vercel that's Project Settings → Environment Variables.
        They must keep the <code>VITE_</code> prefix or the build drops them.
      </p>
    </main>,
  );
} else {
  // Registered here rather than imported, so nothing touching Supabase loads before the check above.
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  const { default: App } = await import('./App.jsx');
  root.render(<StrictMode><App /></StrictMode>);
}
