package main

import (
	"math"
	"math/rand"
	"time"
)

// The rules that decide what happens (a port of js/rules.js): fires catching, spreading and burning
// blocks away, and dragons losing hearts to fire and bubbles, healing, and waiting out their
// barrel-roll cooldown. Playing together the server runs them and tells everyone what happened, so
// nobody can change them from their browser.

// ---------------------------------------------------------------- fire
// A flammable block that fire touches catches light, now and then sets a flammable neighbour
// alight, and finally burns away, lighting everything touching it as it goes. So a whole tree goes
// up, but the fire doesn't jump across to a tree whose leaves don't touch it.
const (
	maxBurning   = 80  // keeps the flames within the particle pool
	spreadChance = 0.8 // chance a second of trying to light a neighbour
)

var faces = [6][3]int{{1, 0, 0}, {-1, 0, 0}, {0, 0, 1}, {0, 0, -1}, {0, -1, 0}, {0, 1, 0}}

type pos3 struct{ x, y, z int }

type flame struct {
	pos  pos3
	kind uint8
	t    float64 // seconds alight
	dead bool
}

type Fire struct {
	getBlock func(x, y, z int) uint8
	burnAway func(x, y, z int) // a block has burnt away: make it air
	onLight  func(f *flame)    // a block has caught, from light() or from the fire spreading
	burning  map[pos3]*flame
	order    []*flame // the flames in the order they caught, so each tick visits them the same way
}

func newFire() *Fire { return &Fire{burning: map[pos3]*flame{}} }

// sets a block alight, or one that has been burning for t seconds already
func (f *Fire) light(x, y, z int, t float64) bool {
	kind, k := f.getBlock(x, y, z), pos3{x, y, z}
	if _, ok := flammable[kind]; !ok || f.burning[k] != nil || len(f.burning) >= maxBurning {
		return false
	}
	fl := &flame{pos: k, kind: kind, t: t}
	f.burning[k] = fl
	f.order = append(f.order, fl)
	f.onLight(fl)
	return true
}

func (f *Fire) douse(fl *flame) { fl.dead = true; delete(f.burning, fl.pos) }

// is any block from (x0, y0, z0) to (x1, y1, z1) on fire?
func (f *Fire) fireIn(x0, y0, z0, x1, y1, z1 int) bool {
	if len(f.burning) == 0 {
		return false
	}
	for y := y0; y <= y1; y++ {
		for z := z0; z <= z1; z++ {
			for x := x0; x <= x1; x++ {
				if f.burning[pos3{x, y, z}] != nil {
					return true
				}
			}
		}
	}
	return false
}

func (f *Fire) update(dt float64) {
	for i := 0; i < len(f.order); i++ { // (flames that catch during the tick get their turn in it too)
		fl := f.order[i]
		if fl.dead {
			continue
		}
		p := fl.pos
		if f.getBlock(p.x, p.y, p.z) != fl.kind {
			f.douse(fl)
			continue
		}
		fl.t += dt
		if fl.t/flammable[fl.kind] >= 1 {
			f.douse(fl)
			f.burnAway(p.x, p.y, p.z)
			for _, d := range faces {
				f.light(p.x+d[0], p.y+d[1], p.z+d[2], 0)
			}
			continue
		}
		if rand.Float64() < dt*spreadChance {
			d := faces[rand.Intn(len(faces))]
			f.light(p.x+d[0], p.y+d[1], p.z+d[2], 0)
		}
	}
	live := f.order[:0]
	for _, fl := range f.order {
		if !fl.dead {
			live = append(live, fl)
		}
	}
	f.order = live
}

