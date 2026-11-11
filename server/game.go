package main

import (
	"fmt"
	"math"
	"net"
	"slices"
	"sync"
	"time"
)

// The game: who is playing, the world they share, and the rules that run it. Everything here runs
// with `mu` held, one message or tick at a time, so none of it needs any locking of its own.

type M = map[string]any

var mu sync.Mutex

// ---------------------------------------------------------------- state
type Player struct {
	id    int
	name  string
	conn  net.Conn
	out   chan []byte   // frames waiting to be written (see ws.go)
	done  chan struct{} // closed when the player has gone
	ready bool          // welcomed: in the game
	away  bool          // their tab is hidden
	heard time.Time     // when they last sent anything
	s     M             // where they are, and where they're looking
	track track
	// messages they may still send: see allowance
	tokens   float64
	tokensAt time.Time
}

var (
	seedSet  bool               // the world seed has been picked, by the first player
	chooser  *Player            // the player picking it; everyone else waits for it
	waiting  []*Player          // players waiting for the seed
	edits    = map[pos3]uint8{} // every block changed since the world began
	editList []pos3             // ...in the order they were first changed
	riders   = map[string]int{} // animal id -> id of the player riding it
	players  = map[int]*Player{}
	joined   []*Player // everyone connected, in the order they joined
	hostId   = 0
	nextId   = 1
	fire     *Fire
	dragons  = map[string]*Dragon{}
	animals  = map[string]*track{} // animal id -> where it was last, as sent by whoever runs it
	chunks   = map[[2]int][]uint8{}
)

func init() {
	fire = newFire()
	fire.getBlock = getBlock
	// fires: the server lights them, spreads them and burns blocks away, and tells everyone
	fire.burnAway = func(x, y, z int) {
		setBlock(x, y, z, AIR)
		broadcast(M{"t": "edit", "x": x, "y": y, "z": z, "b": AIR}, nil)
	}
	fire.onLight = func(f *flame) { broadcast(M{"t": "burn", "x": f.pos.x, "y": f.pos.y, "z": f.pos.z}, nil) }
}

// the clock: one day lasts 10 minutes, or 40 times faster while anyone holds T
const daySeconds = 600

var (
	hour        = 5.6
	clockAt     = time.Now()
	fastForward = map[int]bool{}
)

func tickClock() {
	now := time.Now()
	speed := 1.0
	if len(fastForward) > 0 {
		speed = 40
	}
	hour = math.Mod(hour+now.Sub(clockAt).Seconds()*24/daySeconds*speed, 24)
	clockAt = now
}

func timeMsg() M {
	tickClock()
	return M{"t": "time", "hour": hour, "ffwd": len(fastForward) > 0}
}

func send(p *Player, msg M) { p.push(frame(encode(msg))) }

func broadcast(msg M, except *Player) {
	f := frame(encode(msg))
	for _, p := range joined {
		if p.ready && p != except {
			p.push(f)
		}
	}
}

func readyPlayers() []*Player {
	var out []*Player
	for _, p := range joined {
		if p.ready {
			out = append(out, p)
		}
	}
	return out
}

func join(p *Player) {
	p.id = nextId
	nextId++
	if p.name == "" {
		p.name = fmt.Sprintf("Player %d", p.id)
	}
	p.tokens, p.tokensAt, p.heard = burst, time.Now(), time.Now()
	players[p.id] = p
	joined = append(joined, p)
	switch {
	case seedSet:
		welcome(p)
	case chooser == nil: // the first player picks the world
		chooser = p
		welcome(p)
	default:
		waiting = append(waiting, p)
	}
}

// A game that is running sends where its player is a dozen times a second. One that has sent
// nothing for this long isn't running: its tab is hidden (which it says: away), or its connection
// has stalled or gone without closing, which over the internet is the commoner thing.
const hostQuiet = 3 * time.Second

func (p *Player) stopped() bool { return p.away || time.Since(p.heard) > hostQuiet }

