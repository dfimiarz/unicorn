import * as THREE from 'three';
import { H } from './config.js';
import { wrapAngle, lerpAngle } from './util.js';
import { findLand } from './world.js';
import { scene } from './render.js';
import { Entity } from './physics.js';
import { box, pivot, bake } from './modelkit.js';
import { state } from './state.js';

// Models face -Z, so rotation.y uses the same yaw as the camera.
function makePlayerModel() {
  const root = new THREE.Group();
  root.rotation.order = 'YXZ';
  const SKIN = 0xe0ac87, SHIRT = 0x2aa5a5, PANTS = 0x3b46a8, HAIR = 0x4a2f1b;
  const legL = pivot(-0.1125, 0.675, 0, root), legR = pivot(0.1125, 0.675, 0, root);
  for (const l of [legL, legR]) { box(0.225, 0.6, 0.225, PANTS, 0, -0.3, 0, l); box(0.23, 0.08, 0.23, 0x444444, 0, -0.64, 0, l); }
  box(0.45, 0.675, 0.225, SHIRT, 0, 1.0125, 0, root);
  const armL = pivot(-0.3375, 1.35, 0, root), armR = pivot(0.3375, 1.35, 0, root);
  for (const a of [armL, armR]) { box(0.225, 0.3, 0.225, SHIRT, 0, -0.15, 0, a); box(0.22, 0.375, 0.22, SKIN, 0, -0.4875, 0, a); }
  const head = pivot(0, 1.35, 0, root);
  head.rotation.order = 'YXZ';
  box(0.45, 0.45, 0.45, SKIN, 0, 0.225, 0, head);
  box(0.47, 0.12, 0.47, HAIR, 0, 0.41, 0, head);
  box(0.47, 0.3, 0.08, HAIR, 0, 0.28, 0.2, head);
  for (const s of [-1, 1]) { box(0.09, 0.06, 0.02, 0xffffff, s * 0.1, 0.22, -0.226, head); box(0.045, 0.06, 0.025, 0x3355aa, s * 0.08, 0.22, -0.228, head); }
  box(0.14, 0.04, 0.02, 0x9a5a4a, 0, 0.1, -0.226, head);
  bake(root);
  scene.add(root);
  return { root, legL, legR, armL, armR, head };
}

export const player = new Entity(0.3, 1.8);
player.riding = null;
export const playerModel = makePlayerModel();
player.pos.copy(findLand(0, 0, 15) || findLand(0, 0, 60) || new THREE.Vector3(0.5, H - 5, 0.5));

const tmp = new THREE.Vector3();
export function updatePlayerModel(dt) {
  const pm = playerModel;
  pm.root.visible = state.camMode === 1;
  const m = player.riding;
  if (m) {
    // sit in the saddle, tilt with the animal, lean forward at a gallop, when it rears, or in flight
    const body = m.model.body, dragon = m.kind === 'dragon';
    const move = Math.min(1, Math.hypot(m.vel.x, m.vel.z) / 0.8);
    const lean = dragon ? -0.3 * m.flyW * move : -0.3 * m.gw.gallop * move - 0.45 * m.rearR;
    pm.root.rotation.set(body.rotation.x + lean, m.yaw, body.rotation.z);
    tmp.set(0, 0.675, 0).applyEuler(pm.root.rotation);
    pm.root.position.copy(m.seatWorld).sub(tmp);
    const straddle = dragon ? 0.8 : 0.6; // a dragon's back is broader
    pm.legL.rotation.set(0.4, 0, -straddle);
    pm.legR.rotation.set(0.4, 0, straddle);
    const rein = 0.75 + Math.sin(m.phase * Math.PI * 4) * 0.08 * move;
    pm.armL.rotation.set(rein, 0, 0);
    pm.armR.rotation.set(rein, 0, 0);
  } else {
    pm.root.rotation.x = pm.root.rotation.z = 0;
    pm.root.position.copy(player.pos);
    pm.root.rotation.y = lerpAngle(pm.root.rotation.y, state.yaw, dt * 10);
    const hs = Math.hypot(player.vel.x, player.vel.z);
    player.phase = (player.phase || 0) + dt * hs * 2.2;
    const a = Math.sin(player.phase) * Math.min(0.9, hs * 0.2);
    pm.legL.rotation.set(a, 0, 0);
    pm.legR.rotation.set(-a, 0, 0);
    pm.armL.rotation.set(-a, 0, 0);
    pm.armR.rotation.set(a, 0, 0);
  }
  pm.head.rotation.y = Math.max(-1.2, Math.min(1.2, wrapAngle(state.yaw - pm.root.rotation.y)));
  pm.head.rotation.x = state.pitch * 0.8;
}
