import * as THREE from 'three';
import { H, CH, WATER } from './config.js';
import { mulberry32 } from './util.js';
import { seed, setSeed } from './noise.js';
import { lidx, inBounds, pickSeed, generateChunk } from './terrain.js';
import { B } from './blocks.js';
import { session, send } from './net.js';

// The world is endless: it is stored as 16×16×H chunks that are generated from the seed the
// first time anything looks at them. Chunks far from the player are dropped again unless edited.
export const chunks = new Map(); // ckey -> { cx, cz, data, mesh, edited }
export const ckey = (cx, cz) => (cx + 0x8000) * 0x10000 + (cz + 0x8000);
export { lidx, inBounds, terrainHeight } from './terrain.js';

// in multiplayer everyone plays in the world the first player picked
if (session.seed !== null) setSeed(session.seed);
else {
  setSeed(pickSeed());
  if (session.online) send({ t: 'seed', seed });
}
export const rand = mulberry32(seed);

let cacheKey = -1, cacheChunk = null; // block lookups hit the same chunk over and over
export function getChunk(cx, cz) {
  const k = ckey(cx, cz);
  if (k === cacheKey) return cacheChunk;
  let c = chunks.get(k);
  if (!c) chunks.set(k, c = { cx, cz, data: generateChunk(cx, cz), mesh: null, edited: false });
  cacheKey = k; cacheChunk = c;
  return c;
}
export const getBlock = (x, y, z) => inBounds(y) ? getChunk(x >> 4, z >> 4).data[lidx(x & 15, y, z & 15)] : 0;
export function isSolid(x, y, z) {
  if (y < 0) return true;
  if (y >= H) return false;
  return getBlock(x, y, z) !== 0;
}
export function columnTop(x, z) {
  const d = getChunk(x >> 4, z >> 4).data, lx = x & 15, lz = z & 15;
  for (let y = H - 1; y >= 0; y--) if (d[lidx(lx, y, lz)]) return y;
  return -1;
}
// call after removing chunks from the map, so the lookup cache never hands back a dropped chunk
export function clearChunkCache() { cacheKey = -1; }

// chunks whose mesh needs rebuilding (see meshing.js)
export const dirtyChunks = new Set();
export function setBlock(x, y, z, t) {
  if (!inBounds(y)) return;
  const c = getChunk(x >> 4, z >> 4);
  c.data[lidx(x & 15, y, z & 15)] = t;
  c.edited = true; // edited chunks are kept in memory when they are out of range
  // rebuild this chunk plus any neighbour whose AO/faces touch the block
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const n = getChunk((x + dx) >> 4, (z + dz) >> 4);
    if (n.mesh) dirtyChunks.add(n);
  }
}

// A change the player makes, which the other players should see too
export function editBlock(x, y, z, t) {
  setBlock(x, y, z, t);
  send({ t: 'edit', x, y, z, b: t });
}

// a random grass-topped spot within r blocks of (cx, cz), standing on the ground
export function findLand(cx, cz, r) {
  for (let i = 0; i < 400; i++) {
    const x = Math.floor(cx + (rand() * 2 - 1) * r), z = Math.floor(cz + (rand() * 2 - 1) * r);
    const t = columnTop(x, z);
    if (t > WATER + 1 && getBlock(x, t, z) === B.GRASS) return new THREE.Vector3(x + 0.5, t + 1, z + 0.5);
  }
  return null;
}
