package main

import (
	"math"
	"testing"
	"time"
)

var testStart = time.Unix(1000, 0)

func after(s float64) time.Time { return testStart.Add(time.Duration(s * float64(time.Second))) }

// Nobody goes faster by sending more messages: however many arrive, over ten seconds they get no
// further than ten seconds' movement plus the second in hand, across the ground or up and down.
func TestSpeedLimitIsPerSecondNotPerMessage(t *testing.T) {
	const secs = 10
	for _, perSecond := range []int{12, 200, 2000} {
		for _, c := range []struct {
			name  string
			to    []float64 // each message asks to be far away
			speed float64
			moved func(p [3]float64) float64
		}{
			{"along", []float64{1e5, 50, 0}, run, func(p [3]float64) float64 { return p[0] }},
			{"up", []float64{0, 1e5, 0}, climb, func(p [3]float64) float64 { return p[1] - 50 }},
			{"down", []float64{0, -1e5, 0}, fall, func(p [3]float64) float64 { return 50 - p[1] }},
		} {
			tr := &track{}
			moveToAt(tr, []float64{0, 50, 0}, testStart)
			var at [3]float64
			for i := 1; i <= secs*perSecond; i++ {
				at = moveToAt(tr, c.to, after(float64(i)/float64(perSecond)))
			}
			if got, most := c.moved(at), c.speed*(secs+late); got > most+1e-6 {
				t.Errorf("%d messages a second: %.0f blocks %s in %d seconds, want at most %.0f", perSecond, got, c.name, secs, most)
			}
		}
	}
}

// Someone playing fairly is never held back by the internet: when their updates are held up for
// most of a second and arrive together, each one still puts them exactly where they said.
func TestFairMovementIsNotHeldBack(t *testing.T) {
	const rate = 12 // the game's updates a second
	for _, c := range []struct {
		name   string
		dx, dy float64 // blocks a second
	}{
		{"a dragon in flight", 13, 5}, // the fastest thing there is across the ground
		{"falling", 3, -45},           // as fast as anything falls (see physics.js)
	} {
		tr := &track{}
		moveToAt(tr, []float64{0, 5000, 0}, testStart)
		for i := 1; i <= 20*rate; i++ {
			sent := float64(i) / rate
			arrives := sent
			if held := math.Mod(sent, 3); held > 2 && held < 2.95 { // one second in three: held up, then all at once
				arrives = math.Floor(sent/3)*3 + 2.95
			}
			want := [3]float64{c.dx * sent, 5000 + c.dy*sent, 0}
			if got := moveToAt(tr, want[:], after(arrives)); math.Abs(got[0]-want[0]) > 1e-6 || math.Abs(got[1]-want[1]) > 1e-6 {
				t.Fatalf("%s, update %d: held back to %.2f, %.2f; want %.2f, %.2f", c.name, i, got[0], got[1], want[0], want[1])
			}
		}
	}
}

// The host is whoever's game is running: one that goes quiet (its connection stalled, or gone
// without closing) hands over to someone who is still sending, and doesn't get the job back by
// turning up again.
func TestAQuietHostHandsOver(t *testing.T) {
	saved, savedHost := players, hostId
	defer func() { players, hostId, joined = saved, savedHost, nil }()
	a := &Player{id: 1, ready: true, heard: time.Now(), out: make(chan []byte, 8)}
	b := &Player{id: 2, ready: true, heard: time.Now(), out: make(chan []byte, 8)}
	players, joined, hostId = map[int]*Player{1: a, 2: b}, []*Player{a, b}, 0

	pickHost(nil)
	if hostId != 1 {
		t.Fatalf("host is %d, want the first player", hostId)
	}
	toldA, toldB := len(a.out), len(b.out)
	a.heard = time.Now().Add(-hostQuiet - time.Second)
	pickHost(nil)
	if hostId != 2 {
		t.Fatalf("host is %d, want it handed to the player still sending", hostId)
	}
	if len(a.out) != toldA+1 || len(b.out) != toldB+1 {
		t.Errorf("told %d and %d players of the new host, want both told once", len(a.out)-toldA, len(b.out)-toldB)
	}
	a.heard = time.Now()
	pickHost(nil)
	if hostId != 2 {
		t.Errorf("host is %d, want it left where it was", hostId)
	}
	b.heard = time.Now().Add(-hostQuiet - time.Second)
	a.heard = b.heard
	pickHost(nil)
	if hostId != 2 {
		t.Errorf("host is %d with everyone quiet, want it left where it was", hostId)
	}
}
