// Unicorn Craft multiplayer server. Run it from the game's folder with
//
//	go run ./server            (or PORT=9000 go run ./server)
//
// and open the address it prints. Other computers on the same network open the network address
// it prints. It serves the game's files (never cached, so a refresh always picks up changes) and
// relays messages between the players over a WebSocket at /ws. It needs nothing but Go to build,
// and uses nothing outside Go's standard library.
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
// serves the game's own files: nothing outside the folder, no hidden files (.git), not the server
func fileHandler(root string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
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
		if top := strings.SplitN(rel[1:], "/", 2)[0]; top == "server" || top == "go.mod" || top == "go.sum" {
			http.NotFound(w, r)
			return
		}
		data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
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
	go every(2*time.Second, func() { broadcast(timeMsg(), nil) })

	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("Unicorn Craft is running.\n  On this computer:  http://localhost:%d/\n", port)
	for _, a := range lanAddresses() {
		fmt.Printf("  On the network:    %s\n", a)
	}
	fmt.Println("Add ?name=YourName to the address to pick a name.")
	log.Fatal(http.Serve(ln, mux))
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
