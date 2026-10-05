import * as THREE from 'three';
import { H, WATER, GRAVITY } from './config.js';
import { isSolid } from './world.js';

// Box collision against the blocks, gravity, swimming and steering.
export class Entity {
  constructor(hw, h) {
    this.pos = new THREE.Vector3(); this.vel = new THREE.Vector3();
    this.hw = hw; this.h = h; this.yaw = 0;
    this.onGround = false; this.hitWall = false; this.inWater = false; this.glide = false;
  }
}
export function boxCollides(px, py, pz, hw, h) {
  const x0 = Math.floor(px - hw), x1 = Math.floor(px + hw);
  const y0 = Math.floor(py), y1 = Math.floor(py + h);
  const z0 = Math.floor(pz - hw), z1 = Math.floor(pz + hw);
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++)
    if (isSolid(x, y, z)) return true;
  return false;
}
function moveAxis(e, axis, d) {
  if (d === 0) return false;
  const p = e.pos;
  p[axis] += d;
  if (!boxCollides(p.x, p.y, p.z, e.hw, e.h)) return false;
  if (axis === 'y') {
    if (d < 0) p.y = Math.floor(p.y) + 1;
    else p.y = Math.floor(p.y + e.h) - e.h - 0.001;
  } else if (d > 0) p[axis] = Math.floor(p[axis] + e.hw) - e.hw - 0.001;
  else p[axis] = Math.floor(p[axis] - e.hw) + 1 + e.hw + 0.001;
  return true;
}
export function physics(e, dt) {
  e.inWater = e.pos.y < WATER + 0.4;
  e.vel.y -= GRAVITY * dt * (e.inWater ? 0.25 : 1);
  if (e.inWater) e.vel.y = Math.max(e.vel.y, -2.5);
  if (e.glide) e.vel.y = Math.max(e.vel.y, -3);
  e.vel.y = Math.max(e.vel.y, -45);
  // if something got stuck inside blocks, pop it up
  let guard = 0;
  while (boxCollides(e.pos.x, e.pos.y, e.pos.z, e.hw, e.h) && guard++ < H) e.pos.y = Math.floor(e.pos.y) + 1;
  const maxV = Math.max(Math.abs(e.vel.x), Math.abs(e.vel.y), Math.abs(e.vel.z));
  const steps = Math.max(1, Math.ceil(maxV * dt / 0.3)), sdt = dt / steps;
  e.onGround = false; e.hitWall = false;
  for (let i = 0; i < steps; i++) {
    if (moveAxis(e, 'x', e.vel.x * sdt)) e.hitWall = true;
    if (moveAxis(e, 'z', e.vel.z * sdt)) e.hitWall = true;
    if (moveAxis(e, 'y', e.vel.y * sdt)) { if (e.vel.y < 0) e.onGround = true; e.vel.y = 0; }
  }
}
// Climbing out of the water: when something swims into a bank, find the ledge in front of it (solid
// ground with two free blocks above, up to about 2.5 blocks up) and return the upward speed that
// just clears it, or 0 if there's nothing low enough to climb onto.
export function ledgeJump(e, dx, dz) {
  const fx = Math.floor(e.pos.x + dx * (e.hw + 0.4)), fz = Math.floor(e.pos.z + dz * (e.hw + 0.4));
  const y0 = Math.floor(e.pos.y);
  for (let y = y0; y <= y0 + 3; y++) {
    if (!isSolid(fx, y - 1, fz) || isSolid(fx, y, fz) || isSolid(fx, y + 1, fz)) continue;
    const rise = y - e.pos.y;
    return rise > 0 && rise < 2.6 ? Math.sqrt(2 * GRAVITY * (rise + 0.25)) : 0;
  }
  return 0;
}
export function accelerate(e, tx, tz, dt, airControl = 4) {
  const k = 1 - Math.exp(-(e.onGround ? 14 : airControl) * dt);
  e.vel.x += (tx - e.vel.x) * k;
  e.vel.z += (tz - e.vel.z) * k;
}
