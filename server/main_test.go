package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// A path with a backslash in it is refused before it gets anywhere near the disk, even where a
// file answers to it. On Windows a backslash separates folders, so with ".." it could step out of
// the game's folder, past checks that only look for "/".
func TestBackslashPathsAreRefused(t *testing.T) {
	root := t.TempDir()
	// one file with a backslash in its name here; on Windows, the file y.js in the folder js\x
	name := filepath.Join(root, "js", `x\y.js`)
	if err := os.MkdirAll(filepath.Dir(name), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(name, []byte("// a file"), 0o644); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	fileHandler(root)(w, httptest.NewRequest("GET", "/js/x%5cy.js", nil))
	if w.Code != http.StatusNotFound {
		t.Errorf("/js/x%%5cy.js: %d, want it refused", w.Code)
	}
}

// The game's files are served and nothing else in its folder is, however the name is spelled.
func TestOnlyTheGameIsServed(t *testing.T) {
	serve := fileHandler("..") // tests run in server/, the game is the folder above
	get := func(target string) int {
		w := httptest.NewRecorder()
		serve(w, httptest.NewRequest("GET", target, nil))
		return w.Code
	}
	for _, target := range []string{"/", "/index.html", "/js/main.js", "/css/style.css", "/screech.m4a"} {
		if code := get(target); code != http.StatusOK {
			t.Errorf("%s: %d, want it served", target, code)
		}
	}
	for _, target := range []string{
		"/server/main.go", "/go.mod",
		"/Server/main.go", "/SERVER/game.go", "/GO.MOD", "/%C5%BFerver/main.go", // a disk that ignores capitals
		"/.git/config", "/.GIT/config", "/js/../.git/config", "/js/%2e%2e/server/main.go", "/js/..%2fgo.mod",
		"/js/x%5c..%5c..%5cgo.mod", "/js/x%5c..%5c..%5cserver%5cmain.go", "/js%5cmain.js", "/js/main.js:x", // Windows
		"/js/", "/nothing.html",
	} {
		if code := get(target); code != http.StatusNotFound {
			t.Errorf("%s: %d, want it refused", target, code)
		}
	}
}
