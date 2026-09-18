import * as turf from '@turf/turf';

/** Accepts a GeoJSON Feature, FeatureCollection, Polygon geometry, or raw coordinates; returns Polygon coordinates. */
export function toPolygonCoords(input) {
  if (!input) return null;
  if (Array.isArray(input)) return input;
  if (input.type === 'FeatureCollection') {
    const poly = input.features.find((f) => f.geometry?.type === 'Polygon');
    return poly ? poly.geometry.coordinates : null;
  }
  if (input.type === 'Feature') return toPolygonCoords(input.geometry);
  if (input.type === 'Polygon') return input.coordinates;
  if (input.type === 'MultiPolygon') return input.coordinates[0];
  return null;
}

export function boxCoords([west, south, east, north]) {
  return [[[west, south], [east, south], [east, north], [west, north], [west, south]]];
}

/** Returns [west, south, east, north] if the polygon is an axis-aligned box, otherwise null. */
export function asBox(coords) {
  const ring = coords?.[0];
  if (!ring || coords.length !== 1 || ring.length !== 5) return null;
  const [w, s, e, n] = turf.bbox(turf.polygon(coords));
  const onEdge = ring.every(([x, y]) => (x === w || x === e) && (y === s || y === n));
  return onEdge ? [w, s, e, n] : null;
}

export const distanceM = (a, b) => turf.distance(a, b, { units: 'meters' });

export const pointInPolygon = (pt, coords) => turf.booleanPointInPolygon(pt, turf.polygon(coords));

export const circlePolygon = (center, radiusM, steps = 96) =>
  turf.circle(center, radiusM / 1000, { steps, units: 'kilometers' });

/** Everything outside a circle: the storm haze. */
export function outsideCircle(center, radiusM) {
  const world = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]];
  const hole = circlePolygon(center, radiusM).geometry.coordinates[0].slice().reverse();
  return turf.polygon([world, hole]);
}

/** Smallest circle (centered on the bbox) that covers the whole play area. */
export function coveringCircle(coords) {
  const [w, s, e, n] = turf.bbox(turf.polygon(coords));
  const c = [(w + e) / 2, (s + n) / 2];
  const r = Math.max(...coords[0].map((p) => distanceM(c, p)));
  return { c, r: Math.ceil(r) };
}

/** Closest point on a circle's edge to a point (the "go here" target). */
export function nearestPointOnCircle(center, radiusM, point) {
  const bearing = turf.bearing(center, point);
  return turf.destination(center, radiusM / 1000, bearing, { units: 'kilometers' }).geometry.coordinates;
}

export function randomPointInPolygon(coords) {
  const [w, s, e, n] = turf.bbox(turf.polygon(coords));
  for (let i = 0; i < 500; i++) {
    const p = [w + Math.random() * (e - w), s + Math.random() * (n - s)];
    if (pointInPolygon(p, coords)) return p;
  }
  return [(w + e) / 2, (s + n) / 2];
}

export function formatDistance(m) {
  if (m == null) return '';
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

export function formatClock(totalSeconds) {
  const s = Math.max(0, Math.ceil(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Returns a point at least `minGapM` from every point in `taken`, walking outward in a spiral
 * from where it was asked for. Keeps chests dropped at the same map centre from stacking up.
 */
export function spreadFrom(point, taken, minGapM = 25) {
  const clear = (p) => taken.every((t) => distanceM(t, p) >= minGapM);
  if (clear(point)) return point;
  for (let i = 1; i <= 60; i++) {
    const ring = 1 + Math.floor((i - 1) / 8);
    const candidate = turf.destination(point, (minGapM * ring) / 1000, (i * 137.5) % 360, { units: 'kilometers' })
      .geometry.coordinates;
    if (clear(candidate)) return candidate;
  }
  return point;
}
