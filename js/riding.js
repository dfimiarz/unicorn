import { rnd } from './util.js';
import { rand } from './world.js';
import { boxCollides } from './physics.js';
import { spawnParticle } from './particles.js';
import { player } from './player.js';
import { mobs, REAR_TIME } from './horse.js';
import { dragons } from './dragon.js';
import { session, send } from './net.js';

// Getting on and off horses, unicorns and dragons.

// every animal the player has ridden, for the score
export const ridden = new Set();

export function nearestMob() {
  let best = null, bd = Infinity;
  const check = (m, reach) => {
    if (m.rider || m.health === 0) return; // a dragon out of hearts is too weak to carry anyone
    const d = Math.hypot(m.pos.x - player.pos.x, m.pos.z - player.pos.z);
    if (d < reach && d < bd && Math.abs(m.pos.y - player.pos.y) < 2.5) { bd = d; best = m; }
  };
  for (const m of mobs) check(m, 3.2 * m.size);
  for (const d of dragons) check(d, 3.6);
  return best;
}
// Playing together, climbing on goes through the server, so two players can't get on the same
// animal at once: it answers with who got it, and the winner mounts (see multiplayer.js).
let asked = null; // the animal we've asked the server for, until it answers
export function tryMount(m) {
  if (!session.online) return mount(m);
  if (asked) return;
  asked = m.netId;
  send({ t: 'mount', id: m.netId });
}
export function mountAnswered(id) { if (id === asked) asked = null; }
export function getOff() {
  const m = player.riding;
  dismount();
  send({ t: 'dismount', id: m.netId });
}
// A dragon out of hearts throws its rider off, up into the air and out to the side
export function thrownOff() {
  const m = player.riding;
  getOff();
  const dx = player.pos.x - m.pos.x, dz = player.pos.z - m.pos.z, len = Math.hypot(dx, dz) || 1;
  player.vel.set(dx / len * 5, 8, dz / len * 5);
  const p = m.pos.clone(); p.y += m.seatRestY;
  for (let i = 0; i < 18; i++) spawnParticle(p, rnd(-2, 2), rnd(1, 3), rnd(-2, 2), i % 3 ? 0x6e6e6e : 0xff5a1a, rnd(0.8, 1.3), 1, rnd(1.2, 2));
}

export function mount(m) {
  player.riding = m;
  m.rider = player;
  m.h = m.riddenH; // room for the rider's head
  m.vel.set(0, 0, 0);
  m.idle = null;
  ridden.add(m);
  const p = m.pos.clone(); p.y += m.seatRestY + 0.3;
  if (m.kind === 'dragon') {
    // a snort of smoke and embers
    if (m.state === 'land') m.state = 'fly';
    else if (m.state !== 'fly') { m.state = 'idle'; m.stateT = 0; }
    for (let i = 0; i < 18; i++) spawnParticle(p, rnd(-1.5, 1.5), rnd(1, 3), rnd(-1.5, 1.5), i % 3 ? 0x8a8a8a : 0xff8a2a, rnd(0.8, 1.3), 1, rnd(1.2, 2));
    return;
  }
  m.state = 'idle';
  m.rearT = REAR_TIME; // excited to see you!
  for (let i = 0; i < 18; i++) spawnParticle(p, rnd(-1.5, 1.5), rnd(1, 3), rnd(-1.5, 1.5), i % 2 ? 0xff4f8b : 0xff9ad5, rnd(0.8, 1.3), 1, rnd(1.2, 2));
}
export function dismount() {
  const m = player.riding;
  m.rider = null; m.h = m.baseH;
  player.riding = null;
  player.vel.set(0, 0, 0);
  if (m.kind === 'dragon') m.aiTimer = 1 + rand() * 2; // a dragon left in the air soon comes down
  const rx = Math.cos(m.yaw), rz = -Math.sin(m.yaw), off = m.kind === 'dragon' ? 1.5 : 1.1 * m.size;
  for (const s of [1, -1]) {
    const px = m.pos.x + rx * s * off, pz = m.pos.z + rz * s * off;
    if (!boxCollides(px, m.pos.y, pz, player.hw, player.h)) { player.pos.set(px, m.pos.y, pz); return; }
  }
  player.pos.copy(m.pos);
}
