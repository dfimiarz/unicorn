import * as THREE from 'three';
import { H, CH, RENDER_DIST } from './config.js';
import { NT, tileFor, atlasTex } from './blocks.js';
import { chunks, ckey, lidx, getChunk, dirtyChunks, clearChunkCache } from './world.js';
import { scene } from './render.js';

// ---------------------------------------------------------------- chunk meshing
const FACES = [
  { dir: [-1, 0, 0], shade: 0.92, corners: [[0, 1, 0, 0, 1], [0, 0, 0, 0, 0], [0, 1, 1, 1, 1], [0, 0, 1, 1, 0]] },
  { dir: [1, 0, 0], shade: 0.92, corners: [[1, 1, 1, 0, 1], [1, 0, 1, 0, 0], [1, 1, 0, 1, 1], [1, 0, 0, 1, 0]] },
  { dir: [0, -1, 0], shade: 0.75, corners: [[1, 0, 1, 1, 0], [0, 0, 1, 0, 0], [1, 0, 0, 1, 1], [0, 0, 0, 0, 1]] },
  { dir: [0, 1, 0], shade: 1.0, corners: [[0, 1, 1, 1, 1], [1, 1, 1, 0, 1], [0, 1, 0, 1, 0], [1, 1, 0, 0, 0]] },
  { dir: [0, 0, -1], shade: 0.86, corners: [[1, 0, 0, 0, 0], [0, 0, 0, 1, 0], [1, 1, 0, 0, 1], [0, 1, 0, 1, 1]] },
  { dir: [0, 0, 1], shade: 0.86, corners: [[0, 0, 1, 0, 0], [1, 0, 1, 1, 0], [0, 1, 1, 0, 1], [1, 1, 1, 1, 1]] },
];
// Meshing reads from a padded copy of the chunk: the chunk itself plus a one-block border taken
// from its neighbours, so face culling and AO never need a per-block chunk lookup.
const PW = CH + 2, PL = PW * PW; // padded row width, padded layer size
const pad = new Uint8Array(PL * (H + 2));
const pidx = (px, y, pz) => px + pz * PW + (y + 1) * PL; // px/pz already include the +1 border
const padOff = (d) => d[0] + d[2] * PW + d[1] * PL;
// precompute the neighbour offsets used for face culling and corner ambient occlusion
for (const F of FACES) {
  const ax = F.dir[0] ? 0 : F.dir[1] ? 1 : 2, a1 = (ax + 1) % 3, a2 = (ax + 2) % 3;
  F.off = padOff(F.dir);
  F.ao = F.corners.map(c => {
    const s1 = [...F.dir], s2 = [...F.dir], cn = [...F.dir];
    s1[a1] += c[a1] * 2 - 1; s2[a2] += c[a2] * 2 - 1;
    cn[a1] += c[a1] * 2 - 1; cn[a2] += c[a2] * 2 - 1;
    return [padOff(s1), padOff(s2), padOff(cn)];
  });
}
const AO_LEVELS = [0.45, 0.65, 0.83, 1];
// lit by the sun/sky lights; vertex colours carry the baked corner AO
const terrainMat = new THREE.MeshLambertMaterial({ map: atlasTex, vertexColors: true });

function fillPad(cx, cz) {
  pad.fill(0); // the layers below y=0 and above the top stay air
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    const d = getChunk(cx + dx, cz + dz).data;
    // the part of this neighbour that falls inside the padded window (inclusive local ranges)
    const xa = dx < 0 ? CH - 1 : 0, xb = dx > 0 ? 0 : CH - 1;
    const za = dz < 0 ? CH - 1 : 0, zb = dz > 0 ? 0 : CH - 1;
    for (let y = 0; y < H; y++) for (let lz = za; lz <= zb; lz++) {
      const src = lidx(0, y, lz), dst = pidx(1 + dx * CH, y, lz + dz * CH + 1);
      for (let lx = xa; lx <= xb; lx++) pad[dst + lx] = d[src + lx];
    }
  }
}

// scratch vertex buffers, grown as needed and reused by every chunk build
let vCap = 0, sPos, sNrm, sUv, sCol, sInd;
function growScratch(need) {
  let cap = Math.max(vCap * 2, 16384);
  while (cap < need) cap *= 2;
  const grow = (old, n, T) => { const a = new T(n); if (old) a.set(old); return a; };
  sPos = grow(sPos, cap * 3, Float32Array); sNrm = grow(sNrm, cap * 3, Float32Array);
  sUv = grow(sUv, cap * 2, Float32Array); sCol = grow(sCol, cap * 3, Float32Array);
  sInd = grow(sInd, cap * 1.5, Uint32Array);
  vCap = cap;
}

