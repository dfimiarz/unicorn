import * as THREE from 'three';
import { H } from './config.js';
import { lerpAngle, rnd } from './util.js';
import { B, BLOCK_COLORS, RAINBOW_HEX, HOTBAR } from './blocks.js';
import { getBlock, editBlock, inBounds } from './world.js';
import { physics, accelerate, ledgeJump } from './physics.js';
import { spawnParticle } from './particles.js';
import { player } from './player.js';
import { mobs } from './horse.js';
import { dragons, rideDragon, aimDragon } from './dragon.js';
import { nearestMob, tryMount, getOff, thrownOff } from './riding.js';
import { target, eyePos, lookDir } from './camera.js';
import { keys, isLocked } from './input.js';
import { selected, selectSlot, toggleFps } from './hud.js';
import { state } from './state.js';

// What the player does: walking, steering a ridden animal, and breaking and placing blocks.

// ---------------------------------------------------------------- blocks
function overlapsBlock(e, x, y, z) {
  return e.pos.x + e.hw > x && e.pos.x - e.hw < x + 1 && e.pos.y + e.h > y && e.pos.y < y + 1 && e.pos.z + e.hw > z && e.pos.z - e.hw < z + 1;
}
function breakBlock() {
  if (!target || target.y === 0) return; // bedrock floor stays
  const t = getBlock(target.x, target.y, target.z);
  editBlock(target.x, target.y, target.z, B.AIR);
  const c = new THREE.Vector3(target.x + 0.5, target.y + 0.5, target.z + 0.5);
  for (let i = 0; i < 12; i++) {
    const col = t === B.RAINBOW ? RAINBOW_HEX[i % 6] : BLOCK_COLORS[t];
    spawnParticle(c, rnd(-2, 2), rnd(1, 4), rnd(-2, 2), col, rnd(0.4, 0.8), 15, rnd(0.9, 1.5));
  }
}
function placeBlock() {
  if (!target) return;
  const x = target.x + target.nx, y = target.y + target.ny, z = target.z + target.nz;
  if (!inBounds(y) || getBlock(x, y, z)) return;
  if (overlapsBlock(player.riding || player, x, y, z)) return;
  for (const m of mobs) if (overlapsBlock(m, x, y, z)) return;
  for (const d of dragons) if (overlapsBlock(d, x, y, z)) return;
  editBlock(x, y, z, HOTBAR[selected]);
}

// ---------------------------------------------------------------- key + mouse actions
addEventListener('keydown', e => {
  // F3 works while paused too, and must not open the browser's find bar
  if (e.code === 'F3') { e.preventDefault(); if (!e.repeat) toggleFps(); return; }
  if (!isLocked() || e.repeat) return;
  if (e.code === 'KeyE') {
    if (player.riding) getOff();
    else { const m = nearestMob(); if (m) tryMount(m); }
  }
  if (e.code === 'KeyV') state.camMode = 1 - state.camMode;
  if (e.code === 'KeyB') {
    // a barrel roll, only while flying: toward the right if D is held, otherwise to the left
    // (dragons have to wait out a cooldown between rolls, see dragon.js)
    const m = player.riding;
    const flying = m && (m.kind === 'dragon' ? m.state === 'fly' : m.kind === 'unicorn' && m.airTime > 0.25);
    if (flying && !m.roll && !(m.rollCd > 0)) m.roll = { t: 0, dir: keys.KeyD || keys.ArrowRight ? -1 : 1 };
  }
  if (e.code.startsWith('Digit')) {
    const n = +e.code.slice(5);
    if (n >= 1 && n <= HOTBAR.length) selectSlot(n - 1);
  }
});
addEventListener('mousedown', e => {
  if (!isLocked()) return;
  if (e.button === 0 && player.riding?.kind !== 'dragon') breakBlock(); // on a dragon it breathes fire instead
  if (e.button === 2) placeBlock();
});
addEventListener('wheel', e => {
  if (!isLocked()) return;
  selectSlot((selected + (e.deltaY > 0 ? 1 : -1) + HOTBAR.length) % HOTBAR.length);
});

// ---------------------------------------------------------------- movement
export function updatePlayer(dt) {
  const locked = isLocked();
  let f = 0, s = 0;
  if (locked) {
    if (keys.KeyW || keys.ArrowUp) f += 1;
    if (keys.KeyS || keys.ArrowDown) f -= 1;
    if (keys.KeyD || keys.ArrowRight) s += 1;
    if (keys.KeyA || keys.ArrowLeft) s -= 1;
  }
  const space = locked && keys.Space;
  const shift = locked && (keys.ShiftLeft || keys.ShiftRight);
  let mx = -Math.sin(state.yaw) * f + Math.cos(state.yaw) * s;
  let mz = -Math.cos(state.yaw) * f - Math.sin(state.yaw) * s;
  const len = Math.hypot(mx, mz);
  if (len > 0) { mx /= len; mz /= len; }

  if (player.riding?.health === 0) thrownOff();
  const m = player.riding;
  if (m && m.rearT > 0) { mx = mz = 0; } // hold on while it rears
  if (m && m.kind === 'dragon') {
    m.breathing = locked && keys.Mouse0;
    aimDragon(m, eyePos(), lookDir(), dt);
    rideDragon(m, dt, mx, mz, f < 0, space, shift);
    player.pos.copy(m.pos);
    player.vel.set(0, 0, 0);
  } else if (m) {
    const len = Math.hypot(mx, mz);
    const sp = m.speed * (f < 0 ? 0.5 : 1) * (m.inWater ? 0.4 : 1);
    if (len > 0) m.yaw = lerpAngle(m.yaw, Math.atan2(-mx, -mz), dt * 8);
    m.glide = false;
    if (m.kind === 'unicorn') {
      accelerate(m, mx * sp, mz * sp, dt, 8);
      if (space) m.vel.y = Math.min(m.vel.y + 40 * dt, 7);
      else if (shift) m.vel.y = -8;
      else if (!m.onGround) m.glide = true;
      if (m.pos.y > H + 30) m.vel.y = Math.min(m.vel.y, 0);
    } else {
      accelerate(m, mx * sp, mz * sp, dt, 3);
      if (space && m.onGround) m.vel.y = 10;
      // swimming only ever pushes up, so it can't cut short a jump, and climbs out up a bank
      if (space && m.inWater) m.vel.y = Math.max(m.vel.y, 3, m.hitWall && len > 0 ? ledgeJump(m, mx, mz) : 0);
    }
    if (m.hitWall && m.onGround && len > 0) m.vel.y = 10; // hop up single blocks
    if (m.inWater && !space) m.vel.y = Math.max(m.vel.y, 1.5);
    physics(m, dt);
    player.pos.copy(m.pos);
    player.vel.set(0, 0, 0);
  } else {
    const sp = (shift ? 6.5 : 4.3) * (player.inWater ? 0.5 : 1);
    accelerate(player, mx * sp, mz * sp, dt);
    if (space) {
      if (player.onGround) player.vel.y = 8.6;
      // swimming only ever pushes up, so it can't cut short a jump off the sea floor; swimming
      // into a bank climbs out onto it
      if (player.inWater) player.vel.y = Math.max(player.vel.y, 3.5, player.hitWall && len > 0 ? ledgeJump(player, mx, mz) : 0);
    }
    physics(player, dt);
  }
}
