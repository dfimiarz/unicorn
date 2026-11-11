// Unicorn Craft multiplayer server. Run it from the game's folder with
//
//	go run ./server            (or PORT=9000 go run ./server)
//
// and open the address it prints. Other computers on the same network open the network address
// it prints. It serves the game's files (never cached, so a refresh always picks up changes) and
// relays messages between the players over a WebSocket at /ws. It needs nothing but Go to build,
// and uses nothing outside Go's standard library.
//
// To play over the internet, run it where players can reach it, behind whatever gives it an
// https address (a hosting service, or a proxy such as Caddy or nginx): the game then connects
// with wss by itself. Only the game's own page may connect (see sameOrigin in ws.go); if a proxy
// hides the address players use, give it with ORIGIN=play.example.com.
//
// The server keeps what a newcomer needs to join: the world seed (picked by the first player),
// every block changed since, the blocks on fire, who is riding which animal, the dragons' hearts,
// and the time of day. It also decides what happens, by the game's own rules (rules.go, the same
// as js/rules.js), so nobody can change them from their browser: it builds the same world from
// the seed (terrain.go, the same as js/terrain.js) to check every block change against, runs the
// fires, and decides when dragons are hurt or heal. One player is the host: their computer runs
// the animals nobody is riding (see js/multiplayer.js).
package main

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

var port = 8080

var contentTypes = map[string]string{
	".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon",
	".m4a": "audio/mp4",
}

// ---------------------------------------------------------------- files
// What the game is made of, at the top of its folder: only these (and what's inside the folders)
// are served. Everything else there (the server, .git, anything added later) stays private,
// however its name is spelled: a list of what to hide would miss "Server" on a disk that ignores
// capitals. A new top-level file or folder the game loads has to be added here.
var served = map[string]bool{"index.html": true, "css": true, "js": true, "screech.m4a": true}

// serves the game's own files: nothing outside the folder, no hidden files, nothing but the game
func fileHandler(root string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// on Windows a backslash separates folders too, and a colon names a drive or a hidden
		// stream; the checks below only know about "/", so a path with either is refused
		if strings.ContainsAny(r.URL.Path, `\:`) {
			http.NotFound(w, r)
			return
		}
		rel := path.Clean("/" + r.URL.Path)
		if strings.HasSuffix(r.URL.Path, "/") {
			rel = path.Join(rel, "index.html")
		}
		for _, part := range strings.Split(rel, "/") {
			if strings.HasPrefix(part, ".") {
				http.NotFound(w, r)
				return
			}
		}
		local := filepath.FromSlash(rel[1:])
		if !served[strings.SplitN(rel[1:], "/", 2)[0]] || !filepath.IsLocal(local) {
			http.NotFound(w, r)
			return
		}
		data, err := os.ReadFile(filepath.Join(root, local))
		if err != nil {
			http.Error(w, "Not found", http.StatusNotFound)
			return
		}
		ct := contentTypes[path.Ext(rel)]
		if ct == "" {
			ct = "application/octet-stream"
		}
		w.Header().Set("Content-Type", ct)
		w.Header().Set("Cache-Control", "no-store")
		w.Write(data)
	}
}

func lanAddresses() []string {
	out := []string{}
	addrs, _ := net.InterfaceAddrs()
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok && !n.IP.IsLoopback() && n.IP.To4() != nil {
			out = append(out, fmt.Sprintf("http://%s:%d/", n.IP, port))
		}
	}
	return out
}

func main() {
	if p, err := strconv.Atoi(os.Getenv("PORT")); err == nil && p > 0 {
		port = p
	}
	root, err := os.Getwd()
	if err != nil {
		log.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "index.html")); err != nil {
		log.Fatal("Run this from the game's folder (the one with index.html).")
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", serveWS)
	mux.HandleFunc("/", fileHandler(root))

	go every(time.Duration(tickSeconds*float64(time.Second)), tick)
	go every(2*time.Second, func() {
		pickHost(nil) // the host's game may have stopped without a word: see pickHost
		broadcast(timeMsg(), nil)
	})
	go every(pingEvery, func() { // see readFrames
		for _, p := range joined {
			p.push(pingFrame)
		}
	})

	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("Unicorn Craft is running.\n  On this computer:  http://localhost:%d/\n", port)
	for _, a := range lanAddresses() {
		fmt.Printf("  On the network:    %s\n", a)
	}
	fmt.Println("Add ?name=YourName to the address to pick a name.")
	// on the internet, a connection that never finishes asking for anything isn't left open for ever
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: time.Minute}
	log.Fatal(srv.Serve(ln))
}

func every(d time.Duration, f func()) {
	for range time.Tick(d) {
		func() {
			mu.Lock()
			defer mu.Unlock()
			f()
		}()
	}
}
