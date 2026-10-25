package devui

import (
	"embed"
	"io/fs"
)

//go:embed placeholder
var placeholder embed.FS

// Placeholder is the page served until the UI is built into the CLI.
func Placeholder() fs.FS {
	sub, _ := fs.Sub(placeholder, "placeholder")
	return sub
}
