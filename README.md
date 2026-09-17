# Hunger Games 

A real-life battle royale that runs in the phone browser. Players join with a name, their live location shows up on a map, and a Fortnite-style storm closes in until one team is left. Made for a campus game with laser tag gear, but you can set it up for any area.

- **Players** don't need an account. They open a link, enter a name, and add the site to their Home Screen. Their phone remembers them.
- **Gamemakers** log in with a username and password. They set up the play area, storm, and chests on a map, drag players into teams, see everyone live, and eliminate, revive, remove, or message players.
- **The server enforces the rules:** a storm death after N seconds outside the circle, "went dark" alerts, out-of-bounds alerts, and chests going to the first player who reaches them.
- Also included: a live event feed, push notifications, a spectator link, and full replay.

## How it works

| Piece | Tech |
| --- | --- |
| App | React + Vite, installable to the Home Screen (manifest + service worker) |
| Map | Mapbox GL JS + Turf |
| Data, realtime, auth | Supabase (Postgres, Realtime, anonymous auth) |
| Game rules | SQL functions + a `pg_cron` job that runs every second (`private.game_tick`) |
| Push | `push` edge function (makes its own VAPID keys the first time it runs) |
| Gamemaker signup | `gm-signup` edge function |

Clients can only **read** tables, and row-level security controls what each person sees. Players only get the positions of their own team plus any enemies they've revealed. Every change goes through a `security definer` RPC that checks permissions.

### Limits of a website
A website can only read GPS **while it's open on screen**, on both iPhone and Android. The app keeps the screen awake with the Wake Lock API and tells players to turn their screen timeout off. If a phone stops reporting for `darkAfterSeconds`, gamemakers and that player are alerted. Its last position still counts for storm damage, so locking your screen won't save you.

**iPhone (Safari, iOS 16.4+):** players must add the site to the Home Screen and open it from there. Safari and the Home Screen app keep separate storage, so a player who joins in Safari first is a different player in the installed app. The rejoin code moves them across. Push notifications only work from the Home Screen app.

**Android (Chrome):** Chrome offers a one-tap "Add to Home Screen" button, which the join page shows automatically. Installing is optional there, because Chrome and the installed app share storage and notifications work in a normal tab too.

## Setup

1. **Supabase project:** create one at [supabase.com](https://supabase.com).
   - Authentication → Sign In / Providers → turn on **Allow anonymous sign-ins**.
   - Run the SQL files in `supabase/migrations/` in order, using the SQL editor or `supabase db push`.
   - Deploy the functions **without JWT verification**, since they check requests themselves:
     ```sh
     supabase functions deploy push --no-verify-jwt
     supabase functions deploy gm-signup --no-verify-jwt
     ```
   - Optional: `supabase secrets set GM_SIGNUP_CODE=something` so only people with the code can create gamemaker accounts.
   - Optional: `supabase secrets set VAPID_SUBJECT=mailto:you@example.com`.
   - Open `https://<project>.supabase.co/functions/v1/push` once in a browser. This creates the push keys and turns on notification delivery.
2. **Mapbox:** make a public token at [account.mapbox.com](https://account.mapbox.com) and restrict it to your site's URL.
3. **Env:** `cp .env.example .env` and fill it in.
4. **Run:** `npm install && npm run dev`.
5. **Deploy:** any static host with HTTPS works. GPS, Wake Lock, and push all require HTTPS. `vercel.json` and `public/_redirects` handle page routing on Vercel and Netlify.
   - Set the same three `VITE_` variables in your host's environment settings. `.env` is gitignored, so without them the build has no Supabase or Mapbox credentials and the app shows a "Missing configuration" screen.
   - On Vercel, share the **production** domain. Preview URLs (`…-<hash>-<team>.vercel.app`) sit behind Vercel Authentication and redirect anyone who isn't logged into your Vercel account. To open previews to players, turn off Project Settings → Deployment Protection.

To test on a phone before deploying, run `npx vite --host` behind an HTTPS tunnel (e.g. `cloudflared tunnel --url http://localhost:5173`). Plain `http://<your-ip>` won't get GPS.

## Your own game: `public/game.config.json`

This file holds the defaults the gamemaker starts from when creating a game. Anything in it can be changed in the creation screen, which can also load or download a config.

```jsonc
{
  "name": "My game",
  "playArea": { "type": "Feature", "geometry": { "type": "Polygon", "coordinates": [[[lng, lat], ...]] } },
  "rules": {
    "maxNameLength": 16,
    "showAliveCount": true,        // the "ALIVE" counter in the corner
    "allowLateJoin": false,
    "stormDeathSeconds": 10,       // time outside the circle before automatic death
    "darkAfterSeconds": 15,        // no location for this long → "went dark" alert
    "locationIntervalSeconds": 3,
    "text": ["Rules shown to players"]
  },
  "storm": {
    "firstShrinkAfterMinutes": 10,
    "revealBeforeShrinkSeconds": 120, // how early the next circle appears
    "holdSeconds": 240,               // pause between shrinks
    "shrinkSeconds": 120,
    "shrinkFactor": 0.6,              // each random circle's radius vs. the previous one
    "minRadiusMeters": 30,            // circles stop shrinking here; the gamemaker ends the game
    "circles": [                      // optional hand-placed circles, used first; the rest are random
      { "center": [lng, lat], "radiusMeters": 500, "holdSeconds": 300, "shrinkSeconds": 90 }
    ]
  },
  "chests": {
    "count": 6,
    "claimRadiusMeters": 15,          // phone GPS is usually ±5–15 m
    "visibleToPlayers": true,
    "items": [{ "position": [lng, lat], "prize": { "type": "storm_shield", "label": "Shield", "seconds": 60 } }],
    "prizePool": [{ "type": "reveal_enemy", "label": "Spy", "seconds": 10, "weight": 3 }]
  },
  "teams": [{ "name": "Red", "color": "#ef4444" }]
}
```

`playArea` accepts a GeoJSON Feature, a FeatureCollection (the first Polygon is used), a Polygon geometry, or a bare coordinates array. Draw one at [geojson.io](https://geojson.io).

### Prize types
| type | effect |
| --- | --- |
| `reveal_enemy` | Pick one enemy and see them on your map for `seconds` |
| `reveal_all_enemies` | See every enemy for `seconds` |
| `storm_shield` | The storm can't hurt you for `seconds` |
| `custom` | Anything else (e.g. "extra heart"). Gamemakers get notified when it's used, and you handle it in real life |

To add a type, add a `when` branch in `public.use_item` (SQL) and an entry in `src/lib/prizes.js`.

## Project layout
```
public/game.config.json      default game setup
supabase/migrations/         schema, security, game rules, cron tick, push trigger
supabase/functions/          push delivery, gamemaker signup
src/lib/storm.js             storm plan + circle math (mirrors private.storm_at in SQL)
src/lib/useGame.js           realtime game state hook
src/lib/device.js            GPS reporting, wake lock, push subscription
src/pages/                   Home, Join, Play, GmAuth, GmHome, GmCreate, GmGame, Watch, Replay
```
