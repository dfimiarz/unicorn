import * as THREE from 'three';
import { rnd } from './util.js';
import { B, FLAMMABLE } from './blocks.js';
import { getBlock, setBlock } from './world.js';
import { session, send, on } from './net.js';
import { Fire } from './rules.js';
import { raycast } from './camera.js';
import { spawnParticle } from './particles.js';

// Blocks on fire. What catches, spreads and burns away follows the rules in rules.js. Playing
// together the server decides all of that: a dragon's breath asks it to light the blocks it
// reaches, and everyone is told about every block that catches, so they can show its flames, and
// sees it burn away as an ordinary block change. Playing alone the game decides it here.
export const FIRE_COLORS = [0xfff3a0, 0xffd23a, 0xffb02a, 0xff8a2a, 0xff5a1a, 0xe8341a];
const FLAME_RATE = 8; // flames a second from each burning block

const tmp = new THREE.Vector3();
const fire = new Fire({
  getBlock,
  burnAway: (x, y, z) => setBlock(x, y, z, B.AIR), // only when playing alone
  // gone, in a last puff of smoke and embers if it burnt away
  onGone(f) {
    if (getBlock(f.x, f.y, f.z) !== B.AIR) return;
    tmp.set(f.x + 0.5, f.y + 0.5, f.z + 0.5);
    for (let i = 0; i < 6; i++) spawnParticle(tmp, rnd(-1, 1), rnd(0.5, 2), rnd(-1, 1), i % 3 ? 0x5a5a5a : 0xff8a2a, rnd(0.8, 1.4), -0.6, rnd(1.6, 2.6));
  },
}, !session.online);

const asked = new Map(); // block -> when we last asked the server to light it (the breath hits it every frame)
export function ignite(x, y, z) {
  if (fire.decides) return fire.light(x, y, z);
  const k = x + ',' + y + ',' + z, now = performance.now();
  if (now - (asked.get(k) ?? -1e9) < 1000) return;
  if (asked.size > 500) asked.clear();
  asked.set(k, now);
  send({ t: 'ignite', x, y, z });
}
// a block catching, as the server tells us, or burning for t seconds already (catching up on joining)
export const light = (x, y, z, t) => fire.light(x, y, z, t);
on('burn', m => light(m.x, m.y, m.z));
// is any block from (x0, y0, z0) to (x1, y1, z1) on fire?
export const fireIn = (x0, y0, z0, x1, y1, z1) => fire.fireIn(x0, y0, z0, x1, y1, z1);
export { fire };

// Fire breathed from `from` along the unit vector `dir`: lights the first block within `range`,
// if it burns. Anything solid stops the flames.
export function scorch(from, dir, range) {
  const hit = raycast(from, dir, range);
  if (hit) ignite(hit.x, hit.y, hit.z);
}

export function updateFire(dt) {
  fire.decides = !session.online; // if the server goes, carry on alone and decide fires here
  fire.update(dt);
  // flames lick up off each burning block, catching quickly and dying down at the end
  for (const f of fire.burning.values()) {
    const s = f.t / FLAMMABLE[f.type], strength = Math.max(0, Math.min(1, f.t * 3, (1 - s) * 5));
    for (f.acc += dt * FLAME_RATE * strength; f.acc >= 1; f.acc--) {
      tmp.set(f.x + rnd(0.05, 0.95), f.y + rnd(0.3, 1.05), f.z + rnd(0.05, 0.95));
      const smoke = Math.random() < 0.15;
      spawnParticle(tmp, rnd(-0.3, 0.3), smoke ? rnd(1, 1.8) : rnd(0.8, 2), rnd(-0.3, 0.3),
        smoke ? 0x6e6e6e : FIRE_COLORS[Math.floor(Math.random() * FIRE_COLORS.length)],
        smoke ? rnd(1, 1.6) : rnd(0.4, 0.8), smoke ? -0.5 : -1.5, smoke ? rnd(2.4, 3.6) : rnd(2.6, 4.4));
    }
  }
}
