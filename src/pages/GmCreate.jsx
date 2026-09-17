import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import mapboxgl from 'mapbox-gl';
import GameMap from '../components/GameMap';
import { ErrorText, Loading } from '../components/ui';
import { useAction, useGamemakerSession } from '../lib/hooks';
import { exportConfig, loadDefaultConfig, normalizeConfig } from '../lib/config';
import { asBox, boxCoords, coveringCircle } from '../lib/geo';
import { PRIZE_TYPES, randomChests } from '../lib/prizes';
import { buildStormPlan } from '../lib/storm';
import { rpc } from '../lib/supabaseClient';

const TABS = ['Basics', 'Area', 'Storm', 'Chests', 'Teams'];
const CIRCLE_COLORS = ['#fbbf24', '#f472b6', '#34d399', '#60a5fa', '#f87171', '#a78bfa'];

export default function GmCreate() {
  const session = useGamemakerSession();
  const navigate = useNavigate();
  const [config, setConfig] = useState(null);
  const [tab, setTab] = useState('Basics');
  const [loadError, setLoadError] = useState(null);
  const [map, setMap] = useState(null);
  const [preview, setPreview] = useState(null);
  const { busy, error, run } = useAction();

  useEffect(() => {
    loadDefaultConfig().then(setConfig).catch((e) => setLoadError(e.message));
  }, []);

  if (loadError) return <main className="page narrow"><ErrorText error={loadError} /></main>;
  if (!session || !config) return <Loading />;

  const update = (path, value) => setConfig((prev) => setIn(prev, path, value));

  const create = () => run(async () => {
    const game = await rpc('gm_create_game', { p_name: config.name, p_config: config });
    navigate(`/gm/game/${game.id}`, { replace: true });
  });

  const circles = tab === 'Storm'
    ? (preview ?? []).slice(1).map((c, i) => ({ center: c.c, radius: c.r, color: CIRCLE_COLORS[i % CIRCLE_COLORS.length] }))
    : [];

  return (
    <div className="editor">
      <div className="editor-map">
        <GameMap playArea={config.playArea} onLoad={setMap} circles={circles}
          chests={tab === 'Chests' ? [] : config.chests.items.map((c, i) => ({ id: `c${i}`, lng: c.position[0], lat: c.position[1] }))} />
        {map && tab === 'Area' && <AreaHandles map={map} playArea={config.playArea} onChange={(pa) => update(['playArea'], pa)} />}
        {map && tab === 'Storm' && <CircleHandles map={map} circles={config.storm.circles} onChange={(c) => update(['storm', 'circles'], c)} />}
        {map && tab === 'Chests' && <ChestHandles map={map} items={config.chests.items} onChange={(items) => update(['chests', 'items'], items)} />}
      </div>

      <div className="editor-panel">
        <nav className="tabs">
          {TABS.map((t) => <button key={t} className={t === tab ? 'active' : ''} onClick={() => setTab(t)}>{t}</button>)}
        </nav>

        <div className="editor-body">
          {tab === 'Basics' && <BasicsTab config={config} update={update} setConfig={setConfig} />}
          {tab === 'Area' && <AreaTab config={config} update={update} map={map} />}
          {tab === 'Storm' && <StormTab config={config} update={update} map={map} setPreview={setPreview} />}
          {tab === 'Chests' && <ChestsTab config={config} update={update} map={map} />}
          {tab === 'Teams' && <TeamsTab config={config} update={update} />}
        </div>

        <div className="editor-foot">
          <ErrorText error={error} />
          <button className="btn primary block" disabled={busy || !config.name.trim()} onClick={create}>
            {busy ? 'Creating…' : 'Create game'}
          </button>
        </div>
      </div>
    </div>
  );
}

function setIn(obj, [key, ...rest], value) {
  if (!rest.length) return Array.isArray(obj) ? Object.assign([...obj], { [key]: value }) : { ...obj, [key]: value };
  return Array.isArray(obj)
    ? Object.assign([...obj], { [key]: setIn(obj[key], rest, value) })
    : { ...obj, [key]: setIn(obj[key], rest, value) };
}

