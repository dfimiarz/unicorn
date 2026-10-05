import { findLand } from './world.js';
import { player } from './player.js';
import { makeMob, mobs, HORSE_COATS, HORSE_NAMES, UNICORN_NAMES, UNICORN_COAT } from './horse.js';
import { makeDragon, dragons, DRAGON_COLORS } from './dragon.js';

// one unicorn and one horse right next to the start, the rest scattered around the island
const near = (r) => findLand(player.pos.x, player.pos.z, r);
makeMob('unicorn', UNICORN_COAT, UNICORN_NAMES[0], near(6) || player.pos.clone());
makeMob('horse', HORSE_COATS[0], HORSE_NAMES[0], near(7) || player.pos.clone());
for (let i = 1; i < UNICORN_NAMES.length; i++) {
  const p = findLand(0, 0, 60);
  if (p) makeMob('unicorn', UNICORN_COAT, UNICORN_NAMES[i], p);
}
for (let i = 1; i < 12; i++) {
  const p = findLand(0, 0, 60);
  if (p) makeMob('horse', HORSE_COATS[i % HORSE_COATS.length], HORSE_NAMES[i % HORSE_NAMES.length], p);
}

// one dragon close enough to spot from the start, the rest out around the island
DRAGON_COLORS.forEach((c, i) => {
  const p = i === 0 ? near(22) : findLand(0, 0, 60);
  if (p) makeDragon(c, p);
});

export const totalUnicorns = mobs.filter(m => m.kind === 'unicorn').length;
export const totalHorses = mobs.length - totalUnicorns;
export const totalDragons = dragons.length;
