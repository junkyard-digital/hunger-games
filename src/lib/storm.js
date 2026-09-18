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
  const factor = clamp(storm.shrinkFactor ?? 0.6, 0.1, 0.95);
  const minR = Math.max(storm.minRadiusMeters ?? 30, 5);
  const manual = storm.circles ?? [];
  const useRandom = storm.random !== false;
  const last = useRandom && storm.finalCircle
    ? { c: storm.finalCircle.center, r: Math.max(storm.finalCircle.radiusMeters ?? minR, 5) }
    : null;

  // 1. Radii, largest first. Gamemaker-placed circles keep their own size.
  const circles = [{ c: first.c, r: first.r }];
  const floor = last ? Math.max(last.r, minR) : minR;
  for (let i = 0; circles[circles.length - 1].r > floor && circles.length < 50; i++) {
    const spec = manual[i];
    if (!spec && !useRandom) break;
    const prevR = circles[circles.length - 1].r;
    const r = Math.max(spec ? 10 : floor, Math.min(spec?.radiusMeters ?? prevR * factor, prevR));
    if (last && !spec && r <= last.r * 1.05) break; // the chosen final circle takes this slot
    circles.push({ c: spec?.center ?? null, r: Math.round(r), fixed: !!spec?.center });
  }
  if (last) circles.push({ c: last.c, r: Math.round(Math.min(last.r, circles[circles.length - 1].r)), fixed: true });

  // 2. Centres, each inside the one before it. With a chosen final circle every circle must also
  //    wrap that final circle (containment is what keeps the storm from jumping), so the centre is
  //    drawn evenly from the whole region that satisfies both — not nudged toward the target.
  for (let i = 1; i < circles.length; i++) {
    if (circles[i].c) continue;
    circles[i].c = centreInside(circles[i - 1], circles[i].r, playArea, random, last);
  }
  // Keep every circle inside the one before it, whichever way the centres were chosen.
  for (let i = 1; i < circles.length; i++) circles[i].c = pullInside(circles[i - 1], circles[i]);

  // 3. Timings.
  const plan = [{ c: circles[0].c, r: circles[0].r, revealAt: 0, shrinkStart: 0, shrinkEnd: 0 }];
  let shrinkStart = (storm.firstShrinkAfterMinutes ?? 10) * 60;
  for (let i = 1; i < circles.length; i++) {
    const shrinkSeconds = manual[i - 1]?.shrinkSeconds ?? storm.shrinkSeconds ?? 120;
    const prev = plan[plan.length - 1];
    plan.push({
      c: circles[i].c,
      r: circles[i].r,
      revealAt: prev.shrinkEnd, // players see the next circle the moment the last one settles
      shrinkStart,
      shrinkEnd: shrinkStart + shrinkSeconds,
    });
    shrinkStart += shrinkSeconds + (manual[i]?.holdSeconds ?? storm.holdSeconds ?? 240);
  }
  return plan;
}

/**
 * A centre for a circle of radius r inside `outer`, drawn evenly from everywhere it could go.
 * When `mustHold` is given (the gamemaker's final circle) the centre must also wrap that circle.
 * Candidates in the play area win; otherwise any valid centre beats none.
 */
function centreInside(outer, r, playArea, random, mustHold) {
  const slack = Math.max(outer.r - r, 0);
  const holds = (c) => !mustHold || distanceM(c, mustHold.c) <= Math.max(r - mustHold.r, 0);
  let valid = null;
  for (let i = 0; i < 400; i++) {
    const c = offset(outer.c, slack * Math.sqrt(random()), random() * 360 - 180);
    if (!holds(c)) continue;
    valid ??= c;
    if (pointInPolygon(c, playArea)) return c;
  }
  if (valid) return valid;
  // Nothing sampled worked (a final circle right at the edge): sit as close to it as allowed.
  if (!mustHold) return outer.c;
  const need = distanceM(outer.c, mustHold.c) - Math.max(r - mustHold.r, 0);
  return need > 0 ? offset(outer.c, Math.min(need, slack), turf.bearing(outer.c, mustHold.c)) : outer.c;
}

/** Nudges a circle's centre until it is fully inside the previous circle. */
function pullInside(outer, circle) {
  const allowed = Math.max(outer.r - circle.r, 0);
  const d = distanceM(outer.c, circle.c);
  if (d <= allowed) return circle.c;
  return offset(outer.c, allowed, turf.bearing(outer.c, circle.c));
}

const offset = (c, metres, bearing) =>
  turf.destination(c, metres / 1000, bearing, { units: 'kilometers' }).geometry.coordinates;

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
