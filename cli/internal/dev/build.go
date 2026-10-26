package dev

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
)

// Builder rebuilds the contract with `stellar contract build` (#564),
// leaving CARGO_TARGET_DIR alone so cargo's incremental builds are reused.
type Builder struct {
	// Stellar is the stellar CLI to run.
	Stellar string
	Crate   Crate
	// Now is the clock a build is timed against; time.Now when nil.
	Now func() time.Time

	// last is the most recent good artifact, which a failed build leaves
	// active.
	last string
}

// Built is a successful build.
type Built struct {
	Wasm     string
	Duration time.Duration
}

// BuildError is a failed build: the first error block, how many more
// errors there were, and all of the output.
type BuildError struct {
	First  string
	More   int
	Output string
	// Stale is set when the build exited cleanly but left an artifact older
	// than itself.
	Stale bool
}

func (e *BuildError) Error() string {
	if e.Stale {
		return e.First
	}
	if e.More > 0 {
		return fmt.Sprintf("%s\n… and %d more %s", e.First, e.More, map[bool]string{true: "error", false: "errors"}[e.More == 1])
	}
	return e.First
}

// Unwrap makes a build failure ErrBuildFailed (exit 12) for --ci.
func (e *BuildError) Unwrap() error { return exitcode.ErrBuildFailed }

// Artifact is where cargo leaves the contract's WASM.
func (b *Builder) Artifact() string {
	return filepath.Join(b.Crate.TargetDir, WasmTarget, "release", strings.ReplaceAll(b.Crate.Name, "-", "_")+".wasm")
}

// Last is the most recent good artifact; "" before the first.
func (b *Builder) Last() string { return b.last }

// Build runs one build. Cancelling ctx (a newer change arrived) kills the
// build's whole process group and waits for it before returning ctx's
// error. A failure keeps the previous artifact active; so does a build
// whose artifact is older than the build itself, which would otherwise be
// a stale WASM silently reused.
func (b *Builder) Build(ctx context.Context) (Built, error) {
	now := time.Now
	if b.Now != nil {
		now = b.Now
	}
	start := now()
	manifest, absErr := filepath.Abs(b.Crate.ManifestPath)
	if absErr != nil {
		return Built{}, fmt.Errorf("%w: %v", exitcode.ErrConfiguration, absErr)
	}
	args := []string{"contract", "build", "--manifest-path", manifest, "--package", b.Crate.Name}
	cmd := exec.Command(b.Stellar, args...)
	// From the crate's directory, so cargo builds with the toolchain a
	// rust-toolchain.toml there pins, not the working directory's.
	cmd.Dir = filepath.Dir(manifest)
	var output bytes.Buffer
	cmd.Stdout, cmd.Stderr = &output, &output
	ownGroup(cmd)
	if err := cmd.Start(); err != nil {
		return Built{}, fmt.Errorf("%w: starting stellar contract build: %v", exitcode.ErrConfiguration, err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	var err error
	select {
	case err = <-done:
	case <-ctx.Done():
		killGroup(cmd)
		<-done
		return Built{}, ctx.Err()
	}
	if err != nil {
		first, more := firstErrorBlock(output.String())
		if first == "" {
			first = "stellar contract build failed: " + err.Error()
		}
		return Built{}, &BuildError{First: first, More: more, Output: output.String()}
	}
	wasm := b.Artifact()
	info, statErr := os.Stat(wasm)
	if statErr != nil {
		return Built{}, &BuildError{Stale: true, First: fmt.Sprintf("the build succeeded but left no %s", wasm), Output: output.String()}
	}
	// Filesystems keep coarser times than the clock: allow a second.
	if info.ModTime().Before(start.Add(-time.Second)) {
		return Built{}, &BuildError{Stale: true, First: fmt.Sprintf("the build left %s from %s, before it started; refusing a stale WASM", wasm, info.ModTime().Format(time.RFC3339)), Output: output.String()}
	}
	b.last = wasm
	return Built{Wasm: wasm, Duration: now().Sub(start)}, nil
}

// firstErrorBlock is rustc's first error, from its `error` line through the
// next blank line, and how many more errors follow it.
func firstErrorBlock(output string) (string, int) {
	lines := strings.Split(strings.ReplaceAll(output, "\r\n", "\n"), "\n")
	isError := func(l string) bool {
		return strings.HasPrefix(l, "error[") || (strings.HasPrefix(l, "error:") && !strings.HasPrefix(l, "error: could not compile"))
	}
	start := -1
	count := 0
	for i, l := range lines {
		if !isError(l) {
			continue
		}
		count++
		if start == -1 {
			start = i
		}
	}
	if start == -1 {
		return "", 0
	}
	end := len(lines)
	for i := start + 1; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) == "" {
			end = i
			break
		}
	}
	return strings.Join(lines[start:end], "\n"), count - 1
}

// IsBuildError reports whether err is a failed build (not a cancelled or
// unstartable one).
func IsBuildError(err error) bool {
	var be *BuildError
	return errors.As(err, &be)
}
