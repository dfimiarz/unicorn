// Seeded hashes and value noise for the terrain. The seed is picked in world.js (see pickSeed).
export let seed = 0;
export const setSeed = s => { seed = s; };
export function hash2(x, z) {
  let h = Math.imul(x, 374761393) + Math.imul(z, 668265263) + seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
export function hash3(x, y, z) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 1103515245) + Math.imul(z, 668265263) + seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
export const smooth = t => t * t * (3 - 2 * t);
export function valueNoise(x, z) {
  const xi = Math.floor(x), zi = Math.floor(z);
  const u = smooth(x - xi), v = smooth(z - zi);
  const a = hash2(xi, zi), b = hash2(xi + 1, zi), c = hash2(xi, zi + 1), d = hash2(xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
export function fbm(x, z, oct = 4) {
  let s = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) { s += valueNoise(x * f, z * f) * amp; norm += amp; amp *= 0.5; f *= 2; }
  return s / norm;
}
