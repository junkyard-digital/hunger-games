import { toPolygonCoords } from './geo';

export async function loadDefaultConfig() {
  const res = await fetch('/game.config.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('Could not load game.config.json');
  return normalizeConfig(await res.json());
}

/** Fills in defaults and converts the play area to plain Polygon coordinates. */
export function normalizeConfig(raw) {
  const playArea = toPolygonCoords(raw.playArea);
  if (!playArea) throw new Error('playArea must be a GeoJSON Polygon (Feature, geometry, or coordinates)');
  return {
    name: raw.name ?? 'Hunger Games',
    playArea,
    rules: {
      maxNameLength: 16,
      showAliveCount: true,
      allowLateJoin: false,
      stormDeathSeconds: 10,
      darkAfterSeconds: 15,
      locationIntervalSeconds: 3,
      text: [],
      ...raw.rules,
    },
    storm: {
      firstShrinkAfterMinutes: 10,
      holdSeconds: 240,
      shrinkSeconds: 120,
      shrinkFactor: 0.6,
      minRadiusMeters: 30,
      random: true,
      finalCircle: null,
      circles: [],
      ...raw.storm,
    },
    chests: {
      claimRadiusMeters: 20,
      visibleToPlayers: true,
      items: [],
      prizePool: [],
      ...raw.chests,
    },
    teams: raw.teams ?? [],
  };
}

/** Converts back to a shareable game.config.json (GeoJSON play area). */
export function exportConfig(config) {
  return {
    ...config,
    playArea: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: config.playArea } },
  };
}
