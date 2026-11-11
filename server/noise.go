package main

import "math"

// Seeded hashes and value noise for the terrain: a port of js/noise.js that gives the same numbers,
// bit for bit, so the server builds the same world as every player's browser.
//
// Every product that feeds a sum is wrapped in float64(): without it Go may fuse `a*b + c` into a
// single instruction on some CPUs (arm64), which rounds differently from JavaScript.

var seed int64

func hash2(x, z int) float64 {
	h := uint32(x)*374761393 + uint32(z)*668265263 + uint32(seed)
	h = (h ^ (h >> 13)) * 1274126177
	return float64(h^(h>>16)) / 4294967296
}

func hash3(x, y, z int) float64 {
	h := uint32(x)*374761393 + uint32(y)*1103515245 + uint32(z)*668265263 + uint32(seed)
	h = (h ^ (h >> 13)) * 1274126177
	return float64(h^(h>>16)) / 4294967296
}

func smooth(t float64) float64 { return float64(t*t) * (3 - float64(2*t)) }

func valueNoise(x, z float64) float64 {
	xf, zf := math.Floor(x), math.Floor(z)
	xi, zi := int(xf), int(zf)
	u, v := smooth(x-xf), smooth(z-zf)
	a, b, c, d := hash2(xi, zi), hash2(xi+1, zi), hash2(xi, zi+1), hash2(xi+1, zi+1)
	return a + float64((b-a)*u) + float64((c-a)*v) + float64(float64((a-b-c+d)*u)*v)
}

func fbm(x, z float64, oct int) float64 {
	s, amp, f, norm := 0.0, 0.5, 1.0, 0.0
	for i := 0; i < oct; i++ {
		s += float64(valueNoise(float64(x*f), float64(z*f)) * amp)
		norm += amp
		amp *= 0.5
		f *= 2
	}
	return s / norm
}
