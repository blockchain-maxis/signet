package dev

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
)

// fakeStellar builds internal/keys' fake stellar CLI.
func fakeStellar(t *testing.T) string {
	t.Helper()
	goBin, err := exec.LookPath("go")
	if err != nil {
		t.Skipf("go binary not found: %v", err)
	}
	out := filepath.Join(t.TempDir(), "stellar")
	if runtime.GOOS == "windows" {
		out += ".exe"
	}
	if output, err := exec.Command(goBin, "build", "-o", out, "../keys/testdata/fakestellar").CombinedOutput(); err != nil {
		t.Fatalf("building fakestellar: %v\n%s", err, output)
	}
	return out
}

func testBuilder(t *testing.T) *Builder {
	t.Helper()
	dir := t.TempDir()
	return &Builder{
		Stellar: fakeStellar(t),
		Crate:   Crate{Name: "identity-registry", ManifestPath: filepath.Join(dir, "Cargo.toml"), TargetDir: filepath.Join(dir, "target")},
	}
}

func TestABuildLocatesItsArtifact(t *testing.T) {
	b := testBuilder(t)
	built, err := b.Build(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(b.Crate.TargetDir, "wasm32v1-none", "release", "identity_registry.wasm")
	if built.Wasm != want || b.Last() != want {
		t.Fatalf("wasm = %s, last %s, want %s", built.Wasm, b.Last(), want)
	}
}

func TestACompileErrorShowsItsFirstBlockAndKeepsTheLastWasm(t *testing.T) {
	b := testBuilder(t)
	if _, err := b.Build(context.Background()); err != nil {
		t.Fatal(err)
	}
	good := b.Last()
	t.Setenv("FAKESTELLAR_BUILD", "fail")
	_, err := b.Build(context.Background())
	var be *BuildError
	if !errors.As(err, &be) {
		t.Fatalf("err = %v", err)
	}
	want := "error[E0425]: cannot find value `x` in this scope\n  --> src/lib.rs:10:5\n   |\n10 |     x\n   |     ^ not found in this scope"
	if be.First != want || be.More != 1 {
		t.Fatalf("first = %q, more %d", be.First, be.More)
	}
	if !strings.HasSuffix(err.Error(), "… and 1 more error") || !errors.Is(err, exitcode.ErrBuildFailed) {
		t.Fatalf("err = %v", err)
	}
	if b.Last() != good {
		t.Fatal("a failed build replaced the last good WASM")
	}
}

func TestAStaleArtifactIsRefused(t *testing.T) {
	b := testBuilder(t)
	_ = os.MkdirAll(filepath.Dir(b.Artifact()), 0o755)
	_ = os.WriteFile(b.Artifact(), []byte("\x00asm"), 0o644)
	old := time.Now().Add(-time.Hour)
	_ = os.Chtimes(b.Artifact(), old, old)
	t.Setenv("FAKESTELLAR_BUILD", "stale")
	_, err := b.Build(context.Background())
	var be *BuildError
	if !errors.As(err, &be) || !be.Stale || !strings.Contains(err.Error(), "refusing a stale WASM") {
		t.Fatalf("err = %v", err)
	}
	if b.Last() != "" {
		t.Fatal("a stale WASM was taken")
	}
}

func TestFirstErrorBlockWithoutErrors(t *testing.T) {
	if first, more := firstErrorBlock("warning: unused\n\n"); first != "" || more != 0 {
		t.Fatalf("%q %d", first, more)
	}
}