// The host should be someone whose game is actually running, or the animals nobody is riding
// stand still for everyone. Called whenever that might have changed, and every couple of seconds.
func pickHost(except *Player) {
	ready := readyPlayers()
	current := players[hostId]
	if current != nil && current.ready && !current.stopped() {
		return
	}
	var next *Player
	for _, o := range ready {
		if !o.stopped() {
			next = o
			break
		}
	}
	if next == nil {
		if current != nil && current.ready {
			next = current
		} else if len(ready) > 0 {
			next = ready[0]
		}
	}
	id := 0
	if next != nil {
		id = next.id
	}
	if id != hostId {
		hostId = id
		if next != nil {
			broadcast(M{"t": "host", "id": id}, except)
		}
	}
}

func welcome(p *Player) {
	p.ready = true
	pickHost(p) // takes over if there's no host, or the host's tab is hidden; p hears it in the welcome
	t := timeMsg()
	editPairs := make([][]any, 0, len(editList))
	for _, k := range editList {
		editPairs = append(editPairs, []any{keyOf(k), edits[k]})
	}
	riderPairs := [][]any{}
	for animal, rider := range riders {
		riderPairs = append(riderPairs, []any{animal, rider})
	}
	burns := [][]any{}
	for _, f := range fire.order {
		if !f.dead {
			burns = append(burns, []any{keyOf(f.pos), f.t})
		}
	}
	hp := [][]any{}
	for _, d := range dragons {
		if d.health < dragonHearts {
			hp = append(hp, []any{d.id, d.health})
		}
	}
	others := []M{}
	for _, o := range readyPlayers() {
		if o != p {
			others = append(others, M{"id": o.id, "name": o.name, "s": o.s})
		}
	}
	var worldSeed any // null while this player is the one picking it
	if seedSet {
		worldSeed = seed
	}
	send(p, M{
		"t": "welcome", "id": p.id, "name": p.name, "seed": worldSeed, "host": hostId, "hour": t["hour"], "ffwd": t["ffwd"],
		"lan": lanAddresses(), "edits": editPairs, "riders": riderPairs, "burns": burns, "hp": hp, "players": others,
	})
	broadcast(M{"t": "join", "id": p.id, "name": p.name}, p)
	fmt.Printf("%s joined (%d playing)\n", p.name, len(readyPlayers()))
}

func leave(p *Player) {
	if players[p.id] != p {
		return
	}
	delete(players, p.id)
	joined = slices.DeleteFunc(joined, func(o *Player) bool { return o == p })
	waiting = slices.DeleteFunc(waiting, func(o *Player) bool { return o == p })
	if !p.ready {
		return
	}
	for animal, rider := range riders {
		if rider == p.id {
			delete(riders, animal)
			broadcast(M{"t": "rider", "id": animal, "rider": nil}, nil)
		}
	}
	if fastForward[p.id] {
		delete(fastForward, p.id)
		broadcast(timeMsg(), nil)
	}
	broadcast(M{"t": "leave", "id": p.id}, nil)
	if chooser == p {
		chooser = nil
		if len(waiting) > 0 {
			chooser, waiting = waiting[0], waiting[1:]
			welcome(chooser)
		}
	}
	pickHost(nil)
	fmt.Printf("%s left\n", p.name)
}

// ---------------------------------------------------------------- the world
// The same world as everyone's game, built from the seed (see terrain.go), so block changes can
// be checked against what's really there, and fires run. Only chunks something happens in are built.
func chunkAt(x, z int) []uint8 {
	k := [2]int{x >> 4, z >> 4}
	c := chunks[k]
	if c == nil {
		c = generateChunk(k[0], k[1])
		chunks[k] = c
	}
	return c
}

func getBlock(x, y, z int) uint8 {
	if !inBounds(y) {
		return AIR
	}
	return chunkAt(x, z)[lidx(x&15, y, z&15)]
}

func setBlock(x, y, z int, b uint8) {
	chunkAt(x, z)[lidx(x&15, y, z&15)] = b
	k := pos3{x, y, z}
	if _, ok := edits[k]; !ok {
		editList = append(editList, k)
	}
	edits[k] = b
}

