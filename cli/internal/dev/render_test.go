package dev

import (
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/blockchain-maxis/signet/cli/internal/realtx"
	"github.com/blockchain-maxis/signet/cli/internal/simulator"
)

var update = flag.Bool("update", false, "rewrite testdata/render/*.golden with the current output")

// recordedCycle is a cycle recorded from the real simulator for the local
// UI (uifixtures_test.go), with a fixed timing.
func recordedCycle(t *testing.T, name string) *Cycle {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "apps", "sandbox-ui", "src", "fixtures", "cycles", name+".json"))
	if err != nil {
		t.Fatal(err)
	}
	var c Cycle
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	c.Timing = Timing{Install: 3 * time.Millisecond, Swap: 4 * time.Millisecond, A: 80 * time.Millisecond, B: 85 * time.Millisecond, Diff: 15 * time.Millisecond}
	return &c
}

// cleanCycle is two saved calls that behave the same on both sides, and a
// real transaction that matched the chain.
func cleanCycle(t *testing.T) *Cycle {
	c := recordedCycle(t, "counter_v2_auth")
	c.Spec, c.Layout = nil, nil
	c.Outcomes = c.Outcomes[:1]
	c.Outcomes[0].Diff = &simulator.DiffResultsResult{Empty: true}
	real := c.Outcomes[0]
	real.Name = "tx 3f2a… (ledger 4851010, get)"
	real.Real = &RealOutcome{Hash: "3f2a9c", Ledger: 4851010, Function: "get", Fidelity: realFidelity(true)}
	c.Outcomes = append(c.Outcomes, real)
	c.Timing.Install = 0
	return c
}

func realFidelity(high bool) (f realtx.Fidelity) {
	f.High = high
	if !high {
		f.Reason = "low-fidelity (state changed since ledger 4851010): it returns something else now"
	}
	return f
}

func golden(t *testing.T, name, got string) {
	t.Helper()
	path := filepath.Join("testdata", "render", name+".golden")
	if *update {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (run with -update)", err)
	}
	if got != string(want) {
		t.Fatalf("%s differs from %s:\n%s", name, path, got)
	}
}

// The acceptance test of #637.
func TestRenderGoldens(t *testing.T) {
	build := 2100 * time.Millisecond
	breaking := recordedCycle(t, "counter_v2_return")
	lowFidelity := cleanCycle(t)
	lowFidelity.Outcomes[1].Real.Fidelity = realFidelity(false)
	lowFidelity.Outcomes[1].Diff = breaking.Outcomes[0].Diff
	for _, tc := range []struct {
		name  string
		frame Frame
		opts  RenderOptions
	}{
		{"clean", Frame{Build: build, Cycle: cleanCycle(t)}, RenderOptions{}},
		{"same-build", Frame{Cycle: cleanCycle(t)}, RenderOptions{}},
		{"breaking-and-cost", Frame{Build: build, Cycle: breaking}, RenderOptions{}},
		{"breaking-and-cost-items", Frame{Build: build, Cycle: recordedCycle(t, "counter_v2_auth")}, RenderOptions{}},
		{"breaking-and-cost-tty", Frame{Build: build, Cycle: breaking}, RenderOptions{TTY: true, Clear: true}},
		{"breaking-and-cost-verbose", Frame{Build: build, Cycle: breaking}, RenderOptions{Verbose: true}},
		{"layout", Frame{Build: build, Cycle: recordedCycle(t, "profile_v2_field")}, RenderOptions{}},
		{"auth-verbose", Frame{Build: build, Cycle: recordedCycle(t, "auth_signer_changed")}, RenderOptions{Verbose: true}},
		{"low-fidelity", Frame{Build: build, Cycle: lowFidelity}, RenderOptions{}},
		{"build-failed", Frame{Build: 1400 * time.Millisecond, Active: breaking.Local,
			BuildError: "error[E0425]: cannot find value `count` in this scope\n --> src/lib.rs:14:9"}, RenderOptions{}},
		{"build-failed-first", Frame{Build: 900 * time.Millisecond, BuildError: "error: could not compile `counter`"}, RenderOptions{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			golden(t, tc.name, Render(tc.frame, tc.opts))
		})
	}
}
