package main

import "testing"

// A tree on fire burns away entirely: the flames spread block to block through it.
func TestFireBurnsATree(t *testing.T) {
	world := map[pos3]uint8{}
	for y := 1; y <= 3; y++ {
		world[pos3{0, y, 0}] = LOG
	}
	world[pos3{0, 4, 0}] = LEAVES
	world[pos3{5, 1, 5}] = LOG // not touching: must survive
	f := newFire()
	f.getBlock = func(x, y, z int) uint8 { return world[pos3{x, y, z}] }
	f.burnAway = func(x, y, z int) { delete(world, pos3{x, y, z}) }
	lit := 0
	f.onLight = func(*flame) { lit++ }
	if !f.light(0, 1, 0, 0) || f.light(0, 0, 0, 0) {
		t.Fatal("a log should light and air should not")
	}
	for i := 0; i < 400 && len(f.burning) > 0; i++ {
		f.update(0.1)
	}
	if len(world) != 1 || world[pos3{5, 1, 5}] != LOG {
		t.Errorf("world after the fire: %v", world)
	}
	if lit != 4 {
		t.Errorf("%d blocks caught, want 4", lit)
	}
}

func TestDragonHurtsAndHeals(t *testing.T) {
	d := &Dragon{health: dragonHearts}
	hurtOrHeal(d, 0.1, true)
	hurtOrHeal(d, 0.1, true) // still in the cooldown
	if d.health != dragonHearts-1 {
		t.Fatalf("health %d, want %d", d.health, dragonHearts-1)
	}
	for i := 0; i < 200; i++ {
		hurtOrHeal(d, 0.1, false)
	}
	if d.health != dragonHearts {
		t.Errorf("health %d after resting, want %d", d.health, dragonHearts)
	}
	d.roll = &rollState{}
	d.hurtCd = 0
	hurtOrHeal(d, 0.1, true)
	if d.health != dragonHearts {
		t.Error("a dragon in a barrel roll should not be hurt")
	}
}