func keyOf(k pos3) string { return fmt.Sprintf("%d,%d,%d", k.x, k.y, k.z) }

// blocks are placed against another block's face
func touchesSolid(x, y, z int) bool {
	if y == 0 {
		return true
	}
	for _, d := range [...][3]int{{1, 0, 0}, {-1, 0, 0}, {0, 1, 0}, {0, -1, 0}, {0, 0, 1}, {0, 0, -1}} {
		if getBlock(x+d[0], y+d[1], z+d[2]) != AIR {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------- checking what players send
// The game runs in each player's browser, where anyone can change it, so the server checks every
// message before passing it on: that it's well formed (so it can't break anyone else's game), that
// a player only sends updates for the animals theirs to run, and that nobody moves faster, reaches
// further, or changes more of the world than the game allows. What a player does to their own
// game only shows up for everyone else through these messages.
const (
	far   = 1e5 // further from the middle than anyone will ever walk
	run   = 30  // blocks a second: faster than any animal runs, flies or falls
	climb = 30
	fall  = 50
	late  = 1.0 // seconds of movement that may turn up all at once, after a hold-up on the way

	rate  = 200 // messages a second; the game sends a few dozen
	burst = 400
)

var animalStates = map[string]bool{"idle": true, "walk": true, "run": true, "graze": true, "takeoff": true, "fly": true, "land": true}

// JSON numbers arrive as float64 and anything else (including a missing field) fails these.
func num(v any, lo, hi float64) bool { f, ok := v.(float64); return ok && f >= lo && f <= hi } // NaN fails
func numF(v any) bool                { return num(v, -far, far) }
func isInt(v any, lo, hi float64) bool {
	f, ok := v.(float64)
	return ok && f == math.Floor(f) && f >= lo && f <= hi
}

// a list of n numbers
func nums(v any, n int, lo, hi float64) ([]float64, bool) {
	list, ok := v.([]any)
	if !ok || len(list) != n {
		return nil, false
	}
	out := make([]float64, n)
	for i, x := range list {
		if !num(x, lo, hi) {
			return nil, false
		}
		out[i] = x.(float64)
	}
	return out, true
}
func numsF(v any, n int) ([]float64, bool) { return nums(v, n, -far, far) }

func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case float64:
		return x != 0
	case string:
		return x != ""
	}
	return true
}

func block(m M) (x, y, z int, ok bool) {
	if !isInt(m["x"], -far, far) || !isInt(m["y"], 0, H-1) || !isInt(m["z"], -far, far) {
		return
	}
	return int(m["x"].(float64)), int(m["y"].(float64)), int(m["z"].(float64)), true
}

func animalId(v any) (string, bool) {
	s, ok := v.(string)
	if !ok || len(s) < 2 || len(s) > 4 || (s[0] != 'm' && s[0] != 'd') {
		return "", false
	}
	for _, c := range []byte(s[1:]) {
		if c < '0' || c > '9' {
			return "", false
		}
	}
	return s, true
}

func allowance(p *Player) bool {
	now := time.Now()
	p.tokens = math.Min(burst, p.tokens+now.Sub(p.tokensAt).Seconds()*rate)
	p.tokensAt = now
	if p.tokens < 1 {
		return false
	}
	p.tokens--
	return true
}

type track struct {
	has bool
	pos [3]float64
	at  time.Time
	// seconds of movement in hand, across the ground and up or down: see moveTo
	spare, spareY float64
}

// Where something (a player or an animal) is allowed to have got to since the last update: any
// further than it could have run, climbed or fallen in the time, and it only gets that far.
//
// The time is what has passed since the last update, plus what's in hand. Over the internet
// updates are held up and then arrive in a bunch, with no time between them, so time that went
// unused (while the bunch was on its way, or by moving slower than the limit) is kept in hand, up
// to a second (late). Sending more updates gets nobody any further: it's the time that counts.
func moveTo(t *track, to []float64) [3]float64 { return moveToAt(t, to, time.Now()) }

func moveToAt(t *track, to []float64, now time.Time) [3]float64 {
	x, y, z := to[0], to[1], to[2]
	if t.has {
		px, py, pz := t.pos[0], t.pos[1], t.pos[2]
		dt := math.Max(0, now.Sub(t.at).Seconds())

		secs := dt + t.spare
		dx, dz := x-px, z-pz
		d := math.Hypot(dx, dz)
		if maxD := run * secs; d > maxD {
			x, z = px+dx/d*maxD, pz+dz/d*maxD
			d = maxD
		}
		t.spare = math.Min(late, secs-d/run)

		secs = dt + t.spareY
		dy, speed := y-py, float64(climb)
		if dy < 0 {
			dy, speed = -dy, fall
		}
		if maxY := speed * secs; dy > maxY {
			y = py + math.Copysign(maxY, y-py)
			dy = maxY
		}
		t.spareY = math.Min(late, secs-dy/speed)
	} else {
		t.spare, t.spareY = late, late
	}
	t.pos, t.at, t.has = [3]float64{x, y, z}, now, true
	return t.pos
}

func near(t *track, x, y, z, r float64) bool {
	return t.has && math.Hypot(math.Hypot(t.pos[0]-x, t.pos[1]-y), t.pos[2]-z) <= r
}

func ridingOf(p *Player) (string, bool) {
	for animal, rider := range riders {
		if rider == p.id {
			return animal, true
		}
	}
	return "", false
}

// ---------------------------------------------------------------- dragons
// The server keeps each dragon as the rules need it (rules.go): where it is, from the updates
// of whoever runs it; whether its rider is breathing, from where and which way; whether it's in a
// barrel roll, which the server times itself and only allows once its cooldown is over; and its
// hearts, which only the server changes.
func dragonOf(id, kind string) *Dragon {
	d := dragons[id]
	if d == nil {
		breath := "fire"
		if kind == "b" {
			breath = "bubbles"
		}
		size := sizes[breath] // its sort is fixed once seen
		d = &Dragon{
			id: id, breath: breath, size: size, baseH: size.h, h: size.h, breathRange: breathRange[breath],
			fireDir: vec{0, 0, -1}, health: dragonHearts,
		}
		dragons[id] = d
	}
	return d
}

const (
	aimYaw     = 1.0 // how far a dragon's neck turns (see aimDragon in js/dragon.js)
	aimUp      = 0.7
	aimDown    = -1.1
	breathFrom = 5.0 // its breath comes from its mouth, at most this far from its feet
	rollEarly  = 0.3 // seconds a roll may start before the cooldown ends, for lag
)

func clamp(v, lo, hi float64) float64 { return math.Max(lo, math.Min(hi, v)) }

// a barrel roll: how far through it is, and which way
func rollOf(v any) ([]float64, bool) {
	r, ok := v.([]any)
	if !ok || len(r) != 2 || !num(r[0], 0, 1) {
		return nil, false
	}
	if dir, _ := r[1].(float64); dir != 1 && dir != -1 {
		return nil, false
	}
	return []float64{r[0].(float64), r[1].(float64)}, true
}

func dragonUpdate(d *Dragon, e M, out M, ridden bool, yaw float64) {
	now := time.Now()
	pos := out["p"].([3]float64)
	d.pos = vec{pos[0], pos[1], pos[2]}
	if ridden {
		d.h = d.size.riddenH
	} else {
		d.h = d.size.h
	}
	d.heardAt = now
	// breathing (only with a rider on), from near its head, where it's aiming
	d.breathOn = false
	if ff, ok := numsF(e["ff"], 3); ridden && truthy(e["b"]) && ok &&
		math.Hypot(math.Hypot(ff[0]-d.pos.x, ff[1]-d.pos.y), ff[2]-d.pos.z) <= breathFrom {
		d.breathOn = true
		d.fireFrom = vec{ff[0], ff[1], ff[2]}
		ay, ap := 0.0, 0.0
		if a, ok := numsF(e["a"], 2); ok {
			ay, ap = a[0], a[1]
		}
		d.fireDir = breathDir(yaw, clamp(ay, -aimYaw, aimYaw), clamp(ap, aimDown, aimUp))
		out["b"] = 1
	}
	// a barrel roll, if it's flying and the last one's cooldown is over; it lasts as long as the
	// server says, and ends early if its runner stops rolling (touching down mid-roll)
	r, ok := rollOf(e["r"])
	if ok && d.roll == nil && e["s"] == "fly" && d.rollCd <= rollEarly {
		d.roll = &rollState{until: now.Add(time.Duration((1 - r[0]) * rollTime * float64(time.Second)))}
	}
	if !ok {
		d.roll = nil
	}
	if ok && d.roll != nil {
		out["r"] = []float64{r[0], r[1]}
	}
}

// Ten times a second: the fires burn and spread, and dragons in fire or bubbles lose hearts, or heal.
const tickSeconds = 0.1

func tick() {
	fire.update(tickSeconds)
	now := time.Now()
	all := make([]*Dragon, 0, len(dragons))
	for _, d := range dragons {
		all = append(all, d)
		if d.roll != nil && now.After(d.roll.until) {
			d.roll = nil
		}
		if now.Sub(d.heardAt) > 500*time.Millisecond { // nothing from its rider for a while
			d.breathOn = false
		}
		rollCooldown(d, tickSeconds)
	}
	for _, d := range all {
		was := d.health
		hurtOrHeal(d, tickSeconds, inBreath(d, all, fire))
		if d.health == was {
			continue
		}
		broadcast(M{"t": "hp", "id": d.id, "hp": d.health}, nil)
		// out of hearts: it throws its rider off (their game does the throwing, see js/controls.js)
		if _, ridden := riders[d.id]; d.health == 0 && ridden {
			delete(riders, d.id)
			broadcast(M{"t": "rider", "id": d.id, "rider": nil}, nil)
		}
	}
}

// One animal from an update, rebuilt from only the parts that check out, or nil if it isn't theirs
// to send or doesn't make sense.
func animalUpdate(p *Player, v any) M {
	e, ok := v.(M)
	if !ok {
		return nil
	}
	id, ok := animalId(e["i"])
	if !ok {
		return nil
	}
	rider, ridden := riders[id]
	if ridden {
		if rider != p.id { // its rider runs it
			return nil
		}
	} else if p.id != hostId { // or the host, if nobody's on it
		return nil
	}
	pos, okP := numsF(e["p"], 3)
	_, okV := nums(e["v"], 3, -100, 100)
	state, _ := e["s"].(string)
	if !okP || !okV || !numF(e["y"]) || !animalStates[state] {
		return nil
	}
	isDragon := id[0] == 'd'
	kind, _ := e["k"].(string)
	if isDragon && (!num(e["f"], -100, 100) || (kind != "f" && kind != "b")) {
		return nil
	}
	a := animals[id]
	if a == nil {
		a = &track{}
		animals[id] = a
	}
	yaw := e["y"].(float64)
	out := M{"i": id, "p": moveTo(a, pos), "v": e["v"], "y": yaw, "s": state}
	if truthy(e["g"]) {
		out["g"] = 1
	}
	if truthy(e["w"]) {
		out["w"] = 1
	}
	if isDragon {
		d := dragonOf(id, kind)
		out["f"] = e["f"]
		out["k"] = d.breath[:1]
		if _, ok := numsF(e["a"], 2); ok {
			out["a"] = e["a"]
		}
		if _, ok := nums(e["c"], 2, 0, 100); ok {
			out["c"] = e["c"]
		}
		dragonUpdate(d, e, out, ridden, yaw)
	} else {
		if r, ok := rollOf(e["r"]); ok {
			out["r"] = r
		}
		if truthy(e["gl"]) {
			out["gl"] = 1
		}
	}
	return out
}

func receive(p *Player, m M) {
	if !p.ready {
		return
	}
	switch m["t"] {
	case "seed": // the first player has picked the world; let everyone else in
		if p != chooser || seedSet || !isInt(m["seed"], -(1<<31), 1<<31) {
			return
		}
		seed, seedSet, chooser = int64(m["seed"].(float64)), true, nil
		for len(waiting) > 0 {
			w := waiting[0]
			waiting = waiting[1:]
			welcome(w)
		}
	case "p": // where a player is, and where they're looking
		s, ok := m["s"].(M)
		if !ok {
			return
		}
		pos, okP := numsF(s["p"], 3)
		if !okP || !numF(s["y"]) || !num(s["pi"], -2, 2) {
			return
		}
		p.s = M{"p": moveTo(&p.track, pos), "y": s["y"], "pi": s["pi"]}
		broadcast(M{"t": "p", "id": p.id, "s": p.s}, p)
	case "a": // where the animals they run are
		list, ok := m["list"].([]any)
		if !ok {
			return
		}
		list = list[:min(len(list), 2000)]
		out := []M{}
		seen := map[string]bool{} // each animal once: only its first update in a message counts
		for _, e := range list {
			if a, ok := e.(M); ok {
				if id, ok := a["i"].(string); ok {
					if seen[id] {
						continue
					}
					seen[id] = true
				}
			}
			if u := animalUpdate(p, e); u != nil {
				out = append(out, u)
			}
		}
		if len(out) > 0 {
			broadcast(M{"t": "a", "list": out}, p)
		}
	case "edit": // a block broken or placed within reach, where there's a block to break or room to place one
		x, y, z, ok := block(m)
		if !seedSet || !ok || !isInt(m["b"], 0, 255) {
			return
		}
		b := uint8(m["b"].(float64))
		if b != AIR && !slices.Contains(hotbar, b) {
			return
		}
		// (reach first, so nobody can make the server build chunks far away)
		if !near(&p.track, float64(x)+0.5, float64(y)+0.5, float64(z)+0.5, REACH+8) { // + a dragon rider's height, and lag
			return
		}
		was := getBlock(x, y, z)
		var allowed bool
		if b == AIR {
			allowed = was != AIR && was != BEDROCK
		} else {
			allowed = was == AIR && touchesSolid(x, y, z)
		}
		if !allowed { // put their copy back as it really is
			send(p, M{"t": "edit", "x": x, "y": y, "z": z, "b": was})
			return
		}
		setBlock(x, y, z, b)
		broadcast(M{"t": "edit", "x": x, "y": y, "z": z, "b": b}, p)
	case "mount": // free, close by, not out of hearts, and they aren't already on something
		id, ok := animalId(m["id"])
		if !ok {
			return
		}
		a := animals[id]
		_, taken := riders[id]
		_, riding := ridingOf(p)
		d := dragons[id]
		if !taken && !riding && (d == nil || d.health != 0) && (a == nil || !a.has || near(&p.track, a.pos[0], a.pos[1], a.pos[2], 8)) {
			riders[id] = p.id
			broadcast(M{"t": "rider", "id": id, "rider": p.id}, nil)
		} else { // no (someone got there first?)
			var rider any
			if r, ok := riders[id]; ok {
				rider = r
			}
			send(p, M{"t": "rider", "id": id, "rider": rider})
		}
	case "dismount":
		if id, ok := m["id"].(string); ok {
			if rider, on := riders[id]; on && rider == p.id {
				delete(riders, id)
				broadcast(M{"t": "rider", "id": id, "rider": nil}, nil)
			}
		}
	case "ignite": // their dragon's flames reaching a block, which catches if it burns
		animal, ok := ridingOf(p)
		d := dragons[animal]
		x, y, z, okB := block(m)
		if !ok || d == nil || d.breath != "fire" || !d.breathOn || !okB {
			return
		}
		f := d.fireFrom
		if math.Hypot(math.Hypot(float64(x)+0.5-f.x, float64(y)+0.5-f.y), float64(z)+0.5-f.z) > d.breathRange+1.5 {
			return
		}
		fire.light(x, y, z, 0)
	case "away": // their tab is hidden (or back)
		p.away = truthy(m["on"])
		pickHost(nil)
	case "ffwd":
		tickClock()
		if truthy(m["on"]) {
			fastForward[p.id] = true
		} else {
			delete(fastForward, p.id)
		}
		broadcast(timeMsg(), nil)
	}
}
