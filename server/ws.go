package main

import (
	"bufio"
	"bytes"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
	"unicode"
)

// WebSocket (just enough of RFC 6455), over a connection taken from the HTTP server. Each player
// has a goroutine that reads their messages and another that writes to them, so a slow connection
// only ever holds up its own player.

const (
	maxMessage = 64 * 1024 // a message bigger than the game ever sends closes the connection
	queueSize  = 512       // frames that may wait to be written to one player before they're dropped
)

func encode(msg M) []byte {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(msg); err != nil {
		return []byte("{}")
	}
	return bytes.TrimRight(b.Bytes(), "\n")
}

// a text frame, ready to write (frames from a server are never masked)
func frame(text []byte) []byte {
	n := len(text)
	var head []byte
	switch {
	case n < 126:
		head = []byte{0x81, byte(n)}
	case n < 65536:
		head = []byte{0x81, 126, byte(n >> 8), byte(n)}
	default:
		head = binary.BigEndian.AppendUint64([]byte{0x81, 127}, uint64(n))
	}
	return append(head, text...)
}

// queues a frame for the player; one who can't keep up is disconnected, rather than the server
// piling up messages for them
func (p *Player) push(f []byte) {
	select {
	case p.out <- f:
	default:
		p.conn.Close()
	}
}

// writes queued frames until the player has gone, then whatever is still queued
func (p *Player) writeLoop(finished chan<- struct{}) {
	defer close(finished)
	write := func(f []byte) bool {
		p.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		_, err := p.conn.Write(f)
		return err == nil
	}
	for {
		select {
		case f := <-p.out:
			if !write(f) {
				p.conn.Close()
				return
			}
		case <-p.done:
			for {
				select {
				case f := <-p.out:
					if !write(f) {
						return
					}
				default:
					return
				}
			}
		}
	}
}

// Reads frames from the connection and hands each complete text message to onText, until the
// connection closes, or nothing has come from it for too long. Over the internet a player can
// vanish (a laptop shut, a phone out of signal) without their connection ever closing; the server
// pings every browser (see main.go) and each answers by itself, even from a hidden tab, so one
// that has stopped answering has gone.
func readFrames(conn net.Conn, rd *bufio.Reader, p *Player, onText func([]byte)) {
	readFramesFor(conn, rd, p, onText, quiet)
}

func readFramesFor(conn net.Conn, rd *bufio.Reader, p *Player, onText func([]byte), quiet time.Duration) {
	var msg []byte // a message in pieces
	var head [8]byte
	for {
		conn.SetReadDeadline(time.Now().Add(quiet))
		if _, err := io.ReadFull(rd, head[:2]); err != nil {
			return
		}
		fin, op, masked := head[0]&0x80 != 0, head[0]&0x0f, head[1]&0x80 != 0
		n := uint64(head[1] & 0x7f)
		switch n {
		case 126:
			if _, err := io.ReadFull(rd, head[:2]); err != nil {
				return
			}
			n = uint64(binary.BigEndian.Uint16(head[:2]))
		case 127:
			if _, err := io.ReadFull(rd, head[:8]); err != nil {
				return
			}
			n = binary.BigEndian.Uint64(head[:8])
		}
		// (n on its own first: a huge n added to the pieces so far would wrap round to a small number)
		if n > maxMessage || n+uint64(len(msg)) > maxMessage || (op >= 8 && (n > 125 || !fin)) {
			return
		}
		var mask [4]byte
		if masked {
			if _, err := io.ReadFull(rd, mask[:]); err != nil {
				return
			}
		}
		payload := make([]byte, n)
		if _, err := io.ReadFull(rd, payload); err != nil {
			return
		}
		if masked {
			for i := range payload {
				payload[i] ^= mask[i&3]
			}
		}
		switch op {
		case 8: // close
			p.push([]byte{0x88, 0})
			return
		case 9: // ping → pong
			p.push(append([]byte{0x8a, byte(len(payload))}, payload...))
		case 0, 1: // text, or a continuation of it
			msg = append(msg, payload...)
			if fin {
				onText(msg)
				msg = nil
			}
		}
	}
}

const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

