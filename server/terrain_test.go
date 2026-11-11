package main

import "testing"

// Checksums made by running js/terrain.js itself: the server's world has to match the browsers'
// exactly, or it would reject block changes that are fine (or allow ones that aren't).
var goldenChunks = [][2]int{{0, 0}, {-1, -1}, {5, -7}, {-20, 13}, {100, 100}, {-300, 250}, {1000, -1000}}

var golden = []struct {
	seed    int64
	heights uint32 // terrainHeight over a wide grid
	chunks  []uint32
}{
	{1, 3900791295, []uint32{2629862341, 2629862341, 2629862341, 2629862341, 3972991502, 3591128599, 2626128775}},
	{42, 742429528, []uint32{2629862341, 2629862341, 2629862341, 2629862341, 2629862341, 2629862341, 2013721902}},
	{123456789, 633021494, []uint32{3141513453, 359643028, 2760906160, 1317623050, 3640847135, 2629862341, 3182502145}},
	{999999999, 1508559614, []uint32{2697685798, 804076248, 2629862341, 2629862341, 538601362, 3855801610, 2629862341}},
	{-5, 3632980855, []uint32{746124447, 3089234860, 2629862341, 2382399197, 1596415718, 3756920423, 530644710}},
	{-2147483648, 3138996127, []uint32{3874206766, 4292349860, 2629862341, 2629862341, 1485019679, 2123121050, 2629862341}},
	{2147483648, 3138996127, []uint32{3874206766, 4292349860, 2629862341, 2629862341, 1485019679, 2123121050, 2629862341}},
}

func fnv(d []uint8) uint32 {
	h := uint32(2166136261)
	for _, b := range d {
		h = (h ^ uint32(b)) * 16777619
	}
	return h
}

func TestTerrainMatchesBrowser(t *testing.T) {
	for _, g := range golden {
		seed = g.seed
		var hs uint32
		for z := -3000; z <= 3000; z += 37 {
			for x := -3000; x <= 3000; x += 41 {
				hs = hs*31 + uint32(terrainHeight(x, z))
			}
		}
		if hs != g.heights {
			t.Errorf("seed %d: heights %d, want %d", g.seed, hs, g.heights)
		}
		for i, c := range goldenChunks {
			if got := fnv(generateChunk(c[0], c[1])); got != g.chunks[i] {
				t.Errorf("seed %d chunk %v: %d, want %d", g.seed, c, got, g.chunks[i])
			}
		}
	}
}
