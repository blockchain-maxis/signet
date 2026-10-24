package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
	"github.com/blockchain-maxis/signet/cli/internal/fork"
	"github.com/blockchain-maxis/signet/cli/internal/simulator"
)

var forksNow = time.Unix(1_800_000_000, 0).UTC()

// seedForks makes three forks in a temp cache: a fresh and a ten-day-old
// testnet fork of the registry, and a mainnet one.
func seedForks(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	for _, f := range []struct {
		network, passphrase string
		ledger              uint32
		age                 time.Duration
		entries             int
		drift               int
	}{
		{"testnet", testnetPhrase, 100, time.Hour, 3, 0},
		{"testnet", testnetPhrase, 50, 10 * 24 * time.Hour, 1, 2},
		{"mainnet", "Public Global Stellar Network ; September 2015", 900, 2 * time.Minute, 0, 0},
	} {
		c, err := fork.Create(root, fork.Manifest{
			Network: f.network, Passphrase: f.passphrase, RPCURL: "https://rpc.example",
			Contract: registryContract, ForkLedger: f.ledger, ForkTime: forksNow.Add(-f.age),
			Protocol: 29, DriftedEntries: f.drift,
		})
		if err != nil {
			t.Fatal(err)
		}
		var entries []fork.Entry
		for i := 0; i < f.entries; i++ {
			entries = append(entries, fork.Entry{Key: strings.Repeat("A", i+4), XDR: "AAAA"})
		}
		if err := c.PutEntries(entries); err != nil {
			t.Fatal(err)
		}
		if err := c.Close(); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

type forksRun struct {
	stdout, stderr *bytes.Buffer
	err            error
}

func runForks(t *testing.T, root string, stdin io.Reader, args ...string) forksRun {
	t.Helper()
	isolateConfigDir(t)
	deps := defaultDeps()
	deps.ForkRoot = func() (string, error) { return root, nil }
	deps.Now = func() time.Time { return forksNow }
	cmd := newRootCmdWithDeps("0.0.0-test", "abc1234", deps)
	stdout, stderr := &bytes.Buffer{}, &bytes.Buffer{}
	cmd.SetOut(stdout)
	cmd.SetErr(stderr)
	cmd.SetIn(stdin)
	cmd.SetArgs(append([]string{"sandbox", "forks"}, args...))
	return forksRun{stdout, stderr, cmd.Execute()}
}

func TestForksLs(t *testing.T) {
	root := seedForks(t)
	run := runForks(t, root, strings.NewReader(""), "ls")
	if run.err != nil {
		t.Fatal(run.err)
	}
	lines := strings.Split(strings.TrimSpace(run.stdout.String()), "\n")
	if len(lines) != 4 {
		t.Fatalf("ls:\n%s", run.stdout)
	}
	for _, col := range []string{"ID", "NETWORK", "LEDGER", "AGE", "ENTRIES", "SIZE", "DRIFT"} {
		if !strings.Contains(lines[0], col) {
			t.Errorf("header lacks %s: %q", col, lines[0])
		}
	}
	// mainnet first, then testnet by ledger.
	for i, want := range []string{"CASF…RCN@900 mainnet 900 2m 0", "CASF…RCN@50 testnet 50 10d 1", "CASF…RCN@100 testnet 100 1h 3"} {
		if got := strings.Join(strings.Fields(lines[i+1]), " "); !strings.HasPrefix(got, want) {
			t.Errorf("row %d = %q, want prefix %q", i+1, got, want)
		}
	}
	if !strings.HasSuffix(strings.TrimSpace(lines[2]), " 2") {
		t.Errorf("the old fork's drift count: %q", lines[2])
	}

	run = runForks(t, root, strings.NewReader(""), "ls", "--json")
	var rows []forkRow
	if err := json.Unmarshal(run.stdout.Bytes(), &rows); err != nil || len(rows) != 3 {
		t.Fatalf("--json: %v\n%s", err, run.stdout)
	}
	if rows[2].Entries != 3 || rows[2].AgeSeconds != 3600 || rows[2].SizeBytes == 0 || rows[2].ID != fork.ID(registryContract, 100) {
		t.Fatalf("row = %+v", rows[2])
	}
}

func TestForksLsWithNoForks(t *testing.T) {
	run := runForks(t, t.TempDir(), strings.NewReader(""), "ls")
	if run.err != nil || !strings.Contains(run.stdout.String(), "No forks") {
		t.Fatalf("%v %q", run.err, run.stdout)
	}
}

func TestParseAge(t *testing.T) {
	for in, want := range map[string]time.Duration{"7d": 7 * 24 * time.Hour, "2w": 14 * 24 * time.Hour, "36h": 36 * time.Hour, " 90m ": 90 * time.Minute} {
		if got, err := parseAge(in); err != nil || got != want {
			t.Errorf("parseAge(%q) = %s, %v", in, got, err)
		}
	}
	for _, bad := range []string{"", "0d", "-3d", "xd", "soon", "-1h"} {
		if _, err := parseAge(bad); err == nil {
			t.Errorf("parseAge(%q) should fail", bad)
		}
	}
}

func remaining(t *testing.T, root string) int {
	forks, err := fork.List(root)
	if err != nil {
		t.Fatal(err)
	}
	return len(forks)
}

func TestForksRm(t *testing.T) {
	t.Run("by id", func(t *testing.T) {
		root := seedForks(t)
		run := runForks(t, root, strings.NewReader(""), "rm", fork.ID(registryContract, 900))
		if run.err != nil || remaining(t, root) != 2 {
			t.Fatalf("%v, %d left", run.err, remaining(t, root))
		}
		if code := ExitCode(runForks(t, root, strings.NewReader(""), "rm", "nope@1").err); code != exitcode.InvalidInput {
			t.Fatalf("unknown id: exit %d", code)
		}
	})

	t.Run("older-than with --yes", func(t *testing.T) {
		root := seedForks(t)
		run := runForks(t, root, strings.NewReader(""), "rm", "--older-than", "7d", "--yes")
		if run.err != nil || remaining(t, root) != 2 || !strings.Contains(run.stdout.String(), "@50") {
			t.Fatalf("%v, %d left\n%s", run.err, remaining(t, root), run.stdout)
		}
	})

	t.Run("--all needs --yes without a terminal", func(t *testing.T) {
		root := seedForks(t)
		run := runForks(t, root, strings.NewReader("y\n"), "rm", "--all")
		if code := ExitCode(run.err); code != exitcode.InvalidInput || remaining(t, root) != 3 {
			t.Fatalf("exit %d, %d left", code, remaining(t, root))
		}
	})

	t.Run("--all asks on a terminal", func(t *testing.T) {
		old := stdinIsTerminal
		stdinIsTerminal = func(io.Reader) bool { return true }
		t.Cleanup(func() { stdinIsTerminal = old })

		root := seedForks(t)
		run := runForks(t, root, strings.NewReader("n\n"), "rm", "--all")
		if run.err != nil || remaining(t, root) != 3 || !strings.Contains(run.stdout.String(), "Remove 3 fork(s)? [y/N]") {
			t.Fatalf("declined: %v, %d left\n%s", run.err, remaining(t, root), run.stdout)
		}
		run = runForks(t, root, strings.NewReader("yes\n"), "rm", "--all")
		if run.err != nil || remaining(t, root) != 0 {
			t.Fatalf("confirmed: %v, %d left", run.err, remaining(t, root))
		}
	})

	t.Run("one selector only", func(t *testing.T) {
		root := seedForks(t)
		for _, args := range [][]string{{"rm"}, {"rm", "--all", "--older-than", "1d"}, {"rm", "x@1", "--all"}} {
			if code := ExitCode(runForks(t, root, strings.NewReader(""), args...).err); code != exitcode.InvalidInput {
				t.Errorf("%v: exit %d", args, code)
			}
		}
	})

	t.Run("a fork in use is kept", func(t *testing.T) {
		root := seedForks(t)
		c, err := fork.Open(root, testnetPhrase, fork.ID(registryContract, 100))
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = c.Close() }()
		run := runForks(t, root, strings.NewReader(""), "rm", fork.ID(registryContract, 100))
		if run.err == nil || !strings.Contains(run.err.Error(), "in use") {
			t.Fatalf("err = %v", run.err)
		}
	})
}

func TestForksRefreshPinsTheLatestLedger(t *testing.T) {
	r := newRegistryRPC(t)
	root := t.TempDir()
	old, err := fork.Create(root, fork.Manifest{
		Network: "testnet", Passphrase: testnetPhrase, RPCURL: r.srv.URL,
		Contract: registryContract, ForkLedger: 10, ForkTime: forksNow.Add(-48 * time.Hour), Protocol: 28,
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = old.Close()

	isolateConfigDir(t)
	sim := buildFakeSimulator(t)
	deps := defaultDeps()
	deps.ForkRoot = func() (string, error) { return root, nil }
	deps.Now = func() time.Time { return forksNow }
	deps.LocateSimulator = func(context.Context, string, func(string)) (string, error) { return sim, nil }
	deps.SimulatorOptions = []simulator.Option{simulator.WithEnv("FAKESIM_SCRIPT=" + r.forkScript(t, registryInfo()))}
	cmd := newRootCmdWithDeps("0.0.0-test", "abc1234", deps)
	stdout := &bytes.Buffer{}
	cmd.SetOut(stdout)
	cmd.SetErr(&bytes.Buffer{})
	cmd.SetArgs([]string{"sandbox", "forks", "refresh", fork.ID(registryContract, 10), "--json"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	var m fork.Manifest
	if err := json.Unmarshal(stdout.Bytes(), &m); err != nil || m.ForkLedger != registryLedger || m.RPCURL != r.srv.URL {
		t.Fatalf("refreshed = %+v (%v)", m, err)
	}
	if remaining(t, root) != 2 {
		t.Fatalf("the old fork should stay until removed")
	}
}
