import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

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
const bakedMat = new THREE.MeshLambertMaterial({ vertexColors: true });
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
      else bake(c);
    }
  })(joint, new THREE.Matrix4());
  if (!geos.length) return;
  const mesh = new THREE.Mesh(mergeGeometries(geos), bakedMat);
  mesh.castShadow = mesh.receiveShadow = true;
  joint.add(mesh);
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
