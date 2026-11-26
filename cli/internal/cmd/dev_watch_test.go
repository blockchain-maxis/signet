package cmd

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/blockchain-maxis/signet/cli/internal/dev"
	"github.com/blockchain-maxis/signet/cli/internal/devconfig"
	"github.com/blockchain-maxis/signet/cli/internal/devui"
	"github.com/blockchain-maxis/signet/cli/internal/rpc"
	"github.com/blockchain-maxis/signet/cli/internal/simulator"
)

type watchHarness struct {
	crateDir string
	libRs    string
	devFile  string
	setup    devSetup
	builder  *dev.Builder
	session  *devSession
	events   <-chan devui.Event
	progress chan string
}

func newWatchHarness(t *testing.T) *watchHarness {
	t.Helper()
	e := newCallEnv(t)
	devTools(t)
	e.stellar = "stellar"

	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	wasm := filepath.Join(root, "sandbox", "fixtures", "wasm", "counter_v1.wasm")
	t.Setenv("FAKESTELLAR_BUILD_WASM", wasm)
	t.Setenv("FAKESTELLAR_BUILD", "")

	crateDir := t.TempDir()
	cargoToml := "[package]\nname = \"counter\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n[lib]\ncrate-type = [\"cdylib\"]\n"
	if err := os.WriteFile(filepath.Join(crateDir, "Cargo.toml"), []byte(cargoToml), 0o644); err != nil {
		t.Fatal(err)
	}
	srcDir := filepath.Join(crateDir, "src")
	if err := os.MkdirAll(srcDir, 0o755); err != nil {
		t.Fatal(err)
	}
	libRs := filepath.Join(srcDir, "lib.rs")
	if err := os.WriteFile(libRs, []byte("// v1\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	devDir := t.TempDir()
	devFile := filepath.Join(devDir, devconfig.FileName)
	contractAddr := counterContract(t)
	tomlContent := fmt.Sprintf(
		"version = 1\naddress = %q\npath = %q\n\n[[call]]\nname = \"get\"\nfunction = \"get\"\nargs = {}\nexpect = \"any\"\n",
		contractAddr,
		filepath.ToSlash(crateDir),
	)
	if err := os.WriteFile(devFile, []byte(tomlContent), 0o644); err != nil {
		t.Fatal(err)
	}

	loadedFile, err := devconfig.Load(devFile)
	if err != nil {
		t.Fatal(err)
	}

	crate, err := dev.FindCrate(dev.Tools{}, crateDir, "")
	if err != nil {
		t.Fatal(err)
	}

	setup := devSetup{
		contract: contractAddr,
		crate:    crate,
		file:     loadedFile,
		fileDir:  devDir,
	}

	deps := defaultDeps()
	deps.KeysBinary = "stellar"
	deps.ForkRoot = func() (string, error) { return e.root, nil }
	deps.LocateSimulator = func(context.Context, string, func(string)) (string, error) {
		return e.sim, nil
	}
	deps.Now = func() time.Time { return time.Unix(1790458610, 0) }
	deps.Config.Network = "testnet"

	ctx := context.Background()
	network := rpc.Network{Name: "testnet", RPCURL: e.rpc.srv.URL, Passphrase: "Test SDF Network ; September 2015"}
	client, _, err := rpc.Connect(ctx, network, deps.RPCOptions...)
	if err != nil {
		t.Fatal(err)
	}
	sim, err := startSimulator(ctx, deps, func(string) {})
	if err != nil {
		var se *simulator.StartError
		if errors.As(err, &se) {
			t.Fatalf("startSimulator failed: %v (cause: %v, stderr: %v)", err, se.Cause, se.Stderr)
		}
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sim.Close() })

	m, err := forkWithDrift(ctx, deps, network, setup.contract, "warn", func(string) {})
	if err != nil {
		t.Fatal(err)
	}

	session, err := openDevSession(ctx, deps, network, client, sim, m, fileOverrides(setup.file))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(session.Close)

	session.events = devui.NewEvents()
	eventsCh, cancelEv := session.events.Subscribe()
	t.Cleanup(cancelEv)

	builder := &dev.Builder{Stellar: "stellar", Crate: setup.crate}
	built, err := builder.Build(ctx)
	if err != nil {
		t.Fatalf("initial build: %v", err)
	}
	if _, err := session.runCycle(ctx, built.Wasm, built.Duration, session.replays(setup.file), func(string) {}); err != nil {
		t.Fatalf("initial replay: %v", err)
	}

	progressCh := make(chan string, 200)

	return &watchHarness{
		crateDir: crateDir,
		libRs:    libRs,
		devFile:  devFile,
		setup:    setup,
		builder:  builder,
		session:  session,
		events:   eventsCh,
		progress: progressCh,
	}
}

func waitProgress(t *testing.T, ch <-chan string, timeout time.Duration, contains string) string {
	t.Helper()
	deadline := time.After(timeout)
	for {
		select {
		case line := <-ch:
			if strings.Contains(line, contains) {
				return line
			}
		case <-deadline:
			t.Fatalf("timed out waiting for progress containing %q", contains)
			return ""
		}
	}
}

func waitEvent(t *testing.T, ch <-chan devui.Event, timeout time.Duration, eventType string) devui.Event {
	t.Helper()
	deadline := time.After(timeout)
	for {
		select {
		case ev := <-ch:
			if ev.Type == eventType {
				return ev
			}
		case <-deadline:
			t.Fatalf("timed out waiting for event %q", eventType)
			return devui.Event{}
		}
	}
}

func touchFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("writing %s: %v", path, err)
	}
}

