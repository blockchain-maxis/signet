package devui

import (
	"embed"
	"io/fs"
)

// built is apps/sandbox-ui's build (#579), written here by
// `pnpm --filter @signet/sandbox-ui build`. It is gitignored but for a
// .gitkeep, so a Go build without Node still compiles and serves the
// placeholder instead.
//
//go:embed all:dist
var built embed.FS

//go:embed dist-placeholder
var placeholder embed.FS

// Assets is the UI to serve: the build when there is one, the page saying
// how to make one otherwise.
func Assets() fs.FS {
	if dist, err := fs.Sub(built, "dist"); err == nil {
		if _, err := fs.Stat(dist, "index.html"); err == nil {
			return dist
		}
	}
	sub, _ := fs.Sub(placeholder, "dist-placeholder")
	return sub
}

// Built reports whether the UI build is embedded.
func Built() bool {
	_, err := fs.Stat(built, "dist/index.html")
	return err == nil
}