// ---------------------------------------------------------------- dragons
// Fire or bubbles cost a dragon a heart, at most one every hurtCooldown seconds, whether it's
// another dragon's breath or burning blocks it flies or walks through. Out of hearts, it throws its
// rider off and can't be ridden until it has healed a heart. Left alone it heals. A dragon in a
// barrel roll spins clear and isn't hurt; rolls have a cooldown once they finish, which grows the
// more it spins: each roll adds one to its dizziness, which wears off by one every dizzyTime
// seconds, and the cooldown is rollCooldownTime seconds for each.
const (
	dragonHearts     = 10
	hurtCooldown     = 1.0 // seconds
	healDelay        = 8.0
	healTime         = 3.0
	rollTime         = 0.9 // seconds a barrel roll takes
	rollCooldownTime = 0.6
	dizzyTime        = 4.0
	hitRadius        = 1.5 // around the dragon's middle; it widens along the breath
)

type dragonSize struct{ hw, h, riddenH float64 }

// each sort of dragon's size, and how far its breath reaches, by what it breathes (big T-rex
// dragons breathe fire; Bubbles the potato dragon blows bubbles)
var (
	breathRange = map[string]float64{"fire": 7, "bubbles": 8}
	sizes       = map[string]dragonSize{"fire": {0.6, 2.3, 3.4}, "bubbles": {0.85, 1.9, 3.5}}
)

type vec struct{ x, y, z float64 }

type Dragon struct {
	id          string
	breath      string // "fire" or "bubbles"
	size        dragonSize
	baseH, h    float64 // its height alone, and now
	breathRange float64
	pos         vec
	breathOn    bool
	heardAt     time.Time
	fireFrom    vec
	fireDir     vec
	health      int
	hurtCd      float64
	healT       float64
	roll        *rollState // set while rolling
	rollCounted bool
	rollCd      float64
	dizzy       float64
}

type rollState struct{ until time.Time }

// the way a dragon breathes, from the way it faces (yaw) and its aim
func breathDir(yaw, aimYaw, aimPitch float64) vec {
	a := yaw + aimYaw
	cp := math.Cos(aimPitch)
	return vec{-math.Sin(a) * cp, math.Sin(aimPitch), -math.Cos(a) * cp}
}

// Is dragon d in another dragon's breath (from o.fireFrom along o.fireDir, as far as
// o.breathRange, widening as it goes), or in or touching a burning block?
func inBreath(d *Dragon, all []*Dragon, fire *Fire) bool {
	cx, cy, cz := d.pos.x, d.pos.y+d.baseH/2, d.pos.z
	for _, o := range all {
		if o == d || !o.breathOn {
			continue
		}
		vx, vy, vz := cx-o.fireFrom.x, cy-o.fireFrom.y, cz-o.fireFrom.z
		t := vx*o.fireDir.x + vy*o.fireDir.y + vz*o.fireDir.z
		r := hitRadius + t*0.15
		if t > 0 && t < o.breathRange+hitRadius && vx*vx+vy*vy+vz*vz-t*t < r*r {
			return true
		}
	}
	x, z := d.pos.x, d.pos.z
	fl := func(v float64) int { return int(math.Floor(v)) }
	return fire.fireIn(fl(x-1.5), fl(d.pos.y-0.5), fl(z-1.5), fl(x+1.5), fl(d.pos.y+d.h), fl(z+1.5))
}

// A heart lost (if hit) or healed.
func hurtOrHeal(d *Dragon, dt float64, hit bool) {
	d.hurtCd -= dt
	if d.hurtCd <= 0 && d.health > 0 && d.roll == nil && hit {
		d.health--
		d.hurtCd, d.healT = hurtCooldown, healDelay
	} else if d.health < dragonHearts {
		if d.healT -= dt; d.healT <= 0 {
			d.health++
			d.healT = healTime
		}
	}
}

// Counts each roll as it starts, and the cooldown down once it's over.
func rollCooldown(d *Dragon, dt float64) {
	if d.roll != nil && !d.rollCounted {
		d.dizzy++
		d.rollCd = rollCooldownTime * d.dizzy
	}
	d.rollCounted = d.roll != nil
	if d.roll == nil {
		d.rollCd = math.Max(0, d.rollCd-dt)
	}
	d.dizzy = math.Max(0, d.dizzy-dt/dizzyTime)
}