func waitFile(t *testing.T, path string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for file %s", path)
}

func drainEvents(ch <-chan devui.Event) {
	for {
		select {
		case <-ch:
		default:
			return
		}
	}
}

func TestDevWatch_OneSave(t *testing.T) {
	h := newWatchHarness(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	progress := func(msg string) {
		select {
		case h.progress <- msg:
		default:
		}
	}

	done := make(chan error, 1)
	go func() {
		done <- watchAndRebuild(ctx, h.setup, h.builder, h.session, 20*time.Millisecond, nil, progress)
	}()

	waitProgress(t, h.progress, 5*time.Second, "watching")
	drainEvents(h.events)

	touchFile(t, h.libRs, "// save 1\n")
	waitProgress(t, h.progress, 5*time.Second, "changed:")
	waitEvent(t, h.events, 5*time.Second, "build.started")
	waitEvent(t, h.events, 5*time.Second, "cycle.completed")

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("watchAndRebuild error: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("watchAndRebuild did not return after cancel")
	}
}

func TestDevWatch_TwoSavesSuperseded(t *testing.T) {
	h := newWatchHarness(t)
	slowStarted := filepath.Join(t.TempDir(), "slow_started")
	t.Setenv("FAKESTELLAR_BUILD", "slow")
	t.Setenv("FAKESTELLAR_SLOW_STARTED", slowStarted)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	progress := func(msg string) {
		select {
		case h.progress <- msg:
		default:
		}
	}

	done := make(chan error, 1)
	go func() {
		done <- watchAndRebuild(ctx, h.setup, h.builder, h.session, 20*time.Millisecond, nil, progress)
	}()

	waitProgress(t, h.progress, 15*time.Second, "watching")
	drainEvents(h.events)

	h.session.mu.Lock()
	cyclesBefore := len(h.session.cycles)
	h.session.mu.Unlock()

	// Save 1 starts a slow build
	touchFile(t, h.libRs, "// save 1 slow\n")
	waitEvent(t, h.events, 15*time.Second, "build.started")
	waitFile(t, slowStarted, 15*time.Second)

	// The next build succeeds immediately, with different code, so the
	// replay can be traced to it.
	t.Setenv("FAKESTELLAR_BUILD", "")
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	newerWasm := filepath.Join(root, "sandbox", "fixtures", "wasm", "counter_v2_return.wasm")
	t.Setenv("FAKESTELLAR_BUILD_WASM", newerWasm)
	newerRaw, err := os.ReadFile(newerWasm)
	if err != nil {
		t.Fatal(err)
	}
	newerSum := sha256.Sum256(newerRaw)
	newerHash := hex.EncodeToString(newerSum[:])

	// Save 2 arrives while save 1 is in-flight, superseding it
	touchFile(t, filepath.Join(h.crateDir, "Cargo.toml"), "[package]\nname = \"counter\"\nversion = \"0.1.0\"\nedition = \"2021\"\n# save 2\n\n[lib]\ncrate-type = [\"cdylib\"]\n")
	waitProgress(t, h.progress, 15*time.Second, "rebuilding for a newer change")
	waitEvent(t, h.events, 15*time.Second, "build.started")
	waitEvent(t, h.events, 15*time.Second, "cycle.completed")

	// The replay ran on the newer build, not the superseded one.
	h.session.mu.Lock()
	cycles := append([]storedCycle(nil), h.session.cycles...)
	h.session.mu.Unlock()
	if len(cycles) != cyclesBefore+1 {
		t.Fatalf("expected exactly one new cycle, got %d", len(cycles)-cyclesBefore)
	}
	if got := cycles[len(cycles)-1].Cycle.Local; got != newerHash {
		t.Fatalf("replay ran on build %s, want the newer build %s", got, newerHash)
	}

	// No second cycle.completed arrives from the superseded build: wait a
	// little for a stray one rather than only checking what is queued.
	stray := time.After(500 * time.Millisecond)
	for waiting := true; waiting; {
		select {
		case ev := <-h.events:
			if ev.Type == "cycle.completed" {
				t.Fatal("unexpected second cycle.completed from superseded build")
			}
		case <-stray:
			waiting = false
		}
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("watchAndRebuild error: %v", err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("watchAndRebuild did not return after cancel")
	}
}

func TestDevWatch_TomlOnly(t *testing.T) {
	h := newWatchHarness(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	progress := func(msg string) {
		select {
		case h.progress <- msg:
		default:
		}
	}

	done := make(chan error, 1)
	go func() {
		done <- watchAndRebuild(ctx, h.setup, h.builder, h.session, 20*time.Millisecond, nil, progress)
	}()

	waitProgress(t, h.progress, 5*time.Second, "watching")
	drainEvents(h.events)

	// Edit only signet.dev.toml
	newToml := fmt.Sprintf(
		"version = 1\naddress = %q\npath = %q\n# comment update\n\n[[call]]\nname = \"get\"\nfunction = \"get\"\nargs = {}\nexpect = \"any\"\n",
		h.setup.contract,
		filepath.ToSlash(h.crateDir),
	)
	touchFile(t, h.devFile, newToml)
	waitProgress(t, h.progress, 5*time.Second, "signet.dev.toml changed: replaying on the current build")

	// Wait for cycle.completed, verifying no build.started was sent
	deadline := time.After(5 * time.Second)
	completed := false
	for !completed {
		select {
		case ev := <-h.events:
			if ev.Type == "build.started" {
				t.Fatal("unexpected build.started event when only signet.dev.toml changed")
			}
			if ev.Type == "cycle.completed" {
				completed = true
			}
		case <-deadline:
			t.Fatal("timed out waiting for cycle.completed after toml change")
		}
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("watchAndRebuild error: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("watchAndRebuild did not return after cancel")
	}
}

func TestDevWatch_FailedBuildRecovery(t *testing.T) {
	h := newWatchHarness(t)
	lastGoodWasm := h.builder.Last()
	if lastGoodWasm == "" {
		t.Fatal("initial good WASM must not be empty")
	}

	t.Setenv("FAKESTELLAR_BUILD", "fail")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	progress := func(msg string) {
		select {
		case h.progress <- msg:
		default:
		}
	}

	done := make(chan error, 1)
	go func() {
		done <- watchAndRebuild(ctx, h.setup, h.builder, h.session, 20*time.Millisecond, nil, progress)
	}()

	waitProgress(t, h.progress, 5*time.Second, "watching")
	drainEvents(h.events)

	// Failing build save
	touchFile(t, h.libRs, "// save with error\n")
	waitEvent(t, h.events, 5*time.Second, "build.failed")
	waitProgress(t, h.progress, 5*time.Second, "error[E0425]")

	// Last good WASM is preserved
	if got := h.builder.Last(); got != lastGoodWasm {
		t.Fatalf("builder.Last() = %q, want preserved %q", got, lastGoodWasm)
	}

	// Recovery save with good build
	t.Setenv("FAKESTELLAR_BUILD", "")
	touchFile(t, h.libRs, "// save recovered\n")
	waitEvent(t, h.events, 5*time.Second, "build.started")
	waitEvent(t, h.events, 5*time.Second, "cycle.completed")

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("watchAndRebuild error: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("watchAndRebuild did not return after cancel")
	}
}

func TestDevWatch_CancelContext(t *testing.T) {
	h := newWatchHarness(t)
	slowStarted := filepath.Join(t.TempDir(), "slow_started")
	t.Setenv("FAKESTELLAR_BUILD", "slow")
	t.Setenv("FAKESTELLAR_SLOW_STARTED", slowStarted)

	ctx, cancel := context.WithCancel(context.Background())

	progress := func(msg string) {
		select {
		case h.progress <- msg:
		default:
		}
	}

	done := make(chan error, 1)
	go func() {
		done <- watchAndRebuild(ctx, h.setup, h.builder, h.session, 20*time.Millisecond, nil, progress)
	}()

	waitProgress(t, h.progress, 15*time.Second, "watching")
	drainEvents(h.events)

	touchFile(t, h.libRs, "// in flight\n")
	waitEvent(t, h.events, 15*time.Second, "build.started")
	waitFile(t, slowStarted, 15*time.Second)

	// Cancel while build is in flight
	cancel()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("watchAndRebuild returned error on context cancel: %v", err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("watchAndRebuild did not return within deadline after cancel")
	}
}
