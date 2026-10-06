import { H, CH, WATER } from './config.js';
import { seed, setSeed, hash3, smooth, fbm } from './noise.js';
import { B } from './blocktypes.js';

// How the world is made from its seed: the island's shape, the ground, and the trees. Shared by the
// game (world.js) and the server, which builds the same world to check what players do in it.
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
export function pickSeed() {
  let best = 0, bestScore = -1;
  for (let i = 0; i < 200; i++) {
    setSeed(Math.floor(Math.random() * 1e9));
    const near = grassShare(12), wide = grassShare(64);
    if (near >= 0.8 && wide >= 0.5) return seed;
    if (near + wide > bestScore) { bestScore = near + wide; best = seed; }
  }
  return best; // practically never reached; take the most island-like seed seen
}
export function generateChunk(cx, cz) {
  const data = new Uint8Array(CH * CH * H), x0 = cx * CH, z0 = cz * CH;
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
