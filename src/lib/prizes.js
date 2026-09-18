import { randomPointInPolygon, spreadFrom } from './geo';

/** Built-in prize types. Anything else is treated as "custom": the gamemaker is notified when it's used. */
export const PRIZE_TYPES = {
  reveal_enemy: { name: 'Reveal one enemy', needsTarget: true, hasSeconds: true },
  reveal_all_enemies: { name: 'Reveal all enemies', hasSeconds: true },
  storm_shield: { name: 'Storm shield', hasSeconds: true },
  custom: { name: 'Custom (redeem with gamemaker)' },
};

export const prizeInfo = (prize) => PRIZE_TYPES[prize?.type] ?? PRIZE_TYPES.custom;

export function pickPrize(pool) {
  const total = pool.reduce((sum, p) => sum + (p.weight ?? 1), 0);
  let roll = Math.random() * total;
  for (const p of pool) {
    roll -= p.weight ?? 1;
    if (roll <= 0) return stripWeight(p);
  }
  return stripWeight(pool[0]);
}

function stripWeight({ weight: _weight, ...prize }) {
  return prize;
}

/** One chest, placed clear of the ones already down so markers don't stack up. */
export function newChest(position, playArea, pool, existing = []) {
  const taken = existing.map((c) => c.position);
  return {
    position: spreadFrom(position ?? randomPointInPolygon(playArea), taken),
    prize: pool.length ? pickPrize(pool) : { type: 'custom', label: 'Mystery prize' },
  };
}