// Addresses the game's page may be at besides the one the server sees itself asked for, from
// ORIGIN=play.example.com (several with commas between): see sameOrigin.
var extraOrigins = originList(os.Getenv("ORIGIN"))

func originList(s string) map[string]bool {
	out := map[string]bool{}
	for _, o := range strings.Split(s, ",") {
		o = strings.ToLower(strings.TrimSpace(o))
		if i := strings.Index(o, "://"); i >= 0 { // "https://play.example.com/" is fine too
			o = o[i+3:]
		}
		if o = strings.TrimSuffix(o, "/"); o != "" {
			out[o] = true
		}
	}
	return out
}

// Whether a connection comes from the game's own page. A browser says which page opened a
// WebSocket (the Origin header) but doesn't stop other sites opening one, so without this any web
// page a player visits could join the game from their browser. Programs that aren't browsers send
// no Origin; they can reach the server anyway.
//
// The page is the game's own if it's at the address the browser asked this server for. Playing
// over the internet there is often a proxy in between that puts its own address in Host: most
// keep the one the browser used in X-Forwarded-Host (which a web page can't set), and for one
// that doesn't, the address goes in ORIGIN.
func sameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return false
	}
	for _, host := range append([]string{r.Host}, strings.Split(r.Header.Get("X-Forwarded-Host"), ",")...) {
		if strings.EqualFold(u.Host, strings.TrimSpace(host)) {
			return true
		}
	}
	return extraOrigins[strings.ToLower(u.Host)]
}

// Says (once for each page, and not for ever) that a page was turned away: behind a proxy that
// hides the game's address this is every player, and all they'd see is a single player game.
var turnedAway = struct {
	sync.Mutex
	seen map[string]bool
}{seen: map[string]bool{}}

func sayTurnedAway(r *http.Request) {
	origin := r.Header.Get("Origin")
	turnedAway.Lock()
	defer turnedAway.Unlock()
	if turnedAway.seen[origin] || len(turnedAway.seen) >= 20 {
		return
	}
	turnedAway.seen[origin] = true
	fmt.Printf("Turned away a connection from a page at %q: this server was asked for %q.\n"+
		"  If that page is this game (behind a proxy, say), start the server with ORIGIN set to its address.\n", origin, r.Host)
}

const (
	pingEvery = 10 * time.Second // how often each player's browser is asked if it's still there
	quiet     = 30 * time.Second // a connection that hasn't answered (or sent anything) for this long has gone
)

var pingFrame = []byte{0x89, 0}

func serveWS(w http.ResponseWriter, r *http.Request) {
	if !sameOrigin(r) {
		sayTurnedAway(r)
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	hj, ok := w.(http.Hijacker)
	if key == "" || !ok {
		http.Error(w, "Bad request", http.StatusBadRequest)
		return
	}
	conn, rd, err := hj.Hijack()
	if err != nil {
		return
	}
	defer conn.Close()
	sum := sha1.Sum([]byte(key + wsGUID))
	conn.Write([]byte("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
		base64.StdEncoding.EncodeToString(sum[:]) + "\r\n\r\n"))

	p := &Player{name: cleanName(r.URL.Query().Get("name")), conn: conn, out: make(chan []byte, queueSize), done: make(chan struct{})}
	finished := make(chan struct{})
	go p.writeLoop(finished)
	mu.Lock()
	join(p)
	mu.Unlock()

	readFrames(conn, rd.Reader, p, func(text []byte) {
		mu.Lock()
		defer mu.Unlock()
		p.heard = time.Now()
		if !allowance(p) { // sending far more than the game does: drop it
			return
		}
		defer func() { recover() }() // a message that breaks something is ignored, like any other bad one
		var m M
		if json.Unmarshal(text, &m) == nil {
			receive(p, m)
		}
	})

	mu.Lock()
	leave(p)
	mu.Unlock()
	close(p.done)
	<-finished
}

// a name without control characters, at most 20 characters
func cleanName(s string) string {
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || (r >= 0x7f && r <= 0x9f) {
			return -1
		}
		return r
	}, s)
	s = strings.TrimFunc(s, unicode.IsSpace)
	if r := []rune(s); len(r) > 20 {
		s = string(r[:20])
	}
	return s
}
