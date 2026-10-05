// World and gameplay constants.
export const H = 64, CH = 16; // world height, chunk width (CH must stay 16: block lookups use >> 4 and & 15)
export const RENDER_DIST = 8;  // chunks meshed around the player; the fog hides everything past ~130 blocks
export const CHUNK_BUDGET_MS = 4; // time per frame spent building newly visible chunks
export const MOB_ACTIVE_DIST = (RENDER_DIST - 1) * CH; // animals further away than this pause
export const WATER = 12;
export const GRAVITY = 28;
export const REACH = 6;
