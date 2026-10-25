package dev

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/fsnotify/fsnotify"
)

// DefaultDebounce is how long the watcher waits for a burst of filesystem
// events to settle: an editor's save is several (a temp file, a rename, a
// chmod), and one save should be one rebuild.
const DefaultDebounce = 150 * time.Millisecond

// Trigger is one settled burst of changes.
type Trigger struct {
	// Rebuild is set when a source or manifest changed. When only
	// signet.dev.toml changed it is false: the replays run again on the
	// same build.
	Rebuild bool
	// Paths are what changed, sorted.
	Paths []string
}

// WatchOptions says what to watch.
type WatchOptions struct {
	// CrateDir is watched recursively, new subdirectories included.
	CrateDir string
	// Files are watched one by one: the workspace Cargo.toml and
	// Cargo.lock, which may sit above the crate.
	Files []string
	// DevFile is signet.dev.toml, whose change replays without a rebuild.
	DevFile  string
	Debounce time.Duration
}

// ignoredDirs are never watched: build output, VCS and signet's own state.
var ignoredDirs = map[string]bool{"target": true, ".git": true, ".signet": true}

// ignoredFile is an editor's swap or backup file.
func ignoredFile(name string) bool {
	return strings.HasSuffix(name, ".swp") || strings.HasSuffix(name, ".swx") ||
		strings.HasSuffix(name, "~") || strings.HasPrefix(name, ".#")
}

// underIgnoredDir reports whether path sits in an ignored directory below
// root.
func underIgnoredDir(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	if err != nil || strings.HasPrefix(rel, "..") {
		return false
	}
	for _, part := range strings.Split(filepath.ToSlash(rel), "/") {
		if ignoredDirs[part] {
			return true
		}
	}
	return false
}

// Watch reports settled bursts of changes until ctx ends (#565). fsnotify
// watches single directories, so the crate's are added one by one, and a
// directory created later is added when it appears.
func Watch(ctx context.Context, opts WatchOptions) (<-chan Trigger, error) {
	if opts.Debounce <= 0 {
		opts.Debounce = DefaultDebounce
	}
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	addTree := func(root string) error {
		return filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil // a directory gone mid-walk is not an error
			}
			if !d.IsDir() {
				return nil
			}
			if path != opts.CrateDir && ignoredDirs[d.Name()] {
				return filepath.SkipDir
			}
			return w.Add(path)
		})
	}
	if err := addTree(opts.CrateDir); err != nil {
		_ = w.Close()
		return nil, err
	}
	// Single files are watched through their directories, filtered to them.
	single := map[string]bool{}
	for _, f := range append(append([]string{}, opts.Files...), opts.DevFile) {
		if f == "" {
			continue
		}
		abs, _ := filepath.Abs(f)
		single[abs] = true
		_ = w.Add(filepath.Dir(abs))
	}
	crateDir, _ := filepath.Abs(opts.CrateDir)
	devFile := ""
	if opts.DevFile != "" {
		devFile, _ = filepath.Abs(opts.DevFile)
	}

	out := make(chan Trigger)
	go func() {
		defer close(out)
		defer func() { _ = w.Close() }()
		pending := map[string]bool{}
		var timer <-chan time.Time
		for {
			select {
			case <-ctx.Done():
				return
			case err, ok := <-w.Errors:
				if !ok {
					return
				}
				_ = err // an overflowed queue only costs a missed event
			case ev, ok := <-w.Events:
				if !ok {
					return
				}
				path, _ := filepath.Abs(ev.Name)
				inCrate := !strings.HasPrefix(mustRel(crateDir, path), "..")
				switch {
				case single[path]:
				case !inCrate, underIgnoredDir(crateDir, path), ignoredFile(filepath.Base(path)):
					continue
				}
				if ev.Has(fsnotify.Create) {
					if info, err := os.Stat(path); err == nil && info.IsDir() && inCrate {
						_ = addTree(path)
					}
				}
				if ev.Has(fsnotify.Chmod) && !ev.Has(fsnotify.Write) {
					continue // a bare chmod changes nothing a build reads
				}
				pending[path] = true
				timer = time.After(opts.Debounce)
			case <-timer:
				t := Trigger{}
				for p := range pending {
					t.Paths = append(t.Paths, p)
					if p != devFile {
						t.Rebuild = true
					}
				}
				sort.Strings(t.Paths)
				pending = map[string]bool{}
				timer = nil
				select {
				case out <- t:
				case <-ctx.Done():
					return
				}
			}
		}
	}()
	return out, nil
}

func mustRel(base, path string) string {
	rel, err := filepath.Rel(base, path)
	if err != nil {
		return ".."
	}
	return rel
}
