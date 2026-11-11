package main

import (
	"bufio"
	"bytes"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// Only the game's own page may open the WebSocket from a browser: not a page on some other site.
func TestOnlyTheGamesPageMayConnect(t *testing.T) {
	defer func(saved map[string]bool) { extraOrigins = saved }(extraOrigins)
	extraOrigins = originList("https://listed.example/, listed.example:8443")
	for _, c := range []struct {
		host, origin string
		want         bool
	}{
		{"localhost:8080", "", true}, // not a browser
		{"localhost:8080", "http://localhost:8080", true},
		{"192.168.1.104:8080", "http://192.168.1.104:8080", true},
		{"My-Mac.local:8080", "http://my-mac.local:8080", true},
		{"localhost", "http://localhost", true}, // PORT=80
		{"localhost:8080", "https://evil.example", false},
		{"localhost:8080", "http://localhost:9000", false}, // something else on this computer
		{"localhost:8080", "http://localhost.evil.example:8080", false},
		{"192.168.1.104:8080", "http://localhost:8080", false},
		{"localhost:8080", "null", false}, // a sandboxed frame or a file
		{"", "null", false},
		// behind a proxy that puts its own address in Host
		{"localhost:8080 play.example.com", "https://play.example.com", true},
		{"localhost:8080 play.example.com, proxy.internal", "https://play.example.com", true},
		{"localhost:8080 play.example.com", "https://evil.example", false},
		{"localhost:8080", "https://listed.example", true}, // in ORIGIN
		{"localhost:8080", "https://Listed.example:8443", true},
	} {
		r := httptest.NewRequest("GET", "/ws", nil)
		host, forwarded, _ := strings.Cut(c.host, " ")
		r.Host = host
		if forwarded != "" {
			r.Header.Set("X-Forwarded-Host", forwarded)
		}
		if c.origin != "" {
			r.Header.Set("Origin", c.origin)
		}
		if got := sameOrigin(r); got != c.want {
			t.Errorf("host %q, origin %q: allowed %v, want %v", c.host, c.origin, got, c.want)
		}
	}

	// and serveWS turns the others away before it takes over the connection
	r := httptest.NewRequest("GET", "/ws", nil)
	r.Header.Set("Origin", "https://evil.example")
	r.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
	w := httptest.NewRecorder()
	serveWS(w, r)
	if w.Code != http.StatusForbidden {
		t.Errorf("another site's page: %d, want 403", w.Code)
	}
}

// A frame that claims a length near the top of 64 bits, after a first piece, is refused: added to
// the piece it would wrap round to a small number and pass the size check.
func TestHugeFrameAfterAPieceIsRefused(t *testing.T) {
	in := []byte{0x01, 0x01, 'a'} // the first piece of a text message, one byte long
	in = append(in, 0x80, 127, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff)
	got := 0
	conn, other := net.Pipe()
	defer conn.Close()
	defer other.Close()
	readFrames(conn, bufio.NewReader(bytes.NewReader(in)), &Player{}, func([]byte) { got++ }) // would panic
	if got != 0 {
		t.Errorf("%d messages read, want none", got)
	}
}

// A connection that stops answering is given up on, rather than kept as a player who isn't there;
// one that answers the server's pings (as every browser does, by itself) is kept.
func TestASilentConnectionIsDropped(t *testing.T) {
	conn, browser := net.Pipe()
	defer browser.Close()
	gone := make(chan struct{})
	go func() {
		readFramesFor(conn, bufio.NewReader(conn), &Player{}, func([]byte) {}, 300*time.Millisecond)
		close(gone)
	}()
	pong := []byte{0x8a, 0x80, 1, 2, 3, 4} // masked, as a browser's frames are
	for i := 0; i < 5; i++ {               // answering for longer than the wait
		time.Sleep(100 * time.Millisecond)
		if _, err := browser.Write(pong); err != nil {
			t.Fatalf("dropped while still answering: %v", err)
		}
	}
	select {
	case <-gone:
		t.Fatal("dropped while still answering")
	default:
	}
	select {
	case <-gone:
	case <-time.After(2 * time.Second):
		t.Fatal("still waiting on a connection that has stopped answering")
	}
}
