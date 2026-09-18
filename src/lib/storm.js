import * as turf from '@turf/turf';
import { coveringCircle, distanceM, pointInPolygon } from './geo';

/**
 * Builds the full storm plan. Gamemaker-placed circles come first, in order. After those, if
 * `storm.random` isn't false, circles are rolled randomly (each inside the previous) until
 * minRadiusMeters; otherwise the last placed circle is the final one.
 *
 * The same `seed` always produces the same random circles, so the preview in the editor stays put
 * until the gamemaker asks for a re-roll, and the game starts with the plan they were shown.
 *
 * Output format is shared with the database (private.storm_at):
 *   [{ c: [lng, lat], r, revealAt, shrinkStart, shrinkEnd }]  — times in seconds since the game started.
 */
export function buildStormPlan(storm, playArea, seed = randomSeed()) {
  const random = mulberry32(seed);
  const first = coveringCircle(playArea);
  const plan = [{ ...first, revealAt: 0, shrinkStart: 0, shrinkEnd: 0 }];
  const factor = clamp(storm.shrinkFactor ?? 0.6, 0.1, 0.95);
  const minR = Math.max(storm.minRadiusMeters ?? 30, 5);
  const manual = storm.circles ?? [];
  const useRandom = storm.random !== false;
  // Optional gamemaker-chosen last circle. Random circles are kept around it so the storm converges there.
  const last = useRandom && storm.finalCircle
    ? { c: storm.finalCircle.center, r: Math.max(storm.finalCircle.radiusMeters ?? minR, 5) }
    : null;

  const floor = last ? Math.max(last.r, minR) : minR;
  let shrinkStart = (storm.firstShrinkAfterMinutes ?? 10) * 60;
  for (let i = 0; plan[plan.length - 1].r > floor && i < 50; i++) {
    const spec = manual[i];
    if (!spec && !useRandom) break; // gamemaker-placed circles only
    const prev = plan[plan.length - 1];
    const r = Math.max(spec ? 10 : floor, Math.min(spec?.radiusMeters ?? prev.r * factor, prev.r));
    if (last && !spec && r <= last.r * 1.05) break; // close enough; the final circle comes next
    const c = spec?.center ?? randomCenterInside(prev, r, playArea, random, last);
    const shrinkSeconds = spec?.shrinkSeconds ?? storm.shrinkSeconds ?? 120;
    plan.push({
      c,
      r: Math.round(r),
      revealAt: prev.shrinkEnd, // players see the next circle the moment the last one settles
      shrinkStart,
      shrinkEnd: shrinkStart + shrinkSeconds,
    });
    shrinkStart += shrinkSeconds + (manual[i + 1]?.holdSeconds ?? storm.holdSeconds ?? 240);
  }

  if (last) {
    const prev = plan[plan.length - 1];
    const shrinkSeconds = storm.shrinkSeconds ?? 120;
    plan.push({
      c: last.c,
      r: Math.round(Math.min(last.r, prev.r)),
      revealAt: prev.shrinkEnd,
      shrinkStart,
      shrinkEnd: shrinkStart + shrinkSeconds,
    });
  }
  return plan;
}

export const randomSeed = () => Math.floor(Math.random() * 2 ** 32);

/** Small seeded generator, so a given seed always lays out the same circles. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

/**
 * Picks the centre of the next circle: inside the previous one, preferably inside the play area, and
 * — when the gamemaker chose a final circle — still wrapped around that final circle.
 */
function randomCenterInside(prev, r, playArea, random, last) {
  const slack = Math.max(prev.r - r, 0);
  const holdsLast = (c) => !last || distanceM(c, last.c) <= Math.max(r - last.r, 0);
  let best = null;
  for (let i = 0; i < 80; i++) {
    const d = slack * Math.sqrt(random());
    const c = turf.destination(prev.c, d / 1000, random() * 360 - 180, { units: 'kilometers' }).geometry.coordinates;
    if (!holdsLast(c)) continue;
    best ??= c;
    if (pointInPolygon(c, playArea)) return c;
  }
  // Nothing random worked: step straight toward the final circle (or stay put).
  if (!last) return best ?? prev.c;
  const need = distanceM(prev.c, last.c) - Math.max(r - last.r, 0);
  return best ?? (need > 0
    ? turf.destination(prev.c, need / 1000, turf.bearing(prev.c, last.c), { units: 'kilometers' }).geometry.coordinates
    : prev.c);
}

/** Storm state at time t (seconds since start). Mirrors private.storm_at in SQL. */
export function stormAt(plan, t) {
  if (!plan?.length) return null;
  let settled = 0, shrinking = 0, revealed = 0;
  for (let i = 1; i < plan.length; i++) {
    if (t >= plan[i].revealAt) revealed = i;
    if (t >= plan[i].shrinkStart) shrinking = i;
    if (t >= plan[i].shrinkEnd) settled = i;
  }
  const cur = plan[settled];
  let center = cur.c, radius = cur.r;
  if (shrinking > settled) {
    const nxt = plan[shrinking];
    const f = (t - nxt.shrinkStart) / Math.max(nxt.shrinkEnd - nxt.shrinkStart, 0.001);
    center = [cur.c[0] + (nxt.c[0] - cur.c[0]) * f, cur.c[1] + (nxt.c[1] - cur.c[1]) * f];
    radius = cur.r + (nxt.r - cur.r) * f;
  }

  const upcoming = plan[settled + 1];
  let phase, secondsLeft = null, label;
  if (!upcoming) {
    phase = 'final';
    label = 'Final circle';
  } else if (shrinking > settled) {
    phase = 'shrinking';
    secondsLeft = upcoming.shrinkEnd - t;
    label = 'Storm closing';
  } else {
    phase = 'waiting';
    secondsLeft = upcoming.shrinkStart - t;
    label = settled === 0 ? 'Storm arrives in' : 'Storm moves in';
  }

  return {
    center,
    radius,
    phase,
    label,
    secondsLeft,
    // The circle players should head toward, once it's been revealed.
    target: upcoming && revealed > settled ? { center: upcoming.c, radius: upcoming.r } : null,
    // Only show haze once the storm has actually started shrinking at least once.
    active: shrinking > 0,
    settled,
  };
}

export function isInStorm(state, point) {
  return !!(state && point && distanceM(state.center, point) > state.radius);
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
