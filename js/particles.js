import * as THREE from 'three';
import { scene } from './render.js';

// A fixed pool of little cubes for sparkles, smoke, flames and block debris, drawn as one instanced
// mesh (a single draw call). Dead particles are scaled to zero. Burning trees need a lot of them.
const COUNT = 700;
const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), new THREE.MeshBasicMaterial({ color: 0xffffff }), COUNT);
mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
mesh.frustumCulled = false; // particles fly all over; the mesh's own bounds never cover them
const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
const tmpColor = new THREE.Color();
for (let i = 0; i < COUNT; i++) {
  mesh.setMatrixAt(i, hidden);
  mesh.setColorAt(i, tmpColor);
}
mesh.visible = false;
scene.add(mesh);

const particles = [];
for (let i = 0; i < COUNT; i++) particles.push({ pos: new THREE.Vector3(), vel: new THREE.Vector3(), rx: 0, ry: 0, life: 0, max: 1, grav: 0, size: 1 });
let pNext = 0, alive = 0;
export function spawnParticle(pos, vx, vy, vz, color, life, grav, size) {
  const i = pNext++ % COUNT, p = particles[i];
  if (p.life <= 0) alive++;
  p.pos.copy(pos);
  p.vel.set(vx, vy, vz);
  p.rx = p.ry = 0;
  p.life = p.max = life; p.grav = grav; p.size = size;
  mesh.setColorAt(i, tmpColor.setHex(color));
  mesh.instanceColor.needsUpdate = true;
}

const dummy = new THREE.Object3D();
export function updateParticles(dt) {
  if (!alive) return;
  for (let i = 0; i < COUNT; i++) {
    const p = particles[i];
    if (p.life <= 0) continue;
    p.life -= dt;
    if (p.life <= 0) { mesh.setMatrixAt(i, hidden); alive--; continue; }
    p.vel.y -= p.grav * dt;
    p.pos.addScaledVector(p.vel, dt);
    p.rx += dt * 3; p.ry += dt * 2;
    dummy.position.copy(p.pos);
    dummy.rotation.set(p.rx, p.ry, 0);
    dummy.scale.setScalar(p.size * (p.life / p.max));
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.visible = alive > 0;
}
