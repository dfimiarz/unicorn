import * as THREE from 'three';
import { mulberry32 } from './util.js';

// Block types, their colours and the texture atlas they are drawn from.
export const B = { AIR: 0, GRASS: 1, DIRT: 2, STONE: 3, SAND: 4, LOG: 5, PLANKS: 6, LEAVES: 7, BRICK: 8, RAINBOW: 9, BEDROCK: 10 };
export const BLOCK_NAMES = { 1: 'Grass', 2: 'Dirt', 3: 'Stone', 4: 'Sand', 5: 'Wood', 6: 'Planks', 7: 'Leaves', 8: 'Brick', 9: 'Rainbow' };
export const BLOCK_COLORS = { 1: 0x5f9f35, 2: 0x86604a, 3: 0x808080, 4: 0xdcd0a0, 5: 0x69523a, 6: 0xaa8852, 7: 0x377d28, 8: 0x9b4837, 9: 0xff80c0, 10: 0x333333 };
// blocks that catch fire (see fire.js), and how many seconds each burns before it is gone
export const FLAMMABLE = { [B.LOG]: 7, [B.PLANKS]: 6, [B.LEAVES]: 2.5 };
export const HOTBAR = [B.GRASS, B.DIRT, B.STONE, B.SAND, B.LOG, B.PLANKS, B.LEAVES, B.BRICK, B.RAINBOW];
export const RAINBOW_RGB = [[255, 80, 80], [255, 160, 60], [255, 230, 80], [100, 220, 100], [90, 160, 255], [180, 110, 255]];
export const RAINBOW_HEX = [0xff5050, 0xffa03c, 0xffe650, 0x64dc64, 0x5aa0ff, 0xb46eff];

// face order: -x, +x, -y, +y, -z, +z
export function tileFor(t, f) {
  switch (t) {
    case B.GRASS: return f === 3 ? 0 : f === 2 ? 2 : 1;
    case B.DIRT: return 2;
    case B.STONE: return 3;
    case B.SAND: return 4;
    case B.LOG: return (f === 2 || f === 3) ? 6 : 5;
    case B.LEAVES: return 7;
    case B.PLANKS: return 8;
    case B.BRICK: return 9;
    case B.RAINBOW: return 10;
    case B.BEDROCK: return 11;
  }
  return 3;
}
export const ICON_TILE = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 8, 7: 7, 8: 9, 9: 10 };

export const TS = 16, NT = 12;
export const atlas = document.createElement('canvas');
atlas.width = TS * NT; atlas.height = TS;
const actx = atlas.getContext('2d');
const trand = mulberry32(1234);
const vary = (c, amt) => { const k = 1 + (trand() - 0.5) * amt; return [c[0] * k, c[1] * k, c[2] * k]; };
function paint(tile, fn) {
  const img = actx.createImageData(TS, TS);
  for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
    const [r, g, b] = fn(x, y), i = (y * TS + x) * 4;
    img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
  }
  actx.putImageData(img, tile * TS, 0);
}
const grassColor = () => vary([95, 159, 53], 0.3);
const dirtColor = () => trand() < 0.1 ? vary([100, 70, 48], 0.2) : vary([134, 96, 67], 0.25);
const grassEdge = Array.from({ length: TS }, () => 3 + Math.floor(trand() * 3));
paint(0, grassColor);
paint(1, (x, y) => y < grassEdge[x] ? grassColor() : dirtColor());
paint(2, dirtColor);
paint(3, () => trand() < 0.12 ? vary([100, 100, 100], 0.2) : vary([128, 128, 128], 0.2));
paint(4, () => vary([220, 208, 160], 0.12));
paint(5, x => vary(x % 4 === 0 ? [80, 62, 38] : [105, 82, 50], 0.2));
paint(6, (x, y) => {
  if (x === 0 || y === 0 || x === 15 || y === 15) return vary([90, 70, 42], 0.2);
  const d = Math.hypot(x - 7.5, y - 7.5);
  return vary(Math.floor(d) % 2 ? [165, 135, 85] : [140, 110, 65], 0.1);
});
paint(7, () => { const r = trand(); return r < 0.15 ? vary([30, 80, 25], 0.2) : r < 0.3 ? vary([80, 160, 60], 0.2) : vary([55, 125, 40], 0.25); });
paint(8, (x, y) => {
  const row = Math.floor(y / 4), seam = (x + row * 5) % 16 === 0;
  return (y % 4 === 3 || seam) ? vary([110, 85, 50], 0.15) : vary([170, 136, 82], 0.12);
});
paint(9, (x, y) => {
  const off = Math.floor(y / 4) % 2 ? 4 : 0;
  return (y % 4 === 3 || (x + off) % 8 === 7) ? vary([190, 185, 175], 0.1) : vary([155, 72, 55], 0.2);
});
paint(10, (x, y) => vary(RAINBOW_RGB[Math.floor(y * 6 / 16)], 0.08));
paint(11, () => trand() < 0.5 ? vary([40, 40, 40], 0.3) : vary([85, 85, 85], 0.3));

export const atlasTex = new THREE.CanvasTexture(atlas);
atlasTex.magFilter = THREE.NearestFilter;
atlasTex.minFilter = THREE.NearestFilter;
atlasTex.generateMipmaps = false;
atlasTex.colorSpace = THREE.SRGBColorSpace;
