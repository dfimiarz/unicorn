import { FLAMMABLE } from './blocktypes.js';

// The rules that decide what happens: fires catching, spreading and burning blocks away, and
// dragons losing hearts to fire and bubbles, healing, and waiting out their barrel-roll cooldown.
// Playing together the server runs them (server.js) and tells everyone what happened, so nobody can
// change them from their browser; playing alone the game runs them itself (fire.js, dragon.js).
// Nothing here draws anything, and it all works on plain numbers, so it runs the same in Node.

// ---------------------------------------------------------------- fire
// A flammable block that fire touches catches light, now and then sets a flammable neighbour
// alight, and finally burns away, lighting everything touching it as it goes. So a whole tree goes
// up, but the fire doesn't jump across to a tree whose leaves don't touch it.
export const MAX_BURNING = 80; // keeps the flames within the particle pool
const SPREAD_CHANCE = 0.8;     // chance a second of trying to light a neighbour
const FACES = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0], [0, 1, 0]];

// The blocks on fire in a world reached through `world`:
//   getBlock(x, y, z)  the block there
//   burnAway(x, y, z)  a block has burnt away: make it air
//   onLight(f)         (optional) a block has caught, from light() or from the fire spreading
//   onGone(f)          (optional) a block is no longer burning: burnt away, broken or replaced
// `decides` is whether this side spreads fires and burns blocks away (the server, or the game when
// playing alone), or only keeps track of the fires it's told about, to show them.
export class Fire {
  constructor(world, decides) {
    this.world = world;
    this.decides = decides;
    this.burning = new Map(); // "x,y,z" -> { x, y, z, type, t (seconds alight), acc }
  }
  // sets a block alight, or one that has been burning for t seconds already
  light(x, y, z, t = 0) {
    const type = this.world.getBlock(x, y, z), k = x + ',' + y + ',' + z;
    if (!FLAMMABLE[type] || this.burning.has(k) || this.burning.size >= MAX_BURNING) return false;
    const f = { x, y, z, type, t, acc: Math.random() };
    this.burning.set(k, f);
    this.world.onLight?.(f);
    return true;
  }
  // is any block from (x0, y0, z0) to (x1, y1, z1) on fire?
  fireIn(x0, y0, z0, x1, y1, z1) {
    if (!this.burning.size) return false;
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++)
      if (this.burning.has(x + ',' + y + ',' + z)) return true;
    return false;
  }
  update(dt) {
    for (const [k, f] of this.burning) {
      if (this.world.getBlock(f.x, f.y, f.z) !== f.type) { this.burning.delete(k); this.world.onGone?.(f); continue; }
      f.t += dt;
      const s = f.t / FLAMMABLE[f.type];
      if (s >= 1) {
        // whoever decides burns it away and everyone else gets the block change; this is in case
        // that never comes
        if (!this.decides) { if (s > 1.5) this.burning.delete(k); continue; }
        this.burning.delete(k);
        this.world.burnAway(f.x, f.y, f.z);
        this.world.onGone?.(f);
        for (const [dx, dy, dz] of FACES) this.light(f.x + dx, f.y + dy, f.z + dz);
        continue;
      }
      if (this.decides && Math.random() < dt * SPREAD_CHANCE) {
        const [dx, dy, dz] = FACES[Math.floor(Math.random() * FACES.length)];
        this.light(f.x + dx, f.y + dy, f.z + dz);
      }
    }
  }
}

// ---------------------------------------------------------------- dragons
// Fire or bubbles cost a dragon a heart, at most one every HURT_COOLDOWN seconds, whether it's
// another dragon's breath or burning blocks it flies or walks through. Out of hearts, it throws its
// rider off and can't be ridden until it has healed a heart. Left alone it heals. A dragon in a
// barrel roll spins clear and isn't hurt; rolls have a cooldown once they finish, which grows the
// more it spins: each roll adds one to its dizziness, which wears off by one every DIZZY_TIME
// seconds, and the cooldown is ROLL_COOLDOWN seconds for each.
export const DRAGON_HEARTS = 10;
const HURT_COOLDOWN = 1, HEAL_DELAY = 8, HEAL_TIME = 3; // seconds
export const ROLL_TIME = 0.9;                           // seconds a barrel roll takes
const ROLL_COOLDOWN = 0.6, DIZZY_TIME = 4;
export const BREATH_RANGE = { fire: 7, bubbles: 8 };    // how far each reaches, in blocks
// each sort of dragon's size, by what it breathes: half its width, and its height alone and with
// a rider on (big T-rex dragons breathe fire; Bubbles the potato dragon blows bubbles)
export const DRAGON_SIZE = { fire: { hw: 0.6, h: 2.3, riddenH: 3.4 }, bubbles: { hw: 0.85, h: 1.9, riddenH: 3.5 } };
const HIT_RADIUS = 1.5; // around the dragon's middle; it widens along the breath

// the way a dragon breathes, from the way it faces (yaw) and its aim, into `out`
export function breathDir(yaw, aimYaw, aimPitch, out) {
  const a = yaw + aimYaw, cp = Math.cos(aimPitch);
  out.x = -Math.sin(a) * cp; out.y = Math.sin(aimPitch); out.z = -Math.cos(a) * cp;
  return out;
}

// Is dragon d in another dragon's breath (from o.fireFrom along o.fireDir, as far as
// o.breathRange, widening as it goes), or in or touching a burning block? Each dragon needs pos,
// baseH and h (its height now), and breathOn, fireFrom, fireDir and breathRange.
export function inBreath(d, dragons, fire) {
  const cx = d.pos.x, cy = d.pos.y + d.baseH / 2, cz = d.pos.z;
  for (const o of dragons) {
    if (o === d || !o.breathOn) continue;
    const vx = cx - o.fireFrom.x, vy = cy - o.fireFrom.y, vz = cz - o.fireFrom.z;
    const t = vx * o.fireDir.x + vy * o.fireDir.y + vz * o.fireDir.z, r = HIT_RADIUS + t * 0.15;
    if (t > 0 && t < o.breathRange + HIT_RADIUS && vx * vx + vy * vy + vz * vz - t * t < r * r) return true;
  }
  const x = d.pos.x, z = d.pos.z;
  return fire.fireIn(Math.floor(x - 1.5), Math.floor(d.pos.y - 0.5), Math.floor(z - 1.5), Math.floor(x + 1.5), Math.floor(d.pos.y + d.h), Math.floor(z + 1.5));
}

// A heart lost (if `hit`) or healed. Needs health, hurtCd, healT, and roll (set while rolling).
export function hurtOrHeal(d, dt, hit) {
  d.hurtCd -= dt;
  if (d.hurtCd <= 0 && d.health > 0 && !d.roll && hit) {
    d.health--;
    d.hurtCd = HURT_COOLDOWN; d.healT = HEAL_DELAY;
  } else if (d.health < DRAGON_HEARTS && (d.healT -= dt) <= 0) {
    d.health++; d.healT = HEAL_TIME;
  }
}

// Counts each roll as it starts, and the cooldown down once it's over. Needs roll (set while
// rolling), rollCounted, dizzy and rollCd.
export function rollCooldown(d, dt) {
  if (d.roll && !d.rollCounted) { d.dizzy++; d.rollCd = ROLL_COOLDOWN * d.dizzy; }
  d.rollCounted = !!d.roll;
  if (!d.roll) d.rollCd = Math.max(0, d.rollCd - dt);
  d.dizzy = Math.max(0, d.dizzy - dt / DIZZY_TIME);
}
