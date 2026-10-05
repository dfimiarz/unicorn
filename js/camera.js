import * as THREE from 'three';
import { REACH } from './config.js';
import { getBlock } from './world.js';
import { scene, camera } from './render.js';
import { player } from './player.js';
import { state } from './state.js';

// Camera placement and finding the block under the crosshair.
export function lookDir() {
  return new THREE.Vector3(-Math.sin(state.yaw) * Math.cos(state.pitch), Math.sin(state.pitch), -Math.cos(state.yaw) * Math.cos(state.pitch));
}
export function eyePos() {
  if (player.riding) {
    // follow the saddle up and down, but only half as much so the camera isn't too bouncy
    const m = player.riding, seatLift = m.seatWorld.y - (m.pos.y + m.seatRestY);
    return new THREE.Vector3(m.pos.x, m.pos.y + m.seatRestY + 0.94 + seatLift * 0.5, m.pos.z);
  }
  return new THREE.Vector3(player.pos.x, player.pos.y + 1.62, player.pos.z);
}
export function raycast(o, d, maxD) {
  let x = Math.floor(o.x), y = Math.floor(o.y), z = Math.floor(o.z);
  const sx = Math.sign(d.x), sy = Math.sign(d.y), sz = Math.sign(d.z);
  const tdx = d.x ? Math.abs(1 / d.x) : Infinity, tdy = d.y ? Math.abs(1 / d.y) : Infinity, tdz = d.z ? Math.abs(1 / d.z) : Infinity;
  let tmx = d.x > 0 ? (x + 1 - o.x) * tdx : d.x < 0 ? (o.x - x) * tdx : Infinity;
  let tmy = d.y > 0 ? (y + 1 - o.y) * tdy : d.y < 0 ? (o.y - y) * tdy : Infinity;
  let tmz = d.z > 0 ? (z + 1 - o.z) * tdz : d.z < 0 ? (o.z - z) * tdz : Infinity;
  let nx = 0, ny = 0, nz = 0, t = 0;
  while (t <= maxD) {
    if (getBlock(x, y, z)) return { x, y, z, nx, ny, nz };
    if (tmx < tmy && tmx < tmz) { x += sx; t = tmx; tmx += tdx; nx = -sx; ny = 0; nz = 0; }
    else if (tmy < tmz) { y += sy; t = tmy; tmy += tdy; nx = 0; ny = -sy; nz = 0; }
    else { z += sz; t = tmz; tmz += tdz; nx = 0; ny = 0; nz = -sz; }
  }
  return null;
}
export const highlight = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1.004, 1.004, 1.004)),
  new THREE.LineBasicMaterial({ color: 0x000000 })
);
scene.add(highlight);
export let target = null; // the block the player is looking at, or null

const tmp = new THREE.Vector3();
export function updateCamera() {
  const eye = eyePos();
  const dir = lookDir();
  camera.rotation.set(state.pitch, state.yaw, 0);
  if (state.camMode === 1) {
    // pull the camera back behind the player, stopping short of any block in the way
    const m = player.riding;
    const maxDist = !m ? 4 : m.kind === 'dragon' ? 8 : 6 * m.size;
    let d = 0;
    while (d < maxDist) {
      tmp.copy(eye).addScaledVector(dir, -(d + 0.3));
      if (tmp.y < 0 || getBlock(Math.floor(tmp.x), Math.floor(tmp.y), Math.floor(tmp.z))) break;
      d += 0.1;
    }
    camera.position.copy(eye).addScaledVector(dir, -d);
  } else {
    camera.position.copy(eye);
  }

  target = raycast(eye, dir, REACH);
  highlight.visible = !!target;
  if (target) highlight.position.set(target.x + 0.5, target.y + 0.5, target.z + 0.5);
}