function NumberField({ label, value, onChange, min, max, step = 1, suffix }) {
  return (
    <label className="field-inline">
      <span>{label}</span>
      <span className="input-suffix">
        <input type="number" inputMode="decimal" value={value} min={min} max={max} step={step}
          onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />
        {suffix && <span className="muted small">{suffix}</span>}
      </span>
    </label>
  );
}

function Toggle({ label, checked, onChange, hint }) {
  return (
    <label className="toggle">
      <span>{label}{hint && <span className="muted small block">{hint}</span>}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

// ───────────── Basics ─────────────

function BasicsTab({ config, update, setConfig }) {
  const fileRef = useRef(null);
  const [importError, setImportError] = useState(null);
  const r = config.rules;

  const importFile = async (file) => {
    try {
      setConfig(normalizeConfig(JSON.parse(await file.text())));
      setImportError(null);
    } catch (e) {
      setImportError(`Couldn't load that file: ${e.message}`);
    }
  };
  const download = () => {
    const blob = new Blob([JSON.stringify(exportConfig(config), null, 2)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'game.config.json' });
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      <label>Game name<input value={config.name} maxLength={60} onChange={(e) => update(['name'], e.target.value)} /></label>
      <Toggle label="Show players-alive count" checked={r.showAliveCount} onChange={(v) => update(['rules', 'showAliveCount'], v)} />
      <Toggle label="Allow joining after start" checked={r.allowLateJoin} onChange={(v) => update(['rules', 'allowLateJoin'], v)} />
      <NumberField label="Storm kills after" value={r.stormDeathSeconds} min={1} suffix="sec" onChange={(v) => update(['rules', 'stormDeathSeconds'], v)} />
      <NumberField label="'Went dark' alert after" value={r.darkAfterSeconds} min={5} suffix="sec" onChange={(v) => update(['rules', 'darkAfterSeconds'], v)} />
      <NumberField label="Location updates every" value={r.locationIntervalSeconds} min={1} max={30} suffix="sec" onChange={(v) => update(['rules', 'locationIntervalSeconds'], v)} />
      <NumberField label="Max name length" value={r.maxNameLength} min={3} max={30} onChange={(v) => update(['rules', 'maxNameLength'], v)} />
      <label>Rules shown to players <span className="muted small">(one per line)</span>
        <textarea rows={4} value={r.text.join('\n')} onChange={(e) => update(['rules', 'text'], e.target.value.split('\n'))} />
      </label>

      <h3>Config file</h3>
      <p className="muted small">Defaults come from <code>public/game.config.json</code>. You can load your own or save this setup for later.</p>
      <div className="button-row">
        <button className="btn" onClick={() => fileRef.current.click()}>Load JSON</button>
        <button className="btn" onClick={download}>Download JSON</button>
      </div>
      <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => e.target.files[0] && importFile(e.target.files[0])} />
      <ErrorText error={importError} />
    </>
  );
}

// ───────────── Play area ─────────────

function AreaTab({ config, update, map }) {
  const [geojson, setGeojson] = useState('');
  const [err, setErr] = useState(null);
  const box = asBox(config.playArea);

  const useView = () => {
    const b = map.getBounds();
    const padX = (b.getEast() - b.getWest()) * 0.1;
    const padY = (b.getNorth() - b.getSouth()) * 0.1;
    update(['playArea'], boxCoords([b.getWest() + padX, b.getSouth() + padY, b.getEast() - padX, b.getNorth() - padY]));
  };
  const applyGeojson = () => {
    try {
      update(['playArea'], normalizeConfig({ playArea: JSON.parse(geojson) }).playArea);
      setErr(null);
    } catch (e) {
      setErr(e.message);
    }
  };

  return (
    <>
      <p className="muted">
        {box ? 'Drag the corner handles on the map to resize the play area.' : 'Custom polygon loaded from GeoJSON.'}
      </p>
      <button className="btn block" disabled={!map} onClick={useView}>Use current map view as the box</button>
      {!box && <button className="btn block" onClick={() => update(['playArea'], boxCoords(bboxOf(config.playArea)))}>Convert to editable box</button>}
      <label>Paste GeoJSON (Polygon)
        <textarea rows={5} value={geojson} onChange={(e) => setGeojson(e.target.value)} placeholder='{"type":"Polygon","coordinates":[...]}' />
      </label>
      <button className="btn block" disabled={!geojson.trim()} onClick={applyGeojson}>Apply GeoJSON</button>
      <ErrorText error={err} />
    </>
  );
}

const bboxOf = (coords) => {
  const xs = coords[0].map((p) => p[0]);
  const ys = coords[0].map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

function handleEl(className, text = '') {
  const el = document.createElement('div');
  el.className = className;
  el.textContent = text;
  return el;
}

function AreaHandles({ map, playArea, onChange }) {
  const box = asBox(playArea);
  const markers = useRef([]);
  const changeRef = useRef(onChange);
  useEffect(() => {
    changeRef.current = onChange;
  }, [onChange]);

  const key = box ? box.join(',') : null;
  useEffect(() => {
    if (!box) return;
    const [w, s, e, n] = box;
    const corners = [[w, s], [e, s], [e, n], [w, n]];
    markers.current = corners.map((pt, i) => {
      const m = new mapboxgl.Marker({ element: handleEl('handle corner'), draggable: true }).setLngLat(pt).addTo(map);
      m.on('dragend', () => {
        const moved = m.getLngLat();
        const opposite = corners[(i + 2) % 4];
        changeRef.current(boxCoords([
          Math.min(moved.lng, opposite[0]), Math.min(moved.lat, opposite[1]),
          Math.max(moved.lng, opposite[0]), Math.max(moved.lat, opposite[1]),
        ]));
      });
      return m;
    });
    return () => markers.current.forEach((m) => m.remove());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, key]);
  return null;
}

// ───────────── Storm ─────────────

function StormTab({ config, update, map, setPreview }) {
  const s = config.storm;
  const full = coveringCircle(config.playArea);
  const [rollCount, setRollCount] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const plan = useMemo(() => buildStormPlan(s, config.playArea), [s, config.playArea, rollCount]);

  useEffect(() => {
    setPreview(plan);
    return () => setPreview(null);
  }, [plan, setPreview]);

  const reroll = () => setRollCount((n) => n + 1);

  const addCircle = () => {
    const prevR = s.circles.length ? s.circles[s.circles.length - 1].radiusMeters : full.r;
    const c = map ? map.getCenter() : { lng: full.c[0], lat: full.c[1] };
    update(['storm', 'circles'], [...s.circles, { center: [c.lng, c.lat], radiusMeters: Math.round(prevR * (s.shrinkFactor || 0.6)) }]);
  };

  const total = plan.length ? plan[plan.length - 1].shrinkEnd : 0;

  return (
    <>
      <NumberField label="First shrink after" value={s.firstShrinkAfterMinutes} min={0} step={0.5} suffix="min" onChange={(v) => update(['storm', 'firstShrinkAfterMinutes'], v)} />
      <NumberField label="Show next circle before shrink" value={s.revealBeforeShrinkSeconds} min={0} suffix="sec" onChange={(v) => update(['storm', 'revealBeforeShrinkSeconds'], v)} />
      <NumberField label="Wait between shrinks" value={s.holdSeconds} min={0} suffix="sec" onChange={(v) => update(['storm', 'holdSeconds'], v)} />
      <NumberField label="Shrink duration" value={s.shrinkSeconds} min={10} suffix="sec" onChange={(v) => update(['storm', 'shrinkSeconds'], v)} />
      <NumberField label="Each circle is" value={s.shrinkFactor} min={0.1} max={0.95} step={0.05} suffix="× previous" onChange={(v) => update(['storm', 'shrinkFactor'], v)} />
      <NumberField label="Smallest circle" value={s.minRadiusMeters} min={5} suffix="m radius" onChange={(v) => update(['storm', 'minRadiusMeters'], v)} />

      <h3>Circles</h3>
      <p className="muted small">
        Place circles yourself, in order. After your circles run out, the rest are random, each one inside the one before it, until the smallest size.
        Dashed outlines show one possible storm ({plan.length - 1} circles, about {Math.round(total / 60)} min until the final circle). Random circles are rolled again when the game starts.
      </p>
      <ul className="pick-list">
        {s.circles.map((c, i) => (
          <li key={i} className="circle-row">
            <span className="dot" style={{ background: CIRCLE_COLORS[i % CIRCLE_COLORS.length] }} />
            <span>#{i + 1}</span>
            <input type="range" min={10} max={full.r} value={c.radiusMeters}
              onChange={(e) => update(['storm', 'circles', i, 'radiusMeters'], Number(e.target.value))} />
            <span className="small mono">{c.radiusMeters}m</span>
            <button className="icon-btn" onClick={() => update(['storm', 'circles'], s.circles.filter((_, j) => j !== i))}>Remove</button>
          </li>
        ))}
      </ul>
      <div className="button-row">
        <button className="btn" onClick={addCircle}>+ Circle at map center</button>
        <button className="btn ghost" onClick={reroll}>Re-roll preview</button>
      </div>
    </>
  );
}

function CircleHandles({ map, circles, onChange }) {
  const changeRef = useRef(onChange);
  const circlesRef = useRef(circles);
  useEffect(() => {
    changeRef.current = onChange;
    circlesRef.current = circles;
  }, [onChange, circles]);

  const key = circles.map((c) => c.center.join(',')).join('|');
  useEffect(() => {
    const markers = circles.map((c, i) => {
      const m = new mapboxgl.Marker({ element: handleEl('handle circle-handle', String(i + 1)), draggable: true })
        .setLngLat(c.center).addTo(map);
      m.on('dragend', () => {
        const { lng, lat } = m.getLngLat();
        changeRef.current(circlesRef.current.map((cc, j) => (j === i ? { ...cc, center: [lng, lat] } : cc)));
      });
      return m;
    });
    return () => markers.forEach((m) => m.remove());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, key]);
  return null;
}

// ───────────── Chests ─────────────

function ChestsTab({ config, update, map }) {
  const c = config.chests;
  const setPool = (pool) => update(['chests', 'prizePool'], pool);

  return (
    <>
      <NumberField label="Open within" value={c.claimRadiusMeters} min={3} suffix="meters" onChange={(v) => update(['chests', 'claimRadiusMeters'], v)} />
      <p className="muted small">Phone GPS is usually off by 5–15 m, so under ~10 m can be frustrating.</p>
      <Toggle label="Players can see chests on the map" checked={c.visibleToPlayers} onChange={(v) => update(['chests', 'visibleToPlayers'], v)} />

      <h3>Placement</h3>
      <NumberField label="Number of chests" value={c.count} min={0} max={100} onChange={(v) => update(['chests', 'count'], v)} />
      <div className="button-row">
        <button className="btn" onClick={() => update(['chests', 'items'], randomChests(Number(c.count) || 0, config.playArea, c.prizePool))}>Place randomly</button>
        <button className="btn" disabled={!map} onClick={() => {
          const { lng, lat } = map.getCenter();
          update(['chests', 'items'], [...c.items, { position: [lng, lat], prize: randomChests(1, config.playArea, c.prizePool)[0].prize }]);
        }}>+ At map center</button>
      </div>
      <p className="muted small">Drag the chest markers to move them. {c.items.length} placed.</p>
      <ul className="pick-list">
        {c.items.map((item, i) => (
          <li key={i} className="item-row">
            <span>Chest {i + 1}</span>
            <select className="grow" value={c.prizePool.findIndex((p) => p.label === item.prize?.label)}
              onChange={(e) => {
                const { weight: _w, ...prize } = c.prizePool[Number(e.target.value)];
                update(['chests', 'items', i, 'prize'], prize);
              }}>
              {c.prizePool.map((p, j) => <option key={j} value={j}>{p.label}</option>)}
              {c.prizePool.findIndex((p) => p.label === item.prize?.label) === -1 && <option value={-1}>{item.prize?.label ?? 'Prize'}</option>}
            </select>
            <button className="icon-btn" onClick={() => update(['chests', 'items'], c.items.filter((_, j) => j !== i))}>Remove</button>
          </li>
        ))}
      </ul>

      <h3>Prize pool</h3>
      <p className="muted small">Random chests pick from this list. Higher weight = more common.</p>
      {c.prizePool.map((p, i) => (
        <div key={i} className="prize-edit">
          <select value={p.type} onChange={(e) => setPool(c.prizePool.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))}>
            {Object.entries(PRIZE_TYPES).map(([type, info]) => <option key={type} value={type}>{info.name}</option>)}
          </select>
          <input value={p.label} placeholder="Label shown to players" onChange={(e) => setPool(c.prizePool.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
          <div className="button-row">
            {PRIZE_TYPES[p.type]?.hasSeconds && (
              <NumberField label="Seconds" value={p.seconds ?? 10} min={1} onChange={(v) => setPool(c.prizePool.map((x, j) => (j === i ? { ...x, seconds: v } : x)))} />
            )}
            <NumberField label="Weight" value={p.weight ?? 1} min={0} onChange={(v) => setPool(c.prizePool.map((x, j) => (j === i ? { ...x, weight: v } : x)))} />
            <button className="icon-btn" onClick={() => setPool(c.prizePool.filter((_, j) => j !== i))}>Remove</button>
          </div>
        </div>
      ))}
      <button className="btn block" onClick={() => setPool([...c.prizePool, { type: 'custom', label: 'New prize', weight: 1 }])}>+ Add prize</button>
    </>
  );
}

function ChestHandles({ map, items, onChange }) {
  const changeRef = useRef(onChange);
  const itemsRef = useRef(items);
  useEffect(() => {
    changeRef.current = onChange;
    itemsRef.current = items;
  }, [onChange, items]);

  const key = items.map((c) => c.position.join(',')).join('|');
  useEffect(() => {
    const markers = items.map((item, i) => {
      const m = new mapboxgl.Marker({ element: handleEl('chest-marker draggable', '🎁'), draggable: true })
        .setLngLat(item.position).addTo(map);
      m.on('dragend', () => {
        const { lng, lat } = m.getLngLat();
        changeRef.current(itemsRef.current.map((it, j) => (j === i ? { ...it, position: [lng, lat] } : it)));
      });
      return m;
    });
    return () => markers.forEach((m) => m.remove());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, key]);
  return null;
}

// ───────────── Teams ─────────────

function TeamsTab({ config, update }) {
  const teams = config.teams;
  return (
    <>
      <p className="muted small">Starting teams. You'll drag players into them in the lobby, and you can still add or rename teams there.</p>
      {teams.map((t, i) => (
        <div key={i} className="item-row">
          <input type="color" value={t.color} onChange={(e) => update(['teams', i, 'color'], e.target.value)} />
          <input className="grow" value={t.name} maxLength={30} onChange={(e) => update(['teams', i, 'name'], e.target.value)} />
          <button className="icon-btn" onClick={() => update(['teams'], teams.filter((_, j) => j !== i))}>Remove</button>
        </div>
      ))}
      <button className="btn block" onClick={() => update(['teams'], [...teams, { name: `Team ${teams.length + 1}`, color: CIRCLE_COLORS[teams.length % CIRCLE_COLORS.length] }])}>+ Add team</button>
    </>
  );
}