function buildChunk(c) {
  fillPad(c.cx, c.cz);
  const d = c.data, ao = [0, 0, 0, 0];
  let nv = 0, ni = 0;
  // vertices are chunk-local (the mesh is placed at the chunk origin) so they stay precise far from 0,0
  for (let y = 0; y < H; y++) for (let z = 0; z < CH; z++) for (let x = 0; x < CH; x++) {
    const t = d[lidx(x, y, z)];
    if (!t) continue;
    const p = pidx(x + 1, y, z + 1);
    for (let f = 0; f < 6; f++) {
      const F = FACES[f];
      if ((f === 2 && y === 0) || pad[p + F.off]) continue; // no bottom faces under bedrock
      if (nv + 4 > vCap) growScratch(nv + 4);
      const tile = tileFor(t, f), n = nv;
      for (let i = 0; i < 4; i++) {
        const cr = F.corners[i], o = F.ao[i];
        const s1 = pad[p + o[0]] ? 1 : 0, s2 = pad[p + o[1]] ? 1 : 0, cn = pad[p + o[2]] ? 1 : 0;
        ao[i] = (s1 && s2) ? 0 : 3 - (s1 + s2 + cn);
        const s = F.shade * AO_LEVELS[ao[i]], v3 = nv * 3, v2 = nv * 2;
        sPos[v3] = x + cr[0]; sPos[v3 + 1] = y + cr[1]; sPos[v3 + 2] = z + cr[2];
        sNrm[v3] = F.dir[0]; sNrm[v3 + 1] = F.dir[1]; sNrm[v3 + 2] = F.dir[2];
        sUv[v2] = (tile + 0.002 + cr[3] * 0.996) / NT; sUv[v2 + 1] = cr[4];
        sCol[v3] = sCol[v3 + 1] = sCol[v3 + 2] = s;
        nv++;
      }
      if (ao[0] + ao[3] > ao[1] + ao[2]) { sInd[ni++] = n; sInd[ni++] = n + 1; sInd[ni++] = n + 3; sInd[ni++] = n; sInd[ni++] = n + 3; sInd[ni++] = n + 2; }
      else { sInd[ni++] = n; sInd[ni++] = n + 1; sInd[ni++] = n + 2; sInd[ni++] = n + 2; sInd[ni++] = n + 1; sInd[ni++] = n + 3; }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(sPos.slice(0, nv * 3), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(sNrm.slice(0, nv * 3), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(sUv.slice(0, nv * 2), 2));
  g.setAttribute('color', new THREE.BufferAttribute(sCol.slice(0, nv * 3), 3));
  const ind = sInd.subarray(0, ni);
  g.setIndex(new THREE.BufferAttribute(nv > 65535 ? ind.slice() : Uint16Array.from(ind), 1));
  if (c.mesh) { c.mesh.geometry.dispose(); c.mesh.geometry = g; }
  else {
    c.mesh = new THREE.Mesh(g, terrainMat);
    c.mesh.position.set(c.cx * CH, 0, c.cz * CH);
    c.mesh.castShadow = c.mesh.receiveShadow = true;
    scene.add(c.mesh);
  }
}

// ---------------------------------------------------------------- chunk streaming
// Chunks within RENDER_DIST of the player get meshes, nearest first, a few per frame. Meshes are
// freed a little further out, and the block data of unedited chunks further out still.
let centerKey = NaN, loadQueue = [];
function refreshChunks(pcx, pcz) {
  const r2 = (RENDER_DIST + 0.5) ** 2, meshOut = (RENDER_DIST + 2) ** 2, dataOut = (RENDER_DIST + 3) ** 2;
  loadQueue = [];
  for (let dz = -RENDER_DIST; dz <= RENDER_DIST; dz++) for (let dx = -RENDER_DIST; dx <= RENDER_DIST; dx++) {
    const d2 = dx * dx + dz * dz;
    if (d2 > r2) continue;
    const c = chunks.get(ckey(pcx + dx, pcz + dz));
    if (!c || !c.mesh) loadQueue.push([pcx + dx, pcz + dz, d2]);
  }
  loadQueue.sort((a, b) => b[2] - a[2]); // nearest at the end, for pop()
  for (const [k, c] of chunks) {
    const d2 = (c.cx - pcx) ** 2 + (c.cz - pcz) ** 2;
    if (c.mesh && d2 > meshOut) {
      scene.remove(c.mesh);
      c.mesh.geometry.dispose();
      c.mesh = null;
      dirtyChunks.delete(c);
    }
    if (!c.edited && d2 > dataOut) chunks.delete(k);
  }
  clearChunkCache();
}
// pos: where the player is
export function updateChunks(budgetMs, pos) {
  const pcx = Math.floor(pos.x) >> 4, pcz = Math.floor(pos.z) >> 4, k = ckey(pcx, pcz);
  if (k !== centerKey) { centerKey = k; refreshChunks(pcx, pcz); }
  for (const c of dirtyChunks) buildChunk(c);
  dirtyChunks.clear();
  const t0 = performance.now();
  while (loadQueue.length && performance.now() - t0 < budgetMs) {
    const [cx, cz] = loadQueue.pop(), c = getChunk(cx, cz);
    if (!c.mesh) buildChunk(c);
  }
}
