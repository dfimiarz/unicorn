import * as THREE from 'three';
import { scene } from './render.js';

// A fixed pool of little cubes for sparkles, smoke and block debris.
const particles = [];
const pGeo = new THREE.BoxGeometry(0.1, 0.1, 0.1);
for (let i = 0; i < 260; i++) {
  const m = new THREE.Mesh(pGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }));
  m.visible = false;
  scene.add(m);
  particles.push({ m, vel: new THREE.Vector3(), life: 0, max: 1, grav: 0, size: 1 });
}
let pNext = 0;
export function spawnParticle(pos, vx, vy, vz, color, life, grav, size) {
  const p = particles[pNext++ % particles.length];
  p.m.position.copy(pos);
  p.vel.set(vx, vy, vz);
  p.m.material.color.setHex(color);
  p.life = p.max = life; p.grav = grav; p.size = size;
  p.m.scale.setScalar(size);
  p.m.visible = true;
}
export function updateParticles(dt) {
  for (const p of particles) {
    if (p.life <= 0) continue;
    p.life -= dt;
    if (p.life <= 0) { p.m.visible = false; continue; }
    p.vel.y -= p.grav * dt;
    p.m.position.addScaledVector(p.vel, dt);
    p.m.scale.setScalar(p.size * (p.life / p.max));
    p.m.rotation.x += dt * 3; p.m.rotation.y += dt * 2;
  }
}
