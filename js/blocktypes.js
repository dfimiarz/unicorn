// The kinds of block, which burn, and which can be placed. Kept apart from blocks.js (their look),
// so the server can use them too (see server.js).
export const B = { AIR: 0, GRASS: 1, DIRT: 2, STONE: 3, SAND: 4, LOG: 5, PLANKS: 6, LEAVES: 7, BRICK: 8, RAINBOW: 9, BEDROCK: 10 };
// blocks that catch fire (see rules.js), and how many seconds each burns before it is gone
export const FLAMMABLE = { [B.LOG]: 7, [B.PLANKS]: 6, [B.LEAVES]: 2.5 };
export const HOTBAR = [B.GRASS, B.DIRT, B.STONE, B.SAND, B.LOG, B.PLANKS, B.LEAVES, B.BRICK, B.RAINBOW];
