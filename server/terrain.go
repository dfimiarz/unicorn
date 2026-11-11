package main

import "math"

// How the world is made from its seed (a port of js/terrain.js, and of js/config.js and
// js/blocktypes.js): the island's shape, the ground, and the trees.

const (
	H     = 64 // world height
	CH    = 16 // chunk width
	WATER = 12
	REACH = 6
)

const (
	AIR = iota
	GRASS
	DIRT
	STONE
	SAND
	LOG
	PLANKS
	LEAVES
	BRICK
	RAINBOW
	BEDROCK
)

// blocks that catch fire, and how many seconds each burns before it is gone
var flammable = map[uint8]float64{LOG: 7, PLANKS: 6, LEAVES: 2.5}

// the blocks a player can place
var hotbar = []uint8{GRASS, DIRT, STONE, SAND, LOG, PLANKS, LEAVES, BRICK, RAINBOW}

func lidx(lx, y, lz int) int { return lx + lz*CH + y*CH*CH }
func inBounds(y int) bool    { return y >= 0 && y < H }

// island shape: large-scale noise decides land vs open sea; the start area is always land
func terrainHeight(x, z int) int {
	fx, fz := float64(x), float64(z)
	c := fbm(float64(fx*0.0035)+200, float64(fz*0.0035)+200, 3) + math.Max(0, 0.25-math.Sqrt(float64(fx*fx)+float64(fz*fz))/400)
	island := smooth(math.Min(1, math.Max(0, (c-0.47)/0.12)))
	h := 8 + float64(fbm(float64(fx*0.025), float64(fz*0.025), 4)*16)
	h += float64(math.Max(0, fbm(float64(fx*0.01)+50, float64(fz*0.01)+50, 4)-0.55) * 70)
	h = (WATER - 6) + float64((h-(WATER-6))*island)
	return int(math.Max(1, math.Min(H-12, math.Floor(h))))
}

func generateChunk(cx, cz int) []uint8 {
	data := make([]uint8, CH*CH*H)
	x0, z0 := cx*CH, cz*CH
	for lz := 0; lz < CH; lz++ {
		for lx := 0; lx < CH; lx++ {
			h := terrainHeight(x0+lx, z0+lz)
			beach := h <= WATER+1
			for y := 0; y <= h; y++ {
				var t uint8
				switch {
				case y == 0:
					t = BEDROCK
				case y == h:
					if beach {
						t = SAND
					} else if h > 32 {
						t = STONE
					} else {
						t = GRASS
					}
				case y > h-4:
					if beach {
						t = SAND
					} else {
						t = DIRT
					}
				default:
					t = STONE
				}
				data[lidx(lx, y, lz)] = t
			}
		}
	}
	// trees: chosen by a hash of their column, so a tree that spans a chunk border is built
	// identically from both sides (each chunk only writes the blocks inside itself)
	put := func(x, y, z int, t uint8, onlyAir bool) {
		lx, lz := x-x0, z-z0
		if lx < 0 || lx >= CH || lz < 0 || lz >= CH || !inBounds(y) {
			return
		}
		i := lidx(lx, y, lz)
		if !onlyAir || data[i] == 0 {
			data[i] = t
		}
	}
	for z := z0 - 2; z < z0+CH+2; z++ {
		for x := x0 - 2; x < x0+CH+2; x++ {
			if hash3(x, 9001, z) > 0.012 {
				continue
			}
			y := terrainHeight(x, z)
			if y <= WATER+1 || y > 32 { // only on grass
				continue
			}
			th := 4 + int(math.Floor(hash3(x, 9002, z)*3))
			top := y + th
			put(x, y, z, DIRT, false)
			for i := 1; i <= th; i++ {
				put(x, y+i, z, LOG, false)
			}
			for ly := top - 2; ly <= top+1; ly++ {
				r := 1
				if ly <= top-1 {
					r = 2
				}
				for dx := -r; dx <= r; dx++ {
					for dz := -r; dz <= r; dz++ {
						if abs(dx) == r && abs(dz) == r && (ly > top-1 || hash3(x+dx, ly, z+dz) < 0.5) {
							continue
						}
						put(x+dx, ly, z+dz, LEAVES, true)
					}
				}
			}
		}
	}
	return data
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}
