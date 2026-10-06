import * as THREE from 'three';
import { WATER } from './config.js';
import { rnd } from './util.js';
import { isSolid } from './world.js';
import { scene } from './render.js';
import { spawnParticle } from './particles.js';

// Bubbles, as blown by Bubbles the potato dragon (see potato.js): see-through, faintly tinted
// spheres with a glint of light on them, that float along, slow down, wobble, drift up a little,
// and pop when they touch a block, the sea or a dragon, or when they've floated long enough. Drawn
// as two instanced meshes (the bubbles and their glints), so a whole stream of them is two draw
// calls. Like the flames, every computer blows its own from where the dragon is aiming; the
// computer running a dragon decides whether bubbles hurt it (see dragon.js).
const COUNT = 220;
const TINTS = [0xd8f4ff, 0xf6dcff, 0xdcffee, 0xfff0dc, 0xe4e0ff];
const DRAG = 1.1;     // how quickly they slow down, a second
const RISE = 0.9;     // how quickly they drift up, in blocks a second a second, while slowing
const sphere = new THREE.SphereGeometry(1, 14, 10);
const mesh = new THREE.InstancedMesh(sphere, new THREE.MeshPhongMaterial({
  color: 0xffffff, transparent: true, opacity: 0.38, shininess: 120, specular: 0xffffff, depthWrite: false,
}), COUNT);
const glints = new THREE.InstancedMesh(sphere, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false }), COUNT);
const hidden = new THREE.Matrix4().makeScale(0, 0, 0), color = new THREE.Color();
for (const m of [mesh, glints]) {
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  m.frustumCulled = false; // they float all over; the meshes' own bounds never cover them
  m.renderOrder = 1;       // after the solid world, so it shows through them
  for (let i = 0; i < COUNT; i++) m.setMatrixAt(i, hidden);
  m.visible = false;
  scene.add(m);
}
for (let i = 0; i < COUNT; i++) mesh.setColorAt(i, color.setHex(TINTS[i % TINTS.length]));

const bubbles = [];
for (let i = 0; i < COUNT; i++) bubbles.push({ pos: new THREE.Vector3(), vel: new THREE.Vector3(), r: 0, life: 0, age: 0, owner: null, wob: 0 });
let next = 0, alive = 0;

// A bubble of radius r at pos, floating off at vel, blown by `owner` (it doesn't pop on them).
export function blowBubble(pos, vel, r, owner) {
  const b = bubbles[next++ % COUNT];
  if (b.life <= 0) alive++;
  b.pos.copy(pos); b.vel.copy(vel);
  b.r = r; b.life = rnd(2.2, 3); b.age = 0; b.owner = owner; b.wob = Math.random() * 6;
}

function pop(b) {
  b.life = 0; alive--;
  for (let i = 0; i < 5; i++) spawnParticle(b.pos, rnd(-1.5, 1.5), rnd(-0.5, 1.5), rnd(-1.5, 1.5), i % 2 ? 0xffffff : TINTS[i % TINTS.length], rnd(0.15, 0.3), 3, b.r * 2.5);
}

// Pops every bubble (but the dragon's own) within r of `at`, and says how many there were.
export function popBubblesNear(at, r, dragon) {
  if (!alive) return 0;
  let n = 0;
  for (const b of bubbles) {
    if (b.life <= 0 || b.owner === dragon) continue;
    const reach = r + b.r;
    if (b.pos.distanceToSquared(at) < reach * reach) { pop(b); n++; }
  }
  return n;
}

const dummy = new THREE.Object3D(), glintOff = new THREE.Vector3();
export function updateBubbles(dt, camera) {
  if (!alive) { mesh.visible = glints.visible = false; return; }
  const drag = Math.exp(-DRAG * dt);
  // the glint sits on the side of each bubble facing up and toward the camera, where the sky shines on it
  camera.getWorldDirection(glintOff).multiplyScalar(-0.45);
  glintOff.y += 0.5;
  for (let i = 0; i < COUNT; i++) {
    const b = bubbles[i];
    if (b.life <= 0) { mesh.setMatrixAt(i, hidden); glints.setMatrixAt(i, hidden); continue; }
    b.age += dt;
    b.vel.multiplyScalar(drag);
    b.vel.y += RISE * dt;
    b.pos.addScaledVector(b.vel, dt);
    const { x, y, z } = b.pos;
    if ((b.life -= dt) <= 0 || y < WATER + 0.5 || isSolid(Math.floor(x), Math.floor(y), Math.floor(z))) {
      pop(b); mesh.setMatrixAt(i, hidden); glints.setMatrixAt(i, hidden); continue;
    }
    // they swell out of the mouth, then wobble as they go
    const grow = Math.min(1, b.age * 6), w = Math.sin(b.age * 9 + b.wob) * 0.07;
    dummy.position.copy(b.pos);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(b.r * grow * (1 + w), b.r * grow * (1 - w), b.r * grow * (1 + w));
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    dummy.position.addScaledVector(glintOff, b.r * grow);
    dummy.scale.setScalar(b.r * grow * 0.18);
    dummy.updateMatrix();
    glints.setMatrixAt(i, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = glints.instanceMatrix.needsUpdate = true;
  mesh.visible = glints.visible = alive > 0;
}
