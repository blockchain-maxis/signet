package dev

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// watching starts a watcher on a fresh crate directory with a
// signet.dev.toml beside it, and returns its triggers.
func watching(t *testing.T) (string, string, <-chan Trigger) {
	t.Helper()
	root := t.TempDir()
	crate := filepath.Join(root, "crate")
	_ = os.MkdirAll(filepath.Join(crate, "src"), 0o755)
	_ = os.MkdirAll(filepath.Join(crate, "target", "release"), 0o755)
	devFile := filepath.Join(root, "signet.dev.toml")
	_ = os.WriteFile(devFile, []byte("version = 1\n"), 0o644)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	triggers, err := Watch(ctx, WatchOptions{CrateDir: crate, DevFile: devFile, Debounce: 150 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	return crate, devFile, triggers
}

func next(t *testing.T, triggers <-chan Trigger, within time.Duration) (Trigger, bool) {
	t.Helper()
	select {
	case tr := <-triggers:
		return tr, true
	case <-time.After(within):
		return Trigger{}, false
	}
}

func TestABurstOfWritesIsOneTrigger(t *testing.T) {
	crate, _, triggers := watching(t)
	file := filepath.Join(crate, "src", "lib.rs")
	for i := 0; i < 5; i++ {
		_ = os.WriteFile(file, []byte{byte(i)}, 0o644)
		time.Sleep(10 * time.Millisecond)
	}
	tr, ok := next(t, triggers, 3*time.Second)
	if !ok || !tr.Rebuild || len(tr.Paths) != 1 {
		t.Fatalf("trigger = %+v, %v", tr, ok)
	}
	if extra, ok := next(t, triggers, 500*time.Millisecond); ok {
		t.Fatalf("a second trigger for one burst: %+v", extra)
	}
}

func TestBuildOutputAndSwapFilesAreIgnored(t *testing.T) {
	crate, _, triggers := watching(t)
	_ = os.WriteFile(filepath.Join(crate, "target", "release", "x.wasm"), []byte("x"), 0o644)
	_ = os.WriteFile(filepath.Join(crate, "src", ".lib.rs.swp"), []byte("x"), 0o644)
	_ = os.WriteFile(filepath.Join(crate, "src", "lib.rs~"), []byte("x"), 0o644)
	if tr, ok := next(t, triggers, 600*time.Millisecond); ok {
		t.Fatalf("triggered by ignored files: %+v", tr)
	}
}

func TestANewSubdirectoryIsWatched(t *testing.T) {
	crate, _, triggers := watching(t)
	sub := filepath.Join(crate, "src", "storage")
	_ = os.MkdirAll(sub, 0o755)
	if _, ok := next(t, triggers, 3*time.Second); !ok {
		t.Fatal("creating the directory did not trigger")
	}
	_ = os.WriteFile(filepath.Join(sub, "keys.rs"), []byte("x"), 0o644)
	tr, ok := next(t, triggers, 3*time.Second)
	if !ok || !tr.Rebuild || filepath.Base(tr.Paths[0]) != "keys.rs" {
		t.Fatalf("a file in the new directory: %+v, %v", tr, ok)
	}
}

func TestSignetDevTomlAloneReplaysWithoutARebuild(t *testing.T) {
	_, devFile, triggers := watching(t)
	_ = os.WriteFile(devFile, []byte("version = 1\n# edited\n"), 0o644)
	tr, ok := next(t, triggers, 3*time.Second)
	if !ok || tr.Rebuild || len(tr.Paths) != 1 || filepath.Base(tr.Paths[0]) != "signet.dev.toml" {
		t.Fatalf("trigger = %+v, %v", tr, ok)
	}
}
