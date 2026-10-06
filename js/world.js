import * as THREE from 'three';
import { H, CH, WATER } from './config.js';
import { mulberry32 } from './util.js';
import { seed, setSeed, hash3, smooth, fbm } from './noise.js';
import { B } from './blocks.js';
import { session, send } from './net.js';

// The world is endless: it is stored as 16×16×H chunks that are generated from the seed the
// first time anything looks at them. Chunks far from the player are dropped again unless edited.
const CHUNK_VOL = CH * CH * H;
export const chunks = new Map(); // ckey -> { cx, cz, data, mesh, edited }
export const ckey = (cx, cz) => (cx + 0x8000) * 0x10000 + (cz + 0x8000);
export const lidx = (lx, y, lz) => lx + lz * CH + y * CH * CH;
export const inBounds = (y) => y >= 0 && y < H;

// island shape: large-scale noise decides land vs open sea; the start area is always land
export function terrainHeight(x, z) {
  const c = fbm(x * 0.0035 + 200, z * 0.0035 + 200, 3) + Math.max(0, 0.25 - Math.hypot(x, z) / 400);
  const island = smooth(Math.min(1, Math.max(0, (c - 0.47) / 0.12)));
  let h = 8 + fbm(x * 0.025, z * 0.025) * 16;
  h += Math.max(0, fbm(x * 0.01 + 50, z * 0.01 + 50) - 0.55) * 70;
  h = (WATER - 6) + (h - (WATER - 6)) * island;
  return Math.max(1, Math.min(H - 12, Math.floor(h)));
}

// Some seeds put the start out at sea or on a speck of sand. Keep drawing seeds until the start is
// a proper island: nearly all grass right around it, and mostly grass out to where the animals
// spawn. About half of all seeds qualify, and a check only samples the height function (~0.1 ms).
function grassShare(r) {
  let grass = 0, n = 0;
  for (let z = -r; z <= r; z += 4) for (let x = -r; x <= r; x += 4) {
    if (x * x + z * z > r * r) continue;
    const h = terrainHeight(x, z);
    n++;
    if (h > WATER + 1 && h <= 32) grass++; // above the beach, below the bare stone peaks
  }
  return grass / n;
}
function pickSeed() {
  let best = 0, bestScore = -1;
  for (let i = 0; i < 200; i++) {
    setSeed(Math.floor(Math.random() * 1e9));
    const near = grassShare(12), wide = grassShare(64);
    if (near >= 0.8 && wide >= 0.5) return seed;
    if (near + wide > bestScore) { bestScore = near + wide; best = seed; }
  }
  return best; // practically never reached; take the most island-like seed seen
}
// in multiplayer everyone plays in the world the first player picked
if (session.seed !== null) setSeed(session.seed);
else {
  setSeed(pickSeed());
  if (session.online) send({ t: 'seed', seed });
}
export const rand = mulberry32(seed);

function generateChunk(cx, cz) {
  const data = new Uint8Array(CHUNK_VOL), x0 = cx * CH, z0 = cz * CH;
  for (let lz = 0; lz < CH; lz++) for (let lx = 0; lx < CH; lx++) {
    const h = terrainHeight(x0 + lx, z0 + lz);
    const beach = h <= WATER + 1;
    for (let y = 0; y <= h; y++) {
      let t;
      if (y === 0) t = B.BEDROCK;
      else if (y === h) t = beach ? B.SAND : h > 32 ? B.STONE : B.GRASS;
      else if (y > h - 4) t = beach ? B.SAND : B.DIRT;
      else t = B.STONE;
      data[lidx(lx, y, lz)] = t;
    }
  }
  // trees: chosen by a hash of their column, so a tree that spans a chunk border is built
  // identically from both sides (each chunk only writes the blocks inside itself)
  const put = (x, y, z, t, onlyAir) => {
    const lx = x - x0, lz = z - z0;
    if (lx < 0 || lx >= CH || lz < 0 || lz >= CH || !inBounds(y)) return;
    const i = lidx(lx, y, lz);
    if (!onlyAir || !data[i]) data[i] = t;
  };
  for (let z = z0 - 2; z < z0 + CH + 2; z++) for (let x = x0 - 2; x < x0 + CH + 2; x++) {
    if (hash3(x, 9001, z) > 0.012) continue;
    const y = terrainHeight(x, z);
    if (y <= WATER + 1 || y > 32) continue; // only on grass
    const th = 4 + Math.floor(hash3(x, 9002, z) * 3), top = y + th;
    put(x, y, z, B.DIRT);
    for (let i = 1; i <= th; i++) put(x, y + i, z, B.LOG);
    for (let ly = top - 2; ly <= top + 1; ly++) {
      const r = ly <= top - 1 ? 2 : 1;
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        if (Math.abs(dx) === r && Math.abs(dz) === r && (ly > top - 1 || hash3(x + dx, ly, z + dz) < 0.5)) continue;
        put(x + dx, ly, z + dz, B.LEAVES, true);
      }
    }
  }
  return data;
}

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

// A change the other players should see too: one the player makes, or fire burning a block away.
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
