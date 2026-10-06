import * as THREE from 'three';
import { rnd } from './util.js';
import { B, FLAMMABLE } from './blocks.js';
import { getBlock, editBlock } from './world.js';
import { session, send, on } from './net.js';
import { raycast } from './camera.js';
import { spawnParticle } from './particles.js';

// Blocks on fire. A flammable block (see FLAMMABLE in blocks.js) that a dragon's fire touches
// catches light, burns with flames and smoke, now and then sets a flammable neighbour alight, and
// finally burns away, lighting everything touching it as it goes. So a whole tree goes up, but the
// fire doesn't jump across to a tree whose leaves don't touch it.
//
// Playing together, the host's computer decides what catches, spreads and burns away. Everyone else
// asks the host to light the blocks their dragon's breath reaches, is told about every block that
// catches so they can show its flames, and sees it burn away as an ordinary block change.
export const FIRE_COLORS = [0xfff3a0, 0xffd23a, 0xffb02a, 0xff8a2a, 0xff5a1a, 0xe8341a];
const MAX_BURNING = 80;    // keeps the flames within the particle pool
const FLAME_RATE = 8;      // flames a second from each burning block
const SPREAD_CHANCE = 0.8; // chance a second of trying to light a neighbour
const FACES = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0], [0, 1, 0]];

const burning = new Map(); // "x,y,z" -> { x, y, z, type, t, acc }

const asked = new Map(); // block -> when we last asked the host to light it (the breath hits it every frame)
export function ignite(x, y, z) {
  if (!session.isHost) {
    const k = x + ',' + y + ',' + z, now = performance.now();
    if (now - (asked.get(k) ?? -1e9) < 1000) return;
    if (asked.size > 500) asked.clear();
    asked.set(k, now);
    return send({ t: 'ignite', x, y, z });
  }
  if (light(x, y, z)) send({ t: 'burn', x, y, z });
}
// sets a block alight, or one that has been burning for t seconds already (catching up on joining)
export function light(x, y, z, t = 0) {
  const type = getBlock(x, y, z), k = x + ',' + y + ',' + z;
  if (!FLAMMABLE[type] || burning.has(k) || burning.size >= MAX_BURNING) return false;
  burning.set(k, { x, y, z, type, t, acc: Math.random() });
  return true;
}
// is any block from (x0, y0, z0) to (x1, y1, z1) on fire?
export function fireIn(x0, y0, z0, x1, y1, z1) {
  if (!burning.size) return false;
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++)
    if (burning.has(x + ',' + y + ',' + z)) return true;
  return false;
}
on('ignite', m => ignite(m.x, m.y, m.z)); // another player's dragon, asking the host
on('burn', m => light(m.x, m.y, m.z));    // the host saying a block caught

// Fire breathed from `from` along the unit vector `dir`: lights the first block within `range`,
// if it burns. Anything solid stops the flames.
export function scorch(from, dir, range) {
  const hit = raycast(from, dir, range);
  if (hit) ignite(hit.x, hit.y, hit.z);
}

const tmp = new THREE.Vector3();
export function updateFire(dt) {
  for (const [k, f] of burning) {
    if (getBlock(f.x, f.y, f.z) !== f.type) { burning.delete(k); continue; } // broken or replaced
    f.t += dt;
    const life = FLAMMABLE[f.type], s = f.t / life;
    if (s >= 1) {
      // the host burns it away and everyone gets the block change; this is in case that never comes
      if (!session.isHost) { if (s > 1.5) burning.delete(k); continue; }
      // burnt away, in a last puff of smoke and embers
      editBlock(f.x, f.y, f.z, B.AIR);
      burning.delete(k);
      for (const [dx, dy, dz] of FACES) ignite(f.x + dx, f.y + dy, f.z + dz);
      tmp.set(f.x + 0.5, f.y + 0.5, f.z + 0.5);
      for (let i = 0; i < 6; i++) spawnParticle(tmp, rnd(-1, 1), rnd(0.5, 2), rnd(-1, 1), i % 3 ? 0x5a5a5a : 0xff8a2a, rnd(0.8, 1.4), -0.6, rnd(1.6, 2.6));
      continue;
    }
    // flames lick up off the block, catching quickly and dying down at the end
    const strength = Math.min(1, f.t * 3, (1 - s) * 5);
    for (f.acc += dt * FLAME_RATE * strength; f.acc >= 1; f.acc--) {
      tmp.set(f.x + rnd(0.05, 0.95), f.y + rnd(0.3, 1.05), f.z + rnd(0.05, 0.95));
      const smoke = Math.random() < 0.15;
      spawnParticle(tmp, rnd(-0.3, 0.3), smoke ? rnd(1, 1.8) : rnd(0.8, 2), rnd(-0.3, 0.3),
        smoke ? 0x6e6e6e : FIRE_COLORS[Math.floor(Math.random() * FIRE_COLORS.length)],
        smoke ? rnd(1, 1.6) : rnd(0.4, 0.8), smoke ? -0.5 : -1.5, smoke ? rnd(2.4, 3.6) : rnd(2.6, 4.4));
    }
    if (session.isHost && Math.random() < dt * SPREAD_CHANCE) {
      const [dx, dy, dz] = FACES[Math.floor(Math.random() * FACES.length)];
      ignite(f.x + dx, f.y + dy, f.z + dz);
    }
  }
}
