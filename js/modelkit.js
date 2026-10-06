import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { smoothstep } from './util.js';
import { ROLL_TIME } from './rules.js';

// Building blocks for the box models (player, horses, dragons), and floating name tags.

// tack colours shared by the horse and dragon models
export const LEATHER = 0x3d2312, GOLD = 0xffd86b;

const matCache = new Map(), geoCache = new Map();
function mat(color) {
  if (!matCache.has(color)) matCache.set(color, new THREE.MeshLambertMaterial({ color }));
  return matCache.get(color);
}
export function box(w, h, d, color, x, y, z, parent) {
  const key = w + ',' + h + ',' + d;
  if (!geoCache.has(key)) geoCache.set(key, new THREE.BoxGeometry(w, h, d));
  const m = new THREE.Mesh(geoCache.get(key), mat(color));
  m.castShadow = m.receiveShadow = true;
  m.position.set(x, y, z);
  m.userData.bake = true;
  parent.add(m);
  return m;
}
export function pivot(x, y, z, parent) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  return g;
}
// a group that never moves on its own (e.g. one feather), so bake() folds it into its joint
export function fixed(x, y, z, parent) {
  const g = pivot(x, y, z, parent);
  g.userData.fixed = true;
  return g;
}
// f < 1 darkens, f > 1 lightens toward white (in sRGB, so it looks even on dark and light colours)
export function shade(hex, f) {
  let out = 0;
  for (let sh = 16; sh >= 0; sh -= 8) {
    const v = (hex >> sh) & 255;
    out = out << 8 | Math.round(f < 1 ? v * f : v + (255 - v) * (f - 1));
  }
  return out;
}

// Merge the plain boxes on each joint into one vertex-coloured mesh, so a detailed model costs
// a draw call per moving part instead of one per box. Groups made with fixed() fold into their
// joint; every other group (or a mesh like the blinking eyes) is a joint of its own.
// Parts smaller than SHADOW_MIN_RADIUS (eyes, ears, glints) don't cast shadows: their shadows are
// too small to see, but each one would cost a draw call in the shadow pass every frame.
const bakedMat = new THREE.MeshLambertMaterial({ vertexColors: true });
const SHADOW_MIN_RADIUS = 0.12;
function castsShadow(geometry) {
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  return geometry.boundingSphere.radius >= SHADOW_MIN_RADIUS;
}
export function bake(joint) {
  const geos = [];
  (function collect(node, m) {
    for (const c of [...node.children]) {
      c.updateMatrix();
      const cm = new THREE.Matrix4().multiplyMatrices(m, c.matrix);
      if (c.userData.bake) {
        const g = c.geometry.clone().applyMatrix4(cm), n = g.attributes.position.count;
        const col = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) c.material.color.toArray(col, i * 3);
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        geos.push(g);
        node.remove(c);
      } else if (c.userData.fixed) { collect(c, cm); node.remove(c); }
      else {
        if (c.isMesh) c.castShadow = castsShadow(c.geometry);
        bake(c);
      }
    }
  })(joint, new THREE.Matrix4());
  if (!geos.length) return;
  const mesh = new THREE.Mesh(mergeGeometries(geos), bakedMat);
  mesh.castShadow = castsShadow(mesh.geometry);
  mesh.receiveShadow = true;
  joint.add(mesh);
}

// Barrel roll: one full turn of the body around its long axis, which runs `axisY` above the body
// pivot, easing in and out. Started by setting m.roll = { t: 0, dir } (dir 1 rolls left, -1 right);
// call after the body's pose is set each frame. m.barrel is the roll angle (0 when not rolling) and
// m.rollAxisH how high the axis is above m.pos.
const rollOff = new THREE.Vector3(), rollTilt = new THREE.Euler();
export function barrelRoll(m, dt, body, axisY) {
  m.barrel = 0;
  if (!m.roll) return;
  m.roll.t += dt / ROLL_TIME * (m.onGround ? 3 : 1); // hurry round if it touches down mid-roll
  if (m.roll.t >= 1) { m.roll = null; return; }
  const a = m.barrel = m.roll.dir * Math.PI * 2 * smoothstep(0, 1, m.roll.t);
  m.rollAxisH = (body.position.y + axisY) * body.parent.scale.y;
  body.rotation.z += a;
  // shift the body so it turns about its middle rather than the pivot
  rollOff.set(axisY * Math.sin(a), axisY * (1 - Math.cos(a)), 0).applyEuler(rollTilt.set(body.rotation.x, body.rotation.y, 0));
  body.position.add(rollOff);
}

export function nameTag(text) {
  const c = document.createElement('canvas'), ctx = c.getContext('2d');
  ctx.font = 'bold 28px monospace';
  const w = Math.ceil(ctx.measureText(text).width) + 20;
  c.width = w; c.height = 40;
  ctx.font = 'bold 28px monospace';
  ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(0, 0, w, 40);
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, 21);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex }));
  s.scale.set(w / 40 * 0.4, 0.4, 1);
  return s;
}
